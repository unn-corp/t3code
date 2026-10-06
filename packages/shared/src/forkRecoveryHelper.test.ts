// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import {
  listRecoveryOptions,
  main,
  recoverCohort,
  RECOVERY_HELPER_PROTOCOL,
  runSelfTest,
  type DesktopRecoveryPorts,
  type HelperIo,
} from "./forkRecoveryHelper.ts";
import {
  decodeHandoffPlan,
  encodeHandoffPlan,
  HANDOFF_EXIT,
  runDesktopHandoff,
  type HandoffIo,
  type HandoffPlan,
} from "./forkDesktopHandoff.ts";
import type { RecoveryCommand } from "./forkRecoveryCache.ts";
import { parseFenceOperation, runFenceOperation } from "./forkMaintenanceFenceOperations.ts";
import { parseHomeOperation, runHomeOperation } from "./forkMaintenanceHomeOperations.ts";
import { newJournal } from "./forkMaintenanceJournal.ts";
import { createSnapshot } from "./forkMaintenanceSnapshot.ts";
import { CoordinatorStore } from "./forkMaintenanceStore.ts";
import { wslHomeId, type Exec, type WslMember } from "./forkMaintenanceWsl.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: HelperIo = { out: (line) => void out.push(line), err: (line) => void err.push(line) };
  return { io, out, err };
};

describe("importable recovery helper", () => {
  it("does not treat a normal CLI --version import as the standalone helper executable", () => {
    const helperPath = NodeURL.fileURLToPath(new URL("./forkRecoveryHelper.ts", import.meta.url));
    // Match the old bundled self-execution condition: process.argv[1] names this module even though
    // it is being imported as a dependency of the normal CLI bundle.
    const source = `
      import { pathToFileURL } from "node:url";
      const helper = ${JSON.stringify(helperPath)};
      process.argv = [process.execPath, helper, "--version"];
      await import(pathToFileURL(helper));
      console.log("normal-cli-survived");
    `;
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("normal-cli-survived");
    expect(result.stdout).not.toContain("recovery-helper-protocol=");
    expect(result.stderr).toBe("");
  });
});

const NOW = 600_000;
// oxlint-disable-next-line t3code/no-global-process-runtime -- The plan ownership rules differ by host OS; tests run on the host.
const HOST_PLATFORM = process.platform;
const sha256Hex = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
interface Behaviour {
  failCapacityIn?: string;
  failRestoreIn?: string;
  unreachable?: Set<string>;
}

/** The distribution answers the way the real CLI would, against its own home and registry. */
function fakeWsl(
  distros: Record<string, { store: CoordinatorStore; home: string; wireHome: string }>,
  behaviour: Behaviour,
  calls: string[],
): Exec {
  return async (_command, args) => {
    const [, distro, , , , verb, ...rest] = args;
    calls.push(`${distro}:${verb}:${rest[0] ?? ""}`);
    const target = distros[distro!];
    if (target === undefined || behaviour.unreachable?.has(distro!))
      return { code: 1, stdout: "", stderr: `distribution ${distro} is not running` };
    if (verb === "home") {
      const parsed = parseHomeOperation(rest);
      if ("error" in parsed)
        return { code: 2, stdout: JSON.stringify({ ok: false, reason: parsed.error }), stderr: "" };
      if (parsed.operation.op === "capacity" && behaviour.failCapacityIn === distro)
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: false,
            reason: "Not enough free space for restore points on: home.",
          }),
          stderr: "",
        };
      if (parsed.operation.op === "restore" && behaviour.failRestoreIn === distro)
        return { code: 0, stdout: JSON.stringify({ ok: false, reason: "disk error" }), stderr: "" };
      return {
        code: 0,
        stdout: `${JSON.stringify(await runHomeOperation(target.home, parsed.operation, { store: target.store }))}\n`,
        stderr: "",
      };
    }
    const parsed = parseFenceOperation(rest);
    if ("error" in parsed)
      return { code: 2, stdout: JSON.stringify({ ok: false, reason: parsed.error }), stderr: "" };
    return {
      code: 0,
      stdout: `${JSON.stringify(await runFenceOperation(target.store, parsed, NOW)).replaceAll(JSON.stringify(target.home), JSON.stringify(target.wireHome))}\n`,
      stderr: "",
    };
  };
}

async function homeWith(root: string, name: string) {
  const home = NodePath.join(root, name);
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
  database.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${name} before')`);
  database.close();
  await NodeFSP.writeFile(NodePath.join(home, "userdata", "settings.json"), `${name} original`);
  return NodeFSP.realpath(home);
}
const readSetting = (home: string) =>
  NodeFSP.readFile(NodePath.join(home, "userdata", "settings.json"), "utf8");

/** A device after a committed update: Windows home + one WSL member, restore points for both, one unrelated idle runtime. */
async function device(behaviour: Behaviour = {}, options: { readonly desktop?: boolean } = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-recover-cohort-"));
  roots.push(root);
  const windowsHome = await homeWith(root, "windows");
  const ubuntuHome = await homeWith(root, "ubuntu");
  const otherHome = await homeWith(root, "other");
  const store = await CoordinatorStore.open(NodePath.join(root, "windows-registry"));
  const ubuntuStore = await CoordinatorStore.open(NodePath.join(root, "ubuntu-registry"));
  const member: WslMember = {
    id: "wsl-ubuntu",
    distro: "Ubuntu",
    home: "/home/fixture/ubuntu",
    executable: "/usr/local/bin/t3",
  };
  const calls: string[] = [];
  const exec = fakeWsl(
    { Ubuntu: { store: ubuntuStore, home: ubuntuHome, wireHome: member.home } },
    behaviour,
    calls,
  );
  const wslId = wslHomeId(member);
  const windowsPoint = await createSnapshot(windowsHome, "tx-update");
  const ubuntuPoint = await createSnapshot(ubuntuHome, "tx-update");
  // The update's data changes, which recovery must give up (after rescuing it).
  await NodeFSP.writeFile(
    NodePath.join(windowsHome, "userdata", "settings.json"),
    "windows after update",
  );
  await NodeFSP.writeFile(
    NodePath.join(ubuntuHome, "userdata", "settings.json"),
    "ubuntu after update",
  );
  const journal = {
    ...newJournal({
      id: "tx-update",
      kind: "update",
      homes: [windowsHome, wslId],
      previous: { version: "1.0.0", artifactSha256: "a" },
      target: {
        version: "1.0.1",
        artifactSha256: options.desktop === true ? sha256Hex("target build") : "b",
      },
      now: 0,
      snapshots: { [windowsHome]: windowsPoint, [wslId]: ubuntuPoint },
    }),
    phase: "committed" as const,
    // The previous build's identity ("a") is a legacy value that is NOT its installer digest; only this record maps them.
    ...(options.desktop === true
      ? {
          desktopHandoffs: {
            install: {
              owner: { pid: 4242, started: "boot:4242" },
              artifactSha256: sha256Hex("target build"),
              counterpartSha256: sha256Hex("previous build"),
            },
          },
        }
      : {}),
  };
  await store.writeJournal(journal);
  // One unrelated runtime on another home, idle for ten minutes, plus the target's own runtimes now stopped.
  await store.register(
    {
      id: "other-runtime",
      label: "Other runtime",
      kind: "service",
      homes: [otherHome],
      updateTarget: true,
    },
    0,
  );
  await store.confirmBootstrap();
  await store.observe("other-runtime", [], 0);
  await store.observe("other-runtime", [], NOW);
  const context = { store, members: [{ member, exec }], now: () => NOW };
  const cutoffs = async () => {
    const [option] = await listRecoveryOptions(context);
    return Object.fromEntries(option!.homes.map((home) => [home.id, home.createdAt]));
  };
  return {
    root,
    windowsHome,
    ubuntuHome,
    otherHome,
    store,
    ubuntuStore,
    member,
    wslId,
    context,
    calls,
    cutoffs,
    windowsPoint,
    ubuntuPoint,
    desktop:
      options.desktop === true
        ? await desktopFixture(root, store.directory, windowsHome, ubuntuHome)
        : null,
  };
}

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Data of both homes at the moment the binary handoff was launched. */
  readonly settings: ReadonlyArray<string>;
}

/** Retained install plan, both cached installers and the cached helper/Node pair of a device whose desktop was replaced. */
async function desktopFixture(
  root: string,
  coordinatorDirectory: string,
  windowsHome: string,
  ubuntuHome: string,
) {
  const handoffDir = NodePath.join(root, "handoff");
  const cacheDir = NodePath.join(root, "recovery");
  const payloads = NodePath.join(root, "payloads");
  for (const directory of [handoffDir, cacheDir, payloads]) {
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.chmod(directory, 0o700);
  }
  const installerPath = NodePath.join(payloads, "target.AppImage");
  const previousPath = NodePath.join(payloads, "previous.AppImage");
  const installTarget = NodePath.join(root, "T3-Code.AppImage");
  await NodeFSP.writeFile(installerPath, "target build");
  await NodeFSP.writeFile(previousPath, "previous build");
  await NodeFSP.writeFile(installTarget, "target build");
  const plan: HandoffPlan = {
    protocol: 1,
    mode: "install",
    transactionId: "tx-update",
    coordinatorDirectory,
    owner: { pid: 4242, started: "boot:4242" },
    packaging: "appimage",
    installer: { path: installerPath, sha256: sha256Hex("target build") },
    previousInstaller: { path: previousPath, sha256: sha256Hex("previous build") },
    installTarget,
    relaunch: { command: installTarget, args: ["--relaunched"] },
    waitForExitMs: 1000,
  };
  const planFile = NodePath.join(handoffDir, "tx-update-install.json.consumed");
  const writePlan = async (
    next: Partial<HandoffPlan> | HandoffPlan = plan,
    file = planFile,
    mode = 0o600,
  ) => {
    await NodeFSP.rm(file, { force: true });
    await NodeFSP.writeFile(file, encodeHandoffPlan({ ...plan, ...next }), { mode });
    await NodeFSP.chmod(file, mode);
  };
  await writePlan();
  const command: RecoveryCommand = {
    protocol: 1,
    version: "1.0.1",
    platform: "linux-x64",
    nodePath: NodePath.join(cacheDir, "1.0.1", "t3-recovery-node-linux-x64"),
    helperPath: NodePath.join(cacheDir, "1.0.1", "t3-recovery-helper-linux-x64.mjs"),
    nodeSha256: sha256Hex("node"),
    helperSha256: sha256Hex("helper"),
    installedAt: 1,
  };
  const spawned: Spawned[] = [];
  const commandReads: string[] = [];
  const ports: Partial<DesktopRecoveryPorts> = {
    // The cached pair is the one external dependency; its byte verification is covered by forkRecoveryCache's own tests.
    readCommand: async (directory) => {
      commandReads.push(directory);
      return command;
    },
    spawn: async (spawnCommand, args) => {
      spawned.push({
        command: spawnCommand,
        args,
        settings: [await readSetting(windowsHome), await readSetting(ubuntuHome)],
      });
    },
  };
  return {
    handoffDir,
    cacheDir,
    planFile,
    plan,
    writePlan,
    command,
    spawned,
    commandReads,
    ports,
    input: { planFile, ports },
  };
}

describe("external recovery helper", () => {
  it("self-test performs a real snapshot, change and restore and reports the protocol", async () => {
    const c = capture();
    await runSelfTest(c.io);
    expect(c.out).toEqual([`recovery-helper-protocol=${RECOVERY_HELPER_PROTOCOL}`]);
    expect(await main(["--self-test"], c.io)).toBe(0);
  });

  it("closes its live database and cleans the fixture when snapshot creation fails", async () => {
    const c = capture();
    const failure = new Error("Private snapshot authorization failed");
    let fixture = "";
    await expect(
      runSelfTest(c.io, async (home) => {
        fixture = home;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fixture).not.toBe("");
    await expect(NodeFSP.stat(fixture)).rejects.toMatchObject({ code: "ENOENT" });
    expect(c.out).toEqual([]);
  });

  it("offers a committed update as a cohort with every home's exact restore cutoff", async () => {
    const d = await device();
    const options = await listRecoveryOptions(d.context);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      transactionId: "tx-update",
      mode: "revert-committed",
      phase: "committed",
    });
    expect(options[0]!.homes.map((home) => home.id)).toEqual([d.windowsHome, d.wslId]);
  });

  it("restores every home of the cohort after verified rescue copies, then stops with admission still fenced and no health claim", async () => {
    const d = await device();
    const lines = await recoverCohort({
      ...d.context,
      transactionId: "tx-update",
      confirm: await d.cutoffs(),
    });
    expect(lines.join(" ")).toContain("Restored all 2 home(s)");
    expect(await readSetting(d.windowsHome)).toBe("windows original");
    expect(await readSetting(d.ubuntuHome)).toBe("ubuntu original");
    const recovery = (await d.store.listJournals()).find((journal) => journal.kind === "recovery")!;
    expect(recovery).toMatchObject({ phase: "restored", previous: { version: "1.0.0" } });
    expect(Object.keys(recovery.rescues).sort()).toEqual([d.windowsHome, d.wslId].sort());
    // The fence is held locally and in the distribution; nothing was released or verified by the helper.
    expect((await d.store.fenceSnapshot())?.transactionId).toBe(recovery.id);
    expect((await d.ubuntuStore.fenceSnapshot())?.transactionId).toBe(recovery.id);
    expect((await d.ubuntuStore.readJournal(recovery.id))?.phase).toBe("restored");
    expect(await d.store.readReceipt(recovery.id, d.windowsHome, "restored")).toBeNull();
    expect(await d.store.readReceipt(recovery.id, d.windowsHome, "trial")).toBeNull();
    await expect(d.store.beginWork("other-runtime")).rejects.toThrow("holds new work");
  });

  it("refuses a confirmation that does not name every home with its exact cutoff, and changes nothing", async () => {
    const d = await device();
    const exact = await d.cutoffs();
    await expect(
      recoverCohort({
        ...d.context,
        transactionId: "tx-update",
        confirm: { [d.windowsHome]: exact[d.windowsHome]! },
      }),
    ).rejects.toThrow("every home");
    await expect(
      recoverCohort({
        ...d.context,
        transactionId: "tx-update",
        confirm: { ...exact, [d.wslId]: "2020-01-01T00:00:00.000Z" },
      }),
    ).rejects.toThrow("every home");
    await expect(
      recoverCohort({
        ...d.context,
        transactionId: "tx-update",
        confirm: { ...exact, extra: "x" },
      }),
    ).rejects.toThrow("every home");
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
    expect(await d.store.fenceSnapshot()).toBeNull();
  });

  it("blocks while any runtime still owns an affected home, a live trial owner included, even if the other home is clear", async () => {
    const d = await device();
    await d.store.register(
      {
        id: "desktop",
        label: "Desktop server",
        kind: "desktop",
        homes: [d.windowsHome],
        updateTarget: true,
      },
      NOW,
    );
    await expect(
      recoverCohort({ ...d.context, transactionId: "tx-update", confirm: await d.cutoffs() }),
    ).rejects.toThrow("Desktop server still owns");
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
    expect(await readSetting(d.ubuntuHome)).toBe("ubuntu after update");
    expect(await d.store.fenceSnapshot()).toBeNull();
  });

  it("blocks while a distribution's own runtime owns its home, so one stopped home never lets the cohort proceed", async () => {
    const d = await device();
    await d.ubuntuStore.register(
      {
        id: "ubuntu-server",
        label: "Ubuntu server",
        kind: "desktop",
        homes: [d.ubuntuHome],
        updateTarget: true,
      },
      NOW,
    );
    await expect(
      recoverCohort({ ...d.context, transactionId: "tx-update", confirm: await d.cutoffs() }),
    ).rejects.toThrow("Ubuntu server in Ubuntu still owns");
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
  });

  it("requires the whole device to be idle: any active participant blocks before any file is touched", async () => {
    const d = await device();
    await d.store.observe(
      "other-runtime",
      [{ participantId: "other-runtime", reason: "active-agents", label: "An agent is running" }],
      NOW,
    );
    await expect(
      recoverCohort({ ...d.context, transactionId: "tx-update", confirm: await d.cutoffs() }),
    ).rejects.toThrow("An agent is running");
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
    expect(await d.store.fenceSnapshot()).toBeNull();
  });

  it("blocks on processes a stopped runtime of the cohort left running, until they are gone", async () => {
    const d = await device();
    const { processCreationIdentity } = await import("./forkMaintenanceStore.ts");
    const survivor = (await processCreationIdentity(process.pid))!;
    const processes = new Map<number, string>([[7002, "boot:desktop"]]);
    const identity = async (pid: number) =>
      pid === 7002 ? (processes.get(7002) ?? null) : pid === process.pid ? survivor : null;
    const desktop = await CoordinatorStore.open(
      NodePath.join(d.root, "windows-registry"),
      identity,
      7002,
    );
    await desktop.register(
      {
        id: "desktop",
        label: "Desktop server",
        kind: "desktop",
        homes: [d.windowsHome],
        updateTarget: true,
      },
      0,
    );
    await desktop.observe("desktop", [], 0, [
      { pid: process.pid, started: survivor, label: "provider cli" },
    ]);
    // The desktop server exits, but the provider process it started keeps running.
    processes.delete(7002);
    const helperStore = await CoordinatorStore.open(
      NodePath.join(d.root, "windows-registry"),
      identity,
      process.pid,
    );
    await expect(
      recoverCohort({
        ...d.context,
        store: helperStore,
        transactionId: "tx-update",
        confirm: await d.cutoffs(),
      }),
    ).rejects.toThrow("processes it started are still running");
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
  });

  it("abandons safely, releasing admission, when a distribution cannot be fenced or checked", async () => {
    const d = await device({ unreachable: new Set(["Ubuntu"]) });
    await expect(
      recoverCohort({
        ...d.context,
        transactionId: "tx-update",
        confirm: { [d.windowsHome]: "x", [d.wslId]: "y" },
      }),
    ).rejects.toThrow();
    // The cutoffs cannot even be listed without the member; the whole option is withheld.
    expect(await listRecoveryOptions(d.context)).toEqual([]);
    expect(await d.store.fenceSnapshot()).toBeNull();
  });

  it("refuses a transaction whose distribution is not in the registered membership instead of guessing or skipping it", async () => {
    const d = await device();
    await expect(
      recoverCohort({
        ...d.context,
        members: [],
        transactionId: "tx-update",
        confirm: await d.cutoffs(),
      }),
    ).rejects.toThrow();
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
  });

  it("checks capacity on every home's own filesystem, with rescue copies, before replacing anything", async () => {
    const d = await device({ failCapacityIn: "Ubuntu" });
    await expect(
      recoverCohort({ ...d.context, transactionId: "tx-update", confirm: await d.cutoffs() }),
    ).rejects.toThrow("Not enough free space");
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
    expect(await d.store.fenceSnapshot()).toBeNull();
    expect(await d.ubuntuStore.fenceSnapshot()).toBeNull();
  });

  it("fails closed when a restore fails partway: the fence stays held in every registry and the journal says so", async () => {
    const d = await device({ failRestoreIn: "Ubuntu" });
    await expect(
      recoverCohort({ ...d.context, transactionId: "tx-update", confirm: await d.cutoffs() }),
    ).rejects.toThrow("Restoration failed");
    const recovery = (await d.store.listJournals()).find((journal) => journal.kind === "recovery")!;
    expect(recovery.phase).toBe("restore-failed");
    expect((await d.store.fenceSnapshot())?.transactionId).toBe(recovery.id);
    expect((await d.ubuntuStore.fenceSnapshot())?.transactionId).toBe(recovery.id);
    // Rescue copies exist for both homes, so no data is only in the replaced directories.
    expect(Object.keys(recovery.rescues)).toHaveLength(2);
  });

  it("finishes or reverses a held, abandoned transaction by taking over its fence, but never while its owner runs", async () => {
    const d = await device();
    // Re-open the same registry as a second process that "owns" a trial transaction, then let that process exit.
    const { processCreationIdentity } = await import("./forkMaintenanceStore.ts");
    const self = (await processCreationIdentity(process.pid))!;
    const processes = new Map<number, string>([
      [7001, "boot:owner"],
      [process.pid, self],
    ]);
    const identity = async (pid: number) => processes.get(pid) ?? null;
    const owner = await CoordinatorStore.open(
      NodePath.join(d.root, "windows-registry"),
      identity,
      7001,
    );
    await owner.freeze("tx-trial", NOW);
    const trial = {
      ...newJournal({
        id: "tx-trial",
        kind: "update",
        homes: [d.windowsHome, d.wslId],
        previous: { version: "1.0.0", artifactSha256: "a" },
        target: { version: "1.0.2", artifactSha256: "c" },
        now: 0,
        snapshots: (await d.store.readJournal("tx-update"))!.snapshots,
      }),
      phase: "restore-failed" as const,
      failure: "boom",
    };
    await owner.writeJournal(trial);
    const helperStore = await CoordinatorStore.open(
      NodePath.join(d.root, "windows-registry"),
      identity,
      process.pid,
    );
    const confirm = Object.fromEntries(
      (await listRecoveryOptions({ ...d.context, store: helperStore }))
        .find((option) => option.transactionId === "tx-trial")!
        .homes.map((home) => [home.id, home.createdAt]),
    );
    await expect(
      recoverCohort({ ...d.context, store: helperStore, transactionId: "tx-trial", confirm }),
    ).rejects.toThrow("still running");
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
    processes.delete(7001);
    await recoverCohort({ ...d.context, store: helperStore, transactionId: "tx-trial", confirm });
    expect(await readSetting(d.windowsHome)).toBe("windows original");
    expect((await helperStore.readJournal("tx-trial"))?.kind).toBe("recovery");
    expect((await helperStore.readJournal("tx-trial"))?.phase).toBe("restored");
  });

  it("prints the cached verified runtime outside the app, or says recovery is not bootstrapped", async () => {
    const d = await device();
    const cache = NodePath.join(d.root, "windows-registry", "recovery");
    const c = capture();
    expect(
      await main(
        [
          "print-runtime",
          "--coordinator",
          NodePath.join(d.root, "windows-registry"),
          "--cache",
          cache,
        ],
        c.io,
      ),
    ).toBe(1);
    expect(c.out.join("\n")).toContain("No verified recovery runtime is cached");
    const version = NodePath.join(cache, "1.0.1");
    await NodeFSP.mkdir(version, { recursive: true });
    const nodePath = NodePath.join(version, "t3-recovery-node-linux-x64");
    const helperPath = NodePath.join(version, "t3-recovery-helper-linux-x64.mjs");
    await NodeFSP.writeFile(nodePath, "node");
    await NodeFSP.chmod(nodePath, 0o700);
    await NodeFSP.writeFile(helperPath, "helper");
    const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
    await NodeFSP.writeFile(
      NodePath.join(cache, "current.json"),
      JSON.stringify({
        protocol: 1,
        version: "1.0.1",
        platform: "linux-x64",
        nodePath,
        helperPath,
        nodeSha256: digest("node"),
        helperSha256: digest("helper"),
        installedAt: 1,
      }),
    );
    const ok = capture();
    expect(
      await main(
        [
          "print-runtime",
          "--coordinator",
          NodePath.join(d.root, "windows-registry"),
          "--cache",
          cache,
        ],
        ok.io,
      ),
    ).toBe(0);
    expect(ok.out.join("\n")).toContain(`Cached runtime: ${nodePath}`);
    expect(ok.out.join("\n")).toContain(`"${nodePath}" "${helperPath}" "options"`);
  });

  it("routes handoff to the desktop handoff runner and fails closed without a readable plan", async () => {
    const c = capture();
    expect(await main(["handoff"], c.io)).toBe(2);
    expect(await main(["handoff", "--plan", "/definitely/not/a/plan.json"], c.io)).toBe(2);
  });

  it("exposes status and options as commands and rejects a recover without a bound confirmation", async () => {
    const d = await device();
    const coordinator = NodePath.join(d.root, "windows-registry");
    const c = capture();
    expect(await main(["status", "--coordinator", coordinator], c.io)).toBe(0);
    expect(JSON.parse(c.out.at(-1)!)).toMatchObject({ bootstrapped: true, fence: null });
    expect(
      await main(["recover", "--transaction", "tx-update", "--coordinator", coordinator], c.io),
    ).toBe(1);
    expect(c.err.at(-1)).toContain("--confirm");
    expect(await main(["wat"], c.io)).toBe(2);
  });
});

describe("external recovery of the desktop binary (recover --desktop-plan)", () => {
  const recover = async (d: Awaited<ReturnType<typeof device>>, transactionId = "tx-update") =>
    recoverCohort({
      ...d.context,
      transactionId,
      confirm: await d.cutoffs(),
      desktop: d.desktop!.input,
    });
  const revertFile = (d: Awaited<ReturnType<typeof device>>, journalId: string) =>
    NodePath.join(d.desktop!.handoffDir, `${journalId}-revert.json`);

  /** Nothing about the device changed: both homes keep the update's data, no fence, no recovery journal, nothing launched. */
  const expectUntouched = async (d: Awaited<ReturnType<typeof device>>) => {
    expect(await readSetting(d.windowsHome)).toBe("windows after update");
    expect(await readSetting(d.ubuntuHome)).toBe("ubuntu after update");
    expect(await d.store.fenceSnapshot()).toBeNull();
    expect(await d.ubuntuStore.fenceSnapshot()).toBeNull();
    expect((await d.store.listJournals()).some((journal) => journal.kind === "recovery")).toBe(
      false,
    );
    expect(d.desktop!.spawned).toEqual([]);
    expect(
      (await NodeFSP.readdir(d.desktop!.handoffDir)).filter((name) => name.includes("-revert")),
    ).toEqual([]);
  };

  it("restores every Windows and WSL home first, then authorizes, writes and launches exactly the revert of the retained install", async () => {
    const d = await device({}, { desktop: true });
    const lines = await recover(d);
    const recovery = (await d.store.listJournals()).find((journal) => journal.kind === "recovery")!;
    const { spawned, command } = d.desktop!;

    // Data first: when the binary handoff was launched every home was already restored from its restore point.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.settings).toEqual(["windows original", "ubuntu original"]);
    expect(Object.keys(recovery.rescues).sort()).toEqual([d.windowsHome, d.wslId].sort());
    // The detached helper is the cached verified pair, started with the exact private plan file.
    expect(spawned[0]).toMatchObject({
      command: command.nodePath,
      args: [command.helperPath, "handoff", "--plan", revertFile(d, recovery.id)],
    });
    expect(d.desktop!.commandReads).toEqual([d.desktop!.cacheDir, d.desktop!.cacheDir]);
    expect(lines.join(" ")).toContain("Restored all 2 home(s)");
    expect(lines.join(" ")).toContain("detached helper");

    // The journal records the exact revert payloads and this process as owner; the previous build identity is the source's.
    expect(recovery).toMatchObject({
      kind: "recovery",
      phase: "restored",
      previous: { version: "1.0.0", artifactSha256: "a" },
    });
    expect(recovery.desktopHandoffs?.revert).toEqual({
      owner: d.store.owner,
      artifactSha256: sha256Hex("previous build"),
      counterpartSha256: sha256Hex("target build"),
    });
    expect(recovery.desktopHandoffs?.install?.artifactSha256).toBe(sha256Hex("target build"));

    const file = revertFile(d, recovery.id);
    if (HOST_PLATFORM !== "win32") expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
    expect(decodeHandoffPlan(await NodeFSP.readFile(file, "utf8"))).toEqual({
      protocol: 1,
      mode: "revert",
      transactionId: recovery.id,
      coordinatorDirectory: d.desktop!.plan.coordinatorDirectory,
      owner: d.store.owner,
      packaging: "appimage",
      installer: d.desktop!.plan.previousInstaller,
      previousInstaller: d.desktop!.plan.installer,
      installTarget: d.desktop!.plan.installTarget,
      relaunch: d.desktop!.plan.relaunch,
      waitForExitMs: 60_000,
    });
    // Nothing was verified or released by this helper: the fence stays held until a healthy prior runtime does it.
    expect((await d.store.fenceSnapshot())?.transactionId).toBe(recovery.id);
    expect((await d.ubuntuStore.fenceSnapshot())?.transactionId).toBe(recovery.id);
    expect(await d.store.readReceipt(recovery.id, d.windowsHome, "restored")).toBeNull();
    expect(await readFileText(d.desktop!.plan.installTarget)).toBe("target build");
  });

  it("produces a plan and recorded authorization the real handoff runner accepts, once, after this process exits", async () => {
    const d = await device({}, { desktop: true });
    await recover(d);
    const recovery = (await d.store.listJournals()).find((journal) => journal.kind === "recovery")!;
    const file = revertFile(d, recovery.id);
    const started: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const io = (): HandoffIo => ({
      // The recovering process has exited: nothing else answers for any pid except the helper itself.
      identity: async (pid) => (pid === 800 ? "boot:helper" : null),
      now: () => 0,
      sleep: async () => undefined,
      run: async () => 0,
      startDetached: async (command, args) => void started.push({ command, args }),
      log: () => undefined,
      platform: HOST_PLATFORM,
      uid: process.getuid?.() ?? null,
      openCoordinator: (directory) =>
        CoordinatorStore.open(directory, async (pid) => (pid === 800 ? "boot:helper" : null), 800),
    });
    expect(await runDesktopHandoff(file, io())).toBe(HANDOFF_EXIT.ok);
    expect(await readFileText(d.desktop!.plan.installTarget)).toBe("previous build");
    expect(started).toEqual([
      { command: d.desktop!.plan.relaunch.command, args: d.desktop!.plan.relaunch.args },
    ]);
    const fence = await d.store.fenceSnapshot();
    expect(fence).toMatchObject({ transactionId: recovery.id, consumedHandoffs: ["revert"] });
    expect(fence?.handoffOwner).toBeUndefined();
    // One use: the consumed plan cannot be replayed.
    expect(await runDesktopHandoff(file, io())).toBe(HANDOFF_EXIT.badPlan);
  });

  it("changes nothing when the plan is not exactly the recorded install of this transaction", async () => {
    type Case = readonly [string, (d: Awaited<ReturnType<typeof device>>) => Promise<void>, string];
    const open: ReadonlyArray<Case> =
      HOST_PLATFORM === "win32"
        ? []
        : [
            [
              "a plan open to other users",
              (d) => d.desktop!.writePlan(d.desktop!.plan, d.desktop!.planFile, 0o644),
              "no group or world access",
            ],
          ];
    const cases: ReadonlyArray<Case> = [
      ["a revert plan", (d) => d.desktop!.writePlan({ mode: "revert" }), "not an install plan"],
      [
        "another transaction's plan",
        (d) => d.desktop!.writePlan({ transactionId: "tx-other" }),
        "belongs to transaction tx-other",
      ],
      [
        "another coordinator's plan",
        (d) => d.desktop!.writePlan({ coordinatorDirectory: NodePath.join(d.root, "elsewhere") }),
        "different coordinator",
      ],
      [
        "a plan without a previous installer",
        (d) => d.desktop!.writePlan({ previousInstaller: null }),
        "no previous installer",
      ],
      [
        "a different owner than the recorded handoff",
        (d) => d.desktop!.writePlan({ owner: { pid: 4243, started: "boot:4243" } }),
        "does not match the install handoff",
      ],
      [
        "a different target installer digest",
        (d) =>
          d.desktop!.writePlan({
            installer: { ...d.desktop!.plan.installer, sha256: sha256Hex("other target") },
          }),
        "does not match the install handoff",
      ],
      [
        "a different previous installer digest (counterpart)",
        (d) =>
          d.desktop!.writePlan({
            previousInstaller: {
              ...d.desktop!.plan.previousInstaller!,
              sha256: sha256Hex("other previous"),
            },
          }),
        "does not match the install handoff",
      ],
      [
        "a malformed digest",
        (d) =>
          d.desktop!.writePlan({
            previousInstaller: { ...d.desktop!.plan.previousInstaller!, sha256: "legacy" },
          }),
        "SHA-256",
      ],
      ...open,
      [
        "a plan that is not a plan",
        async (d) => void (await NodeFSP.writeFile(d.desktop!.planFile, "{}", { mode: 0o600 })),
        "was refused",
      ],
    ];
    for (const [name, mutate, message] of cases) {
      const d = await device({}, { desktop: true });
      await mutate(d);
      await expect(recover(d), name).rejects.toThrow(message);
      await expectUntouched(d);
    }
  });

  it("changes nothing when the journal never recorded the handoff, or recorded different payloads", async () => {
    const missing = await device({}, { desktop: true });
    const { desktopHandoffs: _dropped, ...withoutAuthorization } =
      (await missing.store.readJournal("tx-update"))!;
    await missing.store.writeJournal(withoutAuthorization);
    await expect(recover(missing)).rejects.toThrow("no recorded install handoff");
    await expectUntouched(missing);

    const different = await device({}, { desktop: true });
    const journal = (await different.store.readJournal("tx-update"))!;
    await different.store.writeJournal({
      ...journal,
      desktopHandoffs: {
        install: {
          ...journal.desktopHandoffs!.install!,
          counterpartSha256: sha256Hex("guessed from the build identity"),
        },
      },
    });
    await expect(recover(different)).rejects.toThrow("does not match the install handoff");
    await expectUntouched(different);

    const retargeted = await device({}, { desktop: true });
    const target = (await retargeted.store.readJournal("tx-update"))!;
    await retargeted.store.writeJournal({
      ...target,
      target: { version: "1.0.1", artifactSha256: sha256Hex("another target") },
    });
    await expect(recover(retargeted)).rejects.toThrow("does not match the install handoff");
    await expectUntouched(retargeted);
  });

  it("verifies every cached payload and the cached helper pair before any data is restored", async () => {
    const previous = await device({}, { desktop: true });
    await NodeFSP.writeFile(
      previous.desktop!.plan.previousInstaller!.path,
      "tampered previous build",
    );
    await expect(recover(previous)).rejects.toThrow(
      "previous.AppImage does not match its recorded digest",
    );
    await expectUntouched(previous);

    const target = await device({}, { desktop: true });
    await NodeFSP.rm(target.desktop!.plan.installer.path);
    await expect(recover(target)).rejects.toThrow(
      "target.AppImage does not match its recorded digest",
    );
    await expectUntouched(target);

    const pair = await device({}, { desktop: true });
    const failing = {
      ...pair.desktop!.ports,
      readCommand: async () => {
        throw new Error("The cached recovery helper does not match its recorded digests.");
      },
    };
    await expect(
      recoverCohort({
        ...pair.context,
        transactionId: "tx-update",
        confirm: await pair.cutoffs(),
        desktop: { planFile: pair.desktop!.planFile, ports: failing },
      }),
    ).rejects.toThrow("cached recovery helper and Node runtime could not be verified");
    await expectUntouched(pair);
  });

  it("never touches the binary while any registered agent is active, and still requires the idle window", async () => {
    const d = await device({}, { desktop: true });
    await d.store.observe(
      "other-runtime",
      [{ participantId: "other-runtime", reason: "active-agents", label: "An agent is running" }],
      NOW,
    );
    await expect(recover(d)).rejects.toThrow("An agent is running");
    await expectUntouched(d);
  });

  it("resumes a held, abandoned transaction under its own id and keeps the recorded authorization for a retry", async () => {
    const d = await device({}, { desktop: true });
    // A held transaction whose owner has exited, journaled with the controller's recorded install handoff.
    const { processCreationIdentity } = await import("./forkMaintenanceStore.ts");
    const self = (await processCreationIdentity(process.pid))!;
    const processes = new Map<number, string>([
      [7001, "boot:owner"],
      [process.pid, self],
    ]);
    const identity = async (pid: number) => processes.get(pid) ?? null;
    const owner = await CoordinatorStore.open(
      NodePath.join(d.root, "windows-registry"),
      identity,
      7001,
    );
    await owner.freeze("tx-update-2", NOW);
    const source = (await d.store.readJournal("tx-update"))!;
    await owner.writeJournal({
      ...source,
      id: "tx-update-2",
      phase: "restore-failed",
      failure: "boom",
    });
    processes.delete(7001);
    const helperStore = await CoordinatorStore.open(
      NodePath.join(d.root, "windows-registry"),
      identity,
      process.pid,
    );
    await d.desktop!.writePlan({ transactionId: "tx-update-2" });
    const confirm = Object.fromEntries(
      (await listRecoveryOptions({ ...d.context, store: helperStore }))
        .find((option) => option.transactionId === "tx-update-2")!
        .homes.map((home) => [home.id, home.createdAt]),
    );
    // The same transaction can be resumed by a plan that names it, and the data restore happens before the launch.
    await recoverCohort({
      ...d.context,
      store: helperStore,
      transactionId: "tx-update-2",
      confirm,
      desktop: d.desktop!.input,
    });
    expect(d.desktop!.spawned[0]!.settings).toEqual(["windows original", "ubuntu original"]);
    const resumed = (await helperStore.readJournal("tx-update-2"))!;
    expect(resumed).toMatchObject({ kind: "recovery", phase: "restored" });
    // The authorization the controller recorded survives, so a retry can be matched to its plan again.
    expect(resumed.desktopHandoffs?.install?.artifactSha256).toBe(sha256Hex("target build"));
    expect(resumed.desktopHandoffs?.revert?.artifactSha256).toBe(sha256Hex("previous build"));
    expect((await helperStore.fenceSnapshot())?.transactionId).toBe("tx-update-2");
  });

  it("fails closed after restoring when the launch fails, keeping the fence and printing the exact command to run", async () => {
    const d = await device({}, { desktop: true });
    const failing = {
      ...d.desktop!.ports,
      spawn: async () => {
        throw new Error("spawn EACCES");
      },
    };
    await expect(
      recoverCohort({
        ...d.context,
        transactionId: "tx-update",
        confirm: await d.cutoffs(),
        desktop: { planFile: d.desktop!.planFile, ports: failing },
      }),
    ).rejects.toThrow(
      new RegExp(
        `revert is authorized.*spawn EACCES.*Admission stays fenced.*"${d.desktop!.command.nodePath.replaceAll("\\", "\\\\")}" "${d.desktop!.command.helperPath.replaceAll("\\", "\\\\")}" "handoff" "--plan"`,
      ),
    );
    const recovery = (await d.store.listJournals()).find((journal) => journal.kind === "recovery")!;
    expect(recovery.phase).toBe("restored");
    expect(await readSetting(d.windowsHome)).toBe("windows original");
    expect((await d.store.fenceSnapshot())?.transactionId).toBe(recovery.id);
    expect(recovery.desktopHandoffs?.revert).toBeDefined();
    expect(await NodeFSP.stat(revertFile(d, recovery.id))).toBeDefined();
  });

  it("leaves data-only recovery untouched without --desktop-plan, and the command validates its flag", async () => {
    const d = await device({}, { desktop: true });
    await recoverCohort({ ...d.context, transactionId: "tx-update", confirm: await d.cutoffs() });
    expect(d.desktop!.spawned).toEqual([]);
    expect(await readFileText(d.desktop!.plan.installTarget)).toBe("target build");

    const other = await device({}, { desktop: true });
    const coordinator = NodePath.join(other.root, "windows-registry");
    const confirmations = Object.entries(await other.cutoffs()).flatMap(([home, created]) => [
      "--confirm",
      `${home}=${created}`,
    ]);
    const c = capture();
    expect(
      await main(
        [
          "recover",
          "--transaction",
          "tx-update",
          ...confirmations,
          "--coordinator",
          coordinator,
          "--desktop-plan",
        ],
        c.io,
      ),
    ).toBe(1);
    expect(c.err.at(-1)).toContain("--desktop-plan needs the path");
    expect(
      await main(
        [
          "recover",
          "--transaction",
          "tx-update",
          ...confirmations,
          "--coordinator",
          coordinator,
          "--desktop-plan",
          NodePath.join(other.root, "missing-plan.json"),
        ],
        c.io,
      ),
    ).toBe(1);
    expect(c.err.at(-1)).toContain("Nothing was changed");
    await expectUntouched(other);
  });
});

const readFileText = (file: string) => NodeFSP.readFile(file, "utf8");

/* oxlint-disable t3code/no-global-process-runtime -- native release fixtures use the current host runtime and packaging */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off — the controller is exercised against a real registry, journals and restore points.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type { ForkReleaseManifest } from "@t3tools/contracts";
import { forkAssetUrl, type ForkReleaseRecord } from "@t3tools/shared/forkMaintenance";
import {
  parseFenceOperation,
  runFenceOperation,
} from "@t3tools/shared/forkMaintenanceFenceOperations";
import {
  parseHomeOperation,
  runHomeOperation,
} from "@t3tools/shared/forkMaintenanceHomeOperations";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import { CURRENT_ACTIVITY_PROTOCOL } from "@t3tools/shared/forkMaintenanceAdmission";

import { readVerifiedArtifact } from "./artifactCache.ts";
import { HandoffPlan } from "./handoff.ts";
import {
  createDesktopMaintenance,
  MAINTENANCE_TRIAL_ENV,
  type DesktopMaintenance,
  type DesktopMaintenanceInput,
} from "./maintenanceCore.ts";
import { maintenancePaths } from "./paths.ts";
import * as Schema from "effect/Schema";

const sha = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const commit = (seed: string) => seed.repeat(40).slice(0, 40);
const MINUTE = 60_000;
const HANDOFF_NEVER_MS = 120_000;
const decodePlan = Schema.decodeUnknownSync(Schema.fromJsonString(HandoffPlan));

// Windows needs an actual PE executable. POSIX uses a tiny executable fixture to keep this controller suite light;
// the independent helper suite proves restoration with the real cached runtime on both platforms.
const WINDOWS = process.platform === "win32";
const PLATFORM = WINDOWS ? "windows-x64" : "linux-x64";
const NODE_BYTES = WINDOWS
  ? await NodeFSP.readFile(process.execPath)
  : Buffer.from("#!/bin/sh\necho recovery-helper-protocol=1\n");
const HELPER_BYTES = Buffer.from('console.log("recovery-helper-protocol=1");\n');
const installerName = (version: string) =>
  WINDOWS ? `T3-Code-${version}-x64.exe` : `T3-Code-${version}-x86_64.AppImage`;
const INSTALL_TARGET = WINDOWS ? "C:\\Apps\\T3 Code\\T3 Code.exe" : "/Apps/T3-Code.AppImage";

interface Payload {
  readonly name: string;
  readonly bytes: Buffer;
  readonly kind: "desktop" | "recovery-helper";
}

function releaseOf(
  version: string,
  id: number,
  installer: Buffer,
): { record: ForkReleaseRecord; payloads: ReadonlyArray<Payload> } {
  const channel = version.includes("nightly") ? "nightly" : "stable";
  const sourceCommit = commit(String(id));
  const payloads: Payload[] = [
    { name: installerName(version), bytes: installer, kind: "desktop" },
    {
      name: `t3-recovery-helper-${PLATFORM}.mjs`,
      bytes: HELPER_BYTES,
      kind: "recovery-helper",
    },
    {
      name: `t3-recovery-node-${PLATFORM}${WINDOWS ? ".exe" : ""}`,
      bytes: NODE_BYTES,
      kind: "recovery-helper",
    },
  ];
  const assets: ForkReleaseManifest["assets"] = [
    ...payloads.map((payload): ForkReleaseManifest["assets"][number] => ({
      name: payload.name,
      sha256: sha(payload.bytes),
      bytes: payload.bytes.length,
      kind: payload.kind,
      platform: PLATFORM,
    })),
    {
      name: `t3-${version}.apk`,
      sha256: sha("apk"),
      bytes: 10,
      kind: "android" as const,
      platform: "android" as const,
    },
    {
      name: `t3-${version}-recovery.apk`,
      sha256: sha("apk-r"),
      bytes: 10,
      kind: "android-recovery" as const,
      platform: "android" as const,
    },
  ];
  const manifest: ForkReleaseManifest = {
    format: 1,
    repository: "unn-corp/t3code",
    version,
    commit: sourceCommit,
    channel,
    releasedAt: "2026-10-05T07:23:00Z",
    assets,
    android: {
      normal: {
        asset: assets[3]!.name,
        versionCode: 10,
        sourceVersion: version,
        sourceCommit,
        packageName: "com.devotek.t3code.pwa",
        signerSha256: sha("signer"),
        updaterProtocol: 1,
      },
      recovery: {
        asset: assets[4]!.name,
        versionCode: 11,
        sourceVersion: "1.0.0",
        sourceCommit: commit("0"),
        packageName: "com.devotek.t3code.pwa",
        signerSha256: sha("signer"),
        updaterProtocol: 1,
      },
    },
    checks: { build: true, install: true, update: true, recovery: true },
  };
  return {
    payloads,
    record: {
      id,
      tagName: `fork-v${version}`,
      draft: false,
      body: "",
      createdAt: "2026-10-05T07:30:00Z",
      publishedAt: "2026-10-05T07:30:00Z",
      assets: [
        ...assets.map((asset) => ({ name: asset.name, size: asset.bytes })),
        { name: "fork-release.json", size: 5 },
      ],
      manifest,
    },
  };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        NodeFSP.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
      ),
  );
});

const OLD = releaseOf("1.0.0", 1, Buffer.from("installer-1.0.0"));
const NEW = releaseOf("1.1.0", 2, Buffer.from("installer-1.1.0"));
const OLD_DIGEST = OLD.record.manifest!.assets.find((asset) => asset.kind === "desktop")!.sha256;
const NEW_DIGEST = NEW.record.manifest!.assets.find((asset) => asset.kind === "desktop")!.sha256;

async function makeDevice() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-maintenance-"));
  directories.push(root);
  const coordinator = NodePath.join(root, "coordinator");
  const homeDir = NodePath.join(root, "windows-home");
  await NodeFSP.mkdir(NodePath.join(homeDir, "userdata"), { recursive: true });
  const home = await NodeFSP.realpath(homeDir);
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
  database.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('before the update')",
  );
  database.close();

  const table = new Map<number, string>();
  const identity = async (pid: number) => table.get(pid) ?? null;
  const clock = { value: 10_000_000 };
  const live: Array<{
    store: CoordinatorStore;
    id: string;
    blockers: Array<{ participantId: string; reason: "active-agents"; label: string }>;
  }> = [];
  const cores: DesktopMaintenance[] = [];
  const handoffs: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const handoffSeen: Array<() => void> = [];

  const observeAll = async () => {
    for (const runtime of live)
      if (table.has(runtime.store.owner.pid))
        await runtime.store
          .observe(runtime.id, runtime.blockers, clock.value)
          .catch(() => undefined);
    for (const core of cores) await core.observe().catch(() => undefined);
  };
  const sleep = async (ms: number) => {
    // The process that handed off is exiting: it never resumes. Reaching this wait is its last step, so whoever waits for
    // the handoff learns that nothing else of that process is still running.
    if (ms >= HANDOFF_NEVER_MS) {
      for (const notify of handoffSeen.splice(0)) notify();
      return new Promise<never>(() => undefined);
    }
    clock.value += ms;
    await observeAll();
  };
  const startProcess = (pid: number) => {
    table.set(pid, `boot:${pid}:${table.size}`);
  };
  const processCores = new Map<number, DesktopMaintenance>();
  /** A process that handed off drained its registry operations before quitting, so ending it here is a plain exit. */
  const killProcess = (pid: number) => {
    table.delete(pid);
    // A dead process observes nothing and holds nothing: stop driving its loops from the test.
    const core = processCores.get(pid);
    if (core !== undefined) cores.splice(cores.indexOf(core), 1);
    for (let index = live.length - 1; index >= 0; index -= 1)
      if (live[index]!.store.owner.pid === pid) live.splice(index, 1);
  };
  const server = async (
    pid: number,
    id: string,
    options: {
      trial?: { transactionId: string; home: string; nonce: string };
      /** A runtime of another installation on this device: its kind and its own data home. */
      kind?: "desktop" | "service";
      home?: string;
    } = {},
  ) => {
    startProcess(pid);
    const store = await CoordinatorStore.open(coordinator, identity, pid);
    await store.register(
      {
        id,
        label: id,
        kind: options.kind ?? "desktop",
        homes: [options.home ?? home],
        updateTarget: true,
      },
      clock.value,
      options.trial === undefined ? {} : { trial: options.trial },
    );
    const runtime = {
      store,
      id,
      blockers: [] as Array<{ participantId: string; reason: "active-agents"; label: string }>,
    };
    live.push(runtime);
    await store.observe(id, [], clock.value);
    return runtime;
  };
  /** The data home of another installation, with a database of its own. */
  const otherHome = async (name: string) => {
    const directory = NodePath.join(root, name);
    await NodeFSP.mkdir(NodePath.join(directory, "userdata"), { recursive: true });
    const database = new NodeSqlite.DatabaseSync(
      NodePath.join(directory, "userdata", "statev2.sqlite"),
    );
    database.exec(
      `PRAGMA journal_mode = WAL; CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('${name} before the update')`,
    );
    database.close();
    return NodeFSP.realpath(directory);
  };
  const feedFor = (records: ReadonlyArray<ForkReleaseRecord>) => async () => records;
  const payloads = new Map<string, Buffer>(
    [...OLD.payloads, ...NEW.payloads].map((payload) => [payload.name, payload.bytes]),
  );
  const urls = new Map<string, string>();
  for (const release of [OLD, NEW])
    for (const payload of release.payloads)
      urls.set(forkAssetUrl(release.record.tagName, payload.name), payload.name);
  const tamper = new Set<string>();
  const fetchFake: DesktopMaintenanceInput["fetch"] = async (url) => {
    const name = urls.get(url);
    if (name === undefined) return { ok: false, status: 404, body: null };
    const bytes = tamper.has(name) ? Buffer.from("tampered bytes!!") : payloads.get(name)!;
    return { ok: true, status: 200, body: new Response(new Uint8Array(bytes)).body };
  };

  const makeCore = (options: {
    pid: number;
    version: string;
    commit: string;
    overrides?: Partial<DesktopMaintenanceInput>;
  }) => {
    startProcess(options.pid);
    const core = createDesktopMaintenance({
      namespace: coordinator,
      baseDir: home,
      version: options.version,
      commit: options.commit,
      platform: PLATFORM,
      packaging: WINDOWS ? "nsis" : "appimage",
      installTarget: INSTALL_TARGET,
      disabledReason: null,
      authorizationRequired: () => null,
      feed: feedFor([OLD.record, NEW.record]),
      fetch: fetchFake,
      runtime: {
        stopRuntimes: async () => undefined,
        startRuntimes: async () => undefined,
        quit: async () => undefined,
        self: async () => ({ pid: options.pid, started: table.get(options.pid)! }),
      },
      managedWsl: async () => [],
      descendants: async () => [],
      hasWindow: () => false,
      now: () => clock.value,
      sleep,
      identity,
      selfPid: options.pid,
      spawn: async (command, args) => {
        handoffs.push({ command, args });
      },
      trialTimeoutMs: 3000,
      restoredTimeoutMs: 3000,
      freeBytes: async () => 1e12,
      userHasExistingData: async () => false,
      ...options.overrides,
    });
    cores.push(core);
    processCores.set(options.pid, core);
    return core;
  };
  /** Resolves once a process has launched the helper and reached its final wait for its own exit. */
  const nextHandoff = () => new Promise<void>((resolve) => void handoffSeen.push(resolve));
  /** Starts an install and resolves when the helper was launched; a refusal fails the test with the reason instead of timing out. */
  const installUntilHandoff = async (core: DesktopMaintenance, digest: string) => {
    const launched = nextHandoff();
    const refused = core.install(digest).then(
      () => new Promise<never>(() => undefined),
      (error: { reason?: string }) => {
        throw new Error(`install refused: ${error.reason ?? String(error)}`);
      },
    );
    await Promise.race([launched, refused]);
  };
  /** Five quiet minutes: every participant observed idle long enough, then freshly observed. */
  const quiesce = async () => {
    await observeAll();
    clock.value += 6 * MINUTE;
    await observeAll();
  };
  return {
    installUntilHandoff,
    root,
    coordinator,
    home,
    table,
    identity,
    clock,
    server,
    makeCore,
    quiesce,
    observeAll,
    handoffs,
    nextHandoff,
    /** The transaction of the plan the latest handoff wrote. */
    handoffTransactionId: () => {
      const name = NodePath.basename(handoffs.at(-1)!.args[3]!);
      return name.slice(0, name.lastIndexOf("-"));
    },
    otherHome,
    killProcess,
    startProcess,
    tamper,
    paths: maintenancePaths(home),
    live,
  };
}

const rowsOf = (home: string) => {
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare("SELECT text FROM notes ORDER BY rowid")
      .all()
      .map((row) => String(row.text));
  } finally {
    database.close();
  }
};

describe("DesktopForkMaintenance", () => {
  it("starts a fresh stable installation on stable and an existing device on nightly, and persists the choice", async () => {
    const fresh = await makeDevice();
    await fresh.server(9001, "desktop-server");
    const stable = fresh.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
    await stable.start();
    expect((await stable.status()).policy).toEqual({
      channel: "stable",
      automaticInstallation: false,
      pinnedBuild: null,
    });
    expect((await stable.status()).affectedHomes).toEqual([
      { id: fresh.home, label: WINDOWS ? "Windows" : "Linux" },
    ]);
    // A later launch keeps the stored choice even though the database now exists.
    await NodeFSP.mkdir(NodePath.join(fresh.home, "userdata"), { recursive: true });
    const again = fresh.makeCore({
      pid: 101,
      version: "1.0.0",
      commit: commit("1"),
      overrides: { userHasExistingData: async () => true },
    });
    await again.start();
    expect((await again.status()).policy.channel).toBe("stable");

    const existing = await makeDevice();
    const nightly = existing.makeCore({
      pid: 100,
      version: "1.0.0",
      commit: commit("1"),
      overrides: { userHasExistingData: async () => true },
    });
    await nightly.start();
    expect((await nightly.status()).policy.channel).toBe("nightly");
  });

  it("refuses every installation until the known runtimes are confirmed, and never installs automatically before then", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
    await core.start();
    await core.check();
    await device.quiesce();
    const status = await core.status();
    expect(status.installable).toBe(false);
    expect(status.blockers.map((blocker) => blocker.reason)).toContain("bootstrap");
    await expect(core.install(NEW_DIGEST)).rejects.toMatchObject({
      reason: expect.stringContaining("bootstrap"),
    });
    expect(device.handoffs).toEqual([]);
  });

  it("stages the verified installer, the helper and its runtime, and the installer of the running version", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
    await core.start();
    const status = await core.check();
    // Staged but not yet installable: the runtimes are not confirmed, so the device says it is waiting.
    expect(["staged", "waiting"]).toContain(status.phase);
    expect(status.targetBuild?.artifactSha256).toBe(NEW_DIGEST);
    expect(await readVerifiedArtifact(device.paths.artifacts, NEW_DIGEST)).not.toBeNull();
    // The running build's own installer is what reverses a failed update.
    const oldDigest = OLD.record.manifest!.assets.find((asset) => asset.kind === "desktop")!.sha256;
    expect(await readVerifiedArtifact(device.paths.artifacts, oldDigest)).not.toBeNull();
    const cached = JSON.parse(
      await NodeFSP.readFile(NodePath.join(device.paths.recovery, "current.json"), "utf8"),
    ) as { nodePath: string; helperPath: string };
    expect(NodePath.dirname(cached.nodePath)).toBe(NodePath.dirname(cached.helperPath));
    expect(cached.nodePath.startsWith(device.paths.recovery)).toBe(true);
    // oxlint-disable-next-line t3code/no-global-process-runtime -- These tests assert POSIX file modes, which Windows does not report.
    if (process.platform !== "win32")
      expect((await NodeFSP.stat(cached.nodePath)).mode & 0o777).toBe(0o700);
  });

  it("stages nothing when a payload does not match the digest the release records", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    device.tamper.add(installerName("1.1.0"));
    const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
    await core.start();
    const status = await core.check();
    expect(status.phase).toBe("available");
    expect(status.lastError).toContain("Download failed");
    expect(status.installable).toBe(false);
    expect(await readVerifiedArtifact(device.paths.artifacts, NEW_DIGEST)).toBeNull();
    expect(
      (await NodeFSP.readdir(device.paths.artifacts)).filter((name) => name.startsWith(".staging")),
    ).toEqual([]);
  });

  it("blocks installation while an agent is active and never stops it to admit the update", async () => {
    const device = await makeDevice();
    const runtime = await device.server(9001, "desktop-server");
    const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
    await core.start();
    await core.check();
    await core.runAction({ action: "confirm-bootstrap" });
    await device.quiesce();
    runtime.blockers.push({
      participantId: "desktop-server",
      reason: "active-agents",
      label: "An agent is running.",
    });
    await device.observeAll();
    const status = await core.status();
    expect(status.installable).toBe(false);
    expect(status.blockers.map((blocker) => blocker.reason)).toContain("active-agents");
    await expect(core.install(NEW_DIGEST)).rejects.toMatchObject({
      reason: expect.stringContaining("blocked"),
    });
    expect(device.handoffs).toEqual([]);
    expect(
      await CoordinatorStore.open(device.coordinator, device.identity, 100).then((store) =>
        store.listJournals(),
      ),
    ).toEqual([]);
  });

  it("installs through the external helper, commits only after the trial's health receipt, and records the new build", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
    await core.start();
    await core.check();
    await core.runAction({ action: "confirm-bootstrap" });
    await device.quiesce();

    await device.installUntilHandoff(core, NEW_DIGEST);

    // The old process only waits to exit; the helper is the cached runtime on the cached helper, not Electron or a system Node.
    const invocation = device.handoffs[0]!;
    expect(invocation.command.startsWith(device.paths.recovery)).toBe(true);
    expect(invocation.args[1]).toBe("handoff");
    const plan = decodePlan(await NodeFSP.readFile(invocation.args[3]!, "utf8"));
    expect(plan.mode).toBe("install");
    expect(plan.owner.pid).toBe(100);
    expect(plan.installer.sha256).toBe(NEW_DIGEST);
    expect(plan.previousInstaller?.sha256).toBe(
      OLD.record.manifest!.assets.find((asset) => asset.kind === "desktop")!.sha256,
    );
    expect(plan.installTarget).toBe(INSTALL_TARGET);
    // oxlint-disable-next-line t3code/no-global-process-runtime -- These tests assert POSIX file modes, which Windows does not report.
    if (process.platform !== "win32")
      expect((await NodeFSP.stat(invocation.args[3]!)).mode & 0o777).toBe(0o600);
    const store = await CoordinatorStore.open(device.coordinator, device.identity, 100);
    const [journal] = await store.listJournals();
    expect(journal?.phase).toBe("trial");
    expect(journal?.snapshots[device.home]).toBeDefined();
    // The helper may only claim what this process authorized: its identity (the plan's owner) and the exact payloads.
    expect(journal?.desktopHandoffs).toEqual({
      install: { owner: plan.owner, artifactSha256: NEW_DIGEST, counterpartSha256: OLD_DIGEST },
    });
    // Admission is still held while no process owns the transaction.
    device.killProcess(100);
    device.killProcess(9001);
    expect((await store.status(device.clock.value)).fence?.holderAlive).toBe(false);

    // The new build starts as the trial runtime.
    const next = device.makeCore({
      pid: 101,
      version: "1.1.0",
      commit: NEW.record.manifest!.commit,
    });
    expect(await next.start()).toEqual({ kind: "trial", transactionId: journal!.id });
    const capability = JSON.parse(
      (await next.trialEnv({ kind: "windows" }))[MAINTENANCE_TRIAL_ENV]!,
    ) as { transactionId: string; home: string; nonce: string };
    const trial = await device.server(9002, "desktop-server-new", { trial: capability });
    // The database migrates during the trial: that is the data a failed trial must not keep.
    const migrated = new NodeSqlite.DatabaseSync(
      NodePath.join(device.home, "userdata", "statev2.sqlite"),
    );
    migrated.exec("INSERT INTO notes VALUES ('written by the trial')");
    migrated.close();
    await trial.store.writeReceipt(
      capability.transactionId,
      "desktop-server-new",
      device.home,
      "healthy:1.1.0",
    );

    const status = await next.resumeInterrupted();
    expect(status.phase).toBe("completed");
    expect((await store.status(device.clock.value)).fence).toBeNull();
    expect((await store.readJournal(journal!.id))?.phase).toBe("committed");
    expect(status.currentBuild.artifactSha256).toBe(NEW_DIGEST);
    expect(rowsOf(device.home)).toEqual(["before the update", "written by the trial"]);
    // The restore point is retained for recovery.
    expect((await next.status()).recoveryOptions[0]?.build.version).toBe("1.0.0");
  });

  it("restores every home and puts the previous build back when the trial never becomes healthy", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
    await core.start();
    await core.check();
    await core.runAction({ action: "confirm-bootstrap" });
    await device.quiesce();
    await device.installUntilHandoff(core, NEW_DIGEST);
    device.killProcess(100);
    device.killProcess(9001);

    const trialCore = device.makeCore({
      pid: 101,
      version: "1.1.0",
      commit: NEW.record.manifest!.commit,
    });
    await trialCore.start();
    const migrated = new NodeSqlite.DatabaseSync(
      NodePath.join(device.home, "userdata", "statev2.sqlite"),
    );
    migrated.exec("INSERT INTO notes VALUES ('written by the failing trial')");
    migrated.close();
    // No health receipt ever arrives, so the trial fails; the target build still runs, so the previous installer goes back.
    const second = device.nextHandoff();
    // Resuming a transaction that is handing the device back never returns here: the process is exiting.
    const resumed = trialCore.resumeInterrupted().then(
      (status) => {
        throw new Error(`resume returned ${status.phase}: ${status.lastError}`);
      },
      (error: { reason?: string }) => {
        throw new Error(`resume failed: ${error.reason ?? String(error)}`);
      },
    );
    await Promise.race([second, resumed]);
    const revert = decodePlan(await NodeFSP.readFile(device.handoffs[1]!.args[3]!, "utf8"));
    expect(revert.mode).toBe("revert");
    expect(revert.installer.sha256).toBe(
      OLD.record.manifest!.assets.find((asset) => asset.kind === "desktop")!.sha256,
    );
    // The revert is authorized by the process that issued it (not the original holder), for the previous build's payload.
    const [authorized] = await CoordinatorStore.open(device.coordinator, device.identity, 101).then(
      (opened) => opened.listJournals(),
    );
    expect(authorized?.phase).toBe("restored");
    expect(authorized?.desktopHandoffs?.revert).toEqual({
      owner: revert.owner,
      artifactSha256: OLD_DIGEST,
      counterpartSha256: NEW_DIGEST,
    });
    expect(authorized?.desktopHandoffs?.install?.owner.pid).toBe(100);
    // The older database is back before any previous runtime starts.
    expect(rowsOf(device.home)).toEqual(["before the update"]);
    device.killProcess(101);

    device.startProcess(102);
    const store = await CoordinatorStore.open(device.coordinator, device.identity, 102);
    const previous = device.makeCore({
      pid: 102,
      version: "1.0.0",
      commit: commit("1"),
      overrides: {
        runtime: {
          stopRuntimes: async () => undefined,
          // The previous build's backend starts under the one-use capability and records its "restored" receipt.
          startRuntimes: async () => {
            const [journal] = await store.listJournals();
            const capability = JSON.parse(
              (await previous.trialEnv({ kind: "windows" }))[MAINTENANCE_TRIAL_ENV]!,
            ) as { transactionId: string; home: string; nonce: string };
            const restored = await device.server(9003, "desktop-server-restored", {
              trial: capability,
            });
            await restored.store.writeReceipt(
              journal!.id,
              "desktop-server-restored",
              device.home,
              "healthy:1.0.0",
              "restored",
            );
          },
          quit: async () => undefined,
          self: async () => ({ pid: 102, started: device.table.get(102)! }),
        },
      },
    });
    // The transaction is finished inside start: a launch that returns idle has a released fence and verified restored runtimes.
    expect((await previous.start()).kind).toBe("idle");
    const status = await previous.status();
    expect(status.phase).toBe("failed");
    expect(status.automationReviewRequired).toBe(true);
    expect((await store.status(device.clock.value)).fence).toBeNull();
    expect((await store.readJournal((await store.listJournals())[0]!.id))?.phase).toBe(
      "restore-verified",
    );
    // The failed build is never retried automatically.
    expect((await previous.check()).targetBuild).toBeNull();
    expect(rowsOf(device.home)).toEqual(["before the update"]);
  });

  it("blocks installation when a managed WSL data home cannot be determined", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const core = device.makeCore({
      pid: 100,
      version: "1.0.0",
      commit: commit("1"),
      overrides: {
        managedWsl: async () => [{ distro: "Ubuntu", command: null }],
        resolveWslHome: async () => null,
      },
    });
    await core.start();
    await core.check();
    await core.runAction({ action: "confirm-bootstrap" }).catch(() => undefined);
    await device.quiesce();
    await expect(core.install(NEW_DIGEST)).rejects.toMatchObject({
      reason: expect.stringContaining("Ubuntu"),
    });
    expect(device.handoffs).toEqual([]);
  });

  it("preserves backend ownership and uncertainty when desktop child reads fail before it exits", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    device.startProcess(4500);
    let unreadable = false;
    const core = device.makeCore({
      pid: 100,
      version: "1.0.0",
      commit: commit("1"),
      overrides: {
        descendants: async () => {
          if (unreadable) throw new Error("Process census unavailable");
          return [{ pid: 4500, started: device.table.get(4500)!, label: "Backend" }];
        },
      },
    });
    await core.start();
    await core.runAction({ action: "confirm-bootstrap" });
    await core.observe();
    unreadable = true;
    await core.observe();
    const store = await CoordinatorStore.open(device.coordinator, device.identity, 9001);
    const desktop = (await store.status(device.clock.value)).participants.find(
      (p) => p.label === "T3 Code desktop",
    )!;
    expect(desktop.descendants).toEqual([
      { pid: 4500, started: device.table.get(4500)!, label: "Backend" },
    ]);
    expect(desktop.blockers).toContainEqual(
      expect.objectContaining({ reason: "unknown-participant" }),
    );
    device.killProcess(100);
    expect(
      (await store.status(device.clock.value)).participants.find((p) => p.id === desktop.id)
        ?.orphaned,
    ).toBe(true);
    device.killProcess(4500);
    expect(
      (await store.status(device.clock.value)).participants.find((p) => p.id === desktop.id)
        ?.blockers,
    ).toContainEqual(expect.objectContaining({ reason: "unknown-participant" }));
    await expect(store.freeze("unknown-desktop", device.clock.value)).rejects.toThrow();
  });

  it("registers a confirmed WSL member as a child of the desktop and relays the distribution's own activity as blockers", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const calls: string[][] = [];
    let remoteActivityProtocol: number | undefined = CURRENT_ACTIVITY_PROTOCOL;
    const reply = (value: unknown) => ({
      code: 0,
      stdout: `${JSON.stringify({ ok: true, value })}\n`,
      stderr: "",
    });
    const core = device.makeCore({
      pid: 100,
      version: "1.0.0",
      commit: commit("1"),
      overrides: {
        managedWsl: async () => [
          {
            distro: "Ubuntu",
            command: {
              distroArgs: ["-d", "Ubuntu"],
              path: "/usr/bin",
              command: ["/home/u/.t3/runtime/t3"],
            },
          },
        ],
        resolveWslHome: async () => "/home/u/.t3",
        exec: async (command, args) => {
          calls.push([command, ...args]);
          const verb = args.slice(args.indexOf("maintenance") + 1).join(" ");
          if (verb === "fence status")
            return reply({
              bootstrapped: true,
              fence: null,
              participants: [{ id: "server", activityProtocol: remoteActivityProtocol }],
              blockers: [
                { participantId: "x", reason: "active-agents", label: "Agent running in WSL." },
              ],
            });
          return reply(true);
        },
      },
    });
    await core.start();
    // Membership is stated by the person's confirmation, never inferred: nothing is observed before it.
    await core.observe();
    const store = await CoordinatorStore.open(device.coordinator, device.identity, 100);
    expect(
      (await store.status(device.clock.value)).participants.some(
        (participant) => participant.kind === "wsl",
      ),
    ).toBe(false);
    await core.runAction({ action: "confirm-bootstrap" });
    expect(
      calls.some(
        (call) =>
          call.join(" ") ===
          "wsl.exe -d Ubuntu --exec env PATH=/usr/bin /home/u/.t3/runtime/t3 maintenance fence confirm-bootstrap",
      ),
    ).toBe(true);
    await core.observe();
    const status = await store.status(device.clock.value);
    const wsl = status.participants.find((participant) => participant.kind === "wsl");
    expect(wsl?.homes).toEqual(["wsl:Ubuntu:/home/u/.t3"]);
    expect(wsl?.parentId).toMatch(/^desktop-/);
    expect(status.blockers.some((blocker) => blocker.label === "Agent running in WSL.")).toBe(true);
    for (const outdated of [undefined, CURRENT_ACTIVITY_PROTOCOL - 1]) {
      remoteActivityProtocol = outdated;
      await core.observe();
      expect((await store.status(device.clock.value)).blockers).toContainEqual(
        expect.objectContaining({
          participantId: wsl!.id,
          reason: "unknown-participant",
          label: expect.stringContaining("current process activity census"),
        }),
      );
    }
    // Activity participants and affected homes stay separate: the cohort is Windows plus the confirmed member.
    expect((await core.status()).affectedHomes?.map((entry) => entry.id)).toEqual([
      device.home,
      "wsl:Ubuntu:/home/u/.t3",
    ]);
  });

  it("blocks installation when a managed WSL distribution is not a confirmed member", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const core = device.makeCore({
      pid: 100,
      version: "1.0.0",
      commit: commit("1"),
      overrides: {
        managedWsl: async () => [
          {
            distro: "Debian",
            command: {
              distroArgs: ["-d", "Debian"],
              path: "/usr/bin",
              command: ["/home/u/.t3/runtime/t3"],
            },
          },
        ],
        resolveWslHome: async () => "/home/u/.t3",
      },
    });
    await core.start();
    await core.check();
    await device.quiesce();
    await expect(core.install(NEW_DIGEST)).rejects.toMatchObject({
      reason: expect.stringContaining("Debian"),
    });
    expect(device.handoffs).toEqual([]);
  });

  it("starts the automatic countdown only after five quiet minutes and finished uploads, and a cancelled countdown stays cancelled", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const core = device.makeCore({
      pid: 100,
      version: "1.0.0",
      commit: commit("1"),
      overrides: { hasWindow: () => true },
    });
    await core.start();
    await core.check();
    await core.runAction({ action: "confirm-bootstrap" });
    await core.updatePolicy({ automaticInstallation: true });
    await device.quiesce();

    core.reportInteraction({ inputActiveAt: device.clock.value, uploadsInFlight: 1 });
    let status = await core.tick();
    expect(status.blockers.map((blocker) => blocker.reason)).toEqual(
      expect.arrayContaining(["uploads", "input-active"]),
    );
    expect(status.countdown ?? null).toBeNull();

    device.clock.value += 6 * MINUTE;
    await device.observeAll();
    core.reportInteraction({ inputActiveAt: device.clock.value - 6 * MINUTE, uploadsInFlight: 0 });
    status = await core.tick();
    expect(status.countdown?.targetArtifactSha256).toBe(NEW_DIGEST);
    expect(status.countdown!.installsAt - status.countdown!.startedAt).toBe(15_000);
    expect(device.handoffs).toEqual([]);

    status = await core.cancelCountdown();
    expect(status.countdown ?? null).toBeNull();
    device.clock.value += MINUTE;
    await device.observeAll();
    status = await core.tick();
    expect(status.countdown ?? null).toBeNull();
    expect(device.handoffs).toEqual([]);
  });

  it("treats a renderer that stopped reporting as active input", async () => {
    const device = await makeDevice();
    await device.server(9001, "desktop-server");
    const core = device.makeCore({
      pid: 100,
      version: "1.0.0",
      commit: commit("1"),
      overrides: { hasWindow: () => true },
    });
    await core.start();
    await core.check();
    await core.runAction({ action: "confirm-bootstrap" });
    await core.updatePolicy({ automaticInstallation: true });
    await device.quiesce();
    // No report ever arrived and more than three heartbeats have passed.
    const status = await core.tick();
    expect(status.blockers.map((blocker) => blocker.reason)).toContain("input-active");
  });

  it("registers the desktop process as a participant of its own and keeps check-only runtimes out of the install cohort", async () => {
    const device = await makeDevice();
    device.startProcess(9100);
    const standalone = await CoordinatorStore.open(device.coordinator, device.identity, 9100);
    const standaloneHome = NodePath.join(device.root, "standalone-home");
    await NodeFSP.mkdir(standaloneHome);
    await standalone.register(
      {
        id: "standalone",
        label: "standalone",
        kind: "standalone",
        homes: [standaloneHome],
        updateTarget: false,
      },
      device.clock.value,
    );
    await device.server(9001, "desktop-server");
    const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
    await core.start();
    const store = await CoordinatorStore.open(device.coordinator, device.identity, 100);
    const participants = (await store.status(device.clock.value)).participants;
    expect(
      participants.find(
        (participant) =>
          participant.id.startsWith("desktop-") &&
          participant.kind === "desktop" &&
          !participant.updateTarget,
      ),
    ).toBeDefined();
    expect((await core.status()).affectedHomes?.map((entry) => entry.id)).toEqual([device.home]);
  });

  it("answers concurrent identical requests with one outcome", async () => {
    const device = await makeDevice();
    let listings = 0;
    await device.server(9001, "desktop-server");
    const core = device.makeCore({
      pid: 100,
      version: "1.0.0",
      commit: commit("1"),
      overrides: { feed: async () => ((listings += 1), [OLD.record, NEW.record]) },
    });
    await core.start();
    const [first, second] = await Promise.all([
      core.runAction({ action: "check" }),
      core.runAction({ action: "check" }),
    ]);
    expect(first).toEqual(second);
    // One controller transaction served both, so the release origin was asked once for the check and once more to stage-time confirm.
    expect(listings).toBeLessThanOrEqual(2);
  });

  describe("a device transaction holds the fence", () => {
    /** An update that reached its trial and whose desktop exited: the state a later launch finds. */
    async function interruptedUpdate() {
      const device = await makeDevice();
      await device.server(9001, "desktop-server");
      const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
      await core.start();
      await core.check();
      await core.runAction({ action: "confirm-bootstrap" });
      await device.quiesce();
      await device.installUntilHandoff(core, NEW_DIGEST);
      device.killProcess(100);
      device.killProcess(9001);
      return device;
    }
    const withStarts = () => {
      const starts = { count: 0 };
      return {
        starts,
        runtime: {
          stopRuntimes: async () => undefined,
          startRuntimes: async () => void (starts.count += 1),
          quit: async () => undefined,
          self: async () => ({ pid: 0, started: "" }),
        },
      };
    };

    it("never reads a coordinator error as idle when a backend asks for its trial capability", async () => {
      const device = await interruptedUpdate();
      const next = device.makeCore({
        pid: 101,
        version: "1.1.0",
        commit: NEW.record.manifest!.commit,
      });
      expect((await next.start()).kind).toBe("trial");
      expect(Object.keys(await next.trialEnv({ kind: "windows" }))).toEqual([
        MAINTENANCE_TRIAL_ENV,
      ]);

      const registry = NodePath.join(device.coordinator, "registry.json");
      const good = await NodeFSP.readFile(registry, "utf8");
      await NodeFSP.writeFile(registry, "{broken");
      // A transient registry error must refuse the start, not hand the backend an empty environment.
      await expect(next.trialEnv({ kind: "windows" })).rejects.toThrow();
      await NodeFSP.writeFile(registry, good);
      expect(Object.keys(await next.trialEnv({ kind: "windows" }))).toEqual([
        MAINTENANCE_TRIAL_ENV,
      ]);
    });

    it("gives an empty environment only to a device the coordinator verified idle", async () => {
      const device = await makeDevice();
      await device.server(9001, "desktop-server");
      const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
      expect((await core.start()).kind).toBe("idle");
      expect(await core.trialEnv({ kind: "windows" })).toEqual({});
      // Before start the coordinator is unknown: a backend must not start on that.
      const early = device.makeCore({ pid: 101, version: "1.0.0", commit: commit("1") });
      await expect(early.trialEnv({ kind: "windows" })).rejects.toThrow(/has not started/);
    });

    it("refuses a capability to a build that is neither the trial nor the restored previous build", async () => {
      const device = await interruptedUpdate();
      // The old build came back (the installer failed) while the journal still says the trial is pending.
      const { starts, runtime } = withStarts();
      const old = device.makeCore({
        pid: 102,
        version: "1.0.0",
        commit: commit("1"),
        overrides: { runtime },
      });
      await NodeFSP.rm(NodePath.join(device.home, "maintenance", "restore-points"), {
        recursive: true,
        force: true,
      });
      const plan = await old.start();
      // The restore point is gone, so the transaction cannot be finished: nothing may open the data.
      expect(plan.kind).toBe("blocked");
      expect(starts.count).toBe(0);
      await expect(old.trialEnv({ kind: "windows" })).rejects.toThrow(
        /no backend may open the data/,
      );
    });

    it("holds the whole launch, visibly, when an interrupted restore cannot complete", async () => {
      const device = await interruptedUpdate();
      const { starts, runtime } = withStarts();
      // The previous build is relaunched (its installer failed): the trial never ran, so the data is restored first.
      // The restore point is gone, so the restore cannot be done.
      await NodeFSP.rm(NodePath.join(device.home, "maintenance", "restore-points"), {
        recursive: true,
        force: true,
      });
      const next = device.makeCore({
        pid: 101,
        version: "1.0.0",
        commit: commit("1"),
        overrides: { runtime },
      });
      const plan = await next.start();
      expect(plan.kind).toBe("blocked");
      if (plan.kind !== "blocked") return;
      // The person is told what to do, with the exact helper command, and nothing started.
      expect(plan.reason).toContain("will not open your data");
      expect(plan.reason).toContain(device.paths.recovery);
      // The helper can put the previous application back without opening this one: the claimed install plan is named.
      expect(plan.reason).toContain(
        `--desktop-plan "${NodePath.join(device.paths.handoff, `${device.handoffTransactionId()}-install.json`)}"`,
      );
      expect(starts.count).toBe(0);
      const status = await next.status();
      expect(status.phase).toBe("recovery");
      expect(status.installable).toBe(false);
      expect(status.lastError).toBe(plan.reason);
      // Held means held: no action runs, and no backend can be given a capability.
      await expect(next.install(NEW_DIGEST)).rejects.toMatchObject({ reason: plan.reason });
      await expect(next.check()).rejects.toMatchObject({ reason: plan.reason });
      await expect(next.trialEnv({ kind: "windows" })).rejects.toThrow();
      // The fence is still held for the transaction: a later launch must not find it released.
      device.startProcess(103);
      const store = await CoordinatorStore.open(device.coordinator, device.identity, 103);
      expect((await store.status(device.clock.value)).fence).not.toBeNull();
    });

    it("stops the trial's backends before a failed trial restores, and refuses them a restart afterwards", async () => {
      const device = await interruptedUpdate();
      const stops = { count: 0 };
      const next = device.makeCore({
        pid: 101,
        version: "1.1.0",
        commit: NEW.record.manifest!.commit,
        overrides: {
          runtime: {
            stopRuntimes: async () => void (stops.count += 1),
            startRuntimes: async () => undefined,
            quit: async () => undefined,
            self: async () => ({ pid: 101, started: device.table.get(101)! }),
          },
          trialTimeoutMs: 1000,
        },
      });
      expect((await next.start()).kind).toBe("trial");
      // No receipt arrives; the previous installer is cached, so the controller hands back by revert (which never returns here).
      await NodeFSP.rm(NodePath.join(device.home, "maintenance", "restore-points"), {
        recursive: true,
        force: true,
      });
      const status = await next.resumeInterrupted();
      expect(status.phase).toBe("recovery");
      expect(stops.count).toBeGreaterThan(0);
      // A backend restart while the restore is unresolved gets no capability and so cannot start.
      await expect(next.trialEnv({ kind: "windows" })).rejects.toThrow(
        /no backend may open the data/,
      );
    });

    it("holds the launch when the coordinator cannot be read while a transaction is in flight", async () => {
      const device = await interruptedUpdate();
      const { starts, runtime } = withStarts();
      await NodeFSP.writeFile(NodePath.join(device.coordinator, "registry.json"), "{broken");
      const next = device.makeCore({
        pid: 101,
        version: "1.1.0",
        commit: NEW.record.manifest!.commit,
        overrides: { runtime },
      });
      const plan = await next.start();
      expect(plan.kind).toBe("blocked");
      if (plan.kind === "blocked") expect(plan.reason).toContain("could not be read");
      expect(starts.count).toBe(0);
    });

    it("holds the launch when the registry cannot be opened but a journal says an update is in flight", async () => {
      const device = await interruptedUpdate();
      // A coordinator directory that is not a private real directory cannot be opened; the journals are still readable elsewhere.
      const journals = NodePath.join(device.coordinator, "journals");
      const parked = NodePath.join(device.root, "coordinator-journals");
      await NodeFSP.cp(journals, parked, { recursive: true });
      await NodeFSP.rm(device.coordinator, { recursive: true, force: true });
      await NodeFSP.mkdir(NodePath.dirname(device.coordinator), { recursive: true });
      await NodeFSP.symlink(NodePath.join(device.root, "elsewhere"), device.coordinator);
      await NodeFSP.mkdir(NodePath.join(device.root, "elsewhere", "journals"), { recursive: true });
      await NodeFSP.cp(parked, NodePath.join(device.root, "elsewhere", "journals"), {
        recursive: true,
      });
      const next = device.makeCore({
        pid: 101,
        version: "1.1.0",
        commit: NEW.record.manifest!.commit,
      });
      const plan = await next.start();
      expect(plan.kind).toBe("blocked");
      if (plan.kind === "blocked") expect(plan.reason).toContain("may be in flight");
    });

    it("keeps an installation whose coordinator cannot be opened, with nothing in flight, working", async () => {
      const device = await makeDevice();
      const blocker = NodePath.join(device.root, "not-a-directory");
      await NodeFSP.writeFile(blocker, "x");
      const core = device.makeCore({
        pid: 100,
        version: "1.0.0",
        commit: commit("1"),
        overrides: { namespace: blocker },
      });
      const plan = await core.start();
      expect(plan.kind).toBe("unavailable");
      // Old or unsupported installations are not bricked: installation is simply unavailable and backends start as before.
      expect(await core.trialEnv({ kind: "windows" })).toEqual({});
      expect((await core.status()).installable).toBe(false);
    });
  });

  describe("which installations an update affects", () => {
    it("keeps an idle managed service as an activity participant but never snapshots or restores its data", async () => {
      const device = await makeDevice();
      const serviceHome = await device.otherHome("service");
      await device.server(9001, "desktop-server");
      const service = await device.server(9002, "managed-service", {
        kind: "service",
        home: serviceHome,
      });
      const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
      await core.start();
      await core.check();
      await core.runAction({ action: "confirm-bootstrap" });
      await device.quiesce();

      // While the service works the update waits: it is a participant, and an agent it runs is never stopped for the update.
      service.blockers.push({
        participantId: "managed-service",
        reason: "active-agents",
        label: "The service is running an agent.",
      });
      await device.observeAll();
      expect((await core.status()).blockers.map((blocker) => blocker.participantId)).toContain(
        "managed-service",
      );
      await expect(core.install(NEW_DIGEST)).rejects.toMatchObject({
        reason: expect.stringContaining("blocked"),
      });
      service.blockers.length = 0;
      await device.quiesce();

      await device.installUntilHandoff(core, NEW_DIGEST);
      const first = await CoordinatorStore.open(device.coordinator, device.identity, 100);
      const [journal] = await first.listJournals();
      // Only the home this desktop's binary serves is in the transaction: the service's launcher replaces its own binary.
      expect(journal?.homes).toEqual([device.home]);
      expect(Object.keys(journal?.snapshots ?? {})).toEqual([device.home]);
      await expect(
        NodeFSP.access(NodePath.join(serviceHome, "maintenance", "restore-points")),
      ).rejects.toThrow();
      device.killProcess(100);
      device.killProcess(9001);

      // The trial fails and the data is restored; the service kept writing meanwhile and none of that is rolled back.
      const trialCore = device.makeCore({
        pid: 101,
        version: "1.1.0",
        commit: NEW.record.manifest!.commit,
      });
      await trialCore.start();
      const written = new NodeSqlite.DatabaseSync(
        NodePath.join(serviceHome, "userdata", "statev2.sqlite"),
      );
      written.exec("INSERT INTO notes VALUES ('written by the service during the trial')");
      written.close();
      const handedBack = device.nextHandoff();
      const resumed = trialCore.resumeInterrupted().then(
        (status) => {
          throw new Error(`resume returned ${status.phase}: ${status.lastError}`);
        },
        (error: { reason?: string }) => {
          throw new Error(`resume failed: ${error.reason ?? String(error)}`);
        },
      );
      await Promise.race([handedBack, resumed]);
      expect(rowsOf(device.home)).toEqual(["before the update"]);
      expect(rowsOf(serviceHome)).toEqual([
        "service before the update",
        "written by the service during the trial",
      ]);
    });

    it("blocks installation, visibly, while another desktop uses a different data home", async () => {
      const device = await makeDevice();
      const foreignHome = await device.otherHome("second-desktop");
      await device.server(9001, "desktop-server");
      await device.server(9002, "second-desktop-server", { home: foreignHome });
      const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
      await core.start();
      await core.check();
      await core.runAction({ action: "confirm-bootstrap" });
      await device.quiesce();
      await device.quiesce();

      const status = await core.status();
      expect(status.installable).toBe(false);
      expect(status.blockers.map((blocker) => blocker.label).join("\n")).toContain(foreignHome);
      // Its data is not part of this update, so it is never claimed as updated: nothing was fenced or launched.
      expect((status.affectedHomes ?? []).map((home) => home.id)).toEqual([device.home]);
      await expect(core.install(NEW_DIGEST)).rejects.toMatchObject({
        reason: expect.stringContaining("blocked"),
      });
      expect(device.handoffs).toEqual([]);
    });

    it("gives a trial capability only to the home this desktop owns", async () => {
      const device = await makeDevice();
      await device.server(9001, "desktop-server");
      const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1") });
      await core.start();
      await core.check();
      await core.runAction({ action: "confirm-bootstrap" });
      await device.quiesce();
      await device.installUntilHandoff(core, NEW_DIGEST);
      device.killProcess(100);
      device.killProcess(9001);

      // A desktop running a different data home is never handed the capability for this transaction's home.
      const elsewhere = await device.otherHome("elsewhere");
      const other = device.makeCore({
        pid: 101,
        version: "1.1.0",
        commit: NEW.record.manifest!.commit,
        overrides: { baseDir: elsewhere },
      });
      expect((await other.start()).kind).toBe("trial");
      await expect(other.trialEnv({ kind: "windows" })).rejects.toThrow(
        /does not include this desktop's data home/,
      );
    });
  });

  describe("a Windows home and a WSL distribution update as one cohort", () => {
    const distributionHome = "/home/fixture/wsl";
    /**
     * A distribution with its own filesystem, registry and runtime. The fake `wsl.exe` runs the shared protocol verbs
     * against them exactly as `t3 maintenance ...` would inside the distribution.
     */
    async function withDistribution() {
      const device = await makeDevice();
      const wslDir = NodePath.join(device.root, "wsl-home");
      await NodeFSP.mkdir(NodePath.join(wslDir, "userdata"), { recursive: true });
      const wslHome = await NodeFSP.realpath(wslDir);
      const database = new NodeSqlite.DatabaseSync(
        NodePath.join(wslHome, "userdata", "statev2.sqlite"),
      );
      database.exec(
        "CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('wsl before the update')",
      );
      database.close();
      device.startProcess(9500);
      const distro = await CoordinatorStore.open(
        NodePath.join(device.root, "wsl-coordinator"),
        device.identity,
        9500,
      );
      await distro.register(
        {
          id: "wsl-server",
          label: "wsl-server",
          kind: "desktop",
          homes: [wslHome],
          updateTarget: true,
        },
        device.clock.value,
      );
      await distro.observe("wsl-server", [], device.clock.value);
      // Observed on the same cadence as every other runtime, so its quiet time accrues like theirs.
      device.live.push({ store: distro, id: "wsl-server", blockers: [] });
      const verbs: string[] = [];
      const exec = async (_command: string, args: ReadonlyArray<string>) => {
        const rest = args.slice(args.indexOf("maintenance") + 1);
        verbs.push(rest.slice(0, 2).join(" "));
        let result;
        if (rest[0] === "home") {
          const parsed = parseHomeOperation(rest.slice(1));
          result =
            "error" in parsed
              ? { ok: false, reason: parsed.error }
              : await runHomeOperation(wslHome, parsed.operation, { store: distro });
        } else {
          const parsed = parseFenceOperation(rest.slice(1));
          result =
            "error" in parsed
              ? { ok: false, reason: parsed.error }
              : await runFenceOperation(
                  distro,
                  parsed.op === "issue-trial" || parsed.op === "receipt"
                    ? { ...parsed, home: wslHome }
                    : parsed,
                  device.clock.value,
                );
        }
        return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
      };
      const overrides = {
        managedWsl: async () => [
          {
            distro: "Ubuntu",
            command: { distroArgs: ["-d", "Ubuntu"], path: "/usr/bin", command: ["/opt/t3"] },
          },
        ],
        // The wire carries a Linux path even when this simulated distribution lives on Windows.
        resolveWslHome: async () => distributionHome,
        exec,
      } satisfies Partial<DesktopMaintenanceInput>;
      return { device, wslHome, distro, overrides, verbs };
    }
    const rows = (home: string) => rowsOf(home);

    async function installUntilTrial() {
      const fixture = await withDistribution();
      const { device, overrides, distro } = fixture;
      await device.server(9001, "desktop-server");
      const core = device.makeCore({ pid: 100, version: "1.0.0", commit: commit("1"), overrides });
      await core.start();
      await core.check();
      await core.runAction({ action: "confirm-bootstrap" });
      // The member's quiet time is the desktop's own observation of it: once to learn the distribution is idle, then five quiet minutes.
      await device.quiesce();
      await device.quiesce();
      await device.installUntilHandoff(core, NEW_DIGEST);
      device.killProcess(100);
      device.killProcess(9001);
      // The distribution's runtime was stopped for the update too.
      device.live.splice(
        device.live.findIndex((runtime) => runtime.id === "wsl-server"),
        1,
      );
      await distro.unregister("wsl-server");
      return fixture;
    }

    it("snapshots every home before any trial, fences both registries, and releases both only after both report healthy", async () => {
      const { device, wslHome, distro, overrides, verbs } = await installUntilTrial();
      const store = await CoordinatorStore.open(device.coordinator, device.identity, 150).catch(
        async () => {
          device.startProcess(150);
          return CoordinatorStore.open(device.coordinator, device.identity, 150);
        },
      );
      const [journal] = await store.listJournals();
      // One restore point per home, all taken before the trial began.
      expect(Object.keys(journal!.snapshots).toSorted()).toEqual(
        [device.home, `wsl:Ubuntu:${distributionHome}`].toSorted(),
      );
      expect(journal!.phase).toBe("trial");
      // The distribution holds the fence remotely and mirrors the journal.
      expect((await distro.status(device.clock.value)).fence?.transactionId).toBe(journal!.id);
      expect((await distro.readJournal(journal!.id))?.phase).toBe("trial");
      expect(verbs).toEqual(
        expect.arrayContaining(["fence freeze", "fence journal", "home snapshot"]),
      );

      const next = device.makeCore({
        pid: 101,
        version: "1.1.0",
        commit: NEW.record.manifest!.commit,
        overrides,
      });
      expect((await next.start()).kind).toBe("trial");
      const windowsCapability = JSON.parse(
        (await next.trialEnv({ kind: "windows" }))[MAINTENANCE_TRIAL_ENV]!,
      ) as { transactionId: string; home: string; nonce: string };
      const wslCapability = JSON.parse(
        (await next.trialEnv({ kind: "wsl", distro: "Ubuntu" }))[MAINTENANCE_TRIAL_ENV]!,
      ) as { transactionId: string; home: string; nonce: string };
      expect(wslCapability.home).toBe(wslHome);
      const windowsServer = await device.server(9002, "desktop-server-new", {
        trial: windowsCapability,
      });
      await windowsServer.store.writeReceipt(
        windowsCapability.transactionId,
        "desktop-server-new",
        device.home,
        "windows healthy",
      );
      // Only the Windows side is healthy so far: the cohort is not.
      const waiting = next.resumeInterrupted();
      device.startProcess(9501);
      const wslStore = await CoordinatorStore.open(
        NodePath.join(device.root, "wsl-coordinator"),
        device.identity,
        9501,
      );
      await wslStore.register(
        {
          id: "wsl-server-new",
          label: "wsl-server-new",
          kind: "desktop",
          homes: [wslHome],
          updateTarget: true,
        },
        device.clock.value,
        { trial: wslCapability },
      );
      await wslStore.writeReceipt(
        wslCapability.transactionId,
        "wsl-server-new",
        wslHome,
        "wsl healthy",
      );
      const status = await waiting;
      expect(status.phase).toBe("completed");
      expect((await store.status(device.clock.value)).fence).toBeNull();
      expect((await distro.status(device.clock.value)).fence).toBeNull();
      expect(verbs).toContain("fence receipt");
    });

    it("restores every home when only one reports healthy, and holds both fences until the previous build proves itself", async () => {
      const { device, wslHome, distro, overrides } = await installUntilTrial();
      device.startProcess(150);
      const store = await CoordinatorStore.open(device.coordinator, device.identity, 150);
      const [journal] = await store.listJournals();
      // The trial migrates both databases; the Windows runtime reports healthy, the distribution's never does.
      for (const home of [device.home, wslHome]) {
        const migrated = new NodeSqlite.DatabaseSync(
          NodePath.join(home, "userdata", "statev2.sqlite"),
        );
        migrated.exec("INSERT INTO notes VALUES ('written by the failing trial')");
        migrated.close();
      }
      const next = device.makeCore({
        pid: 101,
        version: "1.1.0",
        commit: NEW.record.manifest!.commit,
        overrides: { ...overrides, trialTimeoutMs: 1000 },
      });
      expect((await next.start()).kind).toBe("trial");
      const windowsCapability = JSON.parse(
        (await next.trialEnv({ kind: "windows" }))[MAINTENANCE_TRIAL_ENV]!,
      ) as { transactionId: string; home: string; nonce: string };
      const windowsServer = await device.server(9002, "desktop-server-new", {
        trial: windowsCapability,
      });
      await windowsServer.store.writeReceipt(
        windowsCapability.transactionId,
        "desktop-server-new",
        device.home,
        "windows healthy",
      );
      const revert = device.nextHandoff();
      const resumed = next.resumeInterrupted().then(
        (status) => {
          throw new Error(`resume returned ${status.phase}: ${status.lastError}`);
        },
        (error: { reason?: string }) => {
          throw new Error(`resume failed: ${error.reason ?? String(error)}`);
        },
      );
      await Promise.race([revert, resumed]);
      // One unhealthy home failed the whole set: both databases are back to their restore points.
      expect(rows(device.home)).toEqual(["before the update"]);
      expect(rows(wslHome)).toEqual(["wsl before the update"]);
      // Neither registry is released: the previous build has not proven itself yet.
      expect((await store.status(device.clock.value)).fence?.transactionId).toBe(journal!.id);
      expect((await distro.status(device.clock.value)).fence?.transactionId).toBe(journal!.id);
    });
  });
});

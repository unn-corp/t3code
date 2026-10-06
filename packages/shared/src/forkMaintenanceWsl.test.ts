// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { parseFenceOperation, runFenceOperation } from "./forkMaintenanceFenceOperations.ts";
import { parseHomeOperation, runHomeOperation } from "./forkMaintenanceHomeOperations.ts";
import { newJournal } from "./forkMaintenanceJournal.ts";
import { CoordinatorStore } from "./forkMaintenanceStore.ts";
import {
  createCohortFence,
  createRunnerFenceControl,
  createRunnerHomeControl,
  createCohortStorage,
  createLocalHomeControl,
  createWslFenceControl,
  createWslHomeControl,
  decodeWslMembership,
  mirrorJournalToMembers,
  observeWslMembers,
  parseWslHomeId,
  wslHomeId,
  wslInvocation,
  type Exec,
  type WslMember,
} from "./forkMaintenanceWsl.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function makeHome(root: string, name: string) {
  const home = NodePath.join(root, name);
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
  database.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${name}')`);
  database.close();
  return NodeFSP.realpath(home);
}

/**
 * A distribution simulated in-process: `wsl.exe -d <distro> -- <t3> maintenance <verb> ...` is parsed and
 * answered exactly as the CLI would, against that distribution's own home and registry.
 */
function fakeWsl(
  distros: Record<string, { home: string; store: CoordinatorStore }>,
  calls: string[] = [],
  now: () => number = () => Date.now(),
): Exec {
  return async (command, args) => {
    expect(command).toBe("wsl.exe");
    const [dash, distro, separator, executable, maintenance, verb, ...rest] = args;
    expect([dash, separator, executable, maintenance]).toEqual([
      "-d",
      "--exec",
      "/usr/local/bin/t3",
      "maintenance",
    ]);
    const target = distros[distro!];
    if (target === undefined)
      return {
        code: 1,
        stdout: "",
        stderr: `There is no distribution with the supplied name: ${distro}`,
      };
    calls.push(`${distro}:${verb}:${rest[0] ?? ""}`);
    if (verb === "home") {
      const parsed = parseHomeOperation(rest);
      if ("error" in parsed)
        return { code: 2, stdout: JSON.stringify({ ok: false, reason: parsed.error }), stderr: "" };
      return {
        code: 0,
        stdout: `${JSON.stringify(await runHomeOperation(parsed.home, parsed.operation, { store: target.store }))}\n`,
        stderr: "",
      };
    }
    const parsed = parseFenceOperation(rest);
    if ("error" in parsed)
      return { code: 2, stdout: JSON.stringify({ ok: false, reason: parsed.error }), stderr: "" };
    return {
      code: 0,
      stdout: `${JSON.stringify(await runFenceOperation(target.store, parsed, now()))}\n`,
      stderr: "",
    };
  };
}
const memberOf = (distro: string, home: string): WslMember => ({
  id: `wsl-${distro.toLowerCase()}`,
  distro,
  home,
  executable: "/usr/local/bin/t3",
});

async function cohort() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-wsl-cohort-"));
  roots.push(root);
  const windowsHome = await makeHome(root, "windows");
  const ubuntuHome = await makeHome(root, "ubuntu-home");
  const debianHome = await makeHome(root, "debian-home");
  const ubuntuStore = await CoordinatorStore.open(NodePath.join(root, "ubuntu-registry"));
  const debianStore = await CoordinatorStore.open(NodePath.join(root, "debian-registry"));
  const windowsStore = await CoordinatorStore.open(NodePath.join(root, "windows-registry"));
  const ubuntu = memberOf("Ubuntu", ubuntuHome);
  const debian = memberOf("Debian", debianHome);
  const calls: string[] = [];
  const clock = { value: 1000 };
  const exec = fakeWsl(
    {
      Ubuntu: { home: ubuntuHome, store: ubuntuStore },
      Debian: { home: debianHome, store: debianStore },
    },
    calls,
    () => clock.value,
  );
  return {
    root,
    windowsHome,
    ubuntu,
    debian,
    ubuntuStore,
    debianStore,
    windowsStore,
    exec,
    calls,
    clock,
  };
}

describe("explicit Windows/WSL membership", () => {
  it("accepts only stated members with absolute Linux paths and safe distro names", () => {
    const good = {
      version: 1,
      members: [
        {
          id: "wsl-ubuntu",
          distro: "Ubuntu-24.04",
          home: "/home/me/.t3",
          executable: "/usr/local/bin/t3",
        },
      ],
    };
    expect(decodeWslMembership(good).members).toHaveLength(1);
    expect(() =>
      decodeWslMembership({
        ...good,
        members: [{ ...good.members[0], distro: "Ubuntu; calc.exe" }],
      }),
    ).toThrow();
    expect(() =>
      decodeWslMembership({
        ...good,
        members: [{ ...good.members[0], home: "\\\\wsl$\\Ubuntu\\home" }],
      }),
    ).toThrow();
    expect(() =>
      decodeWslMembership({ ...good, members: [{ ...good.members[0], executable: "t3" }] }),
    ).toThrow();
    expect(() => decodeWslMembership({ version: 2, members: [] })).toThrow();
  });

  it("names a member's home distinctly from any Windows path and round-trips it", () => {
    const id = wslHomeId({ distro: "Ubuntu", home: "/home/me/.t3" });
    expect(id).toBe("wsl:Ubuntu:/home/me/.t3");
    expect(parseWslHomeId(id)).toEqual({ distro: "Ubuntu", home: "/home/me/.t3" });
    expect(parseWslHomeId("C:\\Users\\me\\.t3")).toBeNull();
  });

  it("drives a member only through wsl.exe -d <distro> --exec <t3> maintenance", () => {
    expect(wslInvocation(memberOf("Ubuntu", "/h"), ["home", "list", "--home", "/h"])).toEqual({
      command: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--exec",
        "/usr/local/bin/t3",
        "maintenance",
        "home",
        "list",
        "--home",
        "/h",
      ],
    });
  });

  it("snapshots, verifies and restores Windows and every member as one cohort set", async () => {
    const c = await cohort();
    const homes = [
      { id: c.windowsHome, label: "Windows", control: createLocalHomeControl(c.windowsHome) },
      {
        id: wslHomeId(c.ubuntu),
        label: "Ubuntu (WSL)",
        control: createWslHomeControl(c.ubuntu, c.exec),
      },
      {
        id: wslHomeId(c.debian),
        label: "Debian (WSL)",
        control: createWslHomeControl(c.debian, c.exec),
      },
    ];
    const storage = createCohortStorage(homes);
    expect(await storage.affectedHomes()).toEqual([
      c.windowsHome,
      "wsl:Ubuntu:" + c.ubuntu.home,
      "wsl:Debian:" + c.debian.home,
    ]);
    await storage.assertCapacity(await storage.affectedHomes());
    const ids = new Map<string, string>();
    for (const id of await storage.affectedHomes()) ids.set(id, await storage.snapshot(id, "tx1"));
    expect([...ids.values()].every((value) => value.startsWith("tx-tx1-restore-point-"))).toBe(
      true,
    );
    await NodeFSP.writeFile(NodePath.join(c.ubuntu.home, "userdata", "settings.json"), "changed");
    for (const [id, snapshotId] of ids) await storage.restore(id, snapshotId, "tx1");
    await expect(
      NodeFSP.stat(NodePath.join(c.ubuntu.home, "userdata", "settings.json")),
    ).rejects.toThrow();
    expect(
      (await storage.restorePoints(wslHomeId(c.ubuntu))).map((point) => point.transactionId),
    ).toEqual(["tx1"]);
  });

  it("fails the whole cohort when a member cannot answer, instead of skipping it", async () => {
    const c = await cohort();
    const gone = createWslHomeControl(memberOf("Gone", "/nowhere"), c.exec);
    const storage = createCohortStorage([
      { id: c.windowsHome, label: "Windows", control: createLocalHomeControl(c.windowsHome) },
      { id: "wsl:Gone:/nowhere", label: "Gone (WSL)", control: gone },
    ]);
    await expect(storage.snapshot("wsl:Gone:/nowhere", "tx1")).rejects.toThrow("Gone (WSL)");
    await expect(storage.snapshot("wsl:Other:/x", "tx1")).rejects.toThrow(
      "not a member of this update's cohort",
    );
    await expect(storage.assertCapacity(["wsl:Gone:/nowhere"])).rejects.toThrow(
      "There is no distribution",
    );
  });

  it("registers members as wsl children of the Windows parent and reflects their own activity", async () => {
    const c = await cohort();
    await c.windowsStore.register(
      {
        id: "desktop",
        label: "Desktop",
        kind: "desktop",
        homes: [c.windowsHome],
        updateTarget: true,
      },
      0,
    );
    await c.ubuntuStore.register(
      {
        id: "ubuntu-server",
        label: "Server",
        kind: "desktop",
        homes: [c.ubuntu.home],
        updateTarget: true,
      },
      0,
    );
    await c.ubuntuStore.confirmBootstrap();
    await c.ubuntuStore.observe(
      "ubuntu-server",
      [
        {
          participantId: "ubuntu-server",
          reason: "active-agents",
          label: "An agent is running in Ubuntu",
        },
      ],
      0,
    );
    const members = [
      { member: c.ubuntu, fence: createWslFenceControl(c.ubuntu, c.exec) },
      { member: c.debian, fence: createWslFenceControl(c.debian, c.exec) },
    ];
    await observeWslMembers({ store: c.windowsStore, parentId: "desktop", members, now: 1000 });
    const status = await c.windowsStore.status(1000);
    const byId = new Map(status.participants.map((participant) => [participant.id, participant]));
    expect(byId.get("wsl-ubuntu")).toMatchObject({
      kind: "wsl",
      parentId: "desktop",
      blockers: [
        {
          reason: "active-agents",
          participantId: "wsl-ubuntu",
          label: "An agent is running in Ubuntu",
        },
      ],
    });
    // A distribution with no registered runtime cannot be shown idle.
    expect(byId.get("wsl-debian")?.blockers[0]).toMatchObject({ reason: "bootstrap" });
    // Unreachable distribution: unknown, which blocks.
    const lost = {
      member: memberOf("Missing", "/x"),
      fence: createWslFenceControl(memberOf("Missing", "/x"), c.exec),
    };
    await observeWslMembers({
      store: c.windowsStore,
      parentId: "desktop",
      members: [lost],
      now: 2000,
    });
    expect(
      (await c.windowsStore.status(2000)).participants.find(
        (participant) => participant.id === lost.member.id,
      )?.blockers[0]?.reason,
    ).toBe("unknown-participant");
  });

  it("lets a member's five-minute idle window elapse across repeated observation passes, so a Windows+WSL update can become installable", async () => {
    const c = await cohort();
    await c.windowsStore.register(
      {
        id: "desktop",
        label: "Desktop",
        kind: "desktop",
        homes: [c.windowsHome],
        updateTarget: true,
      },
      0,
    );
    await c.windowsStore.confirmBootstrap();
    await c.ubuntuStore.register(
      {
        id: "ubuntu-server",
        label: "Server",
        kind: "desktop",
        homes: [c.ubuntu.home],
        updateTarget: true,
      },
      0,
    );
    await c.ubuntuStore.confirmBootstrap();
    const members = [{ member: c.ubuntu, fence: createWslFenceControl(c.ubuntu, c.exec) }];
    for (const now of [0, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000]) {
      c.clock.value = now;
      await c.ubuntuStore.observe("ubuntu-server", [], now);
      await c.windowsStore.observe("desktop", [], now);
      await observeWslMembers({ store: c.windowsStore, parentId: "desktop", members, now });
    }
    expect((await c.windowsStore.status(360_000)).blockers).toEqual([]);
    await c.windowsStore.freeze("tx1", 360_000);
  });

  it("holds a member's fence remotely and releases it only against a mirrored terminal journal", async () => {
    const c = await cohort();
    await c.ubuntuStore.register(
      {
        id: "ubuntu-server",
        label: "Server",
        kind: "desktop",
        homes: [c.ubuntu.home],
        updateTarget: true,
      },
      0,
    );
    await c.ubuntuStore.confirmBootstrap();
    await c.ubuntuStore.observe("ubuntu-server", [], 0);
    await c.ubuntuStore.observe("ubuntu-server", [], 600_000);
    c.clock.value = 600_000;
    const fence = createWslFenceControl(c.ubuntu, c.exec);
    expect(await fence.run({ op: "freeze", transactionId: "tx1", parent: "desktop" })).toEqual({
      ok: true,
      value: true,
    });
    // Admission inside the distribution is now fenced, held by the remote parent.
    await expect(c.ubuntuStore.beginWork("ubuntu-server")).rejects.toThrow("holds new work");
    const journal = newJournal({
      id: "tx1",
      kind: "update",
      homes: [wslHomeId(c.ubuntu)],
      previous: { version: "1.0.0", artifactSha256: "a" },
      target: { version: "1.0.1", artifactSha256: "b" },
      now: 0,
    });
    expect(await fence.run({ op: "release", transactionId: "tx1" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not at a durable"),
    });
    await mirrorJournalToMembers({ ...journal, phase: "committed" }, [fence]);
    expect(await fence.run({ op: "release", transactionId: "tx1" })).toEqual({
      ok: true,
      value: true,
    });
    await (
      await c.ubuntuStore.beginWork("ubuntu-server")
    )();
  });

  it("issues a trial capability inside the distribution for its own home only", async () => {
    const c = await cohort();
    await c.ubuntuStore.register(
      {
        id: "ubuntu-server",
        label: "Server",
        kind: "desktop",
        homes: [c.ubuntu.home],
        updateTarget: true,
      },
      0,
    );
    await c.ubuntuStore.confirmBootstrap();
    await c.ubuntuStore.observe("ubuntu-server", [], 0);
    await c.ubuntuStore.observe("ubuntu-server", [], 600_000);
    c.clock.value = 600_000;
    const fence = createWslFenceControl(c.ubuntu, c.exec);
    await fence.run({ op: "freeze", transactionId: "tx1", parent: "desktop" });
    const issued = await fence.run({
      op: "issue-trial",
      transactionId: "tx1",
      home: c.ubuntu.home,
    });
    expect(issued).toMatchObject({
      ok: true,
      value: { transactionId: "tx1", home: c.ubuntu.home, nonce: expect.any(String) },
    });
  });

  it("freezes the whole cohort or none: a member that refuses releases those already fenced", async () => {
    const c = await cohort();
    for (const [store, id, home] of [
      [c.ubuntuStore, "ubuntu-server", c.ubuntu.home],
      [c.debianStore, "debian-server", c.debian.home],
    ] as const) {
      await store.register(
        { id, label: id, kind: "desktop", homes: [home], updateTarget: true },
        0,
      );
      await store.confirmBootstrap();
      await store.observe(id, [], 0);
      await store.observe(id, [], 600_000);
    }
    c.clock.value = 600_000;
    // Debian has an active agent, so it refuses after Ubuntu was already fenced.
    await c.debianStore.observe(
      "debian-server",
      [
        {
          participantId: "debian-server",
          reason: "active-agents",
          label: "An agent is running in Debian",
        },
      ],
      600_000,
    );
    const fence = createCohortFence({
      parentId: "desktop",
      members: [
        { member: c.ubuntu, fence: createWslFenceControl(c.ubuntu, c.exec) },
        { member: c.debian, fence: createWslFenceControl(c.debian, c.exec) },
      ],
    });
    await expect(fence.freeze("tx1")).rejects.toThrow("Debian");
    expect(await c.ubuntuStore.fenceSnapshot()).toBeNull();
    expect(await c.debianStore.fenceSnapshot()).toBeNull();
    await c.debianStore.observe("debian-server", [], 600_000);
    // The agent finished; Debian must then stay stopped for a further five minutes.
    c.clock.value = 900_000;
    await c.ubuntuStore.observe("ubuntu-server", [], 900_000);
    await c.debianStore.observe("debian-server", [], 900_000);
    await fence.freeze("tx2");
    expect((await c.ubuntuStore.fenceSnapshot())?.transactionId).toBe("tx2");
    expect((await c.debianStore.fenceSnapshot())?.transactionId).toBe("tx2");
    // A release against a non-terminal mirrored journal is refused; a fresh object after a restart still releases only what it holds.
    await expect(fence.release("tx2")).rejects.toThrow("not at a durable");
    const journal = {
      ...newJournal({
        id: "tx2",
        kind: "update",
        homes: [],
        previous: { version: "1", artifactSha256: "a" },
        target: null,
        now: 0,
      }),
      phase: "committed" as const,
    };
    const restarted = createCohortFence({
      parentId: "desktop",
      members: [
        { member: c.ubuntu, fence: createWslFenceControl(c.ubuntu, c.exec) },
        { member: c.debian, fence: createWslFenceControl(c.debian, c.exec) },
      ],
    });
    await restarted.mirrorJournal(journal);
    await restarted.release("tx2");
    expect(await c.ubuntuStore.fenceSnapshot()).toBeNull();
    expect(await c.debianStore.fenceSnapshot()).toBeNull();
    await restarted.release("never-held");
  });

  it("returns the canonical home and the per-slot receipt the distribution recorded, so identities and verification match", async () => {
    const c = await cohort();
    const link = NodePath.join(c.root, "link-to-ubuntu");
    await NodeFSP.symlink(c.ubuntu.home, link);
    const viaLink = createWslHomeControl({ ...c.ubuntu, home: link }, c.exec);
    expect(await viaLink.run({ op: "canonical" })).toEqual({ ok: true, value: c.ubuntu.home });
    c.clock.value = 600_000;
    await c.ubuntuStore.register(
      {
        id: "ubuntu-server",
        label: "Server",
        kind: "service",
        homes: [c.ubuntu.home],
        updateTarget: true,
      },
      0,
    );
    await c.ubuntuStore.confirmBootstrap();
    await c.ubuntuStore.observe("ubuntu-server", [], 0, [
      { pid: 4242, started: "x", label: "codex" },
    ]);
    await c.ubuntuStore.observe("ubuntu-server", [], 600_000, [
      { pid: 4242, started: "x", label: "codex" },
    ]);
    const fence = createWslFenceControl(c.ubuntu, c.exec);
    const status = await fence.run({ op: "status" });
    expect(status).toMatchObject({
      ok: true,
      value: {
        participants: [
          { id: "ubuntu-server", observedAt: 600_000, blockers: [], descendants: [{ pid: 4242 }] },
        ],
      },
    });
    expect(
      await fence.run({ op: "receipt", transactionId: "tx1", home: c.ubuntu.home, slot: "trial" }),
    ).toEqual({ ok: true, value: null });
    await c.ubuntuStore.freeze("tx1", 600_000);
    const capability = await c.ubuntuStore.issueTrial("tx1", c.ubuntu.home);
    // The runtime that was serving the home has stopped before its replacement starts.
    await c.ubuntuStore.unregister("ubuntu-server");
    const trial = await CoordinatorStore.open(
      NodePath.join(c.root, "ubuntu-registry"),
      async (pid) =>
        pid === 4_000_010
          ? "boot:trial"
          : (await import("./forkMaintenanceStore.ts")).processCreationIdentity(pid),
      4_000_010,
    );
    await trial.register(
      { id: "trial", label: "Trial", kind: "service", homes: [c.ubuntu.home], updateTarget: true },
      600_000,
      { trial: capability },
    );
    await trial.writeReceipt(
      "tx1",
      "trial",
      c.ubuntu.home,
      "restored-by-previous-build",
      "restored",
    );
    expect(
      await fence.run({
        op: "receipt",
        transactionId: "tx1",
        home: c.ubuntu.home,
        slot: "restored",
      }),
    ).toEqual({ ok: true, value: "restored-by-previous-build" });
    expect(
      await fence.run({ op: "receipt", transactionId: "tx1", home: c.ubuntu.home, slot: "trial" }),
    ).toEqual({ ok: true, value: null });
  });

  it("runs the same protocol over a caller-owned transport, and a transport failure is an unreachable member, not idle", async () => {
    const c = await cohort();
    // The desktop's runner resolves PATH and the staged t3; it only forwards what follows the executable.
    const runnerFor =
      (distro: string, fail = false) =>
      async (args: ReadonlyArray<string>) => {
        if (fail) throw new Error("wsl.exe exited 1");
        const result = await c.exec("wsl.exe", [
          "-d",
          distro,
          "--exec",
          "/usr/local/bin/t3",
          ...args,
        ]);
        if (result.code !== 0) throw new Error(result.stderr || `exit ${result.code}`);
        return result.stdout;
      };
    const member = { distro: "Ubuntu", home: c.ubuntu.home };
    const home = createRunnerHomeControl(runnerFor("Ubuntu"), member);
    const snapshot = await home.run({ op: "snapshot", transactionId: "tx1" });
    expect(snapshot).toMatchObject({ ok: true });
    expect(await home.run({ op: "list" })).toMatchObject({
      ok: true,
      value: [{ transactionId: "tx1" }],
    });
    expect(await home.run({ op: "canonical" })).toEqual({ ok: true, value: c.ubuntu.home });
    expect(
      await createRunnerFenceControl(runnerFor("Ubuntu"), member).run({ op: "status" }),
    ).toMatchObject({ ok: true, value: { fence: null } });
    expect(
      await createRunnerHomeControl(runnerFor("Ubuntu", true), member).run({ op: "list" }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("did not answer") });
    // A member registered for the runner transport has no executable and still works; the built-in transport refuses it as data.
    expect(
      await createWslHomeControl(
        { id: "wsl-ubuntu", distro: "Ubuntu", home: c.ubuntu.home },
        c.exec,
      ).run({ op: "list" }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("DistroRunner") });
  });

  it("rejects malformed verbs from either side", () => {
    expect(parseFenceOperation(["freeze", "--transaction", "t"])).toEqual({
      error: "--transaction and --parent are required.",
    });
    expect(parseFenceOperation(["journal", "--journal-base64", "!!!"])).toEqual({
      error: "The journal is not valid.",
    });
    expect(parseFenceOperation(["nope"])).toEqual({ error: "Unknown fence operation nope." });
    expect(parseFenceOperation(["confirm-bootstrap"])).toEqual({ op: "confirm-bootstrap" });
  });
});

// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  CoordinatorStore,
  processCreationIdentity,
  UnsupportedPlatformError,
} from "./forkMaintenanceStore.ts";
import { newJournal } from "./forkMaintenanceJournal.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

/** Simulated process table: a pid is alive only while its start identity matches. */
function processTable(entries: Record<number, string>) {
  const table = new Map(Object.entries(entries).map(([pid, started]) => [Number(pid), started]));
  return { table, identity: async (pid: number) => table.get(pid) ?? null };
}
async function fixture(entries: Record<number, string> = { 100: "boot:1", 200: "boot:2" }) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-maintenance-test-"));
  directories.push(directory);
  const processes = processTable(entries);
  const open = (pid: number) =>
    CoordinatorStore.open(NodePath.join(directory, "coordinator"), processes.identity, pid);
  const home = async (name: string) => {
    const value = NodePath.join(directory, name);
    await NodeFSP.mkdir(value);
    return value;
  };
  return { directory, processes, open, home, coordinator: NodePath.join(directory, "coordinator") };
}
const journalAt = (phase: "committed" | "trial" | "aborted") => ({
  ...newJournal({
    id: "tx",
    kind: "update",
    homes: ["h"],
    previous: { version: "1", artifactSha256: "a" },
    target: { version: "2", artifactSha256: "b" },
    now: 0,
  }),
  phase,
});
const idle = async (store: CoordinatorStore, id: string) => {
  await store.observe(id, [], 0);
  await store.observe(id, [], 600_000);
};

describe("host coordinator", () => {
  it("blocks until bootstrap is confirmed and never makes development runtimes update targets", async () => {
    const f = await fixture();
    const store = await f.open(100);
    await store.register(
      {
        id: "dev",
        label: "Development server",
        kind: "development",
        homes: [await f.home("dev")],
        updateTarget: false,
      },
      0,
    );
    await idle(store, "dev");
    expect((await store.status(600_000)).blockers[0]?.reason).toBe("bootstrap");
    await store.confirmBootstrap();
    const status = await store.status(600_000);
    expect(status.blockers).toEqual([]);
    expect(status.participants[0]?.updateTarget).toBe(false);
  });

  it("serializes racing work permits, blocks installation until they finish, then fences new work", async () => {
    const f = await fixture();
    const store = await f.open(100);
    await store.register(
      {
        id: "desktop",
        label: "Desktop",
        kind: "desktop",
        homes: [await f.home("h")],
        updateTarget: true,
      },
      0,
    );
    await store.confirmBootstrap();
    await idle(store, "desktop");
    const releases = await Promise.all(Array.from({ length: 8 }, () => store.beginWork("desktop")));
    await expect(store.freeze("tx", 600_000)).rejects.toThrow();
    await store.observe("desktop", [], 600_000);
    expect((await store.status(600_000)).blockers[0]?.reason).toBe("background-work");
    await Promise.all(releases.map((release) => release()));
    await store.observe("desktop", [], 600_000);
    await store.observe("desktop", [], 900_000);
    await store.freeze("tx", 900_000);
    await expect(store.beginWork("desktop")).rejects.toThrow("holds new work");
    await expect(store.assertAdmitting("desktop")).rejects.toThrow("holds new work");
    await expect(store.recheck("tx", 900_000)).rejects.toThrow("acknowledged");
    await store.observe("desktop", [], 900_000);
    expect(await store.recheck("tx", 900_000)).toHaveLength(1);
    await expect(store.freeze("duplicate", 900_000)).rejects.toThrow("Another device transaction");
  });

  it("clears a work lease whose process exited so a crash cannot block updates forever", async () => {
    const f = await fixture();
    const crashing = await f.open(200);
    const observer = await f.open(100);
    await observer.register(
      {
        id: "desktop",
        label: "Desktop",
        kind: "desktop",
        homes: [await f.home("h")],
        updateTarget: true,
      },
      0,
    );
    // The crashed process holds a lease against a participant it does not own: forge it as that process would have written it.
    await NodeFSP.writeFile(
      NodePath.join(f.coordinator, "work-desktop-00000000-0000-4000-8000-000000000000"),
      JSON.stringify(crashing.owner),
    );
    await observer.confirmBootstrap();
    await idle(observer, "desktop");
    await expect(observer.freeze("tx", 600_000)).rejects.toThrow("local operation");
    f.processes.table.delete(200);
    await observer.observe("desktop", [], 600_000);
    // Clearing the dead lease restarts the five-minute stopped window.
    await expect(observer.freeze("tx", 600_000)).rejects.toThrow("five minutes");
    await observer.observe("desktop", [], 900_000);
    await observer.freeze("tx", 900_000);
  });

  it("treats a reused PID as a different, exited process", async () => {
    const f = await fixture();
    const first = await f.open(200);
    await first.register(
      {
        id: "old",
        label: "Old runtime",
        kind: "standalone",
        homes: [await f.home("old")],
        updateTarget: false,
      },
      0,
    );
    f.processes.table.set(200, "boot:2-after-reuse");
    const observer = await f.open(100);
    expect((await observer.status(0)).participants).toEqual([]);
  });

  it("rejects a second live runtime on the same data home but allows its replacement after exit", async () => {
    const f = await fixture();
    const home = await f.home("shared");
    const first = await f.open(100);
    await first.register(
      { id: "a", label: "A", kind: "standalone", homes: [home], updateTarget: false },
      0,
    );
    const second = await f.open(200);
    await expect(
      second.register(
        { id: "b", label: "B", kind: "standalone", homes: [home], updateTarget: false },
        0,
      ),
    ).rejects.toThrow("owns this data home");
    f.processes.table.delete(100);
    await second.register(
      { id: "b", label: "B", kind: "standalone", homes: [home], updateTarget: false },
      0,
    );
  });

  it("rejects stale transaction acknowledgement and invalid participant identifiers", async () => {
    const f = await fixture();
    const store = await f.open(100);
    await expect(store.recheck("stale", 0)).rejects.toThrow("does not own");
    await expect(
      store.register(
        {
          id: "../escape",
          label: "bad",
          kind: "standalone",
          homes: [f.directory],
          updateTarget: false,
        },
        0,
      ),
    ).rejects.toThrow("Invalid identifier");
  });

  it("never steals an unreadable lock or treats stale activity as proof of process exit", async () => {
    const f = await fixture();
    const store = await f.open(100);
    await store.register(
      { id: "p", label: "P", kind: "standalone", homes: [await f.home("h")], updateTarget: false },
      0,
    );
    await store.confirmBootstrap();
    expect((await store.status(60_000)).blockers[0]?.reason).toBe("unknown-participant");
    await NodeFSP.writeFile(NodePath.join(f.coordinator, "registry.lock"), "interrupted write");
    await expect(store.status(60_000)).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(f.coordinator, "registry.lock"), "utf8")).toBe(
      "interrupted write",
    );
  });

  it("retries when the lock vanishes between a failed link and the owner read, so contending processes never fail with ENOENT", async () => {
    const f = await fixture({ 100: "boot:1", 200: "boot:2" });
    const a = await f.open(100);
    const b = await f.open(200);
    await a.register(
      { id: "p", label: "P", kind: "standalone", homes: [await f.home("h")], updateTarget: false },
      0,
    );
    // Two processes hammering the registry: every attempt that loses the link race reads a lock that may be released at once.
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? a : b).status(0)),
    );
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    // And the pathological interleaving, forced: the lock disappears exactly when it is read.
    const lockPath = NodePath.join(f.coordinator, "registry.lock");
    await NodeFSP.writeFile(lockPath, JSON.stringify(a.owner));
    let vanished = false;
    const target = b as unknown as { readLockFile: (file: string) => Promise<string> };
    const original = target.readLockFile.bind(b);
    target.readLockFile = async (file) => {
      if (!vanished) {
        vanished = true;
        await NodeFSP.unlink(lockPath);
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
      return original(file);
    };
    expect((await b.status(0)).participants).toHaveLength(1);
    expect(vanished).toBe(true);
  });

  it("keeps observed activity when the same owner registers the same runtime again, but a new owner starts unknown", async () => {
    const f = await fixture();
    const store = await f.open(100);
    const home = await f.home("h");
    const input = {
      id: "p",
      label: "P",
      kind: "standalone" as const,
      homes: [home],
      updateTarget: false,
    };
    await store.register(input, 0);
    await store.observe("p", [], 1000, [{ pid: 4242, started: "x", label: "codex" }]);
    await store.register({ ...input, label: "P renamed" }, 50_000);
    const kept = (await store.status(50_000)).participants[0]!;
    expect(kept).toMatchObject({
      label: "P renamed",
      observedAt: 1000,
      idleSince: 1000,
      blockers: [],
      descendants: [{ pid: 4242 }],
    });
    // A different process taking over the id (the old one exited) has not been observed yet.
    f.processes.table.delete(100);
    const other = await f.open(200);
    await other.register(input, 60_000);
    expect((await other.status(60_000)).participants[0]).toMatchObject({
      idleSince: null,
      descendants: [],
      blockers: [{ reason: "unknown-participant" }],
    });
  });

  it("repairs an exited lock only on explicit request and refuses a live owner's lock", async () => {
    const f = await fixture();
    const store = await f.open(100);
    await NodeFSP.writeFile(
      NodePath.join(f.coordinator, "registry.lock"),
      JSON.stringify({ pid: 200, started: "boot:2" }),
    );
    await expect(store.repairExitedLock()).rejects.toThrow("still running");
    f.processes.table.delete(200);
    await expect(store.status(0)).rejects.toThrow("offline repair");
    expect(await store.repairExitedLock()).toBe(true);
    expect((await store.status(0)).participants).toEqual([]);
  });

  it("releases admission only against a durable terminal journal", async () => {
    const f = await fixture();
    const store = await f.open(100);
    await store.register(
      {
        id: "desktop",
        label: "Desktop",
        kind: "desktop",
        homes: [await f.home("h")],
        updateTarget: true,
      },
      0,
    );
    await store.confirmBootstrap();
    await idle(store, "desktop");
    await store.freeze("tx", 600_000);
    await expect(store.releaseFence("tx")).rejects.toThrow("not at a durable");
    await store.writeJournal(journalAt("trial"));
    await expect(store.releaseFence("tx")).rejects.toThrow("not at a durable");
    await store.writeJournal(journalAt("committed"));
    await store.releaseFence("tx");
    await store.beginWork("desktop");
  });

  it("rejects an ordinary registration while a transaction holds the fence, atomically with the fence", async () => {
    const f = await fixture();
    const parent = await f.open(100);
    await parent.register(
      {
        id: "desktop",
        label: "Desktop",
        kind: "desktop",
        homes: [await f.home("a")],
        updateTarget: true,
      },
      0,
    );
    await parent.confirmBootstrap();
    await idle(parent, "desktop");
    await parent.freeze("tx", 600_000);
    const late = await f.open(200);
    // The runtime may have read "no fence" an instant earlier: register itself must refuse.
    await expect(
      late.register(
        {
          id: "late",
          label: "Late",
          kind: "standalone",
          homes: [await f.home("b")],
          updateTarget: false,
        },
        700_000,
      ),
    ).rejects.toThrow("holds new work");
    expect(
      (await parent.status(700_000)).participants.map((participant) => participant.id),
    ).toEqual(["desktop"]);
  });

  it("issues a one-use trial capability bound to an exact home, consumed atomically by registration, and only that runtime may record the receipt", async () => {
    const f = await fixture({ 100: "boot:1", 200: "boot:2", 300: "boot:3" });
    const parent = await f.open(100);
    const homeA = await f.home("a");
    const homeB = await f.home("b");
    await parent.register(
      { id: "desktop", label: "Desktop", kind: "desktop", homes: [homeA], updateTarget: true },
      0,
    );
    await parent.confirmBootstrap();
    await idle(parent, "desktop");
    await parent.freeze("tx", 600_000);
    const canonicalA = await NodeFSP.realpath(homeA);
    const capability = await parent.issueTrial("tx", canonicalA);
    f.processes.table.delete(100);
    const trial = await f.open(200);
    const input = {
      id: "trial",
      label: "Trial",
      kind: "desktop" as const,
      homes: [homeA],
      updateTarget: true,
    };
    await expect(
      trial.register(input, 700_000, { trial: { ...capability, nonce: "wrong" } }),
    ).rejects.toThrow("already used or does not match");
    await expect(
      trial.register({ ...input, homes: [homeB] }, 700_000, { trial: capability }),
    ).rejects.toThrow();
    await trial.register(input, 700_000, { trial: capability });
    // A replayed capability (another runtime, or the same one again) is dead.
    const replay = await f.open(300);
    await expect(
      replay.register({ ...input, id: "replay" }, 700_000, { trial: capability }),
    ).rejects.toThrow("already used");
    await expect(trial.writeReceipt("tx", "trial", homeB, "ok")).rejects.toThrow(
      "Only the transaction's trial",
    );
    await trial.writeReceipt("tx", "trial", canonicalA, "receipt-1");
    expect(await trial.readReceipt("tx", canonicalA)).toBe("receipt-1");
    expect(await trial.readReceipt("tx", "elsewhere")).toBeNull();
  });

  it("keeps a blocking tombstone while processes a runtime started still run, and clears it only once they are gone", async () => {
    const f = await fixture({
      100: "boot:1",
      200: "boot:2",
      4242: "boot:term",
      4243: "boot:agent",
    });
    const runtime = await f.open(200);
    await runtime.register(
      {
        id: "desktop",
        label: "Desktop server",
        kind: "desktop",
        homes: [await f.home("h")],
        updateTarget: true,
      },
      0,
    );
    await runtime.confirmBootstrap();
    await runtime.observe("desktop", [], 0, [
      { pid: 4242, started: "boot:term", label: "terminal" },
      { pid: 4243, started: "boot:agent", label: "agent" },
    ]);
    await runtime.observe("desktop", [], 600_000, [
      { pid: 4242, started: "boot:term", label: "terminal" },
      { pid: 4243, started: "boot:agent", label: "agent" },
    ]);
    const observer = await f.open(100);
    f.processes.table.delete(200);
    const orphaned = await observer.status(600_000);
    expect(orphaned.blockers).toEqual([
      expect.objectContaining({
        participantId: "desktop",
        reason: "commands",
        label: expect.stringContaining("2 processes started by Desktop server"),
      }),
    ]);
    await expect(observer.freeze("tx", 600_000)).rejects.toThrow("2 processes");
    // One exits, and a reused PID with a different start time is not the original process.
    f.processes.table.delete(4242);
    f.processes.table.set(4243, "boot:reused");
    expect((await observer.status(600_000)).participants).toEqual([]);
    expect((await observer.status(600_000)).blockers[0]?.participantId).toBe("coordinator");
  });

  it("reports a single surviving descendant and keeps blocking after the registry is rewritten", async () => {
    const f = await fixture({ 100: "boot:1", 200: "boot:2", 4242: "boot:term" });
    const runtime = await f.open(200);
    await runtime.register(
      {
        id: "svc",
        label: "Service",
        kind: "service",
        homes: [await f.home("h")],
        updateTarget: true,
      },
      0,
    );
    await runtime.confirmBootstrap();
    await runtime.observe("svc", [], 0, [{ pid: 4242, started: "boot:term", label: "terminal" }]);
    f.processes.table.delete(200);
    const observer = await f.open(100);
    expect((await observer.status(0)).blockers[0]?.label).toContain(
      "A process started by Service is still running",
    );
    expect((await observer.status(0)).participants[0]).toMatchObject({ orphaned: true });
    expect((await observer.status(0)).blockers).toHaveLength(1);
  });

  it("lets a service runtime adopt only a fence whose local owner exited, and records its restored receipt separately", async () => {
    const f = await fixture();
    const owner = await f.open(100);
    const home = await f.home("h");
    await owner.register(
      { id: "service", label: "Service", kind: "service", homes: [home], updateTarget: true },
      0,
    );
    await owner.confirmBootstrap();
    await idle(owner, "service");
    await owner.freeze("tx", 600_000);
    f.processes.table.delete(100);
    const successor = await f.open(200);
    await successor.register(
      { id: "next", label: "Service", kind: "service", homes: [home], updateTarget: true },
      700_000,
      { adoptAbandonedFence: true },
    );
    const canonical = await NodeFSP.realpath(home);
    await successor.writeReceipt("tx", "next", canonical, "restored-ok", "restored");
    expect(await successor.readReceipt("tx", canonical, "restored")).toBe("restored-ok");
    expect(await successor.readReceipt("tx", canonical, "trial")).toBeNull();
  });

  it("refuses to adopt a live owner's fence or to adopt as a non-service runtime", async () => {
    const f = await fixture();
    const owner = await f.open(100);
    const home = await f.home("h");
    await owner.register(
      { id: "desktop", label: "Desktop", kind: "desktop", homes: [home], updateTarget: true },
      0,
    );
    await owner.confirmBootstrap();
    await idle(owner, "desktop");
    await owner.freeze("tx", 600_000);
    const other = await f.open(200);
    await expect(
      other.register(
        {
          id: "svc",
          label: "Service",
          kind: "service",
          homes: [await f.home("g")],
          updateTarget: true,
        },
        0,
        { adoptAbandonedFence: true },
      ),
    ).rejects.toThrow("still running");
    f.processes.table.delete(100);
    await expect(
      other.register(
        {
          id: "dev",
          label: "Dev",
          kind: "standalone",
          homes: [await f.home("i")],
          updateTarget: false,
        },
        0,
        { adoptAbandonedFence: true },
      ),
    ).rejects.toThrow("Only a service runtime");
  });

  it("requires an explicit parent control channel for WSL runtimes and ties their liveness to it", async () => {
    const f = await fixture();
    const store = await f.open(100);
    await expect(
      store.register(
        { id: "wsl", label: "Ubuntu", kind: "wsl", homes: ["/home/u/.t3"], updateTarget: true },
        0,
      ),
    ).rejects.toThrow("explicit parent control channel");
    await store.register(
      {
        id: "desktop",
        label: "Desktop",
        kind: "desktop",
        homes: [await f.home("win")],
        updateTarget: true,
      },
      0,
    );
    await store.register(
      {
        id: "wsl",
        label: "Ubuntu",
        kind: "wsl",
        homes: ["/home/u/.t3"],
        updateTarget: true,
        parentId: "desktop",
      },
      0,
    );
    await store.observe("wsl", [], 0);
    expect(
      (await store.status(0)).participants.map((participant) => participant.id).sort(),
    ).toEqual(["desktop", "wsl"]);
    const other = await f.open(200);
    await expect(other.observe("wsl", [], 0)).rejects.toThrow("Unregistered participant");
    f.processes.table.delete(100);
    expect((await other.status(0)).participants).toEqual([]);
  });
});

describe("process identity", () => {
  it("reads the darwin start time and treats ps exit 1 as exited", async () => {
    const run = (async () => ({ stdout: "Mon Oct  5 07:23:00 2026\n", stderr: "" })) as never;
    expect(await processCreationIdentity(42, "darwin", run)).toBe("Mon Oct  5 07:23:00 2026");
    const gone = (async () => {
      throw Object.assign(new Error("exit 1"), { code: 1 });
    }) as never;
    expect(await processCreationIdentity(42, "darwin", gone)).toBeNull();
  });
  it("reports unsupported platforms as a typed error callers can degrade on", async () => {
    await expect(processCreationIdentity(42, "freebsd")).rejects.toBeInstanceOf(
      UnsupportedPlatformError,
    );
  });
});

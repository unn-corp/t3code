import { describe, expect, it } from "@effect/vitest";
import {
  newJournal,
  type MaintenanceJournal,
  type MaintenancePhase,
} from "./forkMaintenanceJournal.ts";
import {
  advanceTransaction,
  beginRecoveryTransaction,
  beginUpdateTransaction,
  type TransactionPorts,
} from "./forkMaintenanceTransaction.ts";

/** In-memory durable journal with crash injection at any persist boundary. */
function harness(
  options: {
    readonly failOn?: Partial<Record<string, number>>;
    readonly crashAfterPersist?: MaintenancePhase;
  } = {},
) {
  const events: string[] = [];
  const disk = new Map<string, MaintenanceJournal>();
  const counts: Record<string, number> = {};
  let fenced = true;
  let clock = 0;
  const hit = (event: string) => {
    events.push(event);
    counts[event] = (counts[event] ?? 0) + 1;
    if (options.failOn?.[event] === counts[event]) throw new Error(`injected:${event}`);
  };
  const ports: TransactionPorts = {
    now: () => ++clock,
    load: async (id) => structuredClone(disk.get(id) ?? null),
    persist: async (journal) => {
      hit(`persist:${journal.phase}`);
      disk.set(journal.id, structuredClone(journal));
      if (journal.phase === options.crashAfterPersist) throw new Error("crash");
    },
    snapshot: async (home) => {
      hit(`snapshot:${home}`);
      return `snap-${home}`;
    },
    discardSnapshot: async (home) => void hit(`discard:${home}`),
    rescue: async (home) => {
      hit(`rescue:${home}`);
      return `rescue-${home}`;
    },
    startTrial: async () => void hit("startTrial"),
    verifyTrial: async (home, id) => {
      hit(`verifyTrial:${home}`);
      return `${id}:${home}`;
    },
    restore: async (home) => void hit(`restore:${home}`),
    verifyRestored: async (home, id) => {
      hit(`verifyRestored:${home}`);
      return `restored:${id}:${home}`;
    },
    release: async (id) => {
      const journal = disk.get(id);
      // Mirrors the store: admission is only released against a durable terminal journal.
      if (
        journal === undefined ||
        !["committed", "restore-verified", "aborted"].includes(journal.phase)
      )
        throw new Error("not releasable");
      hit("release");
      fenced = false;
    },
  };
  const initial = (kind: "update" | "recovery" = "update") =>
    newJournal({
      id: "tx1",
      kind,
      homes: ["windows", "wsl"],
      previous: { version: "1.0.0", artifactSha256: "a" },
      target: { version: "1.0.1", artifactSha256: "b" },
      now: 0,
      ...(kind === "recovery" ? { snapshots: { windows: "old-windows", wsl: "old-wsl" } } : {}),
    });
  return {
    ports,
    events,
    disk,
    initial,
    isFenced: () => fenced,
    phase: () => disk.get("tx1")?.phase,
  };
}

describe("durable multi-home update transaction", () => {
  it("snapshots every home before the trial and commits health receipts for all homes before release", async () => {
    const h = harness();
    const journal = await beginUpdateTransaction(h.initial(), h.ports);
    expect(h.events.indexOf("snapshot:wsl")).toBeLessThan(h.events.indexOf("startTrial"));
    expect(h.events.indexOf("persist:committed")).toBeLessThan(h.events.indexOf("release"));
    expect(h.events.indexOf("verifyTrial:wsl")).toBeLessThan(h.events.indexOf("persist:verified"));
    expect(journal.receipts).toEqual({ windows: "tx1:windows", wsl: "tx1:wsl" });
    expect(h.isFenced()).toBe(false);
  });

  it("aborts safely before any change when one home's snapshot fails, discarding what it made", async () => {
    const h = harness({ failOn: { "snapshot:wsl": 1 } });
    await expect(beginUpdateTransaction(h.initial(), h.ports)).rejects.toThrow(
      "aborted before any change",
    );
    expect(h.events).not.toContain("startTrial");
    expect(h.events).toContain("discard:windows");
    expect(h.phase()).toBe("aborted");
    expect(h.isFenced()).toBe(false);
  });

  it("restores the whole affected set and verifies the restored runtimes before releasing when WSL health fails", async () => {
    const h = harness({ failOn: { "verifyTrial:wsl": 1 } });
    const journal = await beginUpdateTransaction(h.initial(), h.ports);
    expect(journal.phase).toBe("restore-verified");
    const tail = h.events.slice(h.events.indexOf("persist:restoring"));
    expect(tail).toEqual([
      "persist:restoring",
      "restore:windows",
      "restore:wsl",
      "persist:restored",
      "verifyRestored:windows",
      "verifyRestored:wsl",
      "persist:restore-verified",
      "release",
    ]);
  });

  it("keeps admission fenced when the restored runtime cannot be verified", async () => {
    const h = harness({ failOn: { "verifyTrial:windows": 1, "verifyRestored:wsl": 1 } });
    await expect(beginUpdateTransaction(h.initial(), h.ports)).rejects.toThrow(
      "Restored runtime could not be verified",
    );
    expect(h.phase()).toBe("restore-failed");
    expect(h.isFenced()).toBe(true);
    expect(h.events).not.toContain("release");
  });

  it("treats a startTrial that throws as an unchanged, aborted transaction", async () => {
    const h = harness();
    const ports = {
      ...h.ports,
      startTrial: async () => {
        throw new Error("launcher rejected the request");
      },
    };
    await expect(beginUpdateTransaction(h.initial(), ports)).rejects.toThrow(
      "aborted before any change",
    );
    expect(h.phase()).toBe("aborted");
    expect(h.events.some((event) => event.startsWith("restore:"))).toBe(false);
    expect(h.isFenced()).toBe(false);
  });

  it("rejects a missing trial receipt and restores", async () => {
    const h = harness();
    const ports = { ...h.ports, verifyTrial: async () => "" };
    expect((await beginUpdateTransaction(h.initial(), ports)).phase).toBe("restore-verified");
  });

  describe("process crash at every durable boundary", () => {
    // A process that died before the trial began leaves these; resuming abandons safely.
    it.each(["fenced", "snapshotted"] as const)(
      "abandons a transaction found at %s without touching live data",
      async (phase) => {
        const h = harness();
        h.disk.set("tx1", {
          ...h.initial(),
          phase,
          snapshots: phase === "snapshotted" ? { windows: "snap-windows", wsl: "snap-wsl" } : {},
        });
        const journal = await advanceTransaction("tx1", h.ports);
        expect(journal.phase).toBe("aborted");
        expect(
          h.events.some((event) => event.startsWith("restore:") || event === "startTrial"),
        ).toBe(false);
        expect(h.isFenced()).toBe(false);
      },
    );
    const resumeCases: ReadonlyArray<{
      readonly crash: MaintenancePhase;
      readonly end: MaintenancePhase;
      readonly restored: boolean;
    }> = [
      // Desktop exits to install: the next process finds `trial` and verifies.
      { crash: "trial", end: "committed", restored: false },
      { crash: "verified", end: "committed", restored: false },
      { crash: "committed", end: "committed", restored: false },
    ];
    it.each(resumeCases)(
      "resumes a transaction interrupted after persisting $crash",
      async ({ crash, end, restored }) => {
        const first = harness({ crashAfterPersist: crash });
        await expect(beginUpdateTransaction(first.initial(), first.ports)).rejects.toThrow();
        expect(first.phase()).toBe(crash);
        // A fresh process with the same durable journal and no memory of the first.
        const second = harness();
        second.disk.set("tx1", structuredClone(first.disk.get("tx1")!));
        const journal = await advanceTransaction("tx1", second.ports);
        expect(journal.phase).toBe(end);
        expect(second.events.some((event) => event.startsWith("restore:"))).toBe(restored);
        expect(second.isFenced()).toBe(false);
      },
    );

    it("replays an interrupted restoration for the entire set and never releases mid-restore", async () => {
      const first = harness({ failOn: { "verifyTrial:windows": 1, "restore:wsl": 1 } });
      await expect(beginUpdateTransaction(first.initial(), first.ports)).rejects.toThrow(
        "Restoration failed",
      );
      expect(first.phase()).toBe("restore-failed");
      expect(first.isFenced()).toBe(true);
      // Replay is explicit: put the journal back in `restoring` the way a crash would leave it.
      const second = harness();
      second.disk.set("tx1", {
        ...structuredClone(first.disk.get("tx1")!),
        phase: "restoring",
        failure: null,
      });
      const journal = await advanceTransaction("tx1", second.ports);
      expect(journal.phase).toBe("restore-verified");
      expect(second.events.filter((event) => event.startsWith("restore:"))).toEqual([
        "restore:windows",
        "restore:wsl",
      ]);
    });

    it("never restores older data after a commit whose write outcome is ambiguous", async () => {
      const h = harness({ failOn: { "persist:committed": 1 } });
      await expect(beginUpdateTransaction(h.initial(), h.ports)).rejects.toThrow(
        "injected:persist:committed",
      );
      expect(h.events.some((event) => event.startsWith("restore:"))).toBe(false);
      expect(h.isFenced()).toBe(true);
      // The write did not land: the journal still says verified, so resume commits.
      const journal = await advanceTransaction("tx1", h.ports);
      expect(journal.phase).toBe("committed");
      expect(h.isFenced()).toBe(false);
    });
  });
});

describe("explicit recovery transaction", () => {
  it("takes a verified rescue copy of every home before any destructive restore, then verifies restored runtimes", async () => {
    const h = harness();
    const journal = await beginRecoveryTransaction(h.initial("recovery"), h.ports);
    expect(journal.phase).toBe("restore-verified");
    expect(h.events.indexOf("rescue:wsl")).toBeLessThan(h.events.indexOf("restore:windows"));
    expect(journal.rescues).toEqual({ windows: "rescue-windows", wsl: "rescue-wsl" });
  });

  it("refuses recovery without a restore point for every affected home", async () => {
    const h = harness();
    const initial = { ...h.initial("recovery"), snapshots: { windows: "only" } };
    await expect(beginRecoveryTransaction(initial, h.ports)).rejects.toThrow(
      "restore point for every",
    );
    expect(h.events).toEqual([]);
  });

  it("aborts without replacing anything when a rescue copy fails and keeps the retained restore points", async () => {
    const h = harness({ failOn: { "rescue:wsl": 1 } });
    await expect(beginRecoveryTransaction(h.initial("recovery"), h.ports)).rejects.toThrow(
      "Rescue copy failed",
    );
    expect(h.events.some((event) => event.startsWith("restore:"))).toBe(false);
    // Only the rescue copy made here is discarded, never the retained history.
    expect(h.events.filter((event) => event.startsWith("discard:"))).toEqual(["discard:windows"]);
    expect(h.disk.get("tx1")?.snapshots).toEqual({ windows: "old-windows", wsl: "old-wsl" });
    expect(h.isFenced()).toBe(false);
  });
});

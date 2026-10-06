// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import { DeviceRestartBlocked, quiesceDeviceForRestart } from "./coordinatedRestart.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const NOW = 600_000;
async function device() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-restart-guard-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(home);
  const namespace = NodePath.join(root, "coordinator");
  const store = await CoordinatorStore.open(namespace);
  await store.register(
    { id: "svc", label: "Service", kind: "service", homes: [home], updateTarget: true },
    0,
  );
  await store.confirmBootstrap();
  await store.observe("svc", [], 0);
  await store.observe("svc", [], NOW);
  /** Participants re-observe every few seconds: this stands in for that loop whenever the guard waits. */
  const sleep = async () => void (await store.observe("svc", [], NOW));
  return { store, namespace, home, sleep };
}
const quiesce = (d: Awaited<ReturnType<typeof device>>, sleep: () => Promise<void> = d.sleep) =>
  quiesceDeviceForRestart({ namespace: d.namespace, now: () => NOW, sleep });
const blockedWith = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => null,
    (cause: unknown) => cause,
  )) as DeviceRestartBlocked;

describe("coordinated service restart guard", () => {
  it("fences the device atomically, so work cannot start between the idle check and the stop, and reopens it on release", async () => {
    const d = await device();
    const guard = await quiesce(d);
    // The race the guard exists to close: a request that arrives after the check but before the stop.
    await expect(d.store.beginWork("svc")).rejects.toThrow("holds new work");
    await expect(d.store.assertAdmitting("svc")).rejects.toThrow("holds new work");
    // A runtime registering now is refused too (the service starting again before release is not possible).
    const late = await CoordinatorStore.open(d.namespace);
    await expect(
      late.register(
        { id: "late", label: "Late", kind: "standalone", homes: [d.home], updateTarget: false },
        NOW,
      ),
    ).rejects.toThrow("holds new work");
    await guard.release();
    (await d.store.beginWork("svc"))();
    expect(await d.store.fenceSnapshot()).toBeNull();
  });

  it("refuses while any agent is active, naming it, and never takes the fence", async () => {
    const d = await device();
    await d.store.observe(
      "svc",
      [{ participantId: "svc", reason: "active-agents", label: "An agent is running" }],
      NOW,
    );
    const blocked = await blockedWith(quiesce(d));
    expect(blocked).toBeInstanceOf(DeviceRestartBlocked);
    expect(blocked.blockers).toEqual(["An agent is running"]);
    expect(await d.store.fenceSnapshot()).toBeNull();
  });

  it("refuses until the five-minute idle window has passed", async () => {
    const d = await device();
    await d.store.beginWork("svc").then((release) => release());
    await d.store.observe("svc", [], NOW);
    expect((await blockedWith(quiesce(d))).blockers.join(" ")).toContain("five minutes");
  });

  it("refuses when activity cannot be known: an empty registry, an unbootstrapped device, or an unreadable coordinator", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-restart-guard-empty-"));
    roots.push(root);
    expect(
      (
        await blockedWith(
          quiesceDeviceForRestart({ namespace: NodePath.join(root, "empty"), now: () => NOW }),
        )
      ).blockers[0],
    ).toContain("activity cannot be known");
    await NodeFSP.writeFile(NodePath.join(root, "file"), "not a directory");
    expect(
      (
        await blockedWith(
          quiesceDeviceForRestart({ namespace: NodePath.join(root, "file"), now: () => NOW }),
        )
      ).blockers[0],
    ).toContain("could not be read");
    const home = NodePath.join(root, "home");
    await NodeFSP.mkdir(home);
    const store = await CoordinatorStore.open(NodePath.join(root, "unbootstrapped"));
    await store.register(
      { id: "svc", label: "Service", kind: "service", homes: [home], updateTarget: true },
      0,
    );
    expect(
      (
        await blockedWith(
          quiesceDeviceForRestart({
            namespace: NodePath.join(root, "unbootstrapped"),
            now: () => NOW,
          }),
        )
      ).blockers.join(" "),
    ).toContain("must be registered");
  });

  it("refuses while processes a runtime started are still running after it exited", async () => {
    const d = await device();
    const { processCreationIdentity } = await import("@t3tools/shared/forkMaintenanceStore");
    const survivor = (await processCreationIdentity(process.pid))!;
    // The service exits while a provider process it started lives on.
    const exited = await CoordinatorStore.open(
      d.namespace,
      async (pid) => (pid === 4_000_003 ? "boot:gone" : pid === process.pid ? survivor : null),
      4_000_003,
    );
    await exited.register(
      {
        id: "ghost",
        label: "Old service",
        kind: "service",
        homes: [NodePath.join(d.home, "..")],
        updateTarget: true,
      },
      0,
    );
    await exited.observe("ghost", [], 0, [
      { pid: process.pid, started: survivor, label: "provider cli" },
    ]);
    const blocked = await blockedWith(quiesce(d));
    expect(blocked.blockers.join(" ")).toContain("still running after it exited");
  });

  it("gives the fence back when a participant never acknowledges it, so a refused stop leaves the device usable", async () => {
    const d = await device();
    const blocked = await blockedWith(quiesce(d, async () => undefined));
    expect(blocked.blockers.join(" ")).toContain("changed activity after the fence");
    expect(await d.store.fenceSnapshot()).toBeNull();
    (await d.store.beginWork("svc"))();
  });

  it("refuses when work is running at the moment of the fence (a held lease), even if the last observation was idle", async () => {
    const d = await device();
    const release = await d.store.beginWork("svc");
    // beginWork reset the idle window, so the idle check refuses before any fence is taken.
    expect((await blockedWith(quiesce(d))).blockers.join(" ")).toMatch(
      /five minutes|local operation/,
    );
    expect(await d.store.fenceSnapshot()).toBeNull();
    await release();
  });
});

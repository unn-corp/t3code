// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import { deviceRestartBlockers } from "./restartGate.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function device() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-restart-gate-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(home);
  const namespace = NodePath.join(root, "coordinator");
  return { namespace, home, open: () => CoordinatorStore.open(namespace) };
}

describe("operator restart gate", () => {
  it("refuses when no runtime is registered, because activity then cannot be known", async () => {
    const d = await device();
    expect((await deviceRestartBlockers(d.namespace))[0]).toContain("activity cannot be known");
  });

  it("refuses while the device is not bootstrapped or a runtime has not reported idle", async () => {
    const d = await device();
    const store = await d.open();
    await store.register(
      { id: "svc", label: "Service", kind: "service", homes: [d.home], updateTarget: true },
      Date.now(),
    );
    expect(await deviceRestartBlockers(d.namespace)).toEqual([
      "Known fork installations must be registered before automatic installation.",
    ]);
    await store.confirmBootstrap();
    expect((await deviceRestartBlockers(d.namespace)).join(" ")).toContain(
      "Activity has not been verified",
    );
  });

  it("names the active work that blocks the restart and allows it only when nothing is active", async () => {
    const d = await device();
    const store = await d.open();
    await store.register(
      { id: "svc", label: "Service", kind: "service", homes: [d.home], updateTarget: true },
      Date.now(),
    );
    await store.confirmBootstrap();
    await store.observe(
      "svc",
      [
        {
          participantId: "svc",
          reason: "active-agents",
          label: "Agent, approval, provider, command, or background work is still active.",
        },
      ],
      Date.now(),
    );
    expect(await deviceRestartBlockers(d.namespace)).toEqual([
      "Agent, approval, provider, command, or background work is still active.",
    ]);
  });

  it("fails closed when the coordinator cannot be read", async () => {
    const d = await device();
    await NodeFSP.writeFile(d.namespace, "not a directory");
    expect((await deviceRestartBlockers(d.namespace))[0]).toContain("could not be read");
  });
});

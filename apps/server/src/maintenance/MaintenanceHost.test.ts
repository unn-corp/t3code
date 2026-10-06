// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { newJournal, type MaintenanceJournal } from "@t3tools/shared/forkMaintenanceJournal";
import { createSnapshot } from "@t3tools/shared/forkMaintenanceSnapshot";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import {
  acquireMaintenanceHost,
  participantKindFor,
  resetMaintenanceHostsForTests,
  MAINTENANCE_TRIAL_ENV,
} from "./MaintenanceHost.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";

const roots: string[] = [];
beforeEach(() => resetMaintenanceHostsForTests());
afterEach(async () => {
  resetMaintenanceHostsForTests();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

// A pid that cannot exist, so a fence it holds is provably abandoned.
const DEAD_PID = 4_000_001;
const realIdentity = async (pid: number) =>
  pid === DEAD_PID
    ? "boot:dead"
    : await import("@t3tools/shared/forkMaintenanceStore").then((m) =>
        m.processCreationIdentity(pid),
      );

async function device() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-host-test-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
  database.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('before')");
  database.close();
  await NodeFSP.writeFile(NodePath.join(home, "userdata", "settings.json"), "before");
  const namespace = NodePath.join(root, "coordinator");
  const canonical = await NodeFSP.realpath(home);
  const input = (overrides: { mode?: "web" | "desktop"; devUrl?: URL } = {}) => ({
    maintenance: { namespace },
    baseDir: home,
    mode: overrides.mode ?? ("web" as const),
    devUrl: overrides.devUrl,
  });
  /** A fence held by a process that has since exited, for the service runtime in `home`. */
  const abandonedFence = async (phase: MaintenanceJournal["phase"]) => {
    const owner = await CoordinatorStore.open(namespace, realIdentity, DEAD_PID);
    await owner.register(
      { id: "svc", label: "Service", kind: "service", homes: [home], updateTarget: true },
      0,
    );
    await owner.confirmBootstrap();
    await owner.observe("svc", [], 0);
    await owner.observe("svc", [], 600_000);
    const snapshotId = await createSnapshot(canonical, "tx-1");
    await NodeFSP.writeFile(NodePath.join(home, "userdata", "settings.json"), "after the update");
    await owner.freeze("tx-1", 600_000);
    await owner.writeJournal({
      ...newJournal({
        id: "tx-1",
        kind: "update",
        homes: [canonical],
        previous: { version: "1.0.0", artifactSha256: "a" },
        target: { version: "1.0.1", artifactSha256: "b" },
        now: 0,
        snapshots: { [canonical]: snapshotId },
      }),
      phase,
    });
    return { owner };
  };
  return { root, home, canonical, namespace, input, abandonedFence };
}
const launcherEnv = (update?: unknown, childVersion = "1.0.1") => ({
  [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    childVersion,
    capabilities: ["maintenance-trial"],
    ...(update === undefined ? {} : { update }),
  }),
});
// oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- the host is a promise-based process-wide singleton under test
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const acquire = (
  input: ReturnType<Awaited<ReturnType<typeof device>>["input"]>,
  env: NodeJS.ProcessEnv = {},
) => run(acquireMaintenanceHost(input, env));

describe("maintenance host and start gate", () => {
  it("touches no host files and advertises nothing when maintenance is not configured (isolated tests)", async () => {
    const d = await device();
    expect(
      await run(acquireMaintenanceHost({ baseDir: d.home, mode: "web", devUrl: undefined }, {})),
    ).toEqual({ mode: "disabled" });
    await expect(NodeFSP.stat(d.namespace)).rejects.toThrow();
  });

  it("classifies runtimes: only desktop and launcher-managed service are update targets", () => {
    expect(participantKindFor({ mode: "desktop", devUrl: undefined }, {})).toEqual({
      kind: "desktop",
      updateTarget: true,
    });
    expect(participantKindFor({ mode: "web", devUrl: undefined }, launcherEnv())).toEqual({
      kind: "service",
      updateTarget: true,
    });
    expect(participantKindFor({ mode: "web", devUrl: undefined }, {})).toEqual({
      kind: "standalone",
      updateTarget: false,
    });
    expect(
      participantKindFor({ mode: "desktop", devUrl: new URL("http://localhost:5733") }, {}),
    ).toEqual({ kind: "development", updateTarget: false });
  });

  it("registers with the canonical base home that contains userdata, not userdata itself", async () => {
    const d = await device();
    const host = await acquire(d.input());
    expect(host).toMatchObject({
      mode: "active",
      kind: "standalone",
      updateTarget: false,
      home: d.canonical,
      successorOf: null,
    });
    const store = await CoordinatorStore.open(d.namespace);
    expect((await store.status(Date.now())).participants[0]?.homes).toEqual([d.canonical]);
  });

  it("is one host per process and home, so the descriptor, the gate and the work lease agree", async () => {
    const d = await device();
    const first = await acquire(d.input());
    const second = await acquire(d.input());
    expect(second).toBe(first);
  });

  it("refuses any runtime that is not the transaction's own while a fence is held, before it can open the database", async () => {
    const d = await device();
    await d.abandonedFence("trial");
    // Standalone and desktop runtimes never adopt an abandoned fence.
    await expect(acquire(d.input())).rejects.toThrow("Device maintenance is in progress");
    resetMaintenanceHostsForTests();
    await expect(acquire(d.input({ mode: "desktop" }))).rejects.toThrow(
      "Device maintenance is in progress",
    );
    expect(await NodeFSP.readFile(NodePath.join(d.home, "userdata", "settings.json"), "utf8")).toBe(
      "after the update",
    );
  });

  it("starts a trial runtime only with its one-use capability, and strips it from the environment", async () => {
    const d = await device();
    const owner = await CoordinatorStore.open(d.namespace, realIdentity, DEAD_PID);
    await owner.register(
      { id: "svc", label: "Service", kind: "service", homes: [d.home], updateTarget: true },
      0,
    );
    await owner.confirmBootstrap();
    await owner.observe("svc", [], 0);
    await owner.observe("svc", [], 600_000);
    await owner.freeze("tx-1", 600_000);
    const capability = await owner.issueTrial("tx-1", d.canonical);
    const env: NodeJS.ProcessEnv = {
      ...launcherEnv({
        id: "u",
        fromVersion: "1.0.0",
        targetVersion: "1.0.1",
        dbPath: "/d",
        status: "pending",
      }),
      [MAINTENANCE_TRIAL_ENV]: JSON.stringify(capability),
    };
    const host = await acquire(d.input(), env);
    expect(host).toMatchObject({ mode: "active", trial: { transactionId: "tx-1" } });
    expect(env[MAINTENANCE_TRIAL_ENV]).toBeUndefined();
    // The same capability cannot start a second runtime.
    resetMaintenanceHostsForTests();
    await expect(
      acquire(d.input(), { ...launcherEnv(), [MAINTENANCE_TRIAL_ENV]: JSON.stringify(capability) }),
    ).rejects.toThrow();
  });

  it("rejects a malformed capability instead of starting without one", async () => {
    const d = await device();
    await expect(acquire(d.input(), { [MAINTENANCE_TRIAL_ENV]: "{not json" })).rejects.toThrow(
      "malformed",
    );
  });

  describe("service successor of an abandoned transaction", () => {
    it("abandons a transaction that never reached the trial and starts normally", async () => {
      const d = await device();
      await d.abandonedFence("snapshotted");
      const host = await acquire(d.input(), launcherEnv(undefined, "1.0.0"));
      expect(host).toMatchObject({ mode: "active", successorOf: null });
      const store = await CoordinatorStore.open(d.namespace);
      expect(await store.fenceSnapshot()).toBeNull();
      expect((await store.readJournal("tx-1"))?.phase).toBe("aborted");
      // Nothing was restored: the data is as the update left it.
      expect(
        await NodeFSP.readFile(NodePath.join(d.home, "userdata", "settings.json"), "utf8"),
      ).toBe("after the update");
    });

    it("adopts for commit when the launcher committed the new version, restoring nothing", async () => {
      const d = await device();
      await d.abandonedFence("trial");
      const host = await acquire(
        d.input(),
        launcherEnv(
          { id: "u", fromVersion: "1.0.0", targetVersion: "1.0.1", status: "committed" },
          "1.0.1",
        ),
      );
      expect(host).toMatchObject({ mode: "active", successorOf: "tx-1" });
      expect(
        await NodeFSP.readFile(NodePath.join(d.home, "userdata", "settings.json"), "utf8"),
      ).toBe("after the update");
      const store = await CoordinatorStore.open(d.namespace);
      expect((await store.readJournal("tx-1"))?.phase).toBe("trial");
      expect((await store.fenceSnapshot())?.transactionId).toBe("tx-1");
    });

    it("restores the snapshot before the database opens when the launcher rolled back, then adopts to verify", async () => {
      const d = await device();
      await d.abandonedFence("trial");
      const host = await acquire(
        d.input(),
        launcherEnv(
          {
            id: "u",
            fromVersion: "1.0.0",
            targetVersion: "1.0.1",
            status: "rolled-back",
            reason: "prepared-timeout",
          },
          "1.0.0",
        ),
      );
      expect(host).toMatchObject({ mode: "active", successorOf: "tx-1" });
      expect(
        await NodeFSP.readFile(NodePath.join(d.home, "userdata", "settings.json"), "utf8"),
      ).toBe("before");
      const store = await CoordinatorStore.open(d.namespace);
      expect((await store.readJournal("tx-1"))?.phase).toBe("restored");
      // Admission stays fenced until the restored runtime proves itself.
      expect((await store.fenceSnapshot())?.transactionId).toBe("tx-1");
    });

    it("stays blocked after a failed restoration instead of starting on unknown data", async () => {
      const d = await device();
      await d.abandonedFence("restore-failed");
      await expect(acquire(d.input(), launcherEnv(undefined, "1.0.0"))).rejects.toThrow();
    });
  });
});

// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import type { ForkBuildIdentity, ForkReleaseManifest } from "@t3tools/contracts";
import {
  createForkMaintenanceController,
  type ForkInstallerPorts,
  type PolicyState,
  type PolicyStore,
} from "./forkMaintenanceController.ts";
import { forkAssetFor, type ForkReleaseRecord } from "./forkMaintenance.ts";
import { CoordinatorStore } from "./forkMaintenanceStore.ts";

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const commit = (seed: string) => seed.repeat(40).slice(0, 40);
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

function releaseRecord(
  version: string,
  options: { id: number; digest: string; withdrawn?: boolean },
): ForkReleaseRecord {
  const channel = version.includes("nightly") ? "nightly" : "stable";
  const sourceCommit = commit(String(options.id));
  const assets = [
    {
      name: `T3-Code-${version}-x64.exe`,
      sha256: options.digest,
      bytes: 100,
      kind: "desktop" as const,
      platform: "windows-x64" as const,
    },
    {
      name: "recovery-helper.exe",
      sha256: sha("d"),
      bytes: 10,
      kind: "recovery-helper" as const,
      platform: "windows-x64" as const,
    },
    {
      name: `t3-${version}.apk`,
      sha256: sha("e"),
      bytes: 10,
      kind: "android" as const,
      platform: "android" as const,
    },
    {
      name: `t3-${version}-recovery.apk`,
      sha256: sha("f"),
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
        asset: assets[2]!.name,
        versionCode: 10,
        sourceVersion: version,
        sourceCommit,
        packageName: "com.devotek.t3code.pwa",
        signerSha256: sha("9"),
        updaterProtocol: 1,
      },
      recovery: {
        asset: assets[3]!.name,
        versionCode: 11,
        sourceVersion: "1.0.0",
        sourceCommit: commit("0"),
        packageName: "com.devotek.t3code.pwa",
        signerSha256: sha("9"),
        updaterProtocol: 1,
      },
    },
    checks: { build: true, install: true, update: true, recovery: true },
  };
  return {
    id: options.id,
    tagName: `fork-v${version}`,
    draft: false,
    body: options.withdrawn === true ? "<!-- t3-fork-release:withdrawn at=x reason=bad -->" : "",
    createdAt: "2026-10-05T07:30:00Z",
    publishedAt: "2026-10-05T07:30:00Z",
    assets: [
      ...assets.map((asset) => ({ name: asset.name, size: asset.bytes })),
      { name: "fork-release.json", size: 5 },
    ],
    manifest,
  };
}

const CURRENT: ForkBuildIdentity = {
  version: "1.0.0",
  commit: commit("1"),
  channel: "stable",
  artifactSha256: sha("1"),
};

async function harness(options: { channel?: "stable" | "nightly"; autoInstall?: boolean } = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-controller-test-"));
  directories.push(directory);
  const table = new Map<number, string>([
    [100, "boot:100"],
    [200, "boot:200"],
    [300, "boot:300"],
  ]);
  const identity = async (pid: number) => table.get(pid) ?? null;
  const coordinator = NodePath.join(directory, "coordinator");
  const mkHome = async (name: string) => {
    const home = NodePath.join(directory, name);
    await NodeFSP.mkdir(home);
    return NodeFSP.realpath(home);
  };
  const homeA = await mkHome("windows");
  const homeB = await mkHome("wsl");
  const controllerStore = await CoordinatorStore.open(coordinator, identity, 100);
  const clock = { value: 0 };
  /** Runtimes currently alive on the device, each with the store of its own process. */
  let live: Array<{ store: CoordinatorStore; id: string }> = [];
  const stopRuntimes = () => {
    for (const pid of new Set(live.map((runtime) => runtime.store.owner.pid))) table.delete(pid);
    live = [];
  };
  const startRuntimes = async (
    pid: number,
    runtimes: ReadonlyArray<{ id: string; home: string; kind: "desktop" | "service" }>,
  ) => {
    table.set(pid, `boot:${pid}:${table.size}`);
    const store = await CoordinatorStore.open(coordinator, identity, pid);
    for (const runtime of runtimes) {
      await store.register(
        {
          id: runtime.id,
          label: runtime.id,
          kind: runtime.kind,
          homes: [runtime.home],
          updateTarget: true,
        },
        clock.value,
      );
      live.push({ store, id: runtime.id });
    }
    return store;
  };
  const idleRuntimes = async (blockers: Parameters<CoordinatorStore["observe"]>[1] = []) => {
    for (const runtime of live) await runtime.store.observe(runtime.id, blockers, clock.value);
  };
  const OLD = [
    { id: "desktop-server", home: homeA, kind: "desktop" as const },
    { id: "other-server", home: homeB, kind: "service" as const },
  ];
  const runtimeStore = await startRuntimes(200, OLD);
  await controllerStore.confirmBootstrap();
  // Runtimes have been idle for ten minutes.
  await idleRuntimes();
  clock.value = 600_000;
  await idleRuntimes();
  /** Whether new work is admitted, probed through whichever runtime is alive. */
  const admitting = async () => {
    const runtime = live[0]!;
    await runtime.store.beginWork(runtime.id).then((release) => release());
  };
  const fenced = async () => {
    const runtime = live[0]!;
    await expect(runtime.store.beginWork(runtime.id)).rejects.toThrow("holds new work");
  };

  const events: string[] = [];
  const reserves: boolean[] = [];
  let releases: ForkReleaseRecord[] = [releaseRecord("1.0.1", { id: 2, digest: sha("2") })];
  let policyDisk: PolicyState | null = null;
  const policy: PolicyStore = {
    read: async () => policyDisk,
    write: async (value) => void (policyDisk = value),
  };
  const behaviour = {
    cohortFails: false,
    authorization: false,
    feedFails: false,
    failTrialHome: null as string | null,
    failRestoredHome: null as string | null,
    snapshotFails: false,
    capacityFails: false,
    stageDigest: null as string | null,
    runtimesAcknowledge: true,
  };
  const points = new Map<
    string,
    { id: string; transactionId: string; createdAt: string; bytes: number }
  >();
  const installer: ForkInstallerPorts = {
    platform: "windows-x64",
    packaging: "nsis",
    cohort: {
      freeze: async (id) => {
        events.push(`cohort:freeze:${id.slice(0, 1)}`);
        if (behaviour.cohortFails) throw new Error("Ubuntu is not running");
      },
      mirrorJournal: async (journal) => void events.push(`cohort:mirror:${journal.phase}`),
      release: async () => void events.push("cohort:release"),
    },
    authorizationRequired: () =>
      behaviour.authorization ? "Installing the Debian package needs your authorization." : null,
    currentBuild: CURRENT,
    stage: async (selection) => {
      events.push("stage");
      return {
        artifactSha256:
          behaviour.stageDigest ??
          forkAssetFor(selection.manifest, "desktop", "windows-x64")!.sha256,
      };
    },
    recoveryReady: async () => true,
    affectedHomes: async () => [homeA, homeB],
    assertCapacity: async (_homes, reserve) => {
      reserves.push(reserve.rescue);
      if (behaviour.capacityFails)
        throw new Error("Not enough free space for restore points on: wsl.");
    },
    restorePoints: async (home) =>
      [...points.values()].filter((point) => point.id.includes(NodePath.basename(home))),
    homeLabel: (home) => NodePath.basename(home),
    binaryCompatible: async () => true,
    requiresPairing: async () => false,
    snapshot: async (home, id) => {
      if (behaviour.snapshotFails) throw new Error("disk full");
      const snapshotId = `tx-${id}-${NodePath.basename(home)}`;
      points.set(snapshotId, {
        id: snapshotId,
        transactionId: id,
        createdAt: `2026-10-05T0${points.size}:00:00.000Z`,
        bytes: 1000,
      });
      events.push(`snapshot:${NodePath.basename(home)}`);
      return snapshotId;
    },
    discardSnapshot: async (_home, id) => void points.delete(id),
    rescue: async (home) => `rescue-${NodePath.basename(home)}`,
    startTrial: async (journal) => {
      events.push("startTrial");
      // The old runtimes stop; the new build's runtimes start under the fence with a one-use capability and record receipts.
      stopRuntimes();
      table.set(300, `boot:300:${table.size}`);
      const trialStore = await CoordinatorStore.open(coordinator, identity, 300);
      for (const home of journal.homes) {
        if (behaviour.failTrialHome === home) continue;
        const id = `trial-${NodePath.basename(home)}`;
        const capability = await controllerStore.issueTrial(journal.id, home);
        await trialStore.register(
          { id, label: "Trial", kind: "desktop", homes: [home], updateTarget: true },
          clock.value,
          { trial: capability },
        );
        live.push({ store: trialStore, id });
        await trialStore.writeReceipt(journal.id, id, home, `healthy:${NodePath.basename(home)}`);
      }
    },
    verifyTrial: async (home, id) => {
      const receipt = await controllerStore.readReceipt(id, home);
      if (receipt === null) throw new Error(`No health receipt for ${NodePath.basename(home)}.`);
      return receipt;
    },
    restore: async (home) => void events.push(`restore:${NodePath.basename(home)}`),
    verifyRestored: async (home, id) => {
      if (behaviour.failRestoredHome === home) throw new Error("did not start");
      // The previous runtime for this home starts again on the restored data.
      if (!live.some((runtime) => OLD.some((old) => old.id === runtime.id))) {
        stopRuntimes();
        table.set(200, `boot:200:${table.size}`);
      }
      const old = OLD.find((candidate) => candidate.home === home)!;
      if (!live.some((runtime) => runtime.id === old.id)) {
        const store = await CoordinatorStore.open(coordinator, identity, 200);
        // The restored runtime starts under the fence with its own one-use capability, like any trial runtime.
        const capability = await controllerStore.issueTrial(id, home);
        await store.register(
          { id: old.id, label: old.id, kind: old.kind, homes: [old.home], updateTarget: true },
          clock.value,
          { trial: capability },
        );
        live.push({ store, id: old.id });
      }
      events.push(`verifyRestored:${NodePath.basename(home)}`);
      return `restored:${NodePath.basename(home)}`;
    },
  };
  const interaction = {
    value: null as { inputActiveAt: number | null; uploadsInFlight: number } | null,
  };
  const controller = createForkMaintenanceController({
    now: () => clock.value,
    // Each wait lets the registered runtimes observe again, as their five second loops would.
    sleep: async () => {
      if (behaviour.runtimesAcknowledge) await idleRuntimes();
    },
    store: controllerStore,
    policy,
    defaultPolicy: {
      channel: options.channel ?? "nightly",
      automaticInstallation: options.autoInstall ?? false,
      pinnedBuild: null,
      failedArtifactSha256: [],
      automationReviewRequired: false,
      cancelledTargetSha256: null,
    },
    feed: async () => {
      if (behaviour.feedFails) throw new Error("network unreachable");
      return releases;
    },
    installer,
    interaction: () => interaction.value,
  });
  return {
    controller,
    controllerStore,
    runtimeStore,
    table,
    coordinator,
    reserves,
    admitting,
    fenced,
    stopRuntimes,
    startRuntimes,
    addLive: (store: CoordinatorStore, id: string) => void live.push({ store, id }),
    open: (pid: number) => CoordinatorStore.open(coordinator, identity, pid),
    clock,
    events,
    behaviour,
    interaction,
    homeA,
    homeB,
    idleRuntimes,
    directory,
    policyDisk: () => policyDisk,
    setReleases: (next: ForkReleaseRecord[]) => void (releases = next),
    ready: async () => {
      await controller.check();
      await controller.stage();
      return controller.status();
    },
  };
}

describe("fork maintenance controller", () => {
  it("selects a newer eligible release, stages it against its recorded digest, and reports it installable", async () => {
    const h = await harness();
    const status = await h.ready();
    expect(status).toMatchObject({
      phase: "staged",
      targetBuild: { version: "1.0.1", artifactSha256: sha("2") },
      installable: true,
      blockers: [],
    });
  });

  it("reports exactly the homes an update replaces", async () => {
    const h = await harness();
    const status = await h.ready();
    expect((status.affectedHomes ?? []).map((home) => home.label).sort()).toEqual([
      "windows",
      "wsl",
    ]);
  });

  it("refuses to stage a payload whose digest differs from the release record", async () => {
    const h = await harness();
    h.behaviour.stageDigest = sha("9");
    await h.controller.check();
    const status = await h.controller.stage();
    expect(status.phase).toBe("available");
    expect(status.lastError).toContain("does not match the digest");
    expect(status.installable).toBe(false);
  });

  it("backs off exponentially after check failures without losing the previous target", async () => {
    const h = await harness();
    await h.ready();
    h.behaviour.feedFails = true;
    h.clock.value = 1_000_000;
    await h.idleRuntimes();
    const first = await h.controller.check();
    expect(first).toMatchObject({
      phase: "staged",
      targetBuild: { version: "1.0.1" },
      nextCheckAt: 1_000_000 + 60_000,
    });
    expect(first.lastError).toContain("network unreachable");
    expect((await h.controller.check()).nextCheckAt).toBe(1_000_000 + 120_000);
    h.behaviour.feedFails = false;
    const recovered = await h.controller.check();
    expect(recovered.lastError).toBeNull();
    expect(recovered.nextCheckAt).toBe(1_000_000 + 4 * 60 * 60 * 1000);
  });

  it("is hard-blocked by active agents and never offers to stop them", async () => {
    const h = await harness();
    await h.ready();
    await h.idleRuntimes([
      {
        participantId: "desktop-server",
        reason: "active-agents",
        threadId: "t1",
        label: "Agent active",
      },
    ]);
    const status = await h.controller.status();
    expect(status.installable).toBe(false);
    expect(status.blockers[0]).toMatchObject({ reason: "active-agents" });
    await expect(h.controller.install(sha("2"))).rejects.toThrow(/blocked/);
    expect(h.events).not.toContain("snapshot:windows");
  });

  it("rejects an install bound to a different build than the staged one", async () => {
    const h = await harness();
    await h.ready();
    await expect(h.controller.install(sha("3"))).rejects.toThrow("no longer the staged update");
  });

  it("rechecks eligibility against fresh release data and drops a withdrawn target", async () => {
    const h = await harness();
    await h.ready();
    h.setReleases([releaseRecord("1.0.1", { id: 2, digest: sha("2"), withdrawn: true })]);
    await expect(h.controller.install(sha("2"))).rejects.toThrow("withdrawn or replaced");
    const status = await h.controller.status();
    expect(status.targetBuild).toBeNull();
    expect(h.events).not.toContain("snapshot:windows");
  });

  it("snapshots every home, verifies receipts from all of them, commits, and offers recovery to the previous build", async () => {
    const h = await harness();
    await h.ready();
    const status = await h.controller.install(sha("2"));
    expect(status.phase).toBe("completed");
    expect(h.events.indexOf("snapshot:wsl")).toBeLessThan(h.events.indexOf("startTrial"));
    expect(status.recoveryOptions).toHaveLength(1);
    expect(status.recoveryOptions[0]).toMatchObject({
      requiresDataRestore: true,
      build: { version: "1.0.0" },
    });
    expect(status.recoveryOptions[0]!.homes.map((home) => home.label).sort()).toEqual([
      "windows",
      "wsl",
    ]);
    // Admission is open again once the commit is durable.
    await h.admitting();
  });

  it("fences cohort members right after the local fence, mirrors every journal phase, and releases them before the local fence", async () => {
    const h = await harness();
    await h.ready();
    await h.controller.install(sha("2"));
    const cohort = h.events.filter((event) => event.startsWith("cohort:"));
    expect(cohort[0]).toBe("cohort:freeze:u");
    expect(cohort).toEqual(
      expect.arrayContaining([
        "cohort:mirror:fenced",
        "cohort:mirror:snapshotted",
        "cohort:mirror:trial",
        "cohort:mirror:verified",
        "cohort:mirror:committed",
      ]),
    );
    expect(cohort.at(-1)).toBe("cohort:release");
    await h.admitting();
  });

  it("abandons before any snapshot and releases admission when a cohort member cannot be fenced", async () => {
    const h = await harness();
    await h.ready();
    h.behaviour.cohortFails = true;
    await expect(h.controller.install(sha("2"))).rejects.toThrow(
      "could not be fenced: Ubuntu is not running",
    );
    expect(h.events.filter((event) => event.startsWith("snapshot:"))).toEqual([]);
    expect(h.events).not.toContain("startTrial");
    h.behaviour.cohortFails = false;
    expect(await h.controller.status()).toMatchObject({ phase: "staged", installable: true });
    await h.admitting();
  });

  it("restores everything and holds automation when one home's trial runtime never becomes healthy", async () => {
    const h = await harness();
    await h.ready();
    h.behaviour.failTrialHome = h.homeB;
    const status = await h.controller.install(sha("2"));
    expect(status.phase).toBe("failed");
    expect(status.automationReviewRequired).toBe(true);
    expect(h.events.filter((event) => event.startsWith("restore:")).sort()).toEqual([
      "restore:windows",
      "restore:wsl",
    ]);
    expect(h.events.filter((event) => event.startsWith("verifyRestored:")).sort()).toEqual([
      "verifyRestored:windows",
      "verifyRestored:wsl",
    ]);
    expect(h.policyDisk()?.failedArtifactSha256).toEqual([sha("2")]);
    // The failed digest is never selected again, automatically or by a stale review.
    const next = await h.controller.check();
    expect(next.targetBuild).toBeNull();
    await h.admitting();
  });

  it("keeps admission fenced and reports recovery when the restored runtime cannot be verified", async () => {
    const h = await harness();
    await h.ready();
    h.behaviour.failTrialHome = h.homeA;
    h.behaviour.failRestoredHome = h.homeB;
    const status = await h.controller.install(sha("2"));
    expect(status.phase).toBe("recovery");
    await h.fenced();
  });

  it("aborts before any change and releases the fence when a snapshot fails", async () => {
    const h = await harness();
    await h.ready();
    h.behaviour.snapshotFails = true;
    const status = await h.controller.install(sha("2"));
    expect(status.phase).toBe("failed");
    expect(h.events).not.toContain("startTrial");
    expect(h.policyDisk()?.failedArtifactSha256 ?? []).toEqual([]);
    await h.admitting();
  });

  it("releases the fence when a participant never acknowledges it", async () => {
    const h = await harness();
    await h.ready();
    h.behaviour.runtimesAcknowledge = false;
    await expect(h.controller.install(sha("2"))).rejects.toThrow(
      "changed activity after the fence",
    );
    h.behaviour.runtimesAcknowledge = true;
    // Nothing ran, so the earned idle window stands and the staged update stays installable.
    expect(await h.controller.status()).toMatchObject({ phase: "staged", installable: true });
    await h.admitting();
  });

  it("checks capacity before the fence and again while quiescent", async () => {
    const h = await harness();
    await h.ready();
    h.behaviour.capacityFails = true;
    await expect(h.controller.install(sha("2"))).rejects.toThrow("Not enough free space");
    expect(h.events).not.toContain("snapshot:windows");
    await h.admitting();
  });

  describe("policy", () => {
    it("pins only the installed build, holds updates while pinned, and resume does not clear held automation", async () => {
      const h = await harness();
      await h.ready();
      await expect(h.controller.updatePolicy({ pinnedBuild: sha("8") })).rejects.toThrow(
        "Only the installed build",
      );
      const pinned = await h.controller.updatePolicy({ pinnedBuild: CURRENT.artifactSha256 });
      expect(pinned).toMatchObject({
        phase: "pinned",
        targetBuild: null,
        policy: { pinnedBuild: CURRENT.artifactSha256, automaticInstallation: false },
      });
      expect((await h.controller.check()).targetBuild).toBeNull();
      await h.controller.updatePolicy({ pinnedBuild: null });
      expect((await h.controller.check()).targetBuild?.version).toBe("1.0.1");
    });

    it("persists policy through the policy store and switching channels discards the staged target", async () => {
      const h = await harness({ channel: "nightly" });
      await h.ready();
      const status = await h.controller.updatePolicy({ channel: "stable" });
      expect(status.targetBuild).toBeNull();
      expect(h.policyDisk()?.channel).toBe("stable");
    });
  });

  describe("automatic installation", () => {
    it("waits for input and uploads, then counts down fifteen seconds, then installs", async () => {
      const h = await harness({ autoInstall: true });
      await h.ready();
      h.interaction.value = { inputActiveAt: h.clock.value - 1000, uploadsInFlight: 0 };
      expect((await h.controller.tick()).blockers[0]?.reason).toBe("input-active");
      h.interaction.value = { inputActiveAt: null, uploadsInFlight: 1 };
      expect((await h.controller.tick()).phase).toBe("waiting");
      h.interaction.value = { inputActiveAt: null, uploadsInFlight: 0 };
      const counting = await h.controller.tick();
      expect(counting.countdown).toMatchObject({ targetArtifactSha256: sha("2") });
      h.clock.value += 14_000;
      expect((await h.controller.tick()).phase).not.toBe("completed");
      h.clock.value += 1_000;
      expect((await h.controller.tick()).phase).toBe("completed");
    });

    it("stays cancelled for that build after the person cancels the countdown", async () => {
      const h = await harness({ autoInstall: true });
      await h.ready();
      await h.controller.tick();
      const cancelled = await h.controller.cancelCountdown();
      expect(cancelled.countdown).toBeNull();
      h.clock.value += 60_000;
      await h.idleRuntimes();
      expect((await h.controller.tick()).countdown).toBeNull();
      expect(h.events).not.toContain("startTrial");
    });

    it("waits and says why when installing needs an operating-system authorization, but still lets a person install", async () => {
      const h = await harness({ autoInstall: true });
      await h.ready();
      h.behaviour.authorization = true;
      const waiting = await h.controller.tick();
      expect(waiting).toMatchObject({ phase: "waiting", blockers: [{ reason: "authorization" }] });
      expect(waiting.countdown ?? null).toBeNull();
      h.clock.value += 60_000;
      await h.idleRuntimes();
      expect((await h.controller.tick()).phase).toBe("waiting");
      expect(h.events).not.toContain("startTrial");
      await h.idleRuntimes();
      expect((await h.controller.install(sha("2"))).phase).toBe("completed");
    });

    it("never installs automatically while restored automation awaits review", async () => {
      const h = await harness({ autoInstall: true });
      await h.ready();
      h.behaviour.failTrialHome = h.homeB;
      await h.controller.install(sha("2"));
      h.setReleases([releaseRecord("1.0.2", { id: 5, digest: sha("5") })]);
      await h.controller.check();
      await h.controller.stage();
      const waiting = await h.controller.tick();
      expect(
        waiting.blockers.some((blocker) => blocker.reason === "automation-review") ||
          waiting.automationReviewRequired,
      ).toBe(true);
      expect(waiting.countdown ?? null).toBeNull();
    });
  });

  describe("explicit recovery", () => {
    async function installed() {
      const h = await harness();
      await h.ready();
      const status = await h.controller.install(sha("2"));
      h.events.length = 0;
      // Time passes: the new build has been running with agents idle.
      h.clock.value += 600_000;
      await h.idleRuntimes();
      h.clock.value += 600_000;
      await h.idleRuntimes();
      return { h, option: status.recoveryOptions[0]! };
    }
    const request = (option: Awaited<ReturnType<typeof installed>>["option"]) => ({
      optionId: option.id,
      transactionId: option.transactionId,
      restoreTimestamps: Object.fromEntries(
        option.homes.map((home) => [home.id, home.restoreTimestamp]),
      ),
      acknowledgeDataRestore: true,
    });

    it("requires the exact recorded option, the exact restore timestamps, and explicit data-restore confirmation", async () => {
      const { h, option } = await installed();
      await expect(
        h.controller.recover({ ...request(option), optionId: "recovery-other" }),
      ).rejects.toThrow("no longer exists");
      await expect(
        h.controller.recover({
          ...request(option),
          restoreTimestamps: {
            ...request(option).restoreTimestamps,
            [h.homeA]: "2020-01-01T00:00:00.000Z",
          },
        }),
      ).rejects.toThrow("restore point changed");
      await expect(
        h.controller.recover({ ...request(option), restoreTimestamps: {} }),
      ).rejects.toThrow();
      await expect(
        h.controller.recover({ ...request(option), acknowledgeDataRestore: false }),
      ).rejects.toThrow("explicit confirmation");
      expect(h.events).toEqual([]);
    });

    it("restores every home, verifies the restored runtimes, then pins the reverted build and holds automation", async () => {
      const { h, option } = await installed();
      const status = await h.controller.recover(request(option));
      expect(status).toMatchObject({
        phase: "pinned",
        automationReviewRequired: true,
        policy: { pinnedBuild: CURRENT.artifactSha256, automaticInstallation: false },
      });
      expect(h.events.filter((event) => event.startsWith("restore:")).sort()).toEqual([
        "restore:windows",
        "restore:wsl",
      ]);
      expect(h.events.indexOf("verifyRestored:windows")).toBeGreaterThan(
        h.events.indexOf("restore:wsl"),
      );
      await h.admitting();
    });

    it("checks capacity with the rescue-copy doubling for recovery, and without it for an install", async () => {
      const { h, option } = await installed();
      // Install checked before and after the fence, never with a rescue copy.
      expect(h.reserves).toEqual([false, false]);
      h.reserves.length = 0;
      await h.controller.recover(request(option));
      expect(h.reserves).toEqual([true]);
    });

    it("is blocked by active agents like any other destructive change", async () => {
      const { h, option } = await installed();
      await h.idleRuntimes([
        { participantId: "desktop-server", reason: "active-agents", label: "Agent" },
      ]);
      await expect(h.controller.recover(request(option))).rejects.toThrow(/blocked/);
      expect(h.events).toEqual([]);
    });
  });

  describe("resuming an interrupted transaction", () => {
    /** The previous owner (pid 400) fenced, snapshotted, started the trial and then exited. */
    async function interrupted(withReceipts: boolean) {
      const h = await harness();
      h.table.set(400, "boot:400");
      const owner = await h.open(400);
      await owner.freeze("tx-resume", h.clock.value);
      const { newJournal } = await import("./forkMaintenanceJournal.ts");
      const journal = {
        ...newJournal({
          id: "tx-resume",
          kind: "update",
          homes: [h.homeA, h.homeB],
          previous: { version: "1.0.0", artifactSha256: CURRENT.artifactSha256 },
          target: { version: "1.0.1", artifactSha256: sha("2") },
          now: h.clock.value,
        }),
        phase: "trial" as const,
        snapshots: { [h.homeA]: "tx-tx-resume-windows", [h.homeB]: "tx-tx-resume-wsl" },
      };
      await owner.writeJournal(journal);
      h.stopRuntimes();
      if (withReceipts) {
        h.table.set(300, "boot:300:resume");
        const trial = await h.open(300);
        for (const [id, home] of [
          ["trial-windows", h.homeA],
          ["trial-wsl", h.homeB],
        ] as const) {
          const capability = await owner.issueTrial("tx-resume", home);
          await trial.register(
            { id, label: "Trial", kind: "desktop", homes: [home], updateTarget: true },
            h.clock.value,
            { trial: capability },
          );
          h.addLive(trial, id);
          await trial.writeReceipt("tx-resume", id, home, `healthy:${id}`);
        }
      }
      return h;
    }

    it("does nothing while the owner is still alive: it is still driving the transaction", async () => {
      const h = await interrupted(true);
      const status = await h.controller.resumeInterrupted();
      expect(status.transactionId).toBeNull();
      await h.fenced();
    });

    it("verifies receipts and commits once the owner exited, then reopens admission", async () => {
      const h = await interrupted(true);
      h.table.delete(400);
      const status = await h.controller.resumeInterrupted();
      expect(status.phase).toBe("completed");
      expect((await h.controllerStore.readJournal("tx-resume"))?.phase).toBe("committed");
      expect(h.events.some((event) => event.startsWith("restore:"))).toBe(false);
      await h.admitting();
    });

    it("restores and verifies the restored runtimes when receipts never arrived", async () => {
      const h = await interrupted(false);
      h.table.delete(400);
      const status = await h.controller.resumeInterrupted();
      expect(status).toMatchObject({ phase: "failed", automationReviewRequired: true });
      expect(h.events.filter((event) => event.startsWith("restore:")).sort()).toEqual([
        "restore:windows",
        "restore:wsl",
      ]);
      expect((await h.controllerStore.readJournal("tx-resume"))?.phase).toBe("restore-verified");
    });
  });
});

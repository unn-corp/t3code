/* oxlint-disable t3code/no-global-process-runtime -- node-only filesystem coordinator: the host platform is the point */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import type { ForkReleaseManifest } from "@t3tools/contracts";
import type { ForkPlatformKey } from "@t3tools/shared/forkMaintenance";
import {
  createForkMaintenanceController,
  deriveBuildIdentity,
} from "@t3tools/shared/forkMaintenanceController";
import type { ForkReleaseRecord } from "@t3tools/shared/forkMaintenance";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import { createServiceInstaller, type ServiceInstallerInput } from "./serviceInstaller.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
      ),
  );
});
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const commit = (seed: string) => seed.repeat(40).slice(0, 40);
const HOST_PLATFORM: ForkPlatformKey = process.platform === "win32" ? "windows-x64" : "linux-x64";

let nodeBytes: Uint8Array | undefined;
const realNode = async () => (nodeBytes ??= await NodeFSP.readFile(process.execPath));
const helperBytes = new TextEncoder().encode('console.log("recovery-helper-protocol=1");\n');
const archiveBytes = 3000;

async function releaseWithRecovery(version: string): Promise<ForkReleaseRecord> {
  const node = await realNode();
  const assets = [
    {
      name: `t3-${version}-${HOST_PLATFORM}.tar.gz`,
      sha256: sha("2"),
      bytes: archiveBytes,
      kind: "server" as const,
      platform: HOST_PLATFORM,
    },
    {
      name:
        HOST_PLATFORM === "windows-x64"
          ? "t3-recovery-helper-windows-x64.mjs"
          : "t3-recovery-helper-linux-x64.mjs",
      sha256: digest(helperBytes),
      bytes: helperBytes.length,
      kind: "recovery-helper" as const,
      platform: HOST_PLATFORM,
    },
    {
      name:
        HOST_PLATFORM === "windows-x64"
          ? "t3-recovery-node-windows-x64.exe"
          : "t3-recovery-node-linux-x64",
      sha256: digest(node),
      bytes: node.length,
      kind: "recovery-helper" as const,
      platform: HOST_PLATFORM,
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
  const sourceCommit = commit("2");
  const manifest = {
    format: 1,
    repository: "unn-corp/t3code",
    version,
    commit: sourceCommit,
    channel: "stable",
    releasedAt: "2026-10-05T00:00:00Z",
    assets,
    android: {
      normal: {
        asset: assets[3]!.name,
        versionCode: 10,
        sourceVersion: version,
        sourceCommit,
        packageName: "com.devotek.t3code.pwa",
        signerSha256: sha("9"),
        updaterProtocol: 1,
      },
      recovery: {
        asset: assets[4]!.name,
        versionCode: 11,
        sourceVersion: "1.0.0",
        sourceCommit: commit("0"),
        packageName: "com.devotek.t3code.pwa",
        signerSha256: sha("9"),
        updaterProtocol: 1,
      },
    },
    checks: { build: true, install: true, update: true, recovery: true },
  } as unknown as ForkReleaseManifest;
  return {
    id: 2,
    tagName: `fork-v${version}`,
    draft: false,
    body: "",
    createdAt: "2026-10-05T00:00:00Z",
    publishedAt: "2026-10-05T00:00:00Z",
    assets: [
      ...assets.map((asset) => ({ name: asset.name, size: asset.bytes })),
      { name: "fork-release.json", size: 5 },
    ],
    manifest,
  };
}

async function device() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-service-installer-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
  database.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('before')");
  database.close();
  const canonical = await NodeFSP.realpath(home);
  const store = await CoordinatorStore.open(NodePath.join(root, "coordinator"));
  await store.register(
    { id: "svc", label: "Service", kind: "service", homes: [canonical], updateTarget: true },
    0,
  );
  await store.confirmBootstrap();
  await store.observe("svc", [], 0);
  const clock = { value: 600_000 };
  await store.observe("svc", [], clock.value);
  const runtimes = new Set(["1.0.0"]);
  const events: string[] = [];
  const launcher = {
    supportsMaintenanceTrial: true,
    requestUpdate: async (
      request: Parameters<ServiceInstallerInput["launcher"]["requestUpdate"]>[0],
    ) =>
      void events.push(
        `launcher:${request.targetVersion}:${request.trial.transactionId}`,
      ) as unknown as string,
  };
  const input: ServiceInstallerInput = {
    home: canonical,
    store,
    platform: HOST_PLATFORM,
    currentBuild: deriveBuildIdentity({
      version: "1.0.0",
      commit: commit("1"),
      recordedArtifactSha256: sha("1"),
    }),
    launcher: launcher as ServiceInstallerInput["launcher"],
    dbPath: NodePath.join(canonical, "userdata", "statev2.sqlite"),
    stageRuntime: async ({ version, expectedArchiveSha256 }) => {
      events.push(`stage:${version}:${expectedArchiveSha256}`);
      runtimes.add(version);
    },
    runtimeExists: async (version) => runtimes.has(version),
    recoveryCacheDir: NodePath.join(root, "coordinator", "recovery"),
    fetchReleaseAsset: async (_tag, name) =>
      name.endsWith(".mjs") ? helperBytes : await realNode(),
    now: () => clock.value,
    sleep: async (ms) => void (clock.value += ms),
    trialTimeoutMs: 5,
    restoredTimeoutMs: 5,
  };
  return { root, canonical, store, clock, events, runtimes, input };
}

describe("launcher-managed service installer", () => {
  it("is unavailable, with the reason, on an unsupported platform, an old launcher, or without a retained runtime", async () => {
    const d = await device();
    expect(
      await createServiceInstaller({ ...d.input, platform: null }).unavailableReason?.(),
    ).toContain("not published for this platform");
    expect(
      await createServiceInstaller({
        ...d.input,
        launcher: { ...d.input.launcher, supportsMaintenanceTrial: false },
      }).unavailableReason?.(),
    ).toContain("predates device maintenance");
    d.runtimes.clear();
    expect(await createServiceInstaller(d.input).unavailableReason?.()).toContain("not retained");
    d.runtimes.add("1.0.0");
    expect(await createServiceInstaller(d.input).unavailableReason?.()).toBeNull();
  });

  it("stages the runtime against the manifest digest and caches the helper and its Node outside the app before recovery is ready", async () => {
    const d = await device();
    const installer = createServiceInstaller(d.input);
    const release = await releaseWithRecovery("1.0.1");
    expect(await installer.recoveryReady({ record: release, manifest: release.manifest! })).toBe(
      false,
    );
    const staged = await installer.stage({ record: release, manifest: release.manifest! });
    expect(staged.artifactSha256).toBe(sha("2"));
    expect(d.events).toContain(`stage:1.0.1:${sha("2")}`);
    expect(await installer.recoveryReady({ record: release, manifest: release.manifest! })).toBe(
      true,
    );
    if (process.platform !== "win32")
      expect(
        (await NodeFSP.stat(NodePath.join(d.root, "coordinator", "recovery", "current.json")))
          .mode & 0o077,
      ).toBe(0);
  });

  it("refuses a release with no unambiguous server archive", async () => {
    const d = await device();
    const release = await releaseWithRecovery("1.0.1");
    (release.manifest as { assets: unknown }).assets = release.manifest!.assets.filter(
      (asset) => asset.kind !== "server",
    );
    await expect(
      createServiceInstaller(d.input).stage({ record: release, manifest: release.manifest! }),
    ).rejects.toThrow("no unambiguous server archive");
    expect(d.events).toEqual([]);
  });

  it("asks the launcher for the update with a one-use capability for this home, and a launcher refusal aborts as unchanged", async () => {
    const d = await device();
    const installer = createServiceInstaller(d.input);
    await d.store.freeze("tx-1", d.clock.value);
    const journal = {
      ...(await import("@t3tools/shared/forkMaintenanceJournal")).newJournal({
        id: "tx-1",
        kind: "update",
        homes: [d.canonical],
        previous: { version: "1.0.0", artifactSha256: sha("1") },
        target: { version: "1.0.1", artifactSha256: sha("2") },
        now: 0,
      }),
    };
    await installer.startTrial(journal);
    expect(d.events).toEqual(["launcher:1.0.1:tx-1"]);
    const fence = await d.store.fenceSnapshot();
    expect(fence?.trials[d.canonical]).toMatchObject({ consumed: false });
    const refusing = createServiceInstaller({
      ...d.input,
      launcher: {
        supportsMaintenanceTrial: true,
        requestUpdate: async () => {
          throw new Error("Another server update is already pending.");
        },
      },
    });
    await expect(refusing.startTrial(journal)).rejects.toThrow("already pending");
    await expect(
      createServiceInstaller({
        ...d.input,
        launcher: { ...d.input.launcher, supportsMaintenanceTrial: false },
      }).startTrial(journal),
    ).rejects.toThrow("cannot carry a maintenance capability");
  });

  it("verifies the trial only from the receipt the trial runtime itself recorded, and never restores in-process", async () => {
    const d = await device();
    const installer = createServiceInstaller(d.input);
    await expect(installer.verifyTrial(d.canonical, "tx-1")).rejects.toThrow(
      "No health receipt for the trial runtime",
    );
    await expect(installer.verifyRestored(d.canonical, "tx-1")).rejects.toThrow("restored runtime");
    await expect(
      installer.restore(d.canonical, "tx-tx-1-restore-point-00000000", "tx-1"),
    ).rejects.toThrow("before the database opens");
  });

  it("drives a whole update through the shared controller: stage, fence, snapshot, launcher hand-off, receipt, commit, and offers recovery", async () => {
    const d = await device();
    const release = await releaseWithRecovery("1.0.1");
    const base = createServiceInstaller(d.input);
    // The successor process: it registers with the one-use capability and records its health receipt.
    const installer = {
      ...base,
      startTrial: async (journal: Parameters<typeof base.startTrial>[0]) => {
        const capability = await d.store.issueTrial(journal.id, d.canonical);
        d.events.push(`launcher:${journal.target!.version}:${journal.id}`);
        const successor = await CoordinatorStore.open(
          NodePath.join(d.root, "coordinator"),
          async (pid) => (pid === 4_000_002 ? "boot:trial" : pid === process.pid ? "self" : null),
          4_000_002,
        );
        await successor.register(
          {
            id: "trial",
            label: "Trial service",
            kind: "service",
            homes: [d.canonical],
            updateTarget: true,
          },
          d.clock.value,
          { trial: capability },
        );
        await successor.writeReceipt(journal.id, "trial", d.canonical, "healthy", "trial");
        // The old process is stopped by the launcher: its registration goes away.
        await d.store.unregister("svc");
      },
    };
    const controller = createForkMaintenanceController({
      now: () => d.clock.value,
      sleep: async () => {
        await d.store.observe("svc", [], d.clock.value).catch(() => undefined);
      },
      store: d.store,
      policy: { read: async () => null, write: async () => undefined },
      defaultPolicy: {
        channel: "stable",
        automaticInstallation: false,
        pinnedBuild: null,
        failedArtifactSha256: [],
        automationReviewRequired: false,
        cancelledTargetSha256: null,
      },
      feed: async () => [release],
      installer: installer as never,
      interaction: () => null,
    });
    await controller.check();
    const staged = await controller.stage();
    expect(staged).toMatchObject({
      phase: "staged",
      installable: true,
      affectedHomes: [{ label: "This server" }],
    });
    const status = await controller.install(sha("2"));
    expect(status.phase).toBe("completed");
    expect(d.events.indexOf(`stage:1.0.1:${sha("2")}`)).toBeLessThan(
      d.events.findIndex((event) => event.startsWith("launcher:")),
    );
    expect(status.recoveryOptions).toHaveLength(1);
    expect(status.recoveryOptions[0]).toMatchObject({
      build: { version: "1.0.0" },
      homes: [{ label: "This server", binaryCompatible: true }],
    });
  });
});

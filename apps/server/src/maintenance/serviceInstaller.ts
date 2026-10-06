// @effect-diagnostics nodeBuiltinImport:off globalDate:off — filesystem restore points and a polling wait on another process.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ForkBuildIdentity } from "@t3tools/contracts";
import {
  forkInstallAssetFor,
  type ForkPlatformKey,
  type ForkTargetSelection,
} from "@t3tools/shared/forkMaintenance";
import { awaitReceipt, type ForkInstallerPorts } from "@t3tools/shared/forkMaintenanceController";
import {
  assertCapacity,
  createSnapshot,
  discardSnapshot,
  listRestorePoints,
  stateDirectory,
} from "@t3tools/shared/forkMaintenanceSnapshot";
import type { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import { installRecoveryHelper, recoveryReady } from "@t3tools/shared/forkRecoveryCache";
import type { ServiceMaintenanceTrial } from "../cloud/serviceProtocol.ts";

export interface ServiceInstallerInput {
  /** The canonical data home: the directory that contains `userdata`. */
  readonly home: string;
  readonly store: CoordinatorStore;
  readonly platform: ForkPlatformKey | null;
  readonly currentBuild: ForkBuildIdentity;
  readonly launcher: {
    readonly supportsMaintenanceTrial: boolean;
    readonly requestUpdate: (input: {
      readonly targetVersion: string;
      readonly dbPath: string;
      readonly trial: ServiceMaintenanceTrial;
    }) => Promise<string>;
  };
  readonly dbPath: string;
  /** Downloads, verifies against the manifest digest, extracts and preflights one exact runtime. */
  readonly stageRuntime: (input: {
    readonly version: string;
    readonly expectedArchiveSha256: string;
  }) => Promise<void>;
  readonly runtimeExists: (version: string) => Promise<boolean>;
  /** Recovery helper, cached outside the app directory (owner-only), shared by every runtime on the device. */
  readonly recoveryCacheDir: string;
  /** Reads one release asset from the fork release origin. */
  readonly fetchReleaseAsset: (tagName: string, assetName: string) => Promise<Uint8Array>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly trialTimeoutMs?: number;
  readonly restoredTimeoutMs?: number;
}

/** Adapters for a launcher-managed background service. The launcher is the only process that survives a binary swap. */
export function createServiceInstaller(input: ServiceInstallerInput): ForkInstallerPorts {
  const { home, store } = input;
  let stagedBytes = 0;
  const transactionOf = (restorePointId: string) =>
    /^tx-(.+?)-(?:restore-point|rescue)-[0-9a-f]{8}$/.exec(restorePointId)?.[1] ?? null;
  return {
    platform: input.platform,
    packaging: input.platform === null ? null : "service",
    currentBuild: input.currentBuild,
    unavailableReason: async () => {
      if (input.platform === null) return "Fork builds are not published for this platform.";
      if (!input.launcher.supportsMaintenanceTrial) {
        return "The installed service launcher predates device maintenance. Run `t3 service install` once to upgrade it, then updates can run in the product.";
      }
      if (!(await input.runtimeExists(input.currentBuild.version)))
        return "The running version's runtime is not retained, so a failed update could not be reversed.";
      return null;
    },
    stage: async (target: ForkTargetSelection) => {
      const asset =
        input.platform === null
          ? null
          : forkInstallAssetFor(target.manifest, input.platform, "service");
      if (asset === null)
        throw new Error("The release has no unambiguous server archive for this platform.");
      await input.stageRuntime({
        version: target.manifest.version,
        expectedArchiveSha256: asset.sha256,
      });
      // Recovery must exist before any change is made, so a failed update can always be reversed.
      await installRecoveryHelper({
        cacheDir: input.recoveryCacheDir,
        manifest: target.manifest,
        platform: input.platform!,
        fetchAsset: (name) => input.fetchReleaseAsset(target.record.tagName, name),
      });
      // Archive plus its extracted tree.
      stagedBytes = asset.bytes * 3;
      return { artifactSha256: asset.sha256 };
    },
    // The previous runtime stays launchable and the helper plus its own Node are cached and intact.
    recoveryReady: async () =>
      (await input.runtimeExists(input.currentBuild.version)) &&
      (await recoveryReady(input.recoveryCacheDir)),
    affectedHomes: async () => [home],
    assertCapacity: async (homes, reserve) =>
      assertCapacity(homes, {
        rescue: reserve.rescue,
        artifactBytesByHome: { [home]: stagedBytes },
      }),
    restorePoints: async (target) =>
      (await listRestorePoints(target))
        .filter((point) => point.kind === "restore-point")
        .map(({ id, transactionId, createdAt, bytes }) => ({
          id,
          transactionId,
          createdAt,
          bytes,
        })),
    homeLabel: () => "This server",
    binaryCompatible: async (_home, restorePointId) => {
      const transactionId = transactionOf(restorePointId);
      const journal = transactionId === null ? null : await store.readJournal(transactionId);
      return journal !== null && (await input.runtimeExists(journal.previous.version));
    },
    // The database changes constantly, so any write since the restore point would be lost: always say pairing may be affected.
    requiresPairing: async (target, restorePointId) => {
      const point = (await listRestorePoints(target)).find(
        (candidate) => candidate.id === restorePointId,
      );
      if (point === undefined) return true;
      return (
        (await NodeFSP.stat(NodePath.join(stateDirectory(target), "statev2.sqlite"))).mtimeMs >
        Date.parse(point.createdAt)
      );
    },
    snapshot: (target, transactionId) => createSnapshot(target, transactionId),
    discardSnapshot,
    rescue: (target, transactionId) => createSnapshot(target, transactionId, { kind: "rescue" }),
    startTrial: async (journal) => {
      if (!input.launcher.supportsMaintenanceTrial)
        throw new Error("The service launcher cannot carry a maintenance capability.");
      if (journal.target === null) throw new Error("The transaction has no target version.");
      const capability = await store.issueTrial(journal.id, home);
      // After the launcher accepts, it stops this process and starts the target as a trial child.
      await input.launcher.requestUpdate({
        targetVersion: journal.target.version,
        dbPath: input.dbPath,
        trial: capability,
      });
    },
    // This process is stopped by the launcher moments after it accepts; the successor verifies.
    verifyTrial: (target, transactionId) =>
      awaitReceipt(() => store.readReceipt(transactionId, target, "trial"), {
        timeoutMs: input.trialTimeoutMs ?? 5 * 60_000,
        pollMs: 1000,
        sleep: input.sleep,
        now: input.now,
        describe: "the trial runtime",
      }),
    restore: async () => {
      // Restoration needs the database closed. The successor runtime performs it before opening the database.
      throw new Error("Restoration runs before the database opens at the next start.");
    },
    verifyRestored: (target, transactionId) =>
      awaitReceipt(() => store.readReceipt(transactionId, target, "restored"), {
        timeoutMs: input.restoredTimeoutMs ?? 10 * 60_000,
        pollMs: 1000,
        sleep: input.sleep,
        now: input.now,
        describe: "the restored runtime",
      }),
  };
}

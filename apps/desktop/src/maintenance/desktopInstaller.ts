// @effect-diagnostics nodeBuiltinImport:off globalDate:off — filesystem artifacts, restore points and polling of another process.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ForkBuildIdentity } from "@t3tools/contracts";
import {
  forkAssetUrl,
  forkInstallAssetFor,
  type ForkPackaging,
  type ForkPlatformKey,
  type ForkReleaseRecord,
  type ForkTargetSelection,
} from "@t3tools/shared/forkMaintenance";
import { capacityShortfalls } from "@t3tools/shared/forkMaintenanceAdmission";
import { awaitReceipt, type ForkInstallerPorts } from "@t3tools/shared/forkMaintenanceController";
import type { MaintenanceJournal } from "@t3tools/shared/forkMaintenanceJournal";
import { stateDirectory } from "@t3tools/shared/forkMaintenanceSnapshot";
import type { ReceiptSlot } from "@t3tools/shared/forkMaintenanceStore";
import {
  createCohortFence,
  createCohortStorage,
  parseWslHomeId,
  type CohortHome,
  type FenceControl,
  type WslMember,
} from "@t3tools/shared/forkMaintenanceWsl";
import {
  installRecoveryHelper,
  readRecoveryCommand,
  recoveryReady,
} from "@t3tools/shared/forkRecoveryCache";
import {
  pruneArtifacts,
  readVerifiedArtifact,
  stageVerifiedArtifact,
  type CachedArtifact,
  type DownloadFetch,
} from "./artifactCache.ts";
import {
  HANDOFF_EXIT_WAIT_MS,
  launchHandoff,
  type HandoffPlan,
  type SpawnDetached,
} from "./handoff.ts";
import { readInstallerIndex, recordInstaller } from "./installerIndex.ts";
import type { MaintenancePaths } from "./paths.ts";
import type { RelaunchEnvironment } from "@t3tools/shared/forkDesktopHandoff";
import { ensurePrivateDirectory } from "./privateDirectory.ts";

/** What the store records before a helper may replace the application: who may claim, and exactly which bytes. */
export interface HandoffAuthorization {
  readonly mode: "install" | "revert";
  /** The journal's own build identity for the build this handoff puts in place (target for install, previous for revert). */
  readonly buildArtifactSha256: string;
  /** The payload actually handed to the helper. It can differ from the build identity (a legacy build derives its identity). */
  readonly artifactSha256: string;
  /** The payload the other mode would put back. */
  readonly counterpartSha256: string | null;
}

export type DesktopPackaging = Exclude<ForkPackaging, "service">;

/** What this runtime, and only this runtime, can do. Everything else the installer asks for is a port. */
export interface DesktopRuntimeControl {
  /** Stops every backend (Windows and WSL) so nothing owns a home or holds a file the installer replaces. */
  readonly stopRuntimes: () => Promise<void>;
  /** Starts the backends again; the startup path hands each one its one-use trial capability. */
  readonly startRuntimes: () => Promise<void>;
  /** Marks the app as quitting for an update (bypassing quit confirmation) and quits. */
  readonly quit: () => Promise<void>;
  /** This process's own identity, for the helper to wait on. */
  readonly self: () => Promise<{ readonly pid: number; readonly started: string }>;
}

export interface DesktopInstallerInput {
  readonly platform: ForkPlatformKey | null;
  readonly packaging: DesktopPackaging | null;
  readonly currentBuild: () => ForkBuildIdentity;
  /** The running build is the same version and commit (when both are known) as this recorded build. */
  readonly isBuild: (build: {
    readonly version: string;
    readonly commit?: string | undefined;
  }) => boolean;
  readonly paths: MaintenancePaths;
  readonly coordinatorDirectory: string;
  /** Why this runtime cannot update in-product (development build, unsupported platform), or null. */
  readonly unavailableReason: () => string | null;
  /** Debian installs prompt for operating-system authorization; automatic installation then waits for a person. */
  readonly authorizationRequired: () => string | null;
  readonly feed: () => Promise<ReadonlyArray<ForkReleaseRecord>>;
  readonly fetch: DownloadFetch;
  readonly readJournal: (transactionId: string) => Promise<MaintenanceJournal | null>;
  readonly readReceipt: (
    transactionId: string,
    home: string,
    slot: ReceiptSlot,
  ) => Promise<string | null>;
  /**
   * The whole cohort, resolved at call time: the Windows homes of registered update targets and every confirmed WSL
   * member, each with the control that runs storage verbs where that filesystem lives. Throws when a managed
   * distribution cannot be reached or is not a confirmed member: the cohort never proceeds on a home it cannot see.
   */
  readonly cohort: () => Promise<{
    readonly homes: ReadonlyArray<CohortHome>;
    readonly members: ReadonlyArray<{ readonly member: WslMember; readonly fence: FenceControl }>;
  }>;
  /** The desktop's own participant id: the explicit control-channel parent of every WSL member. Null until registered. */
  readonly parentId: () => string | null;
  /** True while a recovery transaction (not an update) holds the fence: it also writes a rescue copy of current data. */
  readonly rescueRequired: () => Promise<boolean>;
  readonly runtime: DesktopRuntimeControl;
  /** The process asked to quit for a replacement and is still here after waiting: its registry operations may run again. */
  readonly exitAbandoned?: () => void;
  /**
   * Records this process as the one that may hand the transaction to the external helper, with the exact payload hashes.
   * Always called immediately before the helper is launched; if it fails nothing is launched and the transaction fails
   * closed, so the helper never replaces a binary on the strength of its own plan alone.
   */
  readonly authorizeHandoff: (journalId: string, metadata: HandoffAuthorization) => Promise<void>;
  /** Executable launched after installation, and for AppImage the file replaced in place. */
  readonly installTarget: string;
  readonly relaunchEnvironment: RelaunchEnvironment;
  readonly spawn?: SpawnDetached;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly trialTimeoutMs?: number;
  readonly restoredTimeoutMs?: number;
  /** Test seam: statfs of the artifact filesystem. */
  readonly freeBytes?: (directory: string) => Promise<number>;
}

const NEVER = new Promise<never>(() => undefined);

export function createDesktopInstaller(input: DesktopInstallerInput) {
  const { paths } = input;
  let previousInstaller: CachedArtifact | null = null;

  const freeBytes =
    input.freeBytes ??
    (async (directory: string) => {
      const stats = await NodeFSP.statfs(directory);
      return Number(stats.bavail) * Number(stats.bsize);
    });

  /** Peak space for what a download adds, with the shared 10 percent / 1 GiB margin, before a byte is written. */
  const assertArtifactSpace = async (additionalBytes: number) => {
    await ensurePrivateDirectory(paths.root);
    const available = await freeBytes(paths.root);
    const short = capacityShortfalls([
      {
        filesystem: paths.root,
        requiredAdditionalBytes: additionalBytes,
        availableBytes: available,
      },
    ]);
    if (short.length > 0)
      throw new Error(`Not enough free space to download and verify the update on ${paths.root}.`);
  };

  const fetchBytes = async (tagName: string, assetName: string, expectedBytes: number) => {
    const response = await input.fetch(forkAssetUrl(tagName, assetName), {
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || response.body === null || response.body === undefined)
      throw new Error(`The release origin returned ${response.status} for ${assetName}.`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      // Recovery assets are small relative to installers; a larger body than recorded is refused, not buffered.
      if (total > expectedBytes)
        throw new Error(`${assetName} is larger than the release records.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };

  /**
   * The installer of the build that is running now, from the release that published it. A failed update
   * is reversed by reinstalling exactly this verified payload, so it is staged before anything changes.
   */
  const locatePreviousInstaller = async (
    records: ReadonlyArray<ForkReleaseRecord>,
  ): Promise<CachedArtifact | null> => {
    if (input.platform === null || input.packaging === null) return null;
    const current = input.currentBuild();
    const cachedByIdentity = await installerFor(current.artifactSha256);
    if (cachedByIdentity !== null) return cachedByIdentity;
    const record = records.find(
      (candidate) =>
        candidate.manifest !== null &&
        !candidate.draft &&
        input.isBuild({ version: candidate.manifest.version, commit: candidate.manifest.commit }),
    );
    const manifest = record?.manifest ?? null;
    if (record === undefined || manifest === null) return null;
    const asset = forkInstallAssetFor(manifest, input.platform, input.packaging);
    if (asset === null) return null;
    await assertArtifactSpace(
      (await readVerifiedArtifact(paths.artifacts, asset.sha256)) === null ? asset.bytes * 2 : 0,
    );
    return stageVerifiedArtifact({
      root: paths.artifacts,
      tagName: record.tagName,
      version: manifest.version,
      asset,
      fetch: input.fetch,
      now: input.now,
    });
  };

  /** The verified installer for a build identity: its own digest when an update installed it, else the one cached for it. */
  const installerFor = async (identitySha256: string): Promise<CachedArtifact | null> => {
    const direct = await readVerifiedArtifact(paths.artifacts, identitySha256);
    if (direct !== null) return direct;
    const cached = (await readInstallerIndex(paths.installerIndex))[identitySha256];
    return cached === undefined ? null : readVerifiedArtifact(paths.artifacts, cached);
  };

  const storage = async () => createCohortStorage((await input.cohort()).homes);
  /** Only freezing names the parent: a process resuming a transaction (not yet registered) still mirrors and releases. */
  const cohortFence = async (freezing: boolean) => {
    const { members } = await input.cohort();
    const parent = input.parentId();
    if (freezing && members.length > 0 && parent === null)
      throw new Error(
        "The desktop is not registered with the device coordinator, so it cannot hold a distribution's fence.",
      );
    return createCohortFence({ parentId: parent ?? "desktop", members });
  };

  const assertAuthorizedPlatform = () => {
    if (input.platform === null || input.packaging === null)
      throw new Error("This installation has no fork build for its platform and package type.");
  };

  const ports: ForkInstallerPorts & {
    readonly stagedPrevious: () => CachedArtifact | null;
    readonly prune: (protect: ReadonlySet<string>) => Promise<ReadonlyArray<string>>;
  } = {
    platform: input.platform,
    packaging: input.packaging,
    get currentBuild() {
      return input.currentBuild();
    },
    authorizationRequired: input.authorizationRequired,
    unavailableReason: async () => {
      const reason = input.unavailableReason();
      if (reason !== null) return reason;
      if (input.platform === null) return "Fork builds are not published for this platform.";
      if (input.packaging === null)
        return "This installation's package type cannot be updated in-product. Use the AppImage or the .deb package, or install a release by hand.";
      return null;
    },
    stage: async (target: ForkTargetSelection) => {
      assertAuthorizedPlatform();
      const { manifest, record } = target;
      const asset = forkInstallAssetFor(manifest, input.platform!, input.packaging!);
      if (asset === null)
        throw new Error(
          "The release has no unambiguous installer for this platform and package type.",
        );
      // Installer, its previous build, the helper and its runtime: all must exist and verify, or nothing is staged.
      const recoveryBytes = manifest.assets
        .filter((entry) => entry.kind === "recovery-helper" && entry.platform === input.platform)
        .reduce((sum, entry) => sum + entry.bytes, 0);
      const missing =
        (await readVerifiedArtifact(paths.artifacts, asset.sha256)) === null ? asset.bytes : 0;
      await assertArtifactSpace((missing + recoveryBytes) * 2);
      const staged = await stageVerifiedArtifact({
        root: paths.artifacts,
        tagName: record.tagName,
        version: manifest.version,
        asset,
        fetch: input.fetch,
        now: input.now,
      });
      await installRecoveryHelper({
        cacheDir: paths.recovery,
        manifest,
        platform: input.platform!,
        fetchAsset: (name) => {
          const entry = manifest.assets.find((candidate) => candidate.name === name);
          if (entry === undefined) throw new Error(`${name} is not in the release.`);
          return fetchBytes(record.tagName, name, entry.bytes);
        },
      });
      previousInstaller = await locatePreviousInstaller(await input.feed());
      if (previousInstaller === null)
        throw new Error(
          "The installer of the version you are running could not be cached, so this update could not be reversed.",
        );
      await recordInstaller(
        paths.installerIndex,
        input.currentBuild().artifactSha256,
        previousInstaller.sha256,
      );
      return { artifactSha256: staged.sha256 };
    },
    recoveryReady: async (target) => {
      if (input.platform === null || input.packaging === null) return false;
      const asset = forkInstallAssetFor(target.manifest, input.platform, input.packaging);
      if (asset === null || (await readVerifiedArtifact(paths.artifacts, asset.sha256)) === null)
        return false;
      if (!(await recoveryReady(paths.recovery))) return false;
      previousInstaller ??= await installerFor(input.currentBuild().artifactSha256);
      return (
        previousInstaller !== null &&
        (await readVerifiedArtifact(paths.artifacts, previousInstaller.sha256)) !== null
      );
    },
    affectedHomes: async () => (await storage()).affectedHomes(),
    assertCapacity: async (homes) => {
      // The installer is extracted on the first home's filesystem; budget the payload staged there.
      await (
        await storage()
      ).assertCapacity(homes, {
        rescue: await input.rescueRequired(),
        artifactBytes: previousInstaller?.bytes ?? 0,
      });
    },
    restorePoints: async (home) => (await storage()).restorePoints(home),
    homeLabel: (home) => {
      const wsl = parseWslHomeId(home);
      return wsl === null
        ? input.platform === "windows-x64"
          ? "Windows"
          : "Linux"
        : `WSL (${wsl.distro})`;
    },
    // No compatibility proof exists between an older binary and newer data, so a binary-only recovery is never offered.
    binaryCompatible: async () => false,
    requiresPairing: async (home, restorePointId) => {
      // A distribution's database cannot be statted from here: assume devices were paired since.
      if (parseWslHomeId(home) !== null) return true;
      const point = (await (await storage()).restorePoints(home)).find(
        (candidate) => candidate.id === restorePointId,
      );
      if (point === undefined) return true;
      return (
        (await NodeFSP.stat(NodePath.join(stateDirectory(home), "statev2.sqlite"))).mtimeMs >
        Date.parse(point.createdAt)
      );
    },
    snapshot: async (home, transactionId) => (await storage()).snapshot(home, transactionId),
    discardSnapshot: async (home, snapshotId) =>
      (await storage()).discardSnapshot(home, snapshotId),
    rescue: async (home, transactionId) => (await storage()).rescue(home, transactionId),
    cohort: {
      freeze: async (transactionId) => (await cohortFence(true)).freeze(transactionId),
      mirrorJournal: async (journal) => (await cohortFence(false)).mirrorJournal(journal),
      release: async (transactionId) => (await cohortFence(false)).release(transactionId),
    },

    startTrial: async (journal) => {
      assertAuthorizedPlatform();
      if (journal.target === null) throw new Error("The transaction has no target build.");
      const installer = await readVerifiedArtifact(paths.artifacts, journal.target.artifactSha256);
      if (installer === null) throw new Error("The verified installer is no longer cached.");
      const previous = previousInstaller ?? (await installerFor(journal.previous.artifactSha256));
      if (previous === null)
        throw new Error(
          "The previous build's installer is not cached, so the update could not be reversed.",
        );
      // A missing or altered helper throws here, before anything is stopped.
      const command = await readRecoveryCommand(paths.recovery);
      const owner = await input.runtime.self();
      const plan: HandoffPlan = {
        protocol: 1,
        mode: "install",
        transactionId: journal.id,
        coordinatorDirectory: input.coordinatorDirectory,
        owner,
        packaging: input.packaging!,
        installer: { path: installer.path, sha256: installer.sha256 },
        previousInstaller: { path: previous.path, sha256: previous.sha256 },
        installTarget: input.installTarget,
        relaunch: {
          command: input.installTarget,
          args: [],
          environment: input.relaunchEnvironment,
        },
        waitForExitMs: HANDOFF_EXIT_WAIT_MS,
      };
      // Everything above may throw and abort the transaction unchanged. The helper only waits for this process to exit.
      await input.authorizeHandoff(journal.id, {
        mode: "install",
        buildArtifactSha256: journal.target.artifactSha256,
        artifactSha256: installer.sha256,
        counterpartSha256: previous.sha256,
      });
      await launchHandoff({
        directory: paths.handoff,
        plan,
        command,
        ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
      });
      await input.runtime.stopRuntimes();
      await input.runtime.quit();
      // This process is on its way out; the target build verifies. Never report a trial result from here.
      await Promise.race([NEVER, input.sleep(HANDOFF_EXIT_WAIT_MS * 2)]);
      input.exitAbandoned?.();
      throw new Error("The app did not exit for the update.");
    },
    verifyTrial: async (home, transactionId) => {
      const journal = await input.readJournal(transactionId);
      if (journal === null || journal.target === null)
        throw new Error("The transaction has no target build.");
      // Only the target build can prove itself. If the previous build is running, the target never started.
      if (
        !input.isBuild({
          version: journal.target.version,
          ...(journal.target.commit === undefined ? {} : { commit: journal.target.commit }),
        })
      )
        throw new Error("The new version did not start.");
      return awaitReceipt(() => input.readReceipt(transactionId, home, "trial"), {
        timeoutMs: input.trialTimeoutMs ?? 5 * 60_000,
        pollMs: 1000,
        sleep: input.sleep,
        now: input.now,
        describe: "the trial runtime",
      });
    },
    restore: async (home, snapshotId, transactionId) => {
      // Idempotent: backends are stopped before any restore point is applied, and a crash replays this step.
      await input.runtime.stopRuntimes();
      await (await storage()).restore(home, snapshotId, transactionId);
    },
    verifyRestored: async (home, transactionId) => {
      const journal = await input.readJournal(transactionId);
      if (journal === null) throw new Error("The transaction journal is missing.");
      const runningPrevious = input.isBuild({
        version: journal.previous.version,
        ...(journal.previous.commit === undefined ? {} : { commit: journal.previous.commit }),
      });
      if (!runningPrevious) {
        // The target build is still the running binary: put the previous installer back, then the previous build proves itself.
        const previous = previousInstaller ?? (await installerFor(journal.previous.artifactSha256));
        const installer =
          journal.target === null
            ? null
            : await readVerifiedArtifact(paths.artifacts, journal.target.artifactSha256);
        if (previous === null) throw new Error("The previous build's installer is not cached.");
        const command = await readRecoveryCommand(paths.recovery);
        const owner = await input.runtime.self();
        await input.authorizeHandoff(transactionId, {
          mode: "revert",
          buildArtifactSha256: journal.previous.artifactSha256,
          artifactSha256: previous.sha256,
          counterpartSha256: installer?.sha256 ?? null,
        });
        await launchHandoff({
          directory: paths.handoff,
          command,
          plan: {
            protocol: 1,
            mode: "revert",
            transactionId,
            coordinatorDirectory: input.coordinatorDirectory,
            owner,
            packaging: input.packaging!,
            installer: { path: previous.path, sha256: previous.sha256 },
            previousInstaller:
              installer === null ? null : { path: installer.path, sha256: installer.sha256 },
            installTarget: input.installTarget,
            relaunch: {
              command: input.installTarget,
              args: [],
              environment: input.relaunchEnvironment,
            },
            waitForExitMs: HANDOFF_EXIT_WAIT_MS,
          },
          ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
        });
        await input.runtime.stopRuntimes();
        await input.runtime.quit();
        await Promise.race([NEVER, input.sleep(HANDOFF_EXIT_WAIT_MS * 2)]);
        input.exitAbandoned?.();
        throw new Error("The app did not exit to restore the previous version.");
      }
      // The previous build runs: its runtimes start under the transaction's capability and write "restored" receipts.
      await input.runtime.startRuntimes();
      return awaitReceipt(() => input.readReceipt(transactionId, home, "restored"), {
        timeoutMs: input.restoredTimeoutMs ?? 10 * 60_000,
        pollMs: 1000,
        sleep: input.sleep,
        now: input.now,
        describe: "the restored runtime",
      });
    },
    stagedPrevious: () => previousInstaller,
    prune: async (protect) => {
      const index = await readInstallerIndex(paths.installerIndex);
      return pruneArtifacts(
        paths.artifacts,
        new Set([
          ...protect,
          ...[...protect].flatMap((digest) =>
            index[digest] === undefined ? [] : [index[digest]!],
          ),
        ]),
      );
    },
  };
  return ports;
}

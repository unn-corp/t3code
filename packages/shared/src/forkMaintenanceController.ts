// @effect-diagnostics nodeBuiltinImport:off globalDate:off — the controller persists policy and talks to the host coordinator files.
/**
 * The one controller behind every update entry point: menus, IPC, desktop
 * automatic updates, remote RPC, CLI and MCP all call these methods, so they all
 * pass the same admission, idle, confirmation and recovery checks. Platform
 * behavior (downloading, launching trial runtimes, WSL homes) arrives as ports.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ForkMaintenanceError,
  type ForkActivityBlocker,
  type ForkBuildIdentity,
  type ForkMaintenanceInteraction,
  type ForkRecoveryOption,
  type ForkRecoveryRequest,
  type ForkUpdateChannel,
  type ForkUpdateCountdown,
  type ForkUpdatePolicyPatch,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  evaluateAutomaticInstall,
  forkCheckBackoffMs,
  forkInstallAssetFor,
  type ForkPackaging,
  forkPlatformKey,
  parseForkVersion,
  selectForkTarget,
  type ForkPlatformKey,
  type ForkReleaseRecord,
  type ForkTargetSelection,
} from "./forkMaintenance.ts";
import { newJournal, type MaintenanceJournal } from "./forkMaintenanceJournal.ts";
import type { CoordinatorStorePort } from "./forkMaintenanceStore.ts";
import {
  advanceTransaction,
  beginRecoveryTransaction,
  beginUpdateTransaction,
  MaintenanceTransactionError,
  type TransactionPorts,
} from "./forkMaintenanceTransaction.ts";

export interface PolicyState {
  readonly channel: ForkUpdateChannel;
  readonly automaticInstallation: boolean;
  /** Artifact digest of the build the device is held on, or null. */
  readonly pinnedBuild: string | null;
  /** Digests whose installation failed here. Never retried automatically. */
  readonly failedArtifactSha256: ReadonlyArray<string>;
  /** Restored schedules and queues stay held until a person reviews them. */
  readonly automationReviewRequired: boolean;
  /** The countdown the person cancelled; stays cancelled until another target appears. */
  readonly cancelledTargetSha256: string | null;
}
const PolicySchema = Schema.Struct({
  channel: Schema.Literals(["stable", "nightly"]),
  automaticInstallation: Schema.Boolean,
  pinnedBuild: Schema.NullOr(Schema.String),
  failedArtifactSha256: Schema.Array(Schema.String),
  automationReviewRequired: Schema.Boolean,
  cancelledTargetSha256: Schema.NullOr(Schema.String),
});
const decodePolicy = Schema.decodeUnknownSync(PolicySchema);

export interface PolicyStore {
  readonly read: () => Promise<PolicyState | null>;
  readonly write: (state: PolicyState) => Promise<void>;
}

/** JSON file policy. Every write is atomic; an unreadable file fails closed to the supplied default rather than guessing. */
export function createFilePolicyStore(file: string): PolicyStore {
  return {
    read: async () => {
      try {
        return decodePolicy(JSON.parse(await NodeFSP.readFile(file, "utf8")));
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return null;
        throw cause;
      }
    },
    write: async (state) => {
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
      const handle = await NodeFSP.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await NodeFSP.rename(temporary, file);
    },
  };
}

export interface ForkInstallerPorts extends Omit<
  TransactionPorts,
  "persist" | "load" | "now" | "release"
> {
  /** Null on a platform with no fork builds (Android, macOS, ARM). Everything fails closed. */
  readonly platform: ForkPlatformKey | null;
  /** Which payload this installation takes. Null fails closed: no payload is ever guessed. */
  readonly packaging: ForkPackaging | null;
  /**
   * Set when installing needs an operating-system authorization prompt (a Debian package). Automatic
   * installation then waits and shows why; only a person-initiated install proceeds, and the prompt is theirs to approve.
   */
  readonly authorizationRequired?: () => string | null;
  readonly currentBuild: ForkBuildIdentity;
  /** Downloads and digest-verifies the payload and the recovery assets. Returns the digest of the staged payload. */
  readonly stage: (target: ForkTargetSelection) => Promise<{ readonly artifactSha256: string }>;
  /** The recovery helper and previous builds are cached and verified, so a failed update can be reversed. */
  readonly recoveryReady: (target: ForkTargetSelection) => Promise<boolean>;
  /** Data homes a binary update affects (update-target participants and their control-channel children). */
  readonly affectedHomes: () => Promise<ReadonlyArray<string>>;
  /** Free space for restore points, rechecked while quiescent. Throws naming the short filesystems. */
  /**
   * `rescue` doubles each home's peak: recovery copies current data before it replaces it. Installs pass `false`.
   * Everything is checked per physical filesystem, on the filesystem that owns each home.
   */
  readonly assertCapacity: (
    homes: ReadonlyArray<string>,
    reserve: { readonly rescue: boolean },
  ) => Promise<void>;
  readonly restorePoints: (home: string) => Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly transactionId: string;
      readonly createdAt: string;
      readonly bytes: number;
    }>
  >;
  readonly homeLabel: (home: string) => string;
  /** Whether the previous binary can safely reopen the data restored for this home. */
  readonly binaryCompatible: (home: string, restorePointId: string) => Promise<boolean>;
  /** Whether restoring would drop devices paired after the restore point. */
  readonly requiresPairing: (home: string, restorePointId: string) => Promise<boolean>;
  /**
   * Members of the same cohort that keep their own coordinator registry (WSL distributions). The
   * controller fences them right after the local fence, mirrors every journal write into them, and
   * releases them before the local fence. A member that cannot be fenced aborts the whole transaction.
   */
  readonly cohort?: {
    readonly freeze: (transactionId: string) => Promise<void>;
    readonly mirrorJournal: (journal: MaintenanceJournal) => Promise<void>;
    readonly release: (transactionId: string) => Promise<void>;
  };
  /** Why this host cannot install in-product (no launcher capability, standalone, unsupported OS). Null when it can. */
  readonly unavailableReason?: () => Promise<string | null>;
}

export interface ForkControllerPorts {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * The registry operations the controller uses. A `CoordinatorStore` satisfies it; a test double or an adapter may too.
   * Members that keep their own registry (WSL) are NOT folded in here: they arrive as `installer.cohort` and cohort storage.
   */
  readonly store: CoordinatorStorePort;
  readonly policy: PolicyStore;
  readonly defaultPolicy: PolicyState;
  readonly feed: () => Promise<ReadonlyArray<ForkReleaseRecord>>;
  readonly installer: ForkInstallerPorts;
  /** Renderer interaction when this runtime has an interactive surface. */
  readonly interaction: () => ForkMaintenanceInteraction | null;
  readonly onStatus?: (status: ForkUpdateStatus) => void;
}

const ACK_ATTEMPTS = 40;
const ACK_INTERVAL_MS = 1000;
const fail = (reason: string, blockers?: ReadonlyArray<ForkActivityBlocker>) =>
  new ForkMaintenanceError({ reason, ...(blockers === undefined ? {} : { blockers }) });
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function createForkMaintenanceController(ports: ForkControllerPorts) {
  const { store, installer } = ports;
  let policy: PolicyState = ports.defaultPolicy;
  let policyLoaded = false;
  let phase: ForkUpdateStatus["phase"] = "idle";
  let target: ForkTargetSelection | null = null;
  let stagedSha256: string | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  let nextCheckAt: number | null = null;
  let countdown: ForkUpdateCountdown | null = null;
  /** Why automatic installation is waiting (input, uploads, review). Distinct from device blockers: manual installs ignore these. */
  let waitingBlockers: ReadonlyArray<ForkActivityBlocker> = [];
  let activeTransactionId: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  /** One action at a time, so a menu click, a poll, and a remote request cannot interleave. */
  const serialized = <A>(work: () => Promise<A>): Promise<A> => {
    const result = chain.then(work, work);
    chain = result.catch(() => undefined);
    return result;
  };
  const loadPolicy = async () => {
    if (policyLoaded) return;
    policy = (await ports.policy.read()) ?? ports.defaultPolicy;
    policyLoaded = true;
  };
  const savePolicy = async (next: PolicyState) => {
    await ports.policy.write(next);
    policy = next;
  };
  const artifactDigest = (manifest: ForkTargetSelection["manifest"]) =>
    installer.platform === null || installer.packaging === null
      ? null
      : (forkInstallAssetFor(manifest, installer.platform, installer.packaging)?.sha256 ?? null);
  const targetDigest = () => (target === null ? null : artifactDigest(target.manifest));
  const buildOf = (selection: ForkTargetSelection): ForkBuildIdentity => ({
    version: selection.manifest.version,
    commit: selection.manifest.commit,
    channel: selection.manifest.channel,
    artifactSha256: artifactDigest(selection.manifest) ?? "",
  });

  const coordinatorState = async (): Promise<{
    readonly id: string;
    readonly blockers: ReadonlyArray<ForkActivityBlocker>;
  }> => {
    try {
      const value = await store.status(ports.now());
      return { id: value.coordinatorId, blockers: value.blockers };
    } catch (cause) {
      return {
        id: "",
        blockers: [
          {
            participantId: "coordinator",
            reason: "bootstrap",
            label: `The device coordinator is unavailable: ${messageOf(cause)}`,
          },
        ],
      };
    }
  };
  const coordinatorBlockers = async () => (await coordinatorState()).blockers;

  const recoveryOptions = async (): Promise<ReadonlyArray<ForkRecoveryOption>> => {
    const options: ForkRecoveryOption[] = [];
    let journals: ReadonlyArray<MaintenanceJournal>;
    try {
      journals = await store.listJournals();
    } catch {
      return [];
    }
    for (const journal of [...journals].sort((a, b) => b.createdAt - a.createdAt)) {
      // Only an installed update has newer data to give up, and only a complete set of points can restore it.
      if (
        journal.kind !== "update" ||
        journal.phase !== "committed" ||
        journal.homes.some((home) => journal.snapshots[home] === undefined)
      )
        continue;
      const homes: ForkRecoveryOption["homes"][number][] = [];
      let complete = true;
      for (const home of journal.homes) {
        const point = (await installer.restorePoints(home)).find(
          (candidate) => candidate.id === journal.snapshots[home],
        );
        if (point === undefined) {
          complete = false;
          break;
        }
        homes.push({
          id: home,
          label: installer.homeLabel(home),
          restoreTimestamp: point.createdAt,
          binaryCompatible: await installer.binaryCompatible(home, point.id).catch(() => false),
          additionalBytes: point.bytes,
          requiresPairing: await installer.requiresPairing(home, point.id).catch(() => true),
        });
      }
      if (!complete) continue;
      const previous = journal.previous;
      options.push({
        id: `recovery-${journal.id}`,
        transactionId: journal.id,
        build: {
          version: previous.version,
          commit: previous.commit ?? "",
          channel: parseForkVersion(previous.version)?.channel ?? "stable",
          artifactSha256: previous.artifactSha256,
        },
        homes,
        requiresDataRestore: true,
      });
    }
    // Two retained previous builds, newest first.
    return options.slice(0, 2);
  };

  const status = async (): Promise<ForkUpdateStatus> => {
    await loadPolicy();
    const unavailable = await installer.unavailableReason?.();
    const coordinator = await coordinatorState();
    const blockers: ForkActivityBlocker[] = [...coordinator.blockers];
    if (unavailable !== null && unavailable !== undefined)
      blockers.push({ participantId: "coordinator", reason: "launcher", label: unavailable });
    const digest = targetDigest();
    const staged = stagedSha256 !== null && stagedSha256 === digest;
    const hardBlocked = blockers.length > 0;
    blockers.push(...waitingBlockers);
    let shown = phase;
    if (policy.pinnedBuild !== null && (phase === "idle" || phase === "available"))
      shown = "pinned";
    else if (staged && (phase === "staged" || phase === "downloaded" || phase === "waiting"))
      shown = blockers.length > 0 || countdown !== null ? "waiting" : "staged";
    const affectedHomes = await installer.affectedHomes().then(
      (homes) => homes.map((id) => ({ id, label: installer.homeLabel(id) })),
      () => [],
    );
    const result: ForkUpdateStatus = {
      coordinatorId: coordinator.id,
      ...(affectedHomes.length === 0
        ? {}
        : {
            controllerId: NodeCrypto.createHash("sha256")
              .update(JSON.stringify([coordinator.id, affectedHomes.map((home) => home.id).sort()]))
              .digest("hex"),
          }),
      phase: shown,
      policy: {
        channel: policy.channel,
        automaticInstallation: policy.automaticInstallation,
        pinnedBuild: policy.pinnedBuild,
      },
      currentBuild: installer.currentBuild,
      targetBuild: target === null ? null : buildOf(target),
      blockers,
      recoveryOptions: await recoveryOptions(),
      transactionId: activeTransactionId,
      automationReviewRequired: policy.automationReviewRequired,
      nextCheckAt,
      countdown,
      lastError,
      affectedHomes,
      installable:
        staged && !hardBlocked && policy.pinnedBuild === null && activeTransactionId === null,
    };
    return result;
  };
  const publish = async () => {
    const value = await status();
    ports.onStatus?.(value);
    return value;
  };

  const check = () =>
    serialized(async () => {
      await loadPolicy();
      if (activeTransactionId !== null) return publish();
      phase = "checking";
      await publish();
      try {
        const releases = await ports.feed();
        consecutiveFailures = 0;
        lastError = null;
        nextCheckAt = ports.now() + forkCheckBackoffMs(0);
        const selected = selectForkTarget({
          channel: policy.channel,
          installedVersion: installer.currentBuild.version,
          releases,
          pinnedBuild: policy.pinnedBuild,
          memory: { failedArtifactSha256: policy.failedArtifactSha256 },
          artifactSha256: artifactDigest,
        });
        const previousDigest = targetDigest();
        target = selected;
        if (selected === null) {
          stagedSha256 = null;
          countdown = null;
          phase = "idle";
        } else {
          if (artifactDigest(selected.manifest) !== previousDigest) {
            stagedSha256 = null;
            countdown = null;
          }
          phase = stagedSha256 === null ? "available" : "staged";
        }
      } catch (cause) {
        consecutiveFailures += 1;
        lastError = `Update check failed: ${messageOf(cause)}`;
        nextCheckAt = ports.now() + forkCheckBackoffMs(consecutiveFailures);
        phase = stagedSha256 !== null ? "staged" : target !== null ? "available" : "idle";
      }
      return publish();
    });

  const stage = () =>
    serialized(async () => {
      await loadPolicy();
      if (target === null || installer.platform === null) return publish();
      const digest = targetDigest();
      if (digest === null || stagedSha256 === digest) return publish();
      phase = "downloading";
      await publish();
      try {
        const staged = await installer.stage(target);
        if (staged.artifactSha256 !== digest)
          throw new Error(
            "The downloaded payload does not match the digest recorded in the release.",
          );
        if (!(await installer.recoveryReady(target)))
          throw new Error("Recovery assets are not cached, so this update cannot be reversed.");
        stagedSha256 = digest;
        lastError = null;
        phase = "staged";
      } catch (cause) {
        stagedSha256 = null;
        lastError = `Download failed: ${messageOf(cause)}`;
        consecutiveFailures += 1;
        nextCheckAt = ports.now() + forkCheckBackoffMs(consecutiveFailures);
        phase = "available";
      }
      return publish();
    });

  /** Acquires the device fence and waits for every participant to acknowledge it. */
  const fenceDevice = async (
    transactionId: string,
    homes: ReadonlyArray<string>,
    previous: ForkBuildIdentity,
    target: ForkTargetSelection | null,
    kind: MaintenanceJournal["kind"],
    snapshots?: Readonly<Record<string, string>>,
  ) => {
    try {
      await store.freeze(transactionId, ports.now());
    } catch (cause) {
      throw fail(`Installation is blocked: ${messageOf(cause)}`, await coordinatorBlockers());
    }
    const journal = newJournal({
      id: transactionId,
      kind,
      homes,
      previous: {
        version: previous.version,
        artifactSha256: previous.artifactSha256,
        commit: previous.commit,
      },
      target:
        target === null
          ? null
          : {
              version: target.manifest.version,
              artifactSha256: artifactDigest(target.manifest) ?? "",
              commit: target.manifest.commit,
            },
      now: ports.now(),
      ...(snapshots === undefined ? {} : { snapshots }),
    });
    await store.writeJournal(journal);
    if (installer.cohort !== undefined) {
      try {
        await installer.cohort.freeze(transactionId);
        await installer.cohort.mirrorJournal(journal);
      } catch (cause) {
        // A member that cannot be fenced means the cohort cannot be quiet: abandon before anything changed.
        await abortFence(transactionId);
        throw fail(
          `A member of this device's update could not be fenced: ${messageOf(cause)}`,
          await coordinatorBlockers(),
        );
      }
    }
    return journal;
  };
  const abortFence = async (transactionId: string) => {
    // Pre-trial journals resolve to the aborted boundary, which releases admission.
    await advanceTransaction(transactionId, transactionPorts()).catch(() => undefined);
  };
  const transactionPorts = (): TransactionPorts => ({
    now: ports.now,
    persist: async (journal) => {
      await store.writeJournal(journal);
      await installer.cohort?.mirrorJournal(journal);
    },
    load: (id) => store.readJournal(id),
    // Members first: if one cannot release, the local fence stays and the device stays fenced.
    release: async (id) => {
      await installer.cohort?.release(id);
      await store.releaseFence(id);
    },
    snapshot: installer.snapshot,
    discardSnapshot: installer.discardSnapshot,
    rescue: installer.rescue,
    startTrial: installer.startTrial,
    verifyTrial: installer.verifyTrial,
    restore: installer.restore,
    verifyRestored: installer.verifyRestored,
  });
  /** Every participant must re-observe after the fence; their observation loops run every few seconds. */
  const awaitAcknowledgement = async (transactionId: string) => {
    let last = "";
    for (let attempt = 0; attempt < ACK_ATTEMPTS; attempt += 1) {
      try {
        await store.recheck(transactionId, ports.now());
        return;
      } catch (cause) {
        last = messageOf(cause);
        if (!last.includes("acknowledged")) break;
        await ports.sleep(ACK_INTERVAL_MS);
      }
    }
    throw fail(
      `A participant changed activity after the fence: ${last}`,
      await coordinatorBlockers(),
    );
  };

  const recordOutcome = async (journal: MaintenanceJournal) => {
    if (journal.kind === "update") {
      if (journal.phase === "committed") {
        // The update is the new current build: drop its failure memory and any stale target.
        target = null;
        stagedSha256 = null;
        countdown = null;
        phase = "completed";
        lastError = null;
      } else if (journal.phase === "restore-verified" || journal.phase === "aborted") {
        const failedDigest = journal.target?.artifactSha256;
        if (
          journal.phase === "restore-verified" &&
          failedDigest !== undefined &&
          failedDigest !== ""
        ) {
          // The old data is back, but automation that ran while the trial held its homes needs a person's review.
          await savePolicy({
            ...policy,
            failedArtifactSha256: [...new Set([...policy.failedArtifactSha256, failedDigest])],
            automationReviewRequired: true,
          });
        }
        stagedSha256 = null;
        phase = "failed";
        lastError =
          journal.failure ?? "The update did not complete and the previous version was restored.";
      }
    } else if (journal.phase === "restore-verified") {
      // The reverted build is pinned until the person resumes updates; restored automation stays held.
      await savePolicy({
        ...policy,
        pinnedBuild: journal.previous.artifactSha256,
        automaticInstallation: false,
        automationReviewRequired: true,
      });
      target = null;
      stagedSha256 = null;
      phase = "pinned";
      lastError = null;
    } else if (journal.phase === "aborted") {
      phase = "failed";
      lastError = journal.failure ?? "Recovery did not begin.";
    }
  };
  const settle = async (transactionId: string, outcome: Promise<MaintenanceJournal>) => {
    try {
      await recordOutcome(await outcome);
    } catch (cause) {
      const journal = await store.readJournal(transactionId).catch(() => null);
      if (journal !== null) await recordOutcome(journal).catch(() => undefined);
      phase = journal?.phase === "restore-failed" ? "recovery" : "failed";
      lastError = messageOf(cause);
      if (cause instanceof MaintenanceTransactionError && cause.phase === "restore-failed")
        phase = "recovery";
    } finally {
      activeTransactionId = null;
    }
  };

  const runInstall = async (expectedSha256: string, automatic: boolean) => {
    await loadPolicy();
    const unavailable = await installer.unavailableReason?.();
    if (unavailable !== null && unavailable !== undefined) throw fail(unavailable);
    if (policy.pinnedBuild !== null)
      throw fail("Updates are held on a pinned build. Resume updates first.");
    if (target === null || stagedSha256 === null || targetDigest() !== stagedSha256)
      throw fail("No staged update is ready.");
    if (expectedSha256 !== stagedSha256)
      throw fail("The reviewed build is no longer the staged update.");
    if (activeTransactionId !== null) throw fail("An update is already in progress.");
    if (automatic && policy.automationReviewRequired)
      throw fail("Review restored automation before automatic updates resume.");
    // Eligibility and digests are re-read from the release origin at the moment of installation, never trusted from an earlier check.
    const fresh = selectForkTarget({
      channel: policy.channel,
      installedVersion: installer.currentBuild.version,
      releases: await ports.feed().catch((cause: unknown) => {
        throw fail(`Could not confirm the release is still eligible: ${messageOf(cause)}`);
      }),
      pinnedBuild: policy.pinnedBuild,
      memory: { failedArtifactSha256: policy.failedArtifactSha256 },
      artifactSha256: artifactDigest,
    });
    if (fresh === null || artifactDigest(fresh.manifest) !== expectedSha256) {
      target = fresh;
      stagedSha256 = null;
      phase = fresh === null ? "idle" : "available";
      throw fail("The release was withdrawn or replaced. Check for updates again.");
    }
    if (!(await installer.recoveryReady(fresh))) throw fail("Recovery assets are not cached.");
    const homes = await installer.affectedHomes();
    if (homes.length === 0) throw fail("No data home is registered for this update.");
    await installer.assertCapacity(homes, { rescue: false }).catch((cause: unknown) => {
      throw fail(messageOf(cause));
    });

    const transactionId = `u${ports.now()}-${NodeCrypto.randomUUID().slice(0, 8)}`;
    activeTransactionId = transactionId;
    phase = "installing";
    countdown = null;
    await publish();
    let journal: MaintenanceJournal;
    try {
      journal = await fenceDevice(transactionId, homes, installer.currentBuild, fresh, "update");
    } catch (cause) {
      activeTransactionId = null;
      phase = "staged";
      throw cause;
    }
    try {
      await awaitAcknowledgement(transactionId);
      // Capacity is rechecked now that nothing else is writing.
      await installer.assertCapacity(homes, { rescue: false }).catch((cause: unknown) => {
        throw fail(messageOf(cause));
      });
    } catch (cause) {
      await abortFence(transactionId);
      activeTransactionId = null;
      phase = "staged";
      throw cause;
    }
    phase = "installing";
    await settle(transactionId, beginUpdateTransaction(journal, transactionPorts()));
    return publish();
  };

  const install = (expectedSha256: string) => serialized(() => runInstall(expectedSha256, false));

  const tick = () =>
    serialized(async () => {
      await loadPolicy();
      if (activeTransactionId !== null || target === null || stagedSha256 === null)
        return publish();
      const gate = evaluateAutomaticInstall({
        now: ports.now(),
        blockers: await coordinatorBlockers(),
        automaticInstallation: policy.automaticInstallation && policy.pinnedBuild === null,
        targetArtifactSha256: stagedSha256,
        interaction: ports.interaction(),
        countdown,
        automationReviewRequired: policy.automationReviewRequired,
        cancelledTargetSha256: policy.cancelledTargetSha256,
      });
      const authorization = installer.authorizationRequired?.() ?? null;
      // An authorization prompt cannot be answered by nobody: automatic installs wait and say so.
      if (authorization !== null && (gate.state === "countdown" || gate.state === "install")) {
        waitingBlockers = [
          { participantId: "installer", reason: "authorization", label: authorization },
        ];
        countdown = null;
        return publish();
      }
      waitingBlockers = gate.state === "waiting" ? gate.blockers : [];
      if (gate.state === "countdown") countdown = gate.countdown;
      else countdown = null;
      if (gate.state === "install") {
        try {
          return await runInstall(stagedSha256, true);
        } catch (cause) {
          lastError = messageOf(cause);
          countdown = null;
        }
      }
      return publish();
    });

  const cancelCountdown = () =>
    serialized(async () => {
      await loadPolicy();
      if (countdown !== null) {
        await savePolicy({ ...policy, cancelledTargetSha256: countdown.targetArtifactSha256 });
        countdown = null;
      }
      return publish();
    });

  const updatePolicy = (patch: ForkUpdatePolicyPatch) =>
    serialized(async () => {
      await loadPolicy();
      if (activeTransactionId !== null)
        throw fail("Policy cannot change while an update is in progress.");
      let next: PolicyState = { ...policy };
      if (patch.channel !== undefined && patch.channel !== policy.channel) {
        next = { ...next, channel: patch.channel, cancelledTargetSha256: null };
        target = null;
        stagedSha256 = null;
        countdown = null;
        phase = "idle";
      }
      if (patch.automaticInstallation !== undefined)
        next = { ...next, automaticInstallation: patch.automaticInstallation };
      if (patch.pinnedBuild !== undefined) {
        if (
          patch.pinnedBuild !== null &&
          patch.pinnedBuild !== installer.currentBuild.artifactSha256
        )
          throw fail("Only the installed build can be pinned.");
        // Resuming never resumes held work: automation review is a separate, explicit step.
        next = {
          ...next,
          pinnedBuild: patch.pinnedBuild,
          ...(patch.pinnedBuild === null ? {} : { automaticInstallation: false }),
        };
        if (patch.pinnedBuild !== null) {
          target = null;
          stagedSha256 = null;
          countdown = null;
          phase = "idle";
        }
      }
      await savePolicy(next);
      return publish();
    });

  /** Person-confirmed review of restored automation. Separate from resuming updates. */
  const acknowledgeAutomationReview = () =>
    serialized(async () => {
      await loadPolicy();
      await savePolicy({ ...policy, automationReviewRequired: false });
      return publish();
    });

  const recover = (request: ForkRecoveryRequest) =>
    serialized(async () => {
      await loadPolicy();
      if (activeTransactionId !== null) throw fail("An update is already in progress.");
      const option = (await recoveryOptions()).find(
        (candidate) => candidate.id === request.optionId,
      );
      if (option === undefined || option.transactionId !== request.transactionId)
        throw fail("That recovery option no longer exists.");
      // The person confirmed these exact restore points; a different set (new snapshot, pruned point) invalidates the confirmation.
      for (const home of option.homes) {
        if (request.restoreTimestamps[home.id] !== home.restoreTimestamp)
          throw fail("The restore point changed. Review recovery again.");
      }
      if (Object.keys(request.restoreTimestamps).length !== option.homes.length)
        throw fail("The restore point set changed. Review recovery again.");
      if (option.requiresDataRestore && !request.acknowledgeDataRestore)
        throw fail("Restoring older data requires explicit confirmation.");
      const source = await store.readJournal(option.transactionId);
      if (source === null) throw fail("The recorded update is missing.");
      const transactionId = `r${ports.now()}-${NodeCrypto.randomUUID().slice(0, 8)}`;
      activeTransactionId = transactionId;
      phase = "recovery";
      let journal: MaintenanceJournal;
      try {
        journal = await fenceDevice(
          transactionId,
          source.homes,
          installer.currentBuild,
          null,
          "recovery",
          source.snapshots,
        );
        journal = { ...journal, previous: source.previous };
        await store.writeJournal(journal);
      } catch (cause) {
        activeTransactionId = null;
        phase = "idle";
        throw cause;
      }
      try {
        await awaitAcknowledgement(transactionId);
        await installer.assertCapacity(source.homes, { rescue: true }).catch((cause: unknown) => {
          throw fail(messageOf(cause));
        });
      } catch (cause) {
        await abortFence(transactionId);
        activeTransactionId = null;
        phase = "idle";
        throw cause;
      }
      await settle(transactionId, beginRecoveryTransaction(journal, transactionPorts()));
      return publish();
    });

  /** On startup: continue any transaction a previous process left in flight. Never restores after a commit. */
  const resumeInterrupted = () =>
    serialized(async () => {
      await loadPolicy();
      let fence: Awaited<ReturnType<CoordinatorStorePort["status"]>>["fence"];
      try {
        fence = (await store.status(ports.now())).fence;
      } catch {
        return publish();
      }
      // Only the process that outlives the transaction's owner may continue it. A live
      // owner is still driving it; a remote (control-channel) owner resumes its own.
      if (fence === null || fence.holderAlive !== false) return publish();
      const journal = await store.readJournal(fence.transactionId);
      if (journal === null) return publish();
      activeTransactionId = fence.transactionId;
      phase =
        journal.phase === "trial" || journal.phase === "verified" ? "verifying" : "installing";
      await settle(
        fence.transactionId,
        advanceTransaction(fence.transactionId, transactionPorts()),
      );
      return publish();
    });

  return {
    status: () => serialized(async () => status()),
    check,
    stage,
    install,
    tick,
    cancelCountdown,
    updatePolicy,
    acknowledgeAutomationReview,
    recover,
    resumeInterrupted,
  };
}

export type ForkMaintenanceController = ReturnType<typeof createForkMaintenanceController>;
export { forkPlatformKey };

/**
 * Identity of the running build. A build installed from a release records its artifact digest;
 * one that never recorded it (an installation that predates the coordinator) gets a stable
 * digest derived from its version and commit, so it can still be pinned and restored to.
 */
export function deriveBuildIdentity(input: {
  readonly version: string;
  readonly commit: string | null;
  readonly recordedArtifactSha256: string | null;
}): ForkBuildIdentity {
  const parsed = parseForkVersion(input.version);
  return {
    version: input.version,
    commit: input.commit ?? "",
    channel: parsed?.channel ?? "nightly",
    artifactSha256:
      input.recordedArtifactSha256 ??
      NodeCrypto.createHash("sha256")
        .update(`build:${input.version}:${input.commit ?? ""}`)
        .digest("hex"),
  };
}

/** A device on a nightly (or on a build older than fork releases) follows nightlies; a stable install follows stable. */
export const defaultChannelForBuild = (version: string): ForkUpdateChannel =>
  parseForkVersion(version)?.channel === "stable" ? "stable" : "nightly";

/** Waits for a receipt written by another process. Polling is bounded by the caller's deadline. */
export async function awaitReceipt(
  read: () => Promise<string | null>,
  options: {
    readonly timeoutMs: number;
    readonly pollMs: number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
    readonly describe: string;
  },
): Promise<string> {
  const deadline = options.now() + options.timeoutMs;
  for (;;) {
    const receipt = await read();
    if (receipt !== null) return receipt;
    if (options.now() >= deadline) throw new Error(`No health receipt for ${options.describe}.`);
    await options.sleep(options.pollMs);
  }
}

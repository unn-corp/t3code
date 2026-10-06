// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalTimers:off — the desktop controller owns real files, timers and the host registry.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  ForkMaintenanceError,
  type ForkActivityBlocker,
  type ForkBuildIdentity,
  type ForkMaintenanceActionInput,
  type ForkMaintenanceInteraction,
  type ForkRecoveryRequest,
  type ForkUpdatePolicyPatch,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import {
  FORK_CHECK_INTERVAL_MS,
  type ForkPackaging,
  type ForkPlatformKey,
  type ForkReleaseRecord,
} from "@t3tools/shared/forkMaintenance";
import {
  createFilePolicyStore,
  createForkMaintenanceController,
  defaultChannelForBuild,
  type ForkMaintenanceController,
  type PolicyState,
} from "@t3tools/shared/forkMaintenanceController";
import {
  decodeJournal,
  IN_FLIGHT_PHASES,
  type MaintenanceJournal,
} from "@t3tools/shared/forkMaintenanceJournal";
import {
  CoordinatorStore,
  coordinatorDirectory,
  processCreationIdentity,
  UNKNOWN_PROCESS_IDENTITY,
  type ProcessIdentity,
  type TrialCapability,
} from "@t3tools/shared/forkMaintenanceStore";
import { readRecoveryCommand, recoveryInvocation } from "@t3tools/shared/forkRecoveryCache";
import { type DownloadFetch } from "./artifactCache.ts";
import { createDesktopInstaller, type DesktopRuntimeControl } from "./desktopInstaller.ts";
import { createInteractionTracker } from "./interaction.ts";
import {
  readInstallerIndex as readIndex,
  recordInstaller as recordIndex,
} from "./installerIndex.ts";
import { readRecordedBuild, resolveCurrentBuild, writeRecordedBuild } from "./installedBuild.ts";
import { maintenancePaths } from "./paths.ts";
import {
  createLocalHomeControl,
  createRunnerFenceControl,
  createRunnerHomeControl,
  observeWslMembers,
  wslActivityIsCurrent,
  parseWslHomeId,
  wslHomeId,
  type CohortHome,
  type DistroRunner,
  type Exec,
  type FenceControl,
  type WslMember,
} from "@t3tools/shared/forkMaintenanceWsl";
import { memberIdFor, readMembers, writeMembers } from "./membership.ts";
import { executableOf, resolveWslHome, wslExec, type WslCommand } from "./wslTransport.ts";
import { pruneHandoffPlans, retainedInstallPlan, type SpawnDetached } from "./handoff.ts";
import { ensurePrivateDirectory } from "./privateDirectory.ts";
import { captureRelaunchEnvironment } from "@t3tools/shared/forkDesktopHandoff";
import { createStoreGate, type StoreGate } from "./storeGate.ts";

/** The capability variable the server's MaintenanceHost reads. Kept in step with apps/server/src/maintenance/MaintenanceHost.ts. */
export const MAINTENANCE_TRIAL_ENV = "T3CODE_MAINTENANCE_TRIAL";
export const OBSERVE_INTERVAL_MS = 5_000;
/** Transactions whose installers and handoff plans are kept for recovery. */
const RETAINED_TRANSACTIONS = 3;
export { FORK_CHECK_INTERVAL_MS };

export interface ManagedWslRuntime {
  readonly distro: string;
  /** Null while the distribution's runtime is not staged: its home cannot be reached, so installation blocks. */
  readonly command: WslCommand | null;
}

export interface DesktopMaintenanceInput {
  /** Namespace override for isolated tests; undefined uses this OS user's device registry. */
  readonly namespace?: string | undefined;
  readonly baseDir: string;
  readonly version: string;
  readonly commit: string | null;
  readonly platform: ForkPlatformKey | null;
  readonly packaging: Exclude<ForkPackaging, "service"> | null;
  readonly installTarget: string;
  /** Original app/profile location overrides, captured in private plans for external recovery. */
  readonly relaunchEnvironment?: Readonly<Record<string, string | undefined>>;
  /** A reason this process must not update in-product at all (development build, updates disabled), or null. */
  readonly disabledReason: string | null;
  readonly authorizationRequired: () => string | null;
  readonly feed: () => Promise<ReadonlyArray<ForkReleaseRecord>>;
  readonly fetch: DownloadFetch;
  readonly runtime: DesktopRuntimeControl;
  readonly managedWsl: () => Promise<ReadonlyArray<ManagedWslRuntime>>;
  /** The processes the desktop started (backends); they keep blocking if this process dies first. */
  readonly descendants: () => Promise<
    ReadonlyArray<{ readonly pid: number; readonly started: string; readonly label: string }>
  >;
  readonly hasWindow: () => boolean;
  readonly onStatus?: (status: ForkUpdateStatus) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly identity?: ProcessIdentity;
  /** Test seam: this process's pid as the registry sees it. */
  readonly selfPid?: number;
  readonly spawn?: SpawnDetached;
  /** Test seam: runs `wsl.exe` commands. */
  readonly exec?: Exec;
  readonly resolveWslHome?: (distro: string) => Promise<string | null>;
  readonly trialTimeoutMs?: number;
  readonly restoredTimeoutMs?: number;
  readonly freeBytes?: (directory: string) => Promise<number>;
  readonly userHasExistingData?: () => Promise<boolean>;
}

export type StartupPlan =
  /** Normal start (including a transaction that was just finished and released). */
  | { readonly kind: "idle" }
  /** This process is the trial runtime of an interrupted update: start the backends under the capability, then resume. */
  | { readonly kind: "trial"; readonly transactionId: string }
  /**
   * No backend may start: a device transaction holds the fence and this process cannot finish it (a restore failed,
   * another process owns it, or the coordinator is unreadable while a transaction is in flight). The reason says what
   * to do; opening the data under it would let writes land on a database that is about to be, or was just, replaced.
   */
  | { readonly kind: "blocked"; readonly reason: string }
  /** Installation is not possible here (development build, unsupported platform). Everything else runs normally. */
  | { readonly kind: "unavailable"; readonly reason: string };

export type TrialTarget =
  | { readonly kind: "windows" }
  | { readonly kind: "wsl"; readonly distro: string };

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const isMaintenanceError = Schema.is(ForkMaintenanceError);
const asMaintenanceError = (cause: unknown) =>
  isMaintenanceError(cause) ? cause : new ForkMaintenanceError({ reason: messageOf(cause) });
const COMMIT = /^[0-9a-f]{40}$/;

export interface DesktopMaintenance {
  readonly start: () => Promise<StartupPlan>;
  readonly resumeInterrupted: () => Promise<ForkUpdateStatus>;
  readonly observe: () => Promise<void>;
  readonly check: () => Promise<ForkUpdateStatus>;
  readonly tick: () => Promise<ForkUpdateStatus>;
  readonly status: () => Promise<ForkUpdateStatus>;
  readonly install: (targetArtifactSha256: string) => Promise<ForkUpdateStatus>;
  readonly cancelCountdown: () => Promise<ForkUpdateStatus>;
  readonly updatePolicy: (patch: ForkUpdatePolicyPatch) => Promise<ForkUpdateStatus>;
  readonly runAction: (input: ForkMaintenanceActionInput) => Promise<ForkUpdateStatus>;
  readonly recover: (request: ForkRecoveryRequest) => Promise<ForkUpdateStatus>;
  readonly reportInteraction: (input: ForkMaintenanceInteraction) => void;
  readonly trialEnv: (target: TrialTarget) => Promise<Record<string, string>>;
  readonly recordWslRuntime: (runtimeId: string) => Promise<void>;
  readonly retainedWslRuntimes: () => Promise<ReadonlyArray<string>>;
  readonly stop: () => Promise<void>;
}

export function createDesktopMaintenance(input: DesktopMaintenanceInput): DesktopMaintenance {
  const now = input.now ?? (() => Date.now());
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const paths = maintenancePaths(input.baseDir);
  const directory = coordinatorDirectory(input.namespace);
  const commit = input.commit !== null && COMMIT.test(input.commit) ? input.commit : null;
  const interaction = createInteractionTracker({ now });

  let store: CoordinatorStore | null = null;
  /** The store before any gate: only the final unregistration at shutdown uses it. */
  let gate: StoreGate | null = null;
  let realStore: CoordinatorStore | null = null;
  let controller: ForkMaintenanceController | null = null;
  let installerPorts: ReturnType<typeof createDesktopInstaller> | null = null;
  let current: ForkBuildIdentity = resolveCurrentBuild({
    version: input.version,
    commit,
    recorded: null,
  });
  let unavailable: string | null = input.disabledReason;
  /** What a backend may assume about the coordinator: `open` is verified, `degraded` means it cannot be opened and no transaction is evidenced. */
  let coordinator: "pending" | "open" | "degraded" | "disabled" =
    input.disabledReason === null ? "pending" : "disabled";
  let participantId: string | null = null;
  const wslParticipants = new Set<string>();
  const wslHomes = new Map<string, string>();
  const inflight = new Map<string, Promise<ForkUpdateStatus>>();
  /** Set when this launch is held: the person sees why, and no action runs until a restart finds the device released. */
  let heldReason: string | null = null;
  const hold = (reason: string): StartupPlan => {
    heldReason = reason;
    return { kind: "blocked", reason };
  };
  const decorate = (status: ForkUpdateStatus): ForkUpdateStatus =>
    heldReason === null
      ? status
      : {
          ...status,
          phase: "recovery",
          lastError: heldReason,
          installable: false,
          blockers: [
            ...status.blockers,
            { participantId: "coordinator", reason: "transaction", label: heldReason },
          ],
        };

  const policyStore = createFilePolicyStore(paths.policy);
  const isBuild = (build: { readonly version: string; readonly commit?: string | undefined }) =>
    build.version === input.version &&
    (build.commit === undefined ||
      build.commit === "" ||
      commit === null ||
      build.commit === commit);

  /**
   * The one local data home this desktop owns and whose binary it replaces. The registry stores homes by real path, so the
   * comparison is by real path too.
   */
  let ownHomeCache: string | null = null;
  const ownHome = async () =>
    (ownHomeCache ??= await NodeFSP.realpath(input.baseDir).catch(() => input.baseDir));
  /**
   * Update-target participants that belong to this desktop's cohort. A managed service is an activity participant (it
   * blocks while it works) but its binary is replaced by its own launcher, never by this desktop, so its home is neither
   * snapshotted nor restored here. Another desktop with a different data home runs the same installed binary but nothing
   * here can give it a trial capability or read its health, so it cannot be claimed as updated: see `foreignDesktopHomes`.
   */
  const isDesktopTarget = (participant: {
    readonly kind: string;
    readonly updateTarget: boolean;
    readonly parentId: string | null;
  }) => participant.updateTarget && participant.parentId === null && participant.kind === "desktop";
  const foreignDesktopHomes = async (activeStore: CoordinatorStore): Promise<string[]> => {
    const own = await ownHome();
    const found = new Set<string>();
    for (const participant of (await activeStore.status(now())).participants)
      if (isDesktopTarget(participant))
        for (const home of participant.homes) if (home !== own) found.add(home);
    return [...found];
  };

  const exec: Exec = input.exec ?? wslExec;
  const wslHome = async (distro: string) => {
    const known = wslHomes.get(distro);
    if (known !== undefined) return known;
    const resolved = await (input.resolveWslHome ?? ((name: string) => resolveWslHome(name, exec)))(
      distro,
    );
    if (resolved !== null) wslHomes.set(distro, resolved);
    return resolved;
  };

  /**
   * The transport into one distribution: the command its backend runs (its PATH and staged `t3`), or, when no backend is
   * running yet (a launch finishing an interrupted restore), the program recorded when the person confirmed it. A command
   * that exits non-zero without a protocol answer rejects; one that answers `ok: false` returns the reason.
   */
  const runnerFor = (
    member: Pick<WslMember, "distro" | "executable">,
    command: WslCommand | null,
  ): DistroRunner => {
    const prefix: string[] | null =
      command !== null
        ? [...command.distroArgs, "--exec", "env", `PATH=${command.path}`, ...command.command]
        : member.executable !== undefined
          ? ["-d", member.distro, "--exec", member.executable]
          : null;
    return async (args) => {
      if (prefix === null)
        throw new Error(
          `The ${member.distro} runtime is not available, so its data home cannot be reached.`,
        );
      const result = await exec("wsl.exe", [...prefix, ...args]);
      if (result.code !== 0 && !result.stdout.includes("{"))
        throw new Error(
          `exit ${result.code}: ${(result.stderr || result.stdout).trim().slice(-300)}`,
        );
      return result.stdout;
    };
  };
  const liveCommand = async (distro: string) =>
    (await input.managedWsl()).find((runtime) => runtime.distro === distro)?.command ?? null;
  const fenceOf = async (member: WslMember): Promise<FenceControl> =>
    createRunnerFenceControl(runnerFor(member, await liveCommand(member.distro)), member);

  /** The transaction holding the device fence, if any: its homes are the cohort, whatever is registered or running now. */
  const inFlightJournal = async (): Promise<MaintenanceJournal | null> => {
    if (store === null) return null;
    const fence = await store.fenceSnapshot().catch(() => null);
    return fence === null ? null : store.readJournal(fence.transactionId).catch(() => null);
  };

  /**
   * The WSL members of the cohort. Normally: every managed distribution, which must be a confirmed member and run a
   * self-contained runtime whose data home is known. While a transaction is in flight, its journal names the cohort
   * (the previous process's runtimes are gone and nothing is registered). Any gap throws: the cohort never proceeds on
   * a home it cannot see.
   */
  const currentMembers = async (
    journal: MaintenanceJournal | null,
  ): Promise<ReadonlyArray<WslMember>> => {
    const persisted = await readMembers(paths.members);
    const managed = await input.managedWsl();
    if (journal !== null) {
      const members: WslMember[] = [];
      for (const id of journal.homes) {
        const wsl = parseWslHomeId(id);
        if (wsl === null) continue;
        const confirmed = persisted.find(
          (member) => member.distro === wsl.distro && member.home === wsl.home,
        );
        if (confirmed === undefined)
          throw new Error(
            `The ${wsl.distro} home in this update is not a confirmed member of the device's installations.`,
          );
        // The program path moves with each release; the transport uses the live command when there is one.
        members.push(confirmed);
      }
      return members;
    }
    const members: WslMember[] = [];
    for (const runtime of managed) {
      const confirmed = persisted.find((member) => member.distro === runtime.distro);
      if (confirmed === undefined)
        throw new Error(
          `The ${runtime.distro} WSL backend is not part of this device's confirmed installations. Confirm the registered runtimes again.`,
        );
      if (runtime.command === null)
        throw new Error(
          `The ${runtime.distro} runtime is not staged, so its data home cannot be reached.`,
        );
      const home = await wslHome(runtime.distro);
      if (home === null)
        throw new Error(
          `The ${runtime.distro} data home could not be determined. Start its backend or disable the WSL backend before updating.`,
        );
      if (home !== confirmed.home)
        throw new Error(
          `The ${runtime.distro} data home changed since it was confirmed. Confirm the registered runtimes again.`,
        );
      members.push(confirmed);
    }
    return members;
  };
  const cohort = async () => {
    if (store === null) throw new Error("Device maintenance is not running.");
    const journal = await inFlightJournal();
    const status = await store.status(now());
    const own = await ownHome();
    const local =
      journal !== null
        ? journal.homes.filter((home) => parseWslHomeId(home) === null)
        : [
            ...new Set(
              status.participants
                .filter(isDesktopTarget)
                .flatMap((participant) => participant.homes)
                .filter((home) => home === own),
            ),
          ];
    const members = await currentMembers(journal);
    const homes: CohortHome[] = [
      ...local.map((home) => ({
        id: home,
        label: input.platform === "windows-x64" ? "Windows" : "Linux",
        control: createLocalHomeControl(home, store!),
      })),
      ...(await Promise.all(
        members.map(async (member) => ({
          id: wslHomeId(member),
          label: `WSL (${member.distro})`,
          control: createRunnerHomeControl(
            runnerFor(member, await liveCommand(member.distro)),
            member,
          ),
        })),
      )),
    ];
    return {
      homes,
      members: await Promise.all(
        members.map(async (member) => ({ member, fence: await fenceOf(member) })),
      ),
    };
  };
  const defaultPolicy = async (): Promise<PolicyState> => {
    const existing = (await input.userHasExistingData?.()) ?? false;
    // An existing device follows nightlies so the owner's devices exercise builds first; a fresh stable installer follows stable.
    return {
      channel: existing ? "nightly" : defaultChannelForBuild(input.version),
      automaticInstallation: false,
      pinnedBuild: null,
      failedArtifactSha256: [],
      automationReviewRequired: false,
      cancelledTargetSha256: null,
    };
  };

  const unavailableStatus = (reason: string): ForkUpdateStatus => ({
    coordinatorId: "",
    phase: "idle",
    policy: {
      channel: defaultChannelForBuild(input.version),
      automaticInstallation: false,
      pinnedBuild: null,
    },
    currentBuild: current,
    targetBuild: null,
    blockers: [{ participantId: "coordinator", reason: "launcher", label: reason }],
    recoveryOptions: [],
    transactionId: null,
    automationReviewRequired: false,
    installable: false,
    affectedHomes: [],
  });
  const refuse = (): never => {
    throw new ForkMaintenanceError({ reason: unavailable ?? "Device maintenance is not running." });
  };

  /** Records the identity of a build whose update committed, and prunes what no transaction or recovery still needs. */
  const housekeeping = async () => {
    if (store === null || installerPorts === null) return;
    try {
      const journals = await store.listJournals();
      const committed = journals.findLast(
        (journal) =>
          journal.kind === "update" &&
          journal.phase === "committed" &&
          journal.target !== null &&
          isBuild(journal.target),
      );
      const recorded = await readRecordedBuild(paths.installedBuild);
      if (
        committed?.target != null &&
        (recorded === null ||
          recorded.artifactSha256 !== committed.target.artifactSha256 ||
          recorded.version !== input.version)
      ) {
        await writeRecordedBuild(paths.installedBuild, {
          version: input.version,
          commit: commit ?? "",
          artifactSha256: committed.target.artifactSha256,
          installationSequence: (recorded?.installationSequence ?? 0) + 1,
        });
        current = resolveCurrentBuild({
          version: input.version,
          commit,
          recorded: await readRecordedBuild(paths.installedBuild),
        });
      }
      const status = await store.status(now());
      if (status.fence !== null) return;
      const live = journals.filter((journal) => journal.phase !== "aborted");
      // The retained handoff plans are what lets the recovery helper put a broken application back without this one: they keep
      // the transactions whose installers are kept, and name exactly the payloads those transactions need.
      const planPayloads = await pruneHandoffPlans(
        paths.handoff,
        new Set(live.slice(-RETAINED_TRANSACTIONS).map((journal) => journal.id)),
      );
      const protect = new Set<string>([
        ...planPayloads,
        current.artifactSha256,
        ...live
          .slice(-RETAINED_TRANSACTIONS)
          .flatMap((journal) => [
            journal.previous.artifactSha256,
            ...(journal.target === null ? [] : [journal.target.artifactSha256]),
          ]),
      ]);
      await installerPorts.prune(protect);
      const pinnedByHome = (home: string) =>
        live
          .flatMap((journal) => [journal.snapshots[home], journal.rescues[home]])
          .filter((id): id is string => id !== undefined);
      const members = await cohort().catch(() => null);
      for (const home of members?.homes ?? []) {
        // Newest two restore points per home, plus everything a transaction still references. Never pruned for space.
        await home.control.run({ op: "prune", keep: 2, pinned: pinnedByHome(home.id) });
      }
    } catch (cause) {
      console.warn("Maintenance housekeeping failed.", messageOf(cause));
    }
  };

  const observeDesktop = async () => {
    if (store === null) return;
    if (participantId === null) {
      const id = `desktop-${NodeCrypto.randomUUID().slice(0, 8)}`;
      try {
        await ensurePrivateDirectory(paths.processHome);
        await store.register(
          {
            id,
            label: "T3 Code desktop",
            kind: "desktop",
            homes: [paths.processHome],
            updateTarget: false,
          },
          now(),
        );
        participantId = id;
      } catch {
        // A held fence refuses new participants; the next pass retries once it is released.
        return;
      }
    }
    const blockers: ForkActivityBlocker[] = [];
    let descendants: Awaited<ReturnType<DesktopMaintenanceInput["descendants"]>> = [];
    let descendantsKnown = true;
    try {
      descendants = await input.descendants();
      if (descendants.some((entry) => entry.started === UNKNOWN_PROCESS_IDENTITY)) {
        descendantsKnown = false;
        blockers.push({
          participantId,
          reason: "unknown-participant",
          label: "The desktop's child process identity could not be verified.",
        });
      }
    } catch {
      descendantsKnown = false;
      blockers.push({
        participantId,
        reason: "unknown-participant",
        label: "The desktop's child processes could not be read.",
      });
    }
    // Never admitted, never claimed updated: another desktop's data home is outside this update's cohort.
    try {
      for (const home of await foreignDesktopHomes(store))
        blockers.push({
          participantId,
          reason: "unknown-participant",
          label: `Another T3 Code desktop uses the data home ${home}. It cannot be updated or health-checked together with this one, so installing is blocked until it is closed.`,
        });
    } catch {
      blockers.push({
        participantId,
        reason: "unknown-participant",
        label: "The device's registered desktops could not be read.",
      });
    }
    await store.observe(participantId, blockers, now(), descendants, { descendantsKnown });
  };

  /** The distribution's own registry is the source of activity; an unreachable one, or one with nothing registered, is never idle. */
  const observeKnownMember = async (member: WslMember, fence: FenceControl) => {
    if (store === null) return;
    const result = await fence.run({ op: "status" });
    let blockers: ForkActivityBlocker[];
    if (!result.ok) {
      blockers = [
        {
          participantId: member.id,
          reason: "unknown-participant",
          label: `${member.distro} could not be reached over its control channel.`,
        },
      ];
    } else {
      const status = result.value as {
        readonly blockers: ReadonlyArray<ForkActivityBlocker>;
        readonly participants: ReadonlyArray<unknown>;
        readonly bootstrapped: boolean;
      };
      blockers =
        status.participants.length === 0
          ? [
              {
                participantId: member.id,
                reason: "bootstrap",
                label: `${member.distro} has no registered T3 runtime.`,
              },
            ]
          : !wslActivityIsCurrent(status.participants)
            ? [
                {
                  participantId: member.id,
                  reason: "unknown-participant",
                  label: `${member.distro} needs a runtime with the current process activity census.`,
                },
              ]
            : !status.bootstrapped
              ? [
                  {
                    participantId: member.id,
                    reason: "bootstrap",
                    label: `${member.distro} has not confirmed its installations.`,
                  },
                ]
              : status.blockers.map((blocker) => ({ ...blocker, participantId: member.id }));
    }
    await store.observe(member.id, blockers, now(), []);
  };

  /** WSL members are registered by this process (their explicit parent) and observed through each distribution's own registry. */
  const observeWsl = async () => {
    if (store === null || participantId === null) return;
    let members: ReadonlyArray<{ readonly member: WslMember; readonly fence: FenceControl }> = [];
    try {
      members = (await cohort()).members;
    } catch {
      // An unreachable or unconfirmed distribution registers nothing; installation blocks on the cohort itself.
    }
    // A member is registered once: registering again replaces its record and restarts its quiet window. After that it is only observed.
    const fresh = members.filter((entry) => !wslParticipants.has(entry.member.id));
    if (fresh.length > 0) {
      await observeWslMembers({ store, parentId: participantId, members: fresh, now: now() }).catch(
        () => undefined,
      );
    }
    const present = new Set(
      (await store.status(now()).catch(() => null))?.participants.map(
        (participant) => participant.id,
      ),
    );
    for (const entry of members) {
      if (!present.has(entry.member.id)) continue;
      if (!fresh.includes(entry)) await observeKnownMember(entry.member, entry.fence);
    }
    const keep = new Set(members.map((entry) => entry.member.id));
    for (const id of wslParticipants) {
      if (keep.has(id)) continue;
      await store.unregister(id).catch(() => undefined);
      wslParticipants.delete(id);
    }
    for (const id of keep) if (present.has(id)) wslParticipants.add(id);
  };

  const observe = async () => {
    await observeDesktop();
    await observeWsl();
  };

  const buildController = (
    activeStore: CoordinatorStore,
    base: PolicyState,
  ): ForkMaintenanceController => {
    installerPorts = createDesktopInstaller({
      platform: input.platform,
      packaging: input.packaging,
      currentBuild: () => current,
      isBuild,
      paths,
      coordinatorDirectory: directory,
      unavailableReason: () => unavailable,
      authorizationRequired: input.authorizationRequired,
      feed: input.feed,
      fetch: input.fetch,
      readJournal: (id) => activeStore.readJournal(id),
      readReceipt: (id, home, slot) => readReceipt(activeStore, id, home, slot),
      cohort,
      parentId: () => participantId,
      rescueRequired: async () => {
        const fence = await activeStore.fenceSnapshot().catch(() => null);
        return fence === null
          ? false
          : (await activeStore.readJournal(fence.transactionId).catch(() => null))?.kind ===
              "recovery";
      },
      // Leaving for a binary replacement: no registry operation is left running or started once the process quits.
      runtime: {
        ...input.runtime,
        quit: async () => {
          await gate?.closeAndDrain();
          try {
            await input.runtime.quit();
          } catch (cause) {
            gate?.reopen();
            throw cause;
          }
        },
      },
      exitAbandoned: () => gate?.reopen(),
      authorizeHandoff: (journalId, metadata) =>
        activeStore.recordDesktopHandoffAuthorization(journalId, metadata),
      installTarget: input.installTarget,
      relaunchEnvironment: captureRelaunchEnvironment(
        input.relaunchEnvironment ?? {},
        input.baseDir,
        directory,
      ),
      ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
      now,
      sleep,
      ...(input.trialTimeoutMs === undefined ? {} : { trialTimeoutMs: input.trialTimeoutMs }),
      ...(input.restoredTimeoutMs === undefined
        ? {}
        : { restoredTimeoutMs: input.restoredTimeoutMs }),
      ...(input.freeBytes === undefined ? {} : { freeBytes: input.freeBytes }),
    });
    return createForkMaintenanceController({
      now,
      sleep,
      store: activeStore,
      policy: policyStore,
      defaultPolicy: base,
      feed: input.feed,
      installer: installerPorts,
      interaction: () => interaction.read(input.hasWindow()),
      ...(input.onStatus === undefined
        ? {}
        : { onStatus: (status: ForkUpdateStatus) => input.onStatus!(decorate(status)) }),
    });
  };

  const readReceipt = async (
    activeStore: CoordinatorStore,
    transactionId: string,
    home: string,
    slot: "trial" | "restored",
  ) => {
    const wsl = parseWslHomeId(home);
    if (wsl === null) return activeStore.readReceipt(transactionId, home, slot);
    // The distribution's own server wrote it into the distribution's registry; ask that registry.
    const member = (await currentMembers(await inFlightJournal())).find(
      (candidate) => candidate.distro === wsl.distro && candidate.home === wsl.home,
    );
    if (member === undefined) return null;
    const result = await (
      await fenceOf(member)
    ).run({ op: "receipt", transactionId, home: wsl.home, slot });
    // A distribution that cannot answer has no receipt yet; the transaction then waits or fails on its own timeout.
    return result.ok && typeof result.value === "string" && result.value.length > 0
      ? result.value
      : null;
  };

  const startupPlan = async (
    activeStore: CoordinatorStore,
  ): Promise<StartupPlan | { readonly kind: "resume-first"; readonly transactionId: string }> => {
    // A coordinator that cannot be read cannot be called idle: backends are held until it can say so.
    const status = await activeStore.status(now()).catch((cause: unknown) => {
      throw new Error(`The device coordinator could not be read: ${messageOf(cause)}`);
    });
    const fence = status.fence;
    if (fence === null) return { kind: "idle" };
    if (fence.holderAlive !== false)
      return {
        kind: "blocked",
        reason:
          "Another T3 Code process is updating or restoring this device. Close every T3 Code window and start it again once that finishes.",
      };
    const journal = await activeStore.readJournal(fence.transactionId);
    if (journal === null)
      return {
        kind: "blocked",
        reason:
          "A device update holds this device but its journal is missing. Run the recovery helper's `status` command before starting T3 Code.",
      };
    const runningTarget = journal.target !== null && isBuild(journal.target);
    return (journal.phase === "trial" || journal.phase === "verified") && runningTarget
      ? { kind: "trial", transactionId: journal.id }
      : { kind: "resume-first", transactionId: journal.id };
  };

  /**
   * What a person can do when nothing here can finish the transaction: the cached helper's exact commands, if it is cached,
   * and the retained install plan of this transaction, which lets the helper put the previous application back by itself.
   */
  const recoveryGuidance = async (transactionId?: string) => {
    try {
      const command = await readRecoveryCommand(paths.recovery);
      const quoted = (args: ReadonlyArray<string>) => {
        const invocation = recoveryInvocation(command, args);
        return `"${invocation.command}" "${invocation.args.join('" "')}"`;
      };
      const plan =
        transactionId === undefined
          ? null
          : await retainedInstallPlan(paths.handoff, transactionId).catch(() => null);
      return `Inspect the device with: ${quoted(["status"])}.${
        plan === null
          ? ""
          : ` The application can be put back without opening it by running the helper's recover command with --desktop-plan "${plan.path}".`
      } Settings, General, App updates also lists the restore points.`;
    } catch {
      return "Settings, General, App updates lists the restore points; install the recovery helper from the release page if it is not cached.";
    }
  };

  /**
   * A transaction that must finish before any backend opens a database (a restore): resume it, and only a fence that is
   * actually released lets the launch continue. A failure that is thrown, or one the controller recorded and returned, both block.
   */
  const resolveBeforeStart = async (activeStore: CoordinatorStore): Promise<StartupPlan> => {
    const blocked = async (why: string): Promise<StartupPlan> => {
      const fence = await activeStore.fenceSnapshot().catch(() => null);
      return hold(
        `The unfinished device update could not be completed: ${why} T3 Code will not open your data until it is restored. ${await recoveryGuidance(fence?.transactionId)}`,
      );
    };
    try {
      await requireController().resumeInterrupted();
      await housekeeping();
    } catch (cause) {
      return blocked(messageOf(cause));
    }
    let held: Awaited<ReturnType<CoordinatorStore["fenceSnapshot"]>>;
    try {
      held = await activeStore.fenceSnapshot();
    } catch (cause) {
      return blocked(messageOf(cause));
    }
    if (held !== null)
      return blocked((await requireController().status()).lastError ?? "The update is still held.");
    await observe().catch(() => undefined);
    return { kind: "idle" };
  };

  /**
   * Whether a transaction that cannot be read is in flight. Used only when the registry cannot be opened: an unreadable
   * journal counts as in flight, because "I could not tell" must never read as "idle".
   */
  const journalsEvidenceInFlight = async (): Promise<boolean> => {
    let names: string[];
    try {
      names = await NodeFSP.readdir(NodePath.join(directory, "journals"));
    } catch (cause) {
      // No journals directory (or no directory at all) is no evidence; an unreadable one is.
      return !(
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      );
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        if (
          IN_FLIGHT_PHASES.has(
            decodeJournal(
              JSON.parse(
                await NodeFSP.readFile(NodePath.join(directory, "journals", name), "utf8"),
              ),
            ).phase,
          )
        )
          return true;
      } catch {
        return true;
      }
    }
    return false;
  };

  const trialEnv = async (target: TrialTarget): Promise<Record<string, string>> => {
    // Updates are off here (development build, disabled): there is no device transaction to honour.
    if (coordinator === "disabled" || coordinator === "degraded") return {};
    if (store === null)
      throw new Error("Device maintenance has not started, so a backend must not start yet.");
    // Every read below throws on a coordinator error: an error is never the same as "idle".
    const fence = await store.fenceSnapshot();
    if (fence === null) return {};
    const journal = await store.readJournal(fence.transactionId);
    if (journal === null)
      throw new Error("A device transaction holds the fence but its journal is missing.");
    const runningTarget = journal.target !== null && isBuild(journal.target);
    const runningPrevious = isBuild(journal.previous);
    const trial = (journal.phase === "trial" || journal.phase === "verified") && runningTarget;
    const restored = journal.phase === "restored" && runningPrevious;
    if (!trial && !restored)
      throw new Error(
        `A device ${journal.kind} is ${journal.phase}; no backend may open the data until it is finished or restored.`,
      );
    let capability: TrialCapability;
    if (target.kind === "windows") {
      // The capability is for this desktop's own home, exactly: never the first local home a transaction happens to name.
      const home = await ownHome();
      if (!journal.homes.includes(home))
        throw new Error(
          "The transaction does not include this desktop's data home, so its backend must not start.",
        );
      capability = await store.issueTrial(journal.id, home);
    } else {
      const member = (await currentMembers(journal)).find(
        (candidate) => candidate.distro === target.distro,
      );
      if (member === undefined || !journal.homes.includes(wslHomeId(member)))
        throw new Error(
          `The ${target.distro} backend is not a member of the transaction in flight, so it must not start.`,
        );
      const issued = await (
        await fenceOf(member)
      ).run({ op: "issue-trial", transactionId: journal.id, home: member.home });
      if (!issued.ok)
        throw new Error(
          `The ${target.distro} runtime could not be given its trial capability: ${issued.reason}`,
        );
      capability = issued.value as TrialCapability;
    }
    return { [MAINTENANCE_TRIAL_ENV]: JSON.stringify(capability) };
  };

  /** Nothing can be trusted to say the device is idle: an unreadable journal holds the launch, anything else only turns installation off. */
  const cannotOpen = async (reason: string): Promise<StartupPlan> => {
    // The server applies the same rule: only a coordinator that cannot be read while a transaction is evidenced holds the launch.
    if (await journalsEvidenceInFlight()) {
      coordinator = "pending";
      return hold(
        `${reason}. A device update may be in flight, so T3 Code will not open your data. ${await recoveryGuidance()}`,
      );
    }
    unavailable = reason;
    coordinator = "degraded";
    return { kind: "unavailable", reason };
  };

  const start = async (): Promise<StartupPlan> => {
    if (unavailable !== null) return { kind: "unavailable", reason: unavailable };
    // Policy, payloads, plans and membership are written below this directory; it is private before any of them exists.
    try {
      await ensurePrivateDirectory(paths.root);
    } catch (cause) {
      return cannotOpen(messageOf(cause));
    }
    try {
      const opened = await CoordinatorStore.open(
        directory,
        input.identity ?? ((pid) => processCreationIdentity(pid)),
        input.selfPid ?? process.pid,
      );
      gate = createStoreGate(opened);
      store = gate.store;
      realStore = opened;
    } catch (cause) {
      return cannotOpen(`The device coordinator could not be opened: ${messageOf(cause)}`);
    }
    coordinator = "open";
    current = resolveCurrentBuild({
      version: input.version,
      commit,
      recorded: await readRecordedBuild(paths.installedBuild),
    });
    // Persisted now: once this build opens the database, an install would otherwise look like an existing one.
    const base = await defaultPolicy();
    if ((await policyStore.read().catch(() => null)) === null) await policyStore.write(base);
    controller = buildController(store, base);
    let plan: Awaited<ReturnType<typeof startupPlan>>;
    try {
      plan = await startupPlan(store);
    } catch (cause) {
      return hold(
        `${messageOf(cause)}. T3 Code will not open your data until the coordinator can say no update is in flight.`,
      );
    }
    if (plan.kind === "resume-first") return resolveBeforeStart(store);
    if (plan.kind === "blocked") return hold(plan.reason);
    if (plan.kind === "idle") await observe().catch(() => undefined);
    return plan;
  };

  const requireController = (): ForkMaintenanceController => {
    if (heldReason !== null) throw new ForkMaintenanceError({ reason: heldReason });
    return controller ?? refuse();
  };
  const guarded = async <A>(work: () => Promise<A>): Promise<A> => {
    try {
      return await work();
    } catch (cause) {
      throw asMaintenanceError(cause);
    }
  };
  /** Identical requests that arrive while one is running share its outcome: one coordinator transaction per target. */
  const shared = (key: string, work: () => Promise<ForkUpdateStatus>) => {
    const running = inflight.get(key);
    if (running !== undefined) return running;
    const promise = guarded(work).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };

  const check = () =>
    shared("check", async () => {
      const active = requireController();
      await active.check();
      return active.stage();
    });
  const confirmBootstrap = async () => {
    if (store === null) refuse();
    // The person's confirmation states the cohort: every managed distribution, with its program and data home.
    const members: WslMember[] = [];
    for (const runtime of await input.managedWsl()) {
      const home = await wslHome(runtime.distro);
      if (runtime.command === null || home === null)
        throw new Error(
          `The ${runtime.distro} WSL backend is not running with a known data home, so it cannot be confirmed.`,
        );
      const executable = executableOf(runtime.command);
      // The program is recorded when it is self-contained, so a later launch can reach the distribution before its backend runs.
      members.push({
        id: memberIdFor(runtime.distro),
        distro: runtime.distro,
        home,
        ...(executable === null ? {} : { executable }),
      });
    }
    await writeMembers(paths.members, members);
    await store!.confirmBootstrap();
    // Each distribution keeps its own registry; the confirmation covers every member.
    for (const member of members) {
      const confirmed = await (await fenceOf(member)).run({ op: "confirm-bootstrap" });
      if (!confirmed.ok)
        throw new Error(
          `${member.distro} could not confirm its registered runtimes: ${confirmed.reason}`,
        );
    }
  };

  return {
    start,
    resumeInterrupted: () =>
      guarded(async () => {
        await requireController().resumeInterrupted();
        await housekeeping();
        // After housekeeping: it records the identity of a build whose update just committed.
        return decorate(await requireController().status());
      }),
    observe,
    check,
    tick: () =>
      guarded(async () => {
        if (controller === null)
          return decorate(unavailableStatus(unavailable ?? "Device maintenance is not running."));
        // A held launch changes nothing: no observation registers this process, and no automatic install can start.
        if (heldReason !== null) return decorate(await controller.status());
        await observe().catch(() => undefined);
        await controller.tick();
        await housekeeping();
        return decorate(await controller.status());
      }),
    status: () =>
      guarded(async () =>
        decorate(
          controller === null
            ? unavailableStatus(unavailable ?? "Device maintenance is not running.")
            : await controller.status(),
        ),
      ),
    install: (digest) => shared(`install:${digest}`, () => requireController().install(digest)),
    cancelCountdown: () => guarded(() => requireController().cancelCountdown()),
    updatePolicy: (patch) => guarded(() => requireController().updatePolicy(patch)),
    runAction: (action) => {
      switch (action.action) {
        case "check":
          return check();
        case "install":
          return shared(`install:${action.targetArtifactSha256}`, () =>
            requireController().install(action.targetArtifactSha256),
          );
        case "cancel-countdown":
          return guarded(() => requireController().cancelCountdown());
        case "acknowledge-automation-review":
          return guarded(() => requireController().acknowledgeAutomationReview());
        case "confirm-bootstrap":
          return guarded(async () => {
            await confirmBootstrap();
            return requireController().status();
          });
      }
    },
    recover: (request) => guarded(() => requireController().recover(request)),
    reportInteraction: (report) => interaction.report(report),
    trialEnv,
    // Same shape as the installer index: build identity digest to a content address, here the distribution's runtime tree.
    recordWslRuntime: (runtimeId) =>
      recordIndex(paths.wslRuntimes, current.artifactSha256, runtimeId),
    retainedWslRuntimes: async () => {
      const byBuild = await readIndex(paths.wslRuntimes);
      const policy = await policyStore.read().catch(() => null);
      const journals = store === null ? [] : await store.listJournals().catch(() => []);
      // The two newest committed updates are the recoveries a person can still choose; a pin names the build held.
      const recoveries = journals
        .filter((journal) => journal.kind === "update" && journal.phase === "committed")
        .slice(-2)
        .map((journal) => journal.previous.artifactSha256);
      const builds = [
        current.artifactSha256,
        ...(policy?.pinnedBuild == null ? [] : [policy.pinnedBuild]),
        ...recoveries,
      ];
      return [
        ...new Set(
          builds.flatMap((digest) => (byBuild[digest] === undefined ? [] : [byBuild[digest]!])),
        ),
      ];
    },
    stop: async () => {
      if (realStore === null) return;
      for (const id of wslParticipants) await realStore.unregister(id).catch(() => undefined);
      if (participantId !== null) await realStore.unregister(participantId).catch(() => undefined);
    },
  };
}

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off — maintenance coordinates host files; receipts are opaque byte-for-byte data.
import { type ForkActivityBlocker, type ForkMaintenanceCapability } from "@t3tools/contracts";
import type { CoordinatorStatus } from "@t3tools/shared/forkMaintenanceStore";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { TerminalSummary } from "@t3tools/contracts";
import { BUILD_IDENTITY } from "../appVersion.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as IdleProcessRoots from "./IdleProcessRoots.ts";
import { type IdleProcessRoot, classifyProcessActivity } from "./IdleProcessRoots.ts";

import { UNKNOWN_PROCESS_IDENTITY } from "@t3tools/shared/forkMaintenanceStore";
import {
  acquireMaintenanceHost,
  describeCapability,
  type MaintenanceHost,
} from "./MaintenanceHost.ts";
import { MaintenanceWorkHeld, WorkAdmission } from "./WorkAdmission.ts";

export class MaintenanceCoordinatorError extends Schema.TaggedError<MaintenanceCoordinatorError>()(
  "MaintenanceCoordinatorError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Device maintenance ${this.operation} failed; installation is blocked.`;
  }
}

export class MaintenanceCoordinator extends Context.Service<
  MaintenanceCoordinator,
  {
    readonly host: MaintenanceHost;
    /** Only an active host with working admission may advertise a capability. */
    readonly capability: (recovery: boolean) => ForkMaintenanceCapability | undefined;
    readonly status: Effect.Effect<CoordinatorStatus | null, MaintenanceCoordinatorError>;
    /** Records this runtime's health receipt when it is a trial or restored runtime; otherwise does nothing. */
    readonly recordHealth: Effect.Effect<void, MaintenanceCoordinatorError>;
  }
>()("t3/maintenance/MaintenanceCoordinator") {}

export { describeCapability };

/** OS creation identity for each descendant, so a reused PID is never mistaken for the original process. */
const identifyDescendants = async (
  participantId: string,
  descendants: ReadonlyArray<{ pid: number; started: string; label: string }>,
  roots: ReadonlyArray<IdleProcessRoot>,
  identify: IdleProcessRoots.IdleProcessRootsShape["identify"],
): Promise<{
  descendants: Array<{ pid: number; started: string; label: string }>;
  complete: boolean;
  blockers: ReturnType<typeof classifyProcessActivity>["blockers"];
}> => {
  const identities = await identify(descendants.map((entry) => entry.pid));
  const identified = descendants.map((entry, index) => {
    const result = identities[index];
    return {
      pid: entry.pid,
      started:
        result?.kind === "present"
          ? result.identity
          : result?.kind === "absent"
            ? null
            : UNKNOWN_PROCESS_IDENTITY,
      label: entry.label.slice(0, 120),
      unreadable: result?.kind === "unreadable" || result === undefined,
    };
  });
  const classified = classifyProcessActivity(
    participantId,
    identified.map((entry) => ({
      pid: entry.pid,
      label: entry.label,
      result:
        entry.started === null
          ? ({ kind: "absent" } as const)
          : entry.unreadable
            ? ({ kind: "unreadable" } as const)
            : ({ kind: "present", identity: entry.started } as const),
    })),
    roots,
  );
  return {
    descendants: classified.descendants,
    blockers: classified.blockers,
    complete: identified.every((entry) => !entry.unreadable),
  };
};

const CAP = 20;
/** Mirrors PENDING_EXPIRY_SECONDS in OrganizationArchitectTranscriptStore. */
const ARCHITECT_PENDING_SECONDS = 120;
const label = (text: string) => text;

/** Activity sources this runtime owns. Any source that cannot be read blocks installation: unknown is never idle. */
export const collectActivity = (participantId: string) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    // Required, not optional: a composition that forgets a source would silently read as idle.
    const terminals = yield* TerminalManager.TerminalManager;
    const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
    const diagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
    const processRoots = yield* IdleProcessRoots.IdleProcessRoots;
    const blockers: ForkActivityBlocker[] = [];
    const unknown = (source: string): ForkActivityBlocker => ({
      participantId,
      reason: "unknown-participant",
      label: `${source} activity could not be read.`,
    });
    const guard = <A, E, R>(
      source: string,
      read: Effect.Effect<A, E, R>,
      onValue: (value: A) => void,
    ) =>
      read.pipe(
        Effect.map(onValue),
        Effect.catchCause(() => Effect.sync(() => void blockers.push(unknown(source)))),
      );

    // Recovery also reconciles ready sessions after restart. Maintenance counts their actual work,
    // pending requests and effects; a ready session alone is idle infrastructure.
    yield* guard("Agent", projections.getRecoveryThreadIds("active-runtime"), (ids) => {
      for (const threadId of ids.slice(0, CAP))
        blockers.push({
          participantId,
          reason: "active-agents",
          threadId,
          label: label("Agent, approval, provider, command, or background work is still active."),
        });
    });
    // Results and completions still owed to a parent: delivered after restart would be late, and dropped if the update loses them.
    yield* guard(
      "Delegated completion",
      projections.getRecoveryThreadIds("delegated-completions"),
      (ids) => {
        for (const threadId of ids.slice(0, CAP))
          blockers.push({
            participantId,
            reason: "background-work",
            threadId,
            label: "A delegated completion is still being delivered.",
          });
      },
    );
    yield* guard("Subagent result", projections.getRecoveryThreadIds("subagent-results"), (ids) => {
      for (const threadId of ids.slice(0, CAP))
        blockers.push({
          participantId,
          reason: "background-work",
          threadId,
          label: "A subagent result has not reached its parent.",
        });
    });
    // Organization work phases and Architect requests run outside the thread projections.
    yield* guard(
      "Organization work",
      sql<{ work_id: string }>`SELECT work_id FROM organization_live_work_phase_claims LIMIT 1`,
      (rows) => {
        if (rows.length > 0)
          blockers.push({
            participantId,
            reason: "active-agents",
            label: "Organization work is still running.",
          });
      },
    );
    // The Architect store itself expires requests pending longer than this.
    const architectCutoff = DateTime.formatIso(
      DateTime.add(yield* DateTime.now, { seconds: -ARCHITECT_PENDING_SECONDS }),
    );
    yield* guard(
      "Architect",
      sql<{
        request_id: string;
      }>`SELECT request_id FROM organization_architect_requests WHERE status = 'pending' AND created_at >= ${architectCutoff} LIMIT 1`,
      (rows) => {
        if (rows.length > 0)
          blockers.push({
            participantId,
            reason: "active-agents",
            label: "An Architect request is still running.",
          });
      },
    );
    // A shell waiting at its prompt is not activity; a running command is.
    yield* guard("Terminal", readTerminals(terminals), (running) => {
      for (const terminal of running.slice(0, CAP))
        blockers.push({
          participantId,
          reason: "commands",
          threadId: terminal.threadId,
          label: `A terminal command is running: ${terminal.label}`,
        });
    });
    yield* guard("Repository clone", Stream.runHead(clones.stream), (head) => {
      const running = Option.getOrElse(head, () => []).filter((clone) => clone.phase === "running");
      if (running.length > 0)
        blockers.push({
          participantId,
          reason: "background-work",
          label: "A repository clone is still running.",
        });
    });
    // Processes this runtime started (provider CLIs, terminals, background commands). If the runtime
    // exits first, the coordinator keeps blocking until these are verified gone.
    const processReadStartedAt = yield* Clock.currentTimeMillis;
    const processSnapshot = yield* diagnostics.read.pipe(
      Effect.map(Option.some),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(processSnapshot)) {
      blockers.push(unknown("Process"));
      return { blockers, descendants: [], descendantsKnown: false };
    }
    const snapshot = processSnapshot.value;
    const roots = yield* processRoots.snapshot;
    const descendants = snapshot.processes.map((entry) => ({
      pid: entry.pid,
      started: String(entry.startTimeMs),
      label: entry.command,
    }));
    const processReadAt = DateTime.toEpochMillis(snapshot.readAt);
    const censusComplete = !(
      Option.isSome(snapshot.error) ||
      processReadAt < processReadStartedAt ||
      snapshot.processCount !== snapshot.processes.length
    );
    if (!censusComplete) blockers.push(unknown("Process"));
    const identified = yield* Effect.tryPromise({
      try: () => identifyDescendants(participantId, descendants, roots, processRoots.identify),
      catch: (cause) => new MaintenanceCoordinatorError({ operation: "process identity", cause }),
    }).pipe(
      Effect.catchTags({
        MaintenanceCoordinatorError: () =>
          Effect.succeed({ descendants: [], complete: false, blockers: [] }),
      }),
    );
    blockers.push(...identified.blockers);
    if (!identified.complete) blockers.push(unknown("Process identity"));
    return {
      blockers,
      descendants: identified.descendants,
      descendantsKnown: censusComplete && identified.complete,
    };
  });

/** First metadata snapshot is the full list of terminals; the subscription is released at once. */
const readTerminals = (manager: TerminalManager.TerminalManager["Service"]) =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
    const unsubscribe = yield* manager.subscribeMetadata((event) =>
      event.type === "snapshot" ? Ref.set(snapshot, event.terminals) : Effect.void,
    );
    // The snapshot is delivered synchronously on subscribe.
    yield* Effect.sync(unsubscribe);
    return (yield* Ref.get(snapshot)).filter(
      (terminal) => terminal.status === "running" && terminal.hasRunningSubprocess,
    );
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* acquireMaintenanceHost(config).pipe(Effect.orDie);
  const status: Effect.Effect<CoordinatorStatus | null, MaintenanceCoordinatorError> =
    host.mode !== "active"
      ? Effect.succeed(null)
      : Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.tryPromise({
              try: () => host.store.status(now),
              catch: (cause) => new MaintenanceCoordinatorError({ operation: "status", cause }),
            }),
          ),
        );

  if (host.mode === "active") {
    const observe = Effect.gen(function* () {
      const timestamp = yield* Clock.currentTimeMillis;
      // A trial runtime is judged by its health receipt; its own start-up work is not agent activity.
      const activity: {
        blockers: ForkActivityBlocker[];
        descendants: Array<{ pid: number; started: string; label: string }>;
        descendantsKnown: boolean;
      } =
        host.trial !== null || host.successorOf !== null
          ? { blockers: [], descendants: [], descendantsKnown: true }
          : yield* collectActivity(host.participantId);
      yield* Effect.tryPromise({
        try: () =>
          host.store.observe(
            host.participantId,
            activity.blockers,
            timestamp,
            activity.descendants,
            {
              descendantsKnown: activity.descendantsKnown,
            },
          ),
        catch: (cause) =>
          new MaintenanceCoordinatorError({ operation: "activity observation", cause }),
      });
    }).pipe(Effect.catchCause(() => Effect.void));
    // A failed pass leaves the old heartbeat, which ages into "unknown participant" and blocks admission.
    yield* observe.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => host.store.unregister(host.participantId)).pipe(Effect.ignore),
    );
  }
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  /**
   * Records this runtime's health receipt once migrations ran, routes are live and projections read
   * back. Called by startup before the launcher is told the runtime is prepared, so the receipt always
   * precedes the launcher's commit. A trial runtime records the "trial" receipt; a successor that restored
   * older data records the "restored" receipt. Neither admits work.
   */
  const recordHealth: Effect.Effect<void, MaintenanceCoordinatorError> = Effect.gen(function* () {
    if (host.mode !== "active" || (host.trial === null && host.successorOf === null)) return;
    yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(
          (cause) => new MaintenanceCoordinatorError({ operation: "projection readback", cause }),
        ),
      );
    const transactionId = host.trial?.transactionId ?? host.successorOf!;
    const journal = yield* Effect.tryPromise({
      try: () => host.store.readJournal(transactionId),
      catch: (cause) => new MaintenanceCoordinatorError({ operation: "journal read", cause }),
    });
    const slot = receiptSlotFor({ trial: host.trial !== null }, journal?.phase ?? null);
    // A successor adopted for commit has nothing to prove: the trial child's receipts already exist.
    if (slot === null) return;
    const receipt = JSON.stringify({
      version: BUILD_IDENTITY.version,
      home: host.home,
      transaction: transactionId,
      projections: "readable",
    });
    yield* Effect.tryPromise({
      try: () =>
        host.store.writeReceipt(transactionId, host.participantId, host.home, receipt, slot),
      catch: (cause) => new MaintenanceCoordinatorError({ operation: "health receipt", cause }),
    });
  });
  return { host, status, recordHealth };
});

/** Reads the durable restored-automation hold. Missing policy is the legacy default; corruption holds autonomous work. */
export const automationReviewAdmissionFor = (
  host:
    | { readonly mode: "disabled" | "unavailable" }
    | { readonly mode: "active"; readonly home: string },
) =>
  host.mode !== "active"
    ? Effect.void
    : Effect.tryPromise({
        try: async () => {
          let raw: string;
          try {
            raw = await NodeFSP.readFile(
              NodePath.join(host.home, "maintenance", "policy.json"),
              "utf8",
            );
          } catch (cause) {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
            )
              return;
            throw cause;
          }
          const policy: unknown = JSON.parse(raw);
          if (
            typeof policy !== "object" ||
            policy === null ||
            !("automationReviewRequired" in policy) ||
            typeof policy.automationReviewRequired !== "boolean"
          )
            throw new Error("Maintenance automation review policy is invalid.");
          if (policy.automationReviewRequired)
            throw new Error("Restored automation is held for person review.");
        },
        catch: (cause) => new MaintenanceWorkHeld({ cause }),
      });

/** Admission that every external-write path shares. */
export const workAdmissionFor = (host: MaintenanceHost) => ({
  acquire:
    host.mode !== "active"
      ? Effect.succeed(() => Effect.void)
      : Effect.tryPromise({
          try: () => host.store.beginWork(host.participantId),
          catch: (cause) => new MaintenanceWorkHeld({ cause }),
        }).pipe(
          Effect.map(
            (release) => () => Effect.promise(release).pipe(Effect.catchCause(() => Effect.void)),
          ),
        ),
  acquirePassive:
    host.mode !== "active"
      ? Effect.succeed(() => Effect.void)
      : Effect.tryPromise({
          try: () => host.store.beginPassiveWork(host.participantId),
          catch: (cause) => new MaintenanceWorkHeld({ cause }),
        }).pipe(
          Effect.map(
            (release) => () => Effect.promise(release).pipe(Effect.catchCause(() => Effect.void)),
          ),
        ),
  check:
    host.mode !== "active"
      ? Effect.void
      : Effect.tryPromise({
          try: () => host.store.assertAdmitting(host.participantId),
          catch: (cause) => new MaintenanceWorkHeld({ cause }),
        }),
  checkAutomation: automationReviewAdmissionFor(host),
});

export const layer = Layer.effectContext(
  make.pipe(
    Effect.map(({ host, status, recordHealth }) =>
      Context.make(
        MaintenanceCoordinator,
        MaintenanceCoordinator.of({
          host,
          capability: (recovery) => describeCapability(host, recovery),
          status,
          recordHealth,
        }),
      ).pipe(Context.add(WorkAdmission, workAdmissionFor(host))),
    ),
  ),
);

/**
 * Which receipt a runtime records. A runtime started with a trial capability proves the NEW build ("trial"), unless the
 * journal is already `restored`: then it is the previous build the transaction restored data for (a desktop reverting a
 * failed trial starts its servers under the fence with a capability too), and it proves the restoration ("restored"), so a
 * stale trial receipt from the failed attempt can never verify it. A successor with no capability only ever proves a restoration.
 */
export const receiptSlotFor = (
  host: { readonly trial: boolean },
  phase: string | null,
): "trial" | "restored" | null => (phase === "restored" ? "restored" : host.trial ? "trial" : null);

/** Startup hook: compositions without a coordinator (isolated tests) have nothing to record. */
export const recordHealthIfPresent = Effect.gen(function* () {
  const present = yield* Effect.serviceOption(MaintenanceCoordinator);
  if (Option.isNone(present)) return;
  yield* present.value.recordHealth;
});

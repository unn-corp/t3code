// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  AgentDashboardAutomationRun,
  AgentDashboardReviewSchedule,
  AgentDashboardReviewScheduleStatus,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import {
  AgentDashboardReviewJobService,
  type AgentDashboardReviewJobServiceError,
  parseReviewMetadata,
} from "./AgentDashboardReviewJobService.ts";
import type { AgentDashboardReviewRunnerError } from "./AgentDashboardReviewRunner.ts";
import { REVIEW_INTERVAL_MINUTES } from "./AgentDashboardReviewRunner.ts";
const SCHEDULE_ID = "t3-random-codebase-review";
const POLL_INTERVAL = Duration.seconds(30);
const INTERVAL_MS = REVIEW_INTERVAL_MINUTES * 60_000;

export class AgentDashboardReviewSchedulerError extends Schema.TaggedErrorClass<AgentDashboardReviewSchedulerError>()(
  "AgentDashboardReviewSchedulerError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentDashboardReviewSchedulerService {
  readonly getStatus: Effect.Effect<AgentDashboardReviewSchedule>;
  /**
   * Enqueues one review through the shared job service. Returns the automation
   * run, or null when the schedule is disabled / not due / already in flight.
   */
  readonly runNow: Effect.Effect<
    AgentDashboardAutomationRun | null,
    | AgentDashboardReviewSchedulerError
    | AgentDashboardReviewJobServiceError
    | AgentDashboardReviewRunnerError
  >;
}

export class AgentDashboardReviewScheduler extends Context.Service<
  AgentDashboardReviewScheduler,
  AgentDashboardReviewSchedulerService
>()("t3/agentDashboard/AgentDashboardReviewScheduler") {}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const stringValue = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isoOrNull = (value: unknown): string | null => {
  const candidate = stringValue(value);
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
};

const isoAt = (milliseconds: number): string => new Date(milliseconds).toISOString();

const statusValue = (value: unknown): AgentDashboardReviewScheduleStatus =>
  value === "running" || value === "completed" || value === "failed" ? value : "idle";

const defaultSchedule = (now = Date.now()): AgentDashboardReviewSchedule => ({
  id: SCHEDULE_ID,
  enabled: true,
  intervalMinutes: REVIEW_INTERVAL_MINUTES,
  nextRunAt: isoAt(now + INTERVAL_MS),
  lastRunAt: null,
  lastCompletedAt: null,
  lastStatus: "idle",
  lastError: null,
  lastTarget: null,
  heartbeatAt: isoAt(now),
  runCount: 0,
});

const normalizeSchedule = (value: unknown, now = Date.now()): AgentDashboardReviewSchedule => {
  const raw = asObject(value);
  if (!raw) return defaultSchedule(now);

  const nextRunAt = isoOrNull(raw.nextRunAt) ?? isoAt(now + INTERVAL_MS);
  const lastStatus = statusValue(raw.lastStatus);
  const recoveredFromRestart = lastStatus === "running";
  return {
    id: SCHEDULE_ID,
    enabled: raw.enabled !== false,
    intervalMinutes: REVIEW_INTERVAL_MINUTES,
    nextRunAt: recoveredFromRestart ? isoAt(now) : nextRunAt,
    lastRunAt: isoOrNull(raw.lastRunAt),
    lastCompletedAt: isoOrNull(raw.lastCompletedAt),
    lastStatus: recoveredFromRestart ? "failed" : lastStatus,
    lastError: recoveredFromRestart
      ? "T3 restarted before the repository review completed."
      : stringValue(raw.lastError),
    lastTarget: stringValue(raw.lastTarget),
    heartbeatAt: isoOrNull(raw.heartbeatAt) ?? isoAt(now),
    runCount:
      typeof raw.runCount === "number" && Number.isFinite(raw.runCount)
        ? Math.max(0, Math.trunc(raw.runCount))
        : 0,
  };
};

const writeAtomic = async (path: string, value: AgentDashboardReviewSchedule): Promise<void> => {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await NodeFSP.rename(temporary, path);
};

const readSchedule = async (path: string): Promise<AgentDashboardReviewSchedule> => {
  try {
    return normalizeSchedule(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  } catch (cause) {
    const code = asObject(cause)?.code;
    if (code === "ENOENT") return defaultSchedule();
    // A truncated or hand-edited schedule must not disable the job forever.
    return defaultSchedule();
  }
};

/** Read-only status access for dashboard snapshots; the scheduler itself owns writes. */
export const readPersistedStatus = (
  stateDir: string,
): Effect.Effect<AgentDashboardReviewSchedule> =>
  Effect.tryPromise({
    try: () => readSchedule(NodePath.join(stateDir, "agent-dashboard", "review-schedule.json")),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => defaultSchedule()));

const scheduleStatusFromRun = (
  run: AgentDashboardAutomationRun,
): AgentDashboardReviewScheduleStatus => {
  switch (run.status) {
    case "queued":
    case "running":
    case "ingesting":
      return "running";
    case "succeeded":
    case "partial":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
  }
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const jobService = yield* AgentDashboardReviewJobService;
  const schedulerScope = yield* Effect.scope;
  const schedulePath = NodePath.join(config.stateDir, "agent-dashboard", "review-schedule.json");
  const stateRef = yield* Ref.make<AgentDashboardReviewSchedule>(
    yield* Effect.tryPromise({
      try: () => readSchedule(schedulePath),
      catch: (cause) =>
        new AgentDashboardReviewSchedulerError({
          operation: "read schedule",
          message: "Failed to initialize the T3 repository review schedule.",
          cause,
        }),
    }),
  );

  const persist = (state: AgentDashboardReviewSchedule) =>
    Effect.tryPromise({
      try: () => writeAtomic(schedulePath, state),
      catch: (cause) =>
        new AgentDashboardReviewSchedulerError({
          operation: "write schedule",
          message: "Failed to persist the T3 repository review schedule.",
          cause,
        }),
    });

  const initial = yield* Ref.get(stateRef);
  yield* persist(initial);

  const applyRunToSchedule = (
    run: AgentDashboardAutomationRun,
    startedAtMs: number,
    startedAt: string,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(stateRef);
      const status = scheduleStatusFromRun(run);
      const completed =
        run.status === "succeeded" ||
        run.status === "partial" ||
        run.status === "failed" ||
        run.status === "cancelled";
      const completedAtMs = completed ? Date.parse(run.completedAt ?? run.updatedAt) : Number.NaN;
      const nextState: AgentDashboardReviewSchedule = {
        ...current,
        lastStatus: status,
        lastRunAt: current.lastRunAt ?? startedAt,
        lastCompletedAt: completed ? (run.completedAt ?? run.updatedAt) : current.lastCompletedAt,
        lastError: completed ? run.error : current.lastError,
        lastTarget: run.target ?? current.lastTarget,
        nextRunAt: completed
          ? isoAt(
              Math.max(
                Number.isFinite(completedAtMs) ? completedAtMs : startedAtMs,
                startedAtMs + INTERVAL_MS,
              ),
            )
          : current.nextRunAt,
        heartbeatAt: run.updatedAt,
        runCount: current.runCount,
      };
      yield* Ref.set(stateRef, nextState);
      yield* persist(nextState);
    });

  const run = (force: boolean): AgentDashboardReviewSchedulerService["runNow"] =>
    Effect.gen(function* () {
      const startedAtTime = yield* DateTime.now;
      const startedAtMs = DateTime.toEpochMillis(startedAtTime);
      const startedAt = DateTime.formatIso(startedAtTime);
      const claimed = yield* Ref.modify(stateRef, (state) => {
        if (
          !state.enabled ||
          state.lastStatus === "running" ||
          (!force && Date.parse(state.nextRunAt) > startedAtMs)
        ) {
          return [false, state] as const;
        }
        return [
          true,
          {
            ...state,
            lastStatus: "running" as const,
            lastRunAt: startedAt,
            lastError: null,
            heartbeatAt: startedAt,
            runCount: state.runCount + 1,
          },
        ] as const;
      });
      if (!claimed) return null;

      yield* persist(yield* Ref.get(stateRef));

      const run = yield* jobService
        .enqueueReview({
          trigger: force ? "manual" : "scheduled",
          // Shared key so schedule ticks and manual force do not pile up.
          idempotencyKey: force ? "manual:repository-review" : "scheduled:repository-review",
        })
        .pipe(
          Effect.tap((enqueued) => applyRunToSchedule(enqueued, startedAtMs, startedAt)),
          Effect.tap((enqueued) =>
            // Follow the job until terminal so schedule lastStatus is truthful.
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 2_000; attempt += 1) {
                const runs = yield* jobService.listRuns.pipe(Effect.orElseSucceed(() => []));
                const current = runs.find((item) => item.id === enqueued.id);
                if (!current) return;
                yield* applyRunToSchedule(current, startedAtMs, startedAt);
                if (
                  current.status === "succeeded" ||
                  current.status === "partial" ||
                  current.status === "failed" ||
                  current.status === "cancelled"
                ) {
                  return;
                }
                yield* Effect.sleep(Duration.seconds(1));
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("T3 schedule follow-up for review job failed", {
                  runId: enqueued.id,
                  cause,
                }),
              ),
              Effect.forkIn(schedulerScope),
            ),
          ),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const nowIso = DateTime.formatIso(now);
              const current = yield* Ref.get(stateRef);
              const nextState: AgentDashboardReviewSchedule = {
                ...current,
                lastStatus: "failed",
                lastError: "message" in cause ? String(cause.message) : "Review enqueue failed.",
                nextRunAt: isoAt(DateTime.toEpochMillis(now) + INTERVAL_MS),
                heartbeatAt: nowIso,
              };
              yield* Ref.set(stateRef, nextState);
              yield* persist(nextState);
              return yield* Effect.fail(cause);
            }),
          ),
        );

      return run;
    });

  const runNow = run(true);
  const runScheduled = run(false).pipe(Effect.asVoid);

  const touchHeartbeat = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const heartbeatAt = DateTime.formatIso(now);
    const current = yield* Ref.get(stateRef);
    const nextState = { ...current, heartbeatAt };
    yield* Ref.set(stateRef, nextState);
    yield* persist(nextState);
  });

  const tick = Effect.gen(function* () {
    yield* touchHeartbeat;
    yield* runScheduled;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("T3 scheduled repository review failed", { cause }).pipe(Effect.asVoid),
    ),
  );
  yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  return {
    getStatus: Ref.get(stateRef),
    runNow,
  } satisfies AgentDashboardReviewSchedulerService;
});

export const layer = Layer.effect(AgentDashboardReviewScheduler, make);

export const __testing = {
  defaultSchedule,
  normalizeSchedule,
  parseReviewMetadata: (text: string) => {
    const parsed = parseReviewMetadata(text);
    if (parsed.kind === "parsed") return parsed.findings;
    if (parsed.kind === "missing") return null;
    return [];
  },
  scheduleStatusFromRun,
  intervalMs: INTERVAL_MS,
};

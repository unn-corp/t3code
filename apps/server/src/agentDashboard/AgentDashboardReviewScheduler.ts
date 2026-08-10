// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  AgentDashboardReviewSchedule,
  AgentDashboardReviewScheduleStatus,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  AgentDashboardReviewRunner,
  type AgentDashboardReviewRunResult,
  type AgentDashboardReviewRunnerError,
  REVIEW_INTERVAL_MINUTES,
} from "./AgentDashboardReviewRunner.ts";

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
  /** Starts one review immediately; a running scheduled review is not duplicated. */
  readonly runNow: Effect.Effect<
    AgentDashboardReviewRunResult | null,
    AgentDashboardReviewSchedulerError | AgentDashboardReviewRunnerError
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

const stringList = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value
        .map(stringValue)
        .filter((item): item is string => item !== null)
        .slice(0, 24)
    : [];

const parseReviewMetadata = (
  text: string,
): ReadonlyArray<AgentDashboardStore.AgentDashboardReviewFindingInput> | null => {
  const metadataLine = text
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith("T3_REVIEW_METADATA:"));
  if (!metadataLine) return null;

  try {
    const parsed = JSON.parse(
      metadataLine.slice(
        metadataLine.indexOf("T3_REVIEW_METADATA:") + "T3_REVIEW_METADATA:".length,
      ),
    );
    const rawFindings = asObject(parsed)?.findings;
    if (!Array.isArray(rawFindings)) return [];
    return rawFindings
      .map(asObject)
      .filter((finding): finding is JsonObject => finding !== null)
      .slice(0, 3)
      .map((finding) => {
        const title = stringValue(finding.title) ?? "";
        const summary = stringValue(finding.summary) ?? title;
        const markdown = stringValue(finding.markdown);
        return {
          title,
          category: stringValue(finding.category) ?? "insight",
          summary,
          impact: stringValue(finding.impact) ?? "",
          confidence: stringValue(finding.confidence) ?? "medium",
          evidence: stringList(finding.evidence),
          nextStep: stringValue(finding.next_step) ?? "",
          githubIssueTitle: stringValue(finding.github_issue_title) ?? title,
          githubIssueBody: stringValue(finding.github_issue_body) ?? markdown ?? summary,
          ...(markdown ? { markdown } : {}),
        } satisfies AgentDashboardStore.AgentDashboardReviewFindingInput;
      })
      .filter((finding) => finding.title.length > 0);
  } catch {
    return [];
  }
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* AgentDashboardReviewRunner;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const dashboardStore = AgentDashboardStore.getStore(config.stateDir);
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

  const monitorReview = (review: AgentDashboardReviewRunResult) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const thread = yield* projectionSnapshotQuery
          .getThreadDetailById(review.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(thread)) {
          const latestTurn = thread.value.latestTurn;
          if (latestTurn !== null && latestTurn.state !== "running") {
            const assistantMessage = latestTurn.assistantMessageId
              ? thread.value.messages.find(
                  (message) => message.id === latestTurn.assistantMessageId,
                )
              : null;
            if (assistantMessage) {
              const findings = parseReviewMetadata(assistantMessage.text);
              if (findings !== null && findings.length > 0) {
                yield* dashboardStore.appendReviewSuggestions({
                  jobId: review.threadId,
                  repository: {
                    name: review.projectName,
                    path: review.workspaceRoot,
                    githubRepo: review.githubRepo,
                  },
                  findings,
                });
              }
            }
            return;
          }
        }
        yield* Effect.sleep("10 seconds");
      }
      yield* Effect.logWarning("T3 repository review did not finish before the monitor timeout", {
        threadId: review.threadId,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("T3 repository review result ingestion failed", {
          threadId: review.threadId,
          cause,
        }),
      ),
    );

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
      const result = yield* runner.runRandomReview.pipe(
        Effect.tap((run) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            const completedAtTime = yield* DateTime.now;
            const completedAt = DateTime.formatIso(completedAtTime);
            const completedAtMs = DateTime.toEpochMillis(completedAtTime);
            const nextState: AgentDashboardReviewSchedule = {
              ...current,
              lastStatus: "completed",
              lastCompletedAt: completedAt,
              lastError: null,
              lastTarget: run.projectName,
              nextRunAt: isoAt(Math.max(completedAtMs, startedAtMs + INTERVAL_MS)),
              heartbeatAt: completedAt,
            };
            yield* Ref.set(stateRef, nextState);
            yield* persist(nextState);
            yield* monitorReview(run).pipe(Effect.forkIn(schedulerScope));
          }),
        ),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const nowIso = DateTime.formatIso(now);
            const current = yield* Ref.get(stateRef);
            const nextState: AgentDashboardReviewSchedule = {
              ...current,
              lastStatus: "failed",
              lastError: cause.message,
              nextRunAt: isoAt(DateTime.toEpochMillis(now) + INTERVAL_MS),
              heartbeatAt: nowIso,
            };
            yield* Ref.set(stateRef, nextState);
            yield* persist(nextState);
            return yield* Effect.fail(cause);
          }),
        ),
      );
      return result;
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
  parseReviewMetadata,
  intervalMs: INTERVAL_MS,
};

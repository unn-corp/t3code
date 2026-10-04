import {
  CommandId,
  orchestrationV2RunWorkStartedAt,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ProviderTurn,
  type RunLimits,
  type ThreadId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const activeStatuses = new Set(["preparing", "starting", "running", "waiting"]);

/** Limits cover continuous work, including wake runs, using normalized main-agent usage. */
export function runLimitCommand(
  input: {
    readonly threadId: ThreadId;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
    readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  },
  limits: RunLimits,
  nowMs: number,
): OrchestrationV2Command | null {
  const run =
    input.runs.findLast((candidate) => activeStatuses.has(candidate.status)) ?? input.runs.at(-1);
  if (!run || run.status === "queued") return null;
  const startedAt = orchestrationV2RunWorkStartedAt(run);
  if (startedAt === null) return null;
  const startedMs = DateTime.toEpochMillis(startedAt);
  const cohortRuns = new Set(
    input.runs
      .filter((candidate) => {
        const start = orchestrationV2RunWorkStartedAt(candidate);
        return start !== null && DateTime.toEpochMillis(start) === startedMs;
      })
      .map((candidate) => candidate.id),
  );
  const cohortAttempts = new Set(
    input.attempts.filter((attempt) => cohortRuns.has(attempt.runId)).map((attempt) => attempt.id),
  );
  const outputTokens = input.providerTurns.reduce(
    (total, turn) =>
      turn.runAttemptId !== null && cohortAttempts.has(turn.runAttemptId)
        ? total + (turn.turnTokenUsage?.outputTokens ?? 0)
        : total,
    0,
  );
  const reason =
    limits.maxDurationMinutes !== null && nowMs - startedMs >= limits.maxDurationMinutes * 60000
      ? `Time limit reached (${limits.maxDurationMinutes} minutes).`
      : limits.maxOutputTokens !== null && outputTokens >= limits.maxOutputTokens
        ? `Reported main-agent output token limit reached (${limits.maxOutputTokens} tokens).`
        : null;
  if (reason === null) return null;
  return {
    type: "run.interrupt",
    commandId: CommandId.make(`run-limit:${run.id}:${reason}`),
    threadId: input.threadId,
    runId: run.id,
    holdQueue: true,
    reason,
  };
}

export class RunLimitsService extends Context.Service<
  RunLimitsService,
  {
    readonly enforce: Effect.Effect<
      void,
      ProjectionStore.ProjectionStoreV2Error | ServerSettingsError
    >;
  }
>()("t3/orchestration-v2/RunLimitsService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const enforce = Effect.gen(function* () {
    const preferences = yield* settings.getSettings;
    const enabled = (limits: RunLimits | null) =>
      limits !== null && (limits.maxDurationMinutes !== null || limits.maxOutputTokens !== null);
    if (
      !enabled(preferences.runLimits) &&
      !Object.values(preferences.threadRunLimits).some(enabled)
    )
      return;
    const now = yield* DateTime.now;
    for (const threadId of yield* projections.getRecoveryThreadIds("runtime")) {
      const limits = preferences.threadRunLimits[threadId] ?? preferences.runLimits;
      if (!enabled(limits)) continue;
      const records = yield* projections.getThreadRecords(threadId, [
        "runs",
        "attempts",
        "providerTurns",
      ]);
      const command = runLimitCommand(
        { ...records, threadId },
        limits,
        DateTime.toEpochMillis(now),
      );
      if (command)
        yield* threads
          .dispatch(command)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Run limit stop failed", { threadId, cause }),
            ),
          );
    }
  });
  return RunLimitsService.of({ enforce });
});

export const layer = Layer.effect(RunLimitsService, make);
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* RunLimitsService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("run-limits", service.enforce);
  }),
);

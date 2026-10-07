import { it as itEffect } from "@effect/vitest";
import { EventId, ThreadId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { expect, it } from "vite-plus/test";
import {
  DEFAULT_RUN_LIMITS,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  MessageId,
  NodeId,
  ProviderThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { runLimitCommand, RunLimitsService, layer as runLimitsLayer } from "./RunLimitsService.ts";

const start = DateTime.makeUnsafe("2026-10-04T12:00:00Z");
const run: OrchestrationV2Run = {
  id: RunId.make("budget-run"),
  threadId: v2Projection.thread.id,
  ordinal: 1,
  providerInstanceId: v2Projection.thread.providerInstanceId,
  modelSelection: v2Projection.thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("budget-message"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: start,
  startedAt: start,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const attempt: OrchestrationV2RunAttempt = {
  id: RunAttemptId.make("budget-attempt"),
  runId: run.id,
  attemptOrdinal: 1,
  rootNodeId: NodeId.make("budget-node"),
  providerInstanceId: run.providerInstanceId,
  providerThreadId: ProviderThreadId.make("budget-provider-thread"),
  providerTurnId: null,
  reason: "initial",
  status: "running",
  startedAt: start,
  completedAt: null,
};
const providerTurn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("budget-turn"),
  providerThreadId: attempt.providerThreadId,
  nodeId: attempt.rootNodeId,
  runAttemptId: attempt.id,
  nativeTurnRef: null,
  ordinal: 1,
  status: "running",
  startedAt: start,
  completedAt: null,
};
const input = {
  threadId: v2Projection.thread.id,
  runs: [run],
  attempts: v2Projection.attempts,
  providerTurns: v2Projection.providerTurns,
};

it("does not stop work unless a limit is explicitly enabled", () => {
  expect(
    runLimitCommand(input, DEFAULT_RUN_LIMITS, DateTime.toEpochMillis(start) + 86400000),
  ).toBeNull();
});
it("stops at the time boundary and holds the queue", () => {
  const limits = { ...DEFAULT_RUN_LIMITS, maxDurationMinutes: 10 };
  expect(runLimitCommand(input, limits, DateTime.toEpochMillis(start) + 599999)).toBeNull();
  expect(runLimitCommand(input, limits, DateTime.toEpochMillis(start) + 600000)).toMatchObject({
    type: "run.interrupt",
    runId: run.id,
    holdQueue: true,
    reason: "Time limit reached (10 minutes).",
  });
});
it("keeps the time budget across automatic continuations", () => {
  const wake = {
    ...run,
    id: RunId.make("wake"),
    ordinal: run.ordinal + 1,
    startedAt: DateTime.add(start, { minutes: 9 }),
    workStartedAt: start,
  };
  expect(
    runLimitCommand(
      { ...input, runs: [{ ...run, status: "completed" }, wake] },
      { ...DEFAULT_RUN_LIMITS, maxDurationMinutes: 10 },
      DateTime.toEpochMillis(start) + 600000,
    ),
  ).toMatchObject({ runId: wake.id });
});
it("counts normalized output once per provider turn, including earlier attempts", () => {
  const turn = {
    ...providerTurn,
    id: ProviderTurnId.make("budget-turn"),
    runAttemptId: attempt.id,
    turnTokenUsage: {
      usageScope: "main_agent" as const,
      usageStatus: "complete" as const,
      inputTokens: 1000000,
      cachedInputTokens: 900000,
      outputTokens: 1000,
      reasoningTokens: 700,
      hasSubagents: true,
    },
  };
  const measured = { ...input, attempts: [attempt], providerTurns: [turn] };
  expect(
    runLimitCommand(
      measured,
      { ...DEFAULT_RUN_LIMITS, maxOutputTokens: 1001 },
      DateTime.toEpochMillis(start),
    ),
  ).toBeNull();
  expect(
    runLimitCommand(
      measured,
      { ...DEFAULT_RUN_LIMITS, maxOutputTokens: 1000 },
      DateTime.toEpochMillis(start),
    ),
  ).toMatchObject({ type: "run.interrupt" });
});
it("does not use context-window totals as a billing counter", () => {
  const turn = {
    ...providerTurn,
    tokenUsage: { usedTokens: 999999, outputTokens: 999999, updatedAt: "2026-10-04T12:00:00Z" },
  };
  expect(
    runLimitCommand(
      { ...input, providerTurns: [turn] },
      { ...DEFAULT_RUN_LIMITS, maxOutputTokens: 1 },
      DateTime.toEpochMillis(start),
    ),
  ).toBeNull();
});
it("uses a stable stop command identity on repeated scheduler ticks", () => {
  const limits = { ...DEFAULT_RUN_LIMITS, maxDurationMinutes: 1 };
  expect(runLimitCommand(input, limits, DateTime.toEpochMillis(start) + 120000)?.commandId).toBe(
    runLimitCommand(input, limits, DateTime.toEpochMillis(start) + 180000)?.commandId,
  );
});

itEffect.effect(
  "enforces defaults through stored runtime state and respects per-thread overrides and removal",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const now = yield* DateTime.now;
      const started = DateTime.subtract(now, { minutes: 20 });
      const first = ThreadId.make("limited-first");
      const second = ThreadId.make("limited-second");
      for (const threadId of [first, second]) {
        yield* projections.apply({
          id: EventId.make(`thread-event:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: started,
          payload: {
            ...v2Projection.thread,
            id: threadId,
            lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
            createdAt: started,
            updatedAt: started,
          },
        });
        yield* projections.apply({
          id: EventId.make(`run-event:${threadId}`),
          type: "run.created",
          threadId,
          runId: RunId.make(`run:${threadId}`),
          occurredAt: started,
          payload: {
            ...run,
            threadId,
            id: RunId.make(`run:${threadId}`),
            requestedAt: started,
            startedAt: started,
          },
        });
      }
      const commands: OrchestrationV2Command[] = [];
      const threads = {
        dispatch: (command: OrchestrationV2Command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      const service = yield* RunLimitsService.pipe(
        Effect.provide(runLimitsLayer),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      );
      yield* settings.updateSettings({
        runLimits: { maxDurationMinutes: 10, maxOutputTokens: null },
        threadRunLimits: { [first]: DEFAULT_RUN_LIMITS },
      });
      yield* service.enforce;
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "run.interrupt",
        threadId: second,
        holdQueue: true,
      });
      yield* settings.updateSettings({ threadRunLimits: { [first]: null } });
      yield* service.enforce;
      expect(
        commands
          .slice(1)
          .map((command) => ("threadId" in command ? command.threadId : null))
          .sort(),
      ).toEqual([first, second].sort());
      yield* settings.updateSettings({ runLimits: DEFAULT_RUN_LIMITS });
      yield* service.enforce;
      expect(commands).toHaveLength(3);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
          ServerSettings.layerTest(),
        ),
      ),
    ),
);

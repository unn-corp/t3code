import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { EventStoreV2 } from "../orchestration-v2/EventStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as SnapshotQuery from "./AutomationSnapshotQuery.ts";
import { emptyProjection, threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { automationThreadShell, automationThreadDetail } from "./AutomationSnapshotQuery.ts";
import { layer, OrchestrationEngineService } from "./AutomationOrchestration.ts";

const now = DateTime.makeUnsafe("2026-10-02T12:00:00Z");
const threadId = ThreadId.make("automation-thread");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("automation-project"),
  title: "Review",
  createdBy: "system",
  creationSource: "server",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const projection = emptyProjection({
  id: EventId.make("created"),
  threadId,
  type: "thread.created",
  occurredAt: now,
  payload: thread,
});
const shell = threadShellFromProjection(projection);

it("keeps queued work active and distinguishes user input from approval", () => {
  const queued = automationThreadShell({
    ...shell,
    status: "queued",
    latestRunId: RunId.make("queued-run"),
  });
  expect(queued.latestTurn?.state).toBe("running");
  expect(queued.session?.status).toBe("running");
  const waiting = automationThreadShell({
    ...shell,
    status: "waiting",
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("question"),
      kind: "user_input",
      createdAt: now,
    },
  });
  expect(waiting.hasPendingUserInput).toBe(true);
  expect(waiting.hasPendingApprovals).toBe(false);
  expect(
    automationThreadShell({ ...shell, status: "failed", lastError: "Provider failed" }).session,
  ).toMatchObject({ status: "error", lastError: "Provider failed" });
});

it("preserves transcript text, tool progress and pending questions for dashboards", () => {
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("tool"),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "GitHub PR",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "gh pr create",
    output: "https://github.com/acme/repo/pull/42",
    exitCode: 0,
  };
  const detail = automationThreadDetail(shell, {
    ...projection,
    turnItems: [item],
    messages: [
      {
        id: MessageId.make("reply"),
        threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text: "Review complete",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: now,
        updatedAt: now,
      },
    ],
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("question"),
        nodeId: NodeId.make("node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    ],
  });
  expect(detail.messages[0]).toMatchObject({
    text: "Review complete",
    createdAt: "2026-10-02T12:00:00.000Z",
  });
  expect(detail.activities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "tool.completed", summary: "gh pr create" }),
      expect.objectContaining({ kind: "user_input.requested", tone: "approval" }),
    ]),
  );
});

it.effect("applies review policy before launching an automated turn", () => {
  const actions: Array<unknown> = [];
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.mock(ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          dispatch: (command) =>
            Effect.sync(() => {
              actions.push(command);
              return { sequence: actions.length, storedEvents: [] };
            }),
          sendToThread: (input) =>
            Effect.sync(() => {
              actions.push(input);
              return { type: "sent" as const, dispatch: { sequence: actions.length } } as never;
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const automation = yield* OrchestrationEngineService;
    yield* automation.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("review"),
      threadId,
      runtimeMode: "automated-review",
      interactionMode: "plan",
      createdAt: DateTime.formatIso(now),
      message: {
        messageId: MessageId.make("review-input"),
        role: "user",
        text: "Review this project",
        attachments: [],
      },
    });
    expect(actions[0]).toMatchObject({
      type: "thread.runtime-mode.set",
      runtimeMode: "automated-review",
    });
    expect(actions[1]).toMatchObject({
      type: "thread.interaction-mode.set",
      interactionMode: "plan",
    });
    expect(actions[2]).toMatchObject({
      text: "Review this project",
      createdBy: "system",
      creationSource: "server",
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect(
  "shows recent tool work without reading every thread transcript or returning tool payloads",
  () => {
    const reads: unknown[] = [];
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("recent-tool"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Git status",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "command_execution",
      input: "git status",
      output: "large private tool output",
      exitCode: 0,
    };
    const testLayer = SnapshotQuery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 6000,
                threads: [shell],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          Layer.mock(EventStoreV2)({
            latestApplicationSequence: Effect.succeed(6000),
            read: (input) => {
              reads.push(input);
              return Stream.make({
                sequence: 5999,
                commandId: null,
                event: {
                  id: EventId.make("recent-event"),
                  threadId,
                  type: "turn-item.updated" as const,
                  occurredAt: now,
                  payload: item,
                },
              });
            },
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const query = yield* SnapshotQuery.ProjectionSnapshotQuery;
      const recent = yield* query.getRecentActivitySummaries!(5);
      expect(recent).toEqual([
        expect.objectContaining({ threadId, kind: "tool.completed", summary: "git status" }),
      ]);
      expect(recent[0]).not.toHaveProperty("payload");
      expect(reads).toEqual([{ afterSequence: 4000, throughSequence: 6000, limit: 2000 }]);
    }).pipe(Effect.provide(testLayer));
  },
);

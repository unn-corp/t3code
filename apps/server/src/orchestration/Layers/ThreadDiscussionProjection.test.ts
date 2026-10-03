import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SideThreadMessageId,
  ThreadId,
  type OrchestrationEvent,
  type SideThread,
} from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const testLayer = Layer.mergeAll(
  OrchestrationProjectionPipelineLive,
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-discussion-projection-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const createdAt = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
const alice = { subject: "clerk:alice", displayName: "Alice" };
const bob = { subject: "clerk:bob", displayName: "Bob" };
const charlie = { subject: "clerk:charlie", displayName: "Charlie" };
const projectId = ProjectId.make("discussion-project");
const threadId = ThreadId.make("discussion-thread");
const sideThreadId = sideThreadIdForThread(threadId);

function eventBase(id: string, target = threadId) {
  return {
    eventId: EventId.make(id),
    aggregateKind: "thread" as const,
    aggregateId: target,
    occurredAt: createdAt,
    commandId: CommandId.make(id),
    causationEventId: null,
    correlationId: null,
    metadata: { collaborationUser: alice },
  };
}

const threadCreated = (id: string, target = threadId) => ({
  ...eventBase(id, target),
  type: "thread.created" as const,
  payload: {
    threadId: target,
    projectId,
    title: "Shared thread",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdAt,
    updatedAt: createdAt,
  },
});

const apply = Effect.fn("applyDiscussionTestEvent")(function* (
  event: Omit<OrchestrationEvent, "sequence">,
) {
  const store = yield* OrchestrationEventStore;
  const pipeline = yield* OrchestrationProjectionPipeline;
  const saved = yield* store.append(event);
  yield* pipeline.projectEvent(saved);
  return saved;
});

const seed = Effect.gen(function* () {
  yield* apply({
    ...eventBase("project-create"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    payload: {
      projectId,
      title: "Shared project",
      workspaceRoot: "/tmp/discussion-projection",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  yield* apply(threadCreated("thread-create"));
});

function sqlTrace() {
  const spans: Tracer.Span[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      if (options.name === "sql.execute") spans.push(span);
      return span;
    },
  });
  return {
    tracer,
    queries: () => spans.map((span) => String(span.attributes.get("db.query.text"))),
  };
}

it.effect(
  "keeps native streaming, activities, metadata and every shell read off discussion bodies",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionThreadRepository;
      const query = yield* ProjectionSnapshotQuery;
      yield* seed;
      const archivedThreadId = ThreadId.make("archived-discussion-thread");
      yield* apply(threadCreated("archived-thread-create", archivedThreadId));
      for (const target of [threadId, archivedThreadId]) {
        yield* repository.updateDiscussion({
          threadId: target,
          updatedAt: createdAt,
          sideThreads: [
            {
              id: sideThreadIdForThread(target),
              createdBy: alice,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              messages: [],
            },
          ],
        });
      }
      yield* sql`UPDATE projection_threads SET archived_at = ${createdAt} WHERE thread_id = ${archivedThreadId}`;
      // Invalid JSON catches accidental decoding; SQL traces also catch unused raw
      // fetches, and the trigger catches any body write even if its value is unchanged.
      yield* sql`UPDATE projection_thread_discussions SET side_threads_json = 'unreadable body'`;
      yield* sql`CREATE TRIGGER reject_discussion_rewrite BEFORE UPDATE ON projection_thread_discussions
      BEGIN SELECT RAISE(ABORT, 'Discussion body must not be rewritten'); END`;
      const trace = sqlTrace();
      yield* Effect.gen(function* () {
        for (let index = 0; index < 3; index += 1) {
          yield* apply({
            ...eventBase(`delta-${index}`),
            type: "thread.message-sent",
            payload: {
              threadId,
              messageId: MessageId.make("assistant-message"),
              role: "assistant",
              text: "token",
              turnId: null,
              streaming: true,
              createdAt,
              updatedAt: createdAt,
            },
          });
        }
        yield* apply({
          ...eventBase("activity"),
          type: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity"),
              kind: "tool.completed",
              summary: "Tool finished",
              tone: "info",
              turnId: null,
              createdAt,
              payload: {},
            },
          },
        });
        yield* apply({
          ...eventBase("metadata"),
          type: "thread.meta-updated",
          payload: { threadId, title: "Updated title", updatedAt: later },
        });
        const active = (yield* query.getShellSnapshot()).threads;
        const archived = (yield* query.getArchivedShellSnapshot()).threads;
        const single = Option.getOrThrow(yield* query.getThreadShellById(threadId));
        assert.equal(active.length, 1);
        assert.equal(archived.length, 1);
        assert.equal(single.title, "Updated title");
        for (const shell of [...active, ...archived, single]) {
          assert.deepEqual(shell.createdBy, alice);
          assert.equal(shell.teamDiscussion?.messageCount, 0);
          assert.deepEqual(shell.teamDiscussion?.createdBy, alice);
        }
      }).pipe(Effect.withTracer(trace.tracer));
      const queries = trace.queries();
      assert.isTrue(queries.some((statement) => statement.includes("projection_threads")));
      assert.isTrue(
        queries.every(
          (statement) =>
            !statement.includes("projection_thread_discussions") &&
            !statement.includes("side_threads_json"),
        ),
      );
      assert.deepEqual(yield* sql`SELECT side_threads_json FROM projection_thread_discussions`, [
        { side_threads_json: "unreadable body" },
        { side_threads_json: "unreadable body" },
      ]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("atomically stores bounded shell summaries while retaining full discussion bodies", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectionThreadRepository;
    const query = yield* ProjectionSnapshotQuery;
    yield* seed;
    const body: SideThread = {
      id: sideThreadId,
      createdBy: alice,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      messages: Array.from({ length: 500 }, (_, index) => ({
        id: SideThreadMessageId.make(`post-${index}`),
        author: alice,
        text: "x".repeat(20_000),
        mentions: [bob],
        createdAt,
        updatedAt: createdAt,
      })),
    };
    yield* repository.updateDiscussion({ threadId, sideThreads: [body], updatedAt: createdAt });
    const shell = Option.getOrThrow(yield* query.getThreadShellById(threadId));
    assert.equal(shell.teamDiscussion?.messageCount, 500);
    assert.equal(shell.teamDiscussion?.latestMessage?.text.length, 500);
    assert.equal(shell.teamDiscussion?.latestMentions[0]?.id, "post-499");
    assert.deepEqual(shell.teamDiscussion?.participants, [alice, bob]);
    for (const thread of [
      (yield* query.getSnapshot()).threads[0]!,
      (yield* query.getCommandReadModel()).threads[0]!,
      Option.getOrThrow(yield* query.getThreadDetailById(threadId)),
    ])
      assert.deepEqual(thread.sideThreads, [body]);
    yield* sql`CREATE TRIGGER reject_discussion_summary BEFORE UPDATE OF team_discussion_json ON projection_threads
      BEGIN SELECT RAISE(ABORT, 'Reject summary update'); END`;
    const failed = yield* Effect.result(
      repository.updateDiscussion({
        threadId,
        sideThreads: [{ ...body, messages: [] }],
        updatedAt: later,
      }),
    );
    assert.equal(failed._tag, "Failure");
    assert.deepEqual(Option.getOrThrow(yield* repository.getDiscussion({ threadId })).sideThreads, [
      body,
    ]);
    assert.deepEqual(
      Option.getOrThrow(yield* query.getThreadShellById(threadId)).teamDiscussion,
      shell.teamDiscussion,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "updates stored summaries for discussion mutations and clears old posts on recreation",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const repository = yield* ProjectionThreadRepository;
      yield* seed;
      yield* apply({
        ...eventBase("discussion-create"),
        type: "sidethread.created",
        payload: { threadId, sideThreadId, createdBy: alice, createdAt },
      });
      assert.equal(
        Option.getOrThrow(yield* query.getThreadShellById(threadId)).teamDiscussion?.messageCount,
        0,
      );
      const messageId = SideThreadMessageId.make("post");
      yield* apply({
        ...eventBase("discussion-post"),
        type: "sidethread.message-posted",
        payload: {
          threadId,
          sideThreadId,
          messageId,
          text: "Review this",
          author: alice,
          mentions: [bob],
          createdAt,
        },
      });
      yield* apply({
        ...eventBase("discussion-edit"),
        type: "sidethread.message-edited",
        payload: {
          threadId,
          sideThreadId,
          messageId,
          editor: alice,
          text: "Edited review",
          editedAt: later,
        },
      });
      yield* apply({
        ...eventBase("discussion-reaction"),
        type: "sidethread.message-reacted",
        payload: {
          threadId,
          sideThreadId,
          messageId,
          emoji: "eyes",
          user: charlie,
          action: "added",
          createdAt: later,
        },
      });
      yield* apply({
        ...eventBase("discussion-read"),
        type: "sidethread.marked-read",
        payload: { threadId, sideThreadId, user: bob, lastReadAt: later, createdAt: later },
      });
      const shell = Option.getOrThrow(yield* query.getThreadShellById(threadId)).teamDiscussion!;
      assert.equal(shell.messageCount, 1);
      assert.equal(shell.latestMessage?.text, "Edited review");
      assert.equal(shell.latestMentions[0]?.text, "Edited review");
      assert.deepEqual(shell.readBy, [{ user: bob, lastReadAt: later }]);
      assert.deepEqual(shell.participants, [alice, bob, charlie]);
      yield* apply({
        ...eventBase("discussion-archive"),
        type: "sidethread.archived",
        payload: { threadId, sideThreadId, archivedAt: later },
      });
      assert.equal(
        Option.getOrThrow(yield* query.getThreadShellById(threadId)).teamDiscussion?.archivedAt,
        later,
      );
      yield* apply({
        ...eventBase("discussion-unarchive"),
        type: "sidethread.unarchived",
        payload: { threadId, sideThreadId, unarchivedAt: later },
      });
      assert.equal(
        Option.getOrThrow(yield* query.getThreadShellById(threadId)).teamDiscussion?.archivedAt,
        null,
      );
      yield* apply({
        ...eventBase("thread-delete"),
        type: "thread.deleted",
        payload: { threadId, deletedAt: later },
      });
      assert.equal((yield* query.getThreadShellById(threadId))._tag, "None");
      yield* apply(threadCreated("thread-recreate"));
      assert.equal(
        Option.getOrThrow(yield* query.getThreadShellById(threadId)).teamDiscussion,
        undefined,
      );
      assert.deepEqual(
        Option.getOrThrow(yield* repository.getDiscussion({ threadId })).sideThreads,
        [],
      );
      yield* repository.deleteById({ threadId });
      assert.deepEqual(yield* sql`SELECT thread_id FROM projection_thread_discussions`, []);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "preserves discussion references without traversing them during native event replay",
  () =>
    Effect.gen(function* () {
      const created = yield* projectEvent(createEmptyReadModel(createdAt), {
        ...threadCreated("thread-create"),
        sequence: 1,
      });
      const body = new Proxy([] as ReadonlyArray<SideThread>, {
        get() {
          throw new Error("Native event traversed discussion body");
        },
      });
      const model = { ...created, threads: [{ ...created.threads[0]!, sideThreads: body }] };
      const streamed = yield* projectEvent(model, {
        ...eventBase("delta"),
        sequence: 2,
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.make("assistant"),
          role: "assistant",
          text: "token",
          turnId: null,
          streaming: true,
          createdAt,
          updatedAt: createdAt,
        },
      });
      assert.strictEqual(streamed.threads[0]?.sideThreads, body);
      assert.equal(streamed.threads[0]?.messages[0]?.text, "token");
    }),
);

import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Reply tests never launch a provider"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "message-replies" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:replies"),
      title: "Replies",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });
const writeMessage = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant",
  parent?: string,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const message: OrchestrationV2ConversationMessage = {
      id: MessageId.make(id),
      threadId,
      runId: null,
      nodeId: null,
      role,
      text: `Text ${id}`,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "web",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      ...(parent
        ? {
            context: {
              version: 1,
              records: [],
              replyTo: {
                threadId,
                messageId: MessageId.make(parent),
                role: "assistant",
                text: `Text ${parent}`,
              },
            },
          }
        : {}),
    };
    yield* sink.write({
      events: [
        {
          type: "message.updated",
          id: EventId.make(`event:${id}`),
          threadId,
          occurredAt: now,
          payload: message,
        },
      ],
    });
    return message;
  });

it.effect(
  "persists canonical replies, paginates only their chain, and rejects foreign targets",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:reply-query");
      yield* createThread(threadId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* writeMessage(threadId, "root", "assistant");
      yield* writeMessage(threadId, "child", "user", "root");
      yield* writeMessage(threadId, "grandchild", "assistant", "child");
      yield* writeMessage(threadId, "sibling", "user", "root");
      yield* writeMessage(threadId, "unrelated", "assistant");
      // A malformed unrelated row proves the query does not hydrate the whole transcript.
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json) VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, '2026-01-01', '2026-01-01', '{"obsolete":true}')`;
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.context.replyTo.messageId') = 'root' AND json_extract(payload_json, '$.context.replyTo.threadId') = thread_id`;
      assert.ok(
        plan.some((row) => row.detail.includes("orchestration_v2_message_reply_parent_idx")),
      );
      const first = yield* store.getThreadRecords(threadId, ["messages"], {
        messageReplyChainId: MessageId.make("grandchild"),
        messageLimit: 2,
      });
      const second = yield* store.getThreadRecords(threadId, ["messages"], {
        messageReplyChainId: MessageId.make("grandchild"),
        messageLimit: 2,
        messageOffset: 2,
      });
      assert.deepEqual(
        [...first.messages, ...second.messages].map((message) => message.id).sort(),
        ["child", "grandchild", "root", "sibling"],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], {
          messageReplyChainId: MessageId.make("gone"),
          messageLimit: 100,
        })).messages,
        [],
      );
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'obsolete'`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send-reply"),
        threadId,
        messageId: MessageId.make("sent"),
        text: "Follow up",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "defer_start" },
        context: {
          version: 1,
          records: [],
          replyTo: {
            threadId,
            messageId: MessageId.make("root"),
            role: "user",
            text: "Spoofed quote",
          },
        },
      });
      const sent = (yield* store.getThreadRecords(threadId, ["messages"], {
        messageIds: [MessageId.make("sent")],
      })).messages[0]!;
      assert.equal(sent.context?.replyTo?.text, "Text root");
      assert.equal(sent.context?.replyTo?.role, "assistant");
      const foreign = ThreadId.make("thread:foreign");
      yield* createThread(foreign);
      yield* writeMessage(foreign, "foreign-message", "assistant");
      for (const target of ["foreign-message", "missing", "self"]) {
        const error = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`reject:${target}`),
            threadId,
            messageId: MessageId.make("self"),
            text: "Reply",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "defer_start" },
            context: {
              version: 1,
              records: [],
              replyTo: {
                threadId,
                messageId: MessageId.make(target),
                role: "assistant",
                text: "Quote",
              },
            },
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.instanceOf(error.cause, Orchestrator.OrchestratorCommandRejectedError);
      }
      // Serialization round-trip through SQL keeps links without relying on live component state.
      const reloaded = (yield* store.getThreadRecords(threadId, ["messages"], {
        messageIds: [sent.id],
      })).messages[0]!;
      assert.deepEqual(reloaded.context, sent.context);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "links agent message and timeline events to the initiating user, with explicit overrides",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:agent-reply");
      yield* createThread(threadId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const earlier = yield* writeMessage(threadId, "earlier-user", "user");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("agent-start"),
        threadId,
        messageId: MessageId.make("current-user"),
        text: "Current question",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* store.getThreadRecords(threadId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            type: "run.updated",
            id: EventId.make("running"),
            threadId,
            occurredAt: now,
            payload: { ...run, status: "running" },
          },
        ],
      });
      const emitAssistant = (suffix: string) =>
        Effect.gen(function* () {
          const id = MessageId.make(`assistant:${suffix}`);
          const message: OrchestrationV2ConversationMessage = {
            id,
            threadId,
            runId: run.id,
            nodeId: null,
            role: "assistant",
            text: "Answer",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          };
          yield* sink.write({
            events: [
              {
                type: "message.updated",
                id: EventId.make(`answer:${suffix}`),
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: message,
              },
              {
                type: "turn-item.updated",
                id: EventId.make(`item:${suffix}`),
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`item:${suffix}`),
                  threadId,
                  runId: run.id,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 0,
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  type: "assistant_message",
                  status: "completed",
                  messageId: id,
                  text: "Answer",
                  attachments: [],
                  streaming: false,
                  updatedAt: now,
                },
              },
            ],
          });
          const records = yield* store.getThreadRecords(threadId, ["messages", "turnItems"], {
            messageIds: [id],
            turnItemRunIds: [run.id],
            turnItemTypes: ["assistant_message"],
          });
          const timeline = records.turnItems.find(
            (item) => item.type === "assistant_message" && item.messageId === id,
          )!;
          assert.deepEqual(
            "context" in timeline ? timeline.context : undefined,
            records.messages[0]?.context,
          );
          return records.messages[0]!;
        });
      assert.equal((yield* emitAssistant("default")).context?.replyTo?.messageId, "current-user");
      yield* orchestrator.dispatch({
        type: "run.reply-target.set",
        commandId: CommandId.make("agent-select"),
        threadId,
        runId: run.id,
        messageId: earlier.id,
      });
      assert.equal((yield* emitAssistant("explicit")).context?.replyTo?.messageId, earlier.id);
      // A queued follow-up points at the current response. Linking that response back
      // to the queued user message, or the queued message to its own descendant, cycles.
      const queuedId = MessageId.make("queued-reply");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue-reply"),
        threadId,
        messageId: queuedId,
        text: "Follow up",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
        context: {
          version: 1,
          records: [],
          replyTo: {
            threadId,
            messageId: MessageId.make("assistant:explicit"),
            role: "assistant",
            text: "Answer",
          },
        },
      });
      const queued = (yield* store.getThreadRecords(threadId, ["runs"])).runs.find(
        (candidate) => candidate.userMessageId === queuedId,
      )!;
      const cycle = yield* orchestrator
        .dispatch({
          type: "run.reply-target.set",
          commandId: CommandId.make("agent-cycle"),
          threadId,
          runId: run.id,
          messageId: queuedId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(cycle.cause, Orchestrator.OrchestratorCommandRejectedError);
      yield* writeMessage(threadId, "queued-descendant", "assistant", queuedId);
      const editCycle = yield* orchestrator
        .dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("edit-cycle"),
          threadId,
          runId: queued.id,
          text: "Edited",
          context: {
            version: 1,
            records: [],
            replyTo: {
              threadId,
              messageId: MessageId.make("queued-descendant"),
              role: "assistant",
              text: "Descendant",
            },
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(editCycle.cause, Orchestrator.OrchestratorCommandRejectedError);
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("edit-reply"),
        threadId,
        runId: queued.id,
        text: "Edited",
        context: {
          version: 1,
          records: [],
          replyTo: { threadId, messageId: earlier.id, role: "assistant", text: "Spoof" },
        },
      });
      assert.equal(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageIds: [queuedId] }))
          .messages[0]?.context?.replyTo?.text,
        earlier.text,
      );
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("clear-reply"),
        threadId,
        runId: queued.id,
        text: "Edited",
        context: { version: 1, records: [] },
      });
      assert.equal(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageIds: [queuedId] }))
          .messages[0]?.context?.replyTo,
        undefined,
      );
      const invalid = yield* orchestrator
        .dispatch({
          type: "run.reply-target.set",
          commandId: CommandId.make("agent-invalid"),
          threadId,
          runId: run.id,
          messageId: MessageId.make("assistant:default"),
        })
        .pipe(Effect.flip);
      assert.equal(invalid._tag, "OrchestratorDispatchError");
      assert.instanceOf(invalid.cause, Orchestrator.OrchestratorCommandRejectedError);
      const currentRun = (yield* store.getThreadRecords(threadId, ["runs"], { runIds: [run.id] }))
        .runs[0]!;
      yield* sink.write({
        events: [
          {
            type: "run.updated",
            id: EventId.make("ended"),
            threadId,
            occurredAt: now,
            payload: { ...currentRun, status: "completed", completedAt: now },
          },
        ],
      });
      assert.equal(
        (yield* orchestrator
          .dispatch({
            type: "run.reply-target.set",
            commandId: CommandId.make("agent-ended"),
            threadId,
            runId: run.id,
            messageId: earlier.id,
          })
          .pipe(Effect.flip))._tag,
        "OrchestratorDispatchError",
      );
    }).pipe(Effect.provide(testLayer)),
);

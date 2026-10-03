import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ClientOrchestrationCommand,
  type OrchestrationCommand,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SideThreadMessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const isClientCommand = Schema.is(ClientOrchestrationCommand);
const now = "2026-07-22T12:00:00.000Z";
const threadId = ThreadId.make("thread-side");
const anchorMessageId = MessageId.make("message-anchor");
const sideThreadId = sideThreadIdForThread(threadId);
const collaborationUser = {
  subject: "clerk:alice-subject",
  displayName: "Alice Example",
};

function persisted(
  sequence: number,
  event: Omit<OrchestrationEvent, "sequence">,
): OrchestrationEvent {
  return { ...event, sequence } as OrchestrationEvent;
}

const seededReadModel = Effect.gen(function* () {
  const created = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      projectId: ProjectId.make("project-side"),
      title: "Side conversation",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(created, {
    sequence: 2,
    eventId: EventId.make("event-anchor-message"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.message-sent",
    occurredAt: now,
    commandId: CommandId.make("command-anchor-message"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId: anchorMessageId,
      role: "assistant",
      text: "Inspect this design.",
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("durable orchestration SideThreads", (it) => {
  it.effect("creates one thread-level discussion and posts with the authenticated author", () =>
    Effect.gen(function* () {
      let readModel = yield* seededReadModel;
      const created = yield* decideOrchestrationCommand({
        readModel,
        collaborationUser,
        command: {
          type: "sidethread.create",
          commandId: CommandId.make("command-side-create"),
          threadId,
          sideThreadId,
          anchorMessageId,
          createdAt: now,
        },
      });
      expect(Array.isArray(created)).toBe(false);
      const createdEvent = created as Omit<OrchestrationEvent, "sequence">;
      expect(createdEvent.type).toBe("sidethread.created");
      if (createdEvent.type === "sidethread.created") {
        expect((createdEvent.payload as { createdBy: unknown }).createdBy).toEqual({
          subject: "clerk:alice-subject",
          displayName: "Alice Example",
        });
      }
      readModel = yield* projectEvent(readModel, persisted(3, createdEvent));

      const posted = yield* decideOrchestrationCommand({
        readModel,
        collaborationUser,
        command: {
          type: "sidethread.message.post",
          commandId: CommandId.make("command-side-post"),
          threadId,
          sideThreadId,
          messageId: SideThreadMessageId.make("side-message-1"),
          text: "Looks safe to me.",
          createdAt: now,
        },
      });
      const postedEvent = posted as Omit<OrchestrationEvent, "sequence">;
      readModel = yield* projectEvent(readModel, persisted(4, postedEvent));
      expect(readModel.threads[0]?.sideThreads?.[0]?.messages[0]?.author.subject).toBe(
        "clerk:alice-subject",
      );
      expect(readModel.threads[0]?.sideThreads?.[0]?.messages[0]?.text).toBe("Looks safe to me.");

      const archived = yield* decideOrchestrationCommand({
        readModel,
        collaborationUser,
        command: {
          type: "sidethread.archive",
          commandId: CommandId.make("command-side-archive"),
          threadId,
          sideThreadId,
          createdAt: now,
        },
      });
      readModel = yield* projectEvent(
        readModel,
        persisted(5, archived as Omit<OrchestrationEvent, "sequence">),
      );
      expect(readModel.threads[0]?.sideThreads?.[0]?.archivedAt).toBe(now);
    }),
  );

  it.effect(
    "accepts no anchor and rejects non-canonical ids, missing anchors, and unauthenticated authors",
    () =>
      Effect.gen(function* () {
        const readModel = yield* seededReadModel;
        const withoutAnchor = yield* decideOrchestrationCommand({
          readModel,
          collaborationUser,
          command: {
            type: "sidethread.create",
            commandId: CommandId.make("command-side-no-anchor"),
            threadId,
            sideThreadId,
            createdAt: now,
          },
        });
        expect((withoutAnchor as Omit<OrchestrationEvent, "sequence">).type).toBe(
          "sidethread.created",
        );

        const nonCanonical = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            collaborationUser,
            command: {
              type: "sidethread.create",
              commandId: CommandId.make("command-side-non-canonical"),
              threadId,
              sideThreadId: sideThreadIdForThread(ThreadId.make("another-thread")),
              createdAt: now,
            },
          }),
        );
        expect(nonCanonical.message).toContain("canonical discussion");

        const missingAnchor = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            collaborationUser,
            command: {
              type: "sidethread.create",
              commandId: CommandId.make("command-side-missing-anchor"),
              threadId,
              sideThreadId,
              anchorMessageId: MessageId.make("missing-message"),
              createdAt: now,
            },
          }),
        );
        expect(missingAnchor.message).toContain("does not exist");

        const missingActor = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "sidethread.create",
              commandId: CommandId.make("command-side-missing-actor"),
              threadId,
              sideThreadId,
              anchorMessageId,
              createdAt: now,
            },
          }),
        );
        expect(missingActor.message).toContain("authenticated collaboration identity");
      }),
  );

  it.effect("supports replies, reactions, edits, attachments, and monotonic read markers", () =>
    Effect.gen(function* () {
      let readModel = yield* seededReadModel;
      const created = yield* decideOrchestrationCommand({
        readModel,
        collaborationUser,
        command: {
          type: "sidethread.create",
          commandId: CommandId.make("command-rich-create"),
          threadId,
          sideThreadId,
          createdAt: now,
        },
      });
      readModel = yield* projectEvent(
        readModel,
        persisted(3, created as Omit<OrchestrationEvent, "sequence">),
      );
      const posted = yield* decideOrchestrationCommand({
        readModel,
        collaborationUser,
        command: {
          type: "sidethread.message.post",
          commandId: CommandId.make("command-rich-post"),
          threadId,
          sideThreadId,
          messageId: SideThreadMessageId.make("rich-message"),
          text: "@bob please check",
          mentions: [{ subject: "clerk:bob", displayName: "Bob" }],
          quotedMessageId: anchorMessageId,
          attachments: [
            {
              type: "gif",
              url: "https://example.test/demo.gif",
              previewUrl: "https://example.test/demo.gif",
              width: 320,
              height: 180,
            },
          ],
          createdAt: now,
        },
      });
      readModel = yield* projectEvent(
        readModel,
        persisted(4, posted as Omit<OrchestrationEvent, "sequence">),
      );

      const reacted = yield* decideOrchestrationCommand({
        readModel,
        collaborationUser,
        command: {
          type: "sidethread.message.react",
          commandId: CommandId.make("command-rich-react"),
          threadId,
          sideThreadId,
          messageId: SideThreadMessageId.make("rich-message"),
          emoji: "eyes",
          createdAt: "2026-07-22T12:01:00.000Z",
        },
      });
      readModel = yield* projectEvent(
        readModel,
        persisted(5, reacted as Omit<OrchestrationEvent, "sequence">),
      );

      const edited = yield* decideOrchestrationCommand({
        readModel,
        collaborationUser,
        command: {
          type: "sidethread.message.edit",
          commandId: CommandId.make("command-rich-edit"),
          threadId,
          sideThreadId,
          messageId: SideThreadMessageId.make("rich-message"),
          text: "@bob checked",
          createdAt: "2026-07-22T12:02:00.000Z",
        },
      });
      readModel = yield* projectEvent(
        readModel,
        persisted(6, edited as Omit<OrchestrationEvent, "sequence">),
      );

      const markedRead = yield* decideOrchestrationCommand({
        readModel,
        collaborationUser,
        command: {
          type: "sidethread.mark-read",
          commandId: CommandId.make("command-rich-read"),
          threadId,
          sideThreadId,
          lastReadAt: "2026-07-22T12:02:00.000Z",
          createdAt: "2026-07-22T12:02:00.000Z",
        },
      });
      readModel = yield* projectEvent(
        readModel,
        persisted(7, markedRead as Omit<OrchestrationEvent, "sequence">),
      );

      const message = readModel.threads[0]?.sideThreads?.[0]?.messages[0];
      expect(message?.text).toBe("@bob checked");
      expect(message?.attachments?.[0]?.type).toBe("gif");
      expect(message?.reactions?.[0]?.users[0]?.subject).toBe("clerk:alice-subject");
      expect(message?.editedAt).toBe("2026-07-22T12:02:00.000Z");
      expect(readModel.threads[0]?.sideThreads?.[0]?.readBy?.[0]?.lastReadAt).toBe(
        "2026-07-22T12:02:00.000Z",
      );

      const foreignEdit = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          collaborationUser: { subject: "clerk:bob", displayName: "Bob" },
          command: {
            type: "sidethread.message.edit",
            commandId: CommandId.make("command-rich-foreign-edit"),
            threadId,
            sideThreadId,
            messageId: SideThreadMessageId.make("rich-message"),
            text: "hijacked",
            createdAt: "2026-07-22T12:03:00.000Z",
          },
        }),
      );
      expect(foreignEdit.message).toContain("original author");

      const unsafeGif = yield* Effect.flip(
        decideOrchestrationCommand({
          readModel,
          collaborationUser,
          command: {
            type: "sidethread.message.post",
            commandId: CommandId.make("command-rich-unsafe-gif"),
            threadId,
            sideThreadId,
            messageId: SideThreadMessageId.make("unsafe-gif-message"),
            text: "",
            attachments: [
              {
                type: "gif",
                url: "http://tracker.example.test/proof.gif",
                previewUrl: "http://tracker.example.test/proof.gif",
                width: 320,
                height: 180,
              },
            ],
            createdAt: "2026-07-22T12:04:00.000Z",
          },
        }),
      );
      expect(unsafeGif.message).toContain("HTTPS");
    }),
  );
  it.effect(
    "rejects forged authors, foreign-project references, archived targets, and oversized content",
    () =>
      Effect.gen(function* () {
        let readModel = yield* seededReadModel;
        const forged = yield* decodeClientCommand({
          type: "sidethread.create",
          commandId: "forged",
          threadId,
          sideThreadId,
          createdAt: now,
          createdBy: collaborationUser,
          author: collaborationUser,
          collaborationUser,
        });
        expect(forged).not.toHaveProperty("author");
        expect(forged).not.toHaveProperty("createdBy");
        expect(forged).not.toHaveProperty("collaborationUser");
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({ readModel, command: forged as OrchestrationCommand }),
        );
        expect(failure.message).toContain("authenticated collaboration identity");
        const created = yield* decideOrchestrationCommand({
          readModel,
          collaborationUser,
          command: {
            type: "sidethread.create",
            commandId: CommandId.make("scope-create"),
            threadId,
            sideThreadId,
            createdAt: now,
          },
        });
        readModel = yield* projectEvent(
          readModel,
          persisted(3, created as Omit<OrchestrationEvent, "sequence">),
        );
        const targetId = ThreadId.make("foreign-thread");
        const base = {
          type: "sidethread.message.post" as const,
          commandId: CommandId.make("scope-post"),
          threadId,
          sideThreadId,
          messageId: SideThreadMessageId.make("scope-message"),
          text: "Take a look",
          createdAt: now,
        };
        for (const target of [
          { ...readModel.threads[0]!, id: targetId, projectId: ProjectId.make("another-project") },
          { ...readModel.threads[0]!, id: targetId, archivedAt: now },
          { ...readModel.threads[0]!, id: targetId, deletedAt: now },
        ]) {
          const failure = yield* Effect.flip(
            decideOrchestrationCommand({
              collaborationUser,
              readModel: { ...readModel, threads: [...readModel.threads, target] },
              command: { ...base, linkedRef: { kind: "agent-thread", threadId: targetId } },
            }),
          );
          expect(failure.message).toContain("active thread in this project");
        }
        const valid = yield* decideOrchestrationCommand({
          collaborationUser,
          readModel: {
            ...readModel,
            threads: [...readModel.threads, { ...readModel.threads[0]!, id: targetId }],
          },
          command: { ...base, linkedRef: { kind: "agent-thread", threadId: targetId } },
        });
        expect((valid as Omit<OrchestrationEvent, "sequence">).type).toBe(
          "sidethread.message-posted",
        );
        for (const command of [
          { ...base, text: "x".repeat(20_001) },
          {
            ...base,
            mentions: Array.from({ length: 21 }, (_, index) => ({
              subject: `member-${index}`,
              displayName: "Member",
            })),
          },
        ]) {
          expect(isClientCommand(command)).toBe(false);
          const failure = yield* Effect.flip(
            decideOrchestrationCommand({ readModel, collaborationUser, command }),
          );
          expect(failure.message).toContain("limit");
        }
        const discussion = readModel.threads[0]!.sideThreads![0]!;
        const full = {
          ...readModel,
          threads: [
            {
              ...readModel.threads[0]!,
              sideThreads: [
                {
                  ...discussion,
                  messages: Array.from({ length: 500 }, (_, index) => ({
                    id: SideThreadMessageId.make(`existing-${index}`),
                    author: collaborationUser,
                    text: "Recorded",
                    createdAt: now,
                  })),
                },
              ],
            },
          ],
        };
        const capped = yield* Effect.flip(
          decideOrchestrationCommand({ readModel: full, collaborationUser, command: base }),
        );
        expect(capped.message).toContain("500 message limit");
      }),
  );

  it.effect(
    "requires identity for archive, reopens the discussion, and clamps monotonic read markers",
    () =>
      Effect.gen(function* () {
        let readModel = yield* seededReadModel;
        const create = {
          type: "sidethread.create" as const,
          commandId: CommandId.make("archive-create"),
          threadId,
          sideThreadId,
          createdAt: now,
        };
        const created = yield* decideOrchestrationCommand({
          readModel,
          collaborationUser,
          command: create,
        });
        readModel = yield* projectEvent(
          readModel,
          persisted(3, created as Omit<OrchestrationEvent, "sequence">),
        );
        const archive = {
          ...create,
          type: "sidethread.archive" as const,
          commandId: CommandId.make("archive"),
        };
        expect(
          (yield* Effect.flip(decideOrchestrationCommand({ readModel, command: archive }))).message,
        ).toContain("authenticated");
        const archived = yield* decideOrchestrationCommand({
          readModel,
          collaborationUser,
          command: archive,
        });
        readModel = yield* projectEvent(
          readModel,
          persisted(4, archived as Omit<OrchestrationEvent, "sequence">),
        );
        const post = {
          ...create,
          type: "sidethread.message.post" as const,
          messageId: SideThreadMessageId.make("reopened-post"),
          text: "Hello",
        };
        expect(
          (yield* Effect.flip(
            decideOrchestrationCommand({ readModel, collaborationUser, command: post }),
          )).message,
        ).toContain("archived");
        const reopened = yield* decideOrchestrationCommand({
          readModel,
          collaborationUser,
          command: { ...archive, type: "sidethread.unarchive" },
        });
        readModel = yield* projectEvent(
          readModel,
          persisted(5, reopened as Omit<OrchestrationEvent, "sequence">),
        );
        expect(readModel.threads[0]?.sideThreads?.[0]?.archivedAt).toBeNull();
        yield* decideOrchestrationCommand({ readModel, collaborationUser, command: post });
        for (const lastReadAt of ["2099-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"]) {
          const marked = yield* decideOrchestrationCommand({
            readModel,
            collaborationUser,
            command: { ...create, type: "sidethread.mark-read", lastReadAt },
          });
          readModel = yield* projectEvent(
            readModel,
            persisted(6, marked as Omit<OrchestrationEvent, "sequence">),
          );
          expect(readModel.threads[0]?.sideThreads?.[0]?.readBy?.[0]?.lastReadAt).toBe(now);
        }
      }),
  );
});

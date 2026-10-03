import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SideThreadId,
  SideThreadMessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const now = "2026-07-22T12:00:00.000Z";
const threadId = ThreadId.make("thread-side-reducer");
const sideThreadId = SideThreadId.make("side-reducer");
const baseThread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-side-reducer"),
  title: "Reducer",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  pullRequests: [],
  sideThreads: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const baseEvent = {
  eventId: EventId.make("event-side-reducer"),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: now,
  commandId: CommandId.make("command-side-reducer"),
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

describe("SideThread detail reduction", () => {
  it("preserves event order for same-timestamp posts when marking them read", () => {
    const user = { subject: "clerk:alice", displayName: "Alice" };
    const ordered = {
      ...baseThread,
      sideThreads: [
        {
          id: SideThreadId.make(`thread:${threadId}`),
          createdBy: user,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          messages: ["post-z", "post-a"].map((id) => ({
            id: SideThreadMessageId.make(id),
            author: user,
            text: id,
            createdAt: now,
          })),
        },
      ],
    };
    const marked = applyThreadDetailEvent(ordered, {
      ...baseEvent,
      sequence: 4,
      type: "sidethread.marked-read",
      payload: {
        threadId,
        sideThreadId: SideThreadId.make(`thread:${threadId}`),
        user,
        lastReadAt: now,
        createdAt: now,
      },
    });
    if (marked.kind !== "updated") throw new Error("Missing discussion update");
    expect(marked.thread.sideThreads?.[0]?.messages.map((message) => message.id)).toEqual([
      "post-z",
      "post-a",
    ]);
  });

  it("replays trusted thread and user-message attribution without labeling assistant output", () => {
    const collaborationUser = { subject: "clerk:alice", displayName: "Alice" };
    const created = applyThreadDetailEvent(baseThread, {
      ...baseEvent,
      metadata: { collaborationUser },
      sequence: 1,
      type: "thread.created",
      payload: {
        threadId,
        projectId: baseThread.projectId,
        title: baseThread.title,
        modelSelection: baseThread.modelSelection,
        runtimeMode: baseThread.runtimeMode,
        interactionMode: baseThread.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (created.kind !== "updated") throw new Error("Missing created thread");
    expect(created.thread.createdBy).toEqual(collaborationUser);
    const message = applyThreadDetailEvent(created.thread, {
      ...baseEvent,
      metadata: { collaborationUser },
      sequence: 2,
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: MessageId.make("native-user"),
        role: "user",
        text: "Start the agent",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (message.kind !== "updated") throw new Error("Missing user message");
    expect(message.thread.messages[0]?.author).toEqual(collaborationUser);
    const assistant = applyThreadDetailEvent(message.thread, {
      ...baseEvent,
      metadata: {},
      sequence: 3,
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: MessageId.make("native-assistant"),
        role: "assistant",
        text: "Working",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (assistant.kind !== "updated") throw new Error("Missing assistant message");
    expect(assistant.thread.messages[0]?.author).toEqual(collaborationUser);
    expect(assistant.thread.messages[1]?.author).toBeUndefined();
  });

  it("replays create, message, and archive events", () => {
    const created = applyThreadDetailEvent(baseThread, {
      ...baseEvent,
      sequence: 1,
      type: "sidethread.created",
      payload: {
        threadId,
        sideThreadId,
        anchorMessageId: MessageId.make("anchor-reducer"),
        createdBy: { subject: "clerk:alice", displayName: "Alice" },
        createdAt: now,
      },
    } satisfies OrchestrationEvent);
    expect(created.kind).toBe("updated");
    if (created.kind !== "updated") return;
    expect(created.thread.sideThreads?.[0]?.id).toBe("thread:thread-side-reducer");

    const posted = applyThreadDetailEvent(created.thread, {
      ...baseEvent,
      sequence: 2,
      type: "sidethread.message-posted",
      payload: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make("message-reducer"),
        author: { subject: "clerk:bob", displayName: "Bob" },
        text: "Ship it",
        createdAt: now,
      },
    } satisfies OrchestrationEvent);
    expect(posted.kind).toBe("updated");
    if (posted.kind !== "updated") return;
    expect(posted.thread.sideThreads?.[0]?.messages[0]?.author.displayName).toBe("Bob");

    const archived = applyThreadDetailEvent(posted.thread, {
      ...baseEvent,
      sequence: 3,
      type: "sidethread.archived",
      payload: { threadId, sideThreadId, archivedAt: now },
    } satisfies OrchestrationEvent);
    expect(archived.kind).toBe("updated");
    if (archived.kind === "updated") {
      expect(archived.thread.sideThreads?.[0]?.archivedAt).toBe(now);
    }
  });

  it("replays reactions, edits, and read markers without losing message metadata", () => {
    const created = applyThreadDetailEvent(baseThread, {
      ...baseEvent,
      sequence: 1,
      type: "sidethread.created",
      payload: {
        threadId,
        sideThreadId,
        anchorMessageId: MessageId.make("anchor-rich-reducer"),
        createdBy: { subject: "clerk:alice", displayName: "Alice" },
        createdAt: now,
      },
    } satisfies OrchestrationEvent);
    if (created.kind !== "updated") throw new Error("Expected side thread creation");

    const posted = applyThreadDetailEvent(created.thread, {
      ...baseEvent,
      sequence: 2,
      type: "sidethread.message-posted",
      payload: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make("message-rich-reducer"),
        author: { subject: "clerk:bob", displayName: "Bob" },
        text: "Please review",
        mentions: [{ subject: "clerk:alice", displayName: "Alice" }],
        attachments: [
          {
            type: "gif",
            url: "https://example.com/review.gif",
            previewUrl: "https://example.com/review-preview.gif",
            width: 320,
            height: 180,
          },
        ],
        linkedRef: { kind: "agent-thread", threadId: ThreadId.make("linked-thread") },
        quotedMessageId: MessageId.make("anchor-rich-reducer"),
        createdAt: now,
      },
    } satisfies OrchestrationEvent);
    if (posted.kind !== "updated") throw new Error("Expected side thread message");

    const reacted = applyThreadDetailEvent(posted.thread, {
      ...baseEvent,
      sequence: 3,
      type: "sidethread.message-reacted",
      payload: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make("message-rich-reducer"),
        emoji: "eyes",
        user: { subject: "clerk:alice", displayName: "Alice" },
        action: "added",
        createdAt: "2026-07-22T12:01:00.000Z",
      },
    } satisfies OrchestrationEvent);
    if (reacted.kind !== "updated") throw new Error("Expected side thread reaction");

    const edited = applyThreadDetailEvent(reacted.thread, {
      ...baseEvent,
      sequence: 4,
      type: "sidethread.message-edited",
      payload: {
        threadId,
        sideThreadId,
        messageId: SideThreadMessageId.make("message-rich-reducer"),
        editor: { subject: "clerk:bob", displayName: "Bob" },
        text: "Please review this",
        editedAt: "2026-07-22T12:02:00.000Z",
      },
    } satisfies OrchestrationEvent);
    if (edited.kind !== "updated") throw new Error("Expected side thread edit");

    const markedRead = applyThreadDetailEvent(edited.thread, {
      ...baseEvent,
      sequence: 5,
      type: "sidethread.marked-read",
      payload: {
        threadId,
        sideThreadId,
        user: { subject: "clerk:alice", displayName: "Alice" },
        lastReadAt: "2026-07-22T12:02:00.000Z",
        createdAt: "2026-07-22T12:02:00.000Z",
      },
    } satisfies OrchestrationEvent);
    if (markedRead.kind !== "updated") throw new Error("Expected side thread read marker");

    const richThread = markedRead.thread.sideThreads?.[0];
    expect(richThread?.messages[0]).toMatchObject({
      text: "Please review this",
      editedAt: "2026-07-22T12:02:00.000Z",
      linkedRef: { kind: "agent-thread", threadId: "linked-thread" },
      reactions: [
        {
          emoji: "eyes",
          users: [{ subject: "clerk:alice", displayName: "Alice" }],
        },
      ],
    });
    expect(richThread?.messages[0]?.attachments?.[0]?.type).toBe("gif");
    expect(richThread?.readBy).toEqual([
      {
        user: { subject: "clerk:alice", displayName: "Alice" },
        lastReadAt: "2026-07-22T12:02:00.000Z",
      },
    ]);
  });
});

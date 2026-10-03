import type { OrchestrationEvent } from "@t3tools/contracts";

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.imported-history-cleared"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set"
      | "sidethread.created"
      | "sidethread.message-posted"
      | "sidethread.message-reacted"
      | "sidethread.message-edited"
      | "sidethread.marked-read"
      | "sidethread.archived"
      | "sidethread.unarchived";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    // Streamed so an open thread drops the prior imported history live, before the
    // replacement import's messages arrive.
    event.type === "thread.imported-history-cleared" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set" ||
    event.type === "sidethread.created" ||
    event.type === "sidethread.message-posted" ||
    event.type === "sidethread.message-reacted" ||
    event.type === "sidethread.message-edited" ||
    event.type === "sidethread.marked-read" ||
    event.type === "sidethread.archived" ||
    event.type === "sidethread.unarchived"
  );
}

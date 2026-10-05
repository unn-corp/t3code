import {
  ThreadExportError,
  type ThreadExportInput,
  type ThreadExportResult,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** Export the full durable conversation, without provider credentials or hidden reasoning. */
export function formatThreadExport(
  projection: OrchestrationV2ThreadProjection,
  format: ThreadExportInput["format"],
): ThreadExportResult {
  const messages = projection.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: DateTime.formatIso(message.createdAt),
    streaming: message.streaming,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
    })),
  }));
  const title = projection.thread.title;
  const filename = `${
    title
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "thread"
  }-${projection.thread.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36)}`;
  const content =
    format === "json"
      ? JSON.stringify(
          {
            formatVersion: 1,
            thread: {
              id: projection.thread.id,
              title,
              createdAt: DateTime.formatIso(projection.thread.createdAt),
            },
            messages,
          },
          null,
          2,
        ) + "\n"
      : `# ${title.replace(/[\r\n]+/g, " ")}\n\nThread: ${projection.thread.id}\n\n` +
        messages
          .map(
            (message) =>
              `## ${message.role} · ${message.createdAt}${message.streaming ? " · partial" : ""}\n\n${message.text}\n${message.attachments.length ? `\nAttachments (references only):\n${message.attachments.map((attachment) => `- ${attachment.name.replace(/[\r\n]+/g, " ")} (${attachment.id})`).join("\n")}\n` : ""}`,
          )
          .join("\n");
  return {
    filename: `${filename}.${format === "json" ? "json" : "md"}`,
    mimeType: format === "json" ? "application/json" : "text/markdown",
    content,
  };
}

export class ThreadExportService extends Context.Service<
  ThreadExportService,
  {
    readonly exportThread: (
      input: ThreadExportInput,
    ) => Effect.Effect<ThreadExportResult, ThreadExportError>;
  }
>()("t3/orchestration-v2/ThreadExportService") {}
const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return ThreadExportService.of({
    exportThread: (input) =>
      threads.getThreadProjection(input.threadId).pipe(
        Effect.map((projection) => formatThreadExport(projection, input.format)),
        Effect.mapError((error) => new ThreadExportError({ message: error.message })),
      ),
  });
});
export const layer = Layer.effect(ThreadExportService, make);

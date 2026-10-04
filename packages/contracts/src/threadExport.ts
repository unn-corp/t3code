import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const ThreadExportInput = Schema.Struct({
  threadId: ThreadId,
  format: Schema.Literals(["markdown", "json"]),
});
export type ThreadExportInput = typeof ThreadExportInput.Type;
export const ThreadExportResult = Schema.Struct({
  filename: Schema.String,
  mimeType: Schema.String,
  content: Schema.String,
});
export type ThreadExportResult = typeof ThreadExportResult.Type;
export class ThreadExportError extends Schema.TaggedError<ThreadExportError>()(
  "ThreadExportError",
  { message: Schema.String },
) {}

/** Versioned portable content; deliberately excludes provider runtime state. */
export const ThreadExportDocument = Schema.Struct({
  formatVersion: Schema.Literal(1),
  thread: Schema.Struct({ id: ThreadId, title: Schema.String, createdAt: Schema.String }),
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.Literals(["user", "assistant", "system"]),
      text: Schema.String,
      createdAt: Schema.String,
      streaming: Schema.Boolean,
      attachments: Schema.Array(
        Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String }),
      ),
    }),
  ),
});
export type ThreadExportDocument = typeof ThreadExportDocument.Type;

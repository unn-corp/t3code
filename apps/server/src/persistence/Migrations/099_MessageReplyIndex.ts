import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Traverse only connected messages; avoid parsing every message body in a long chat.
  yield* sql`CREATE INDEX orchestration_v2_message_reply_parent_idx
    ON orchestration_v2_projection_messages(thread_id, json_extract(payload_json, '$.context.replyTo.messageId'))
    WHERE json_extract(payload_json, '$.context.replyTo.threadId') = thread_id`;
});

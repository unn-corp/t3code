import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep large discussion bodies off the thread row updated by every agent token.
  yield* sql`CREATE TABLE projection_thread_discussions (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    side_threads_json TEXT NOT NULL DEFAULT '[]'
  )`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN team_discussion_json TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN created_by_json TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN created_by_json TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN author_json TEXT`;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN collaboration_subject TEXT`;
});

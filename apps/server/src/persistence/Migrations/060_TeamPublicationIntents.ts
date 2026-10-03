import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE local_team_thread_publications ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE local_team_publication_intents (
    link_id TEXT NOT NULL REFERENCES local_team_project_links(link_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY(link_id,thread_id)
  )`;
});

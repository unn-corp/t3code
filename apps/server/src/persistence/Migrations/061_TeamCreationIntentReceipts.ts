import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE local_team_creation_intents (
    link_id TEXT NOT NULL REFERENCES local_team_project_links(link_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, command_id TEXT NOT NULL, shared INTEGER NOT NULL, root_identity TEXT NOT NULL,
    PRIMARY KEY(link_id,thread_id), UNIQUE(link_id,command_id)
  )`;
});

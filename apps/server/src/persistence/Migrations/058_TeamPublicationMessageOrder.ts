import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE team_publication_messages (
    publication_id TEXT NOT NULL REFERENCES team_publications(publication_id) ON DELETE CASCADE,
    message_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
    PRIMARY KEY(publication_id,message_key), UNIQUE(publication_id,ordinal)
  )`;
  yield* sql`CREATE TABLE local_team_publication_messages (
    publication_id TEXT NOT NULL REFERENCES local_team_thread_publications(publication_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL, turn_key TEXT NOT NULL,
    PRIMARY KEY(publication_id,message_id)
  )`;
});

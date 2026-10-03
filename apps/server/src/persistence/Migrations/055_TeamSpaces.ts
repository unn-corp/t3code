import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE team_spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL)`;
  yield* sql`CREATE TABLE team_members (space_id TEXT NOT NULL REFERENCES team_spaces(id), user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','contributor','viewer')), PRIMARY KEY(space_id,user_id))`;
  yield* sql`CREATE TABLE team_invites (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES team_spaces(id), email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('contributor','viewer')), token_hash TEXT NOT NULL UNIQUE, created_sequence INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)`;
  yield* sql`CREATE TABLE team_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL REFERENCES team_spaces(id), actor TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE team_revocations (space_id TEXT NOT NULL, user_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(space_id,user_id))`;
  yield* sql`CREATE TABLE team_runs (run_id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES team_spaces(id), user_id TEXT NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','cleanup_pending','completed','failed','stopped')), created_at INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX team_events_space_sequence ON team_events(space_id,sequence)`;
});

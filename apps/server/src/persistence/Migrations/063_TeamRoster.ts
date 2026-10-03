import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS team_roster (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','member')))`;
  yield* sql`CREATE TABLE IF NOT EXISTS team_roster_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), initialized INTEGER NOT NULL DEFAULT 0)`;
  const initialized = yield* sql`SELECT singleton FROM team_roster_state WHERE singleton=1`;
  yield* sql`CREATE TABLE IF NOT EXISTS team_roster_invites (id TEXT PRIMARY KEY, email TEXT NOT NULL, issuer TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER)`;
  yield* sql`CREATE TABLE IF NOT EXISTS team_roster_revocations (user_id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS team_project_creation_requests (actor TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES team_spaces(id), PRIMARY KEY(actor,request_id))`;
  yield* sql`CREATE TABLE IF NOT EXISTS local_team_file_creation_requests (service_url TEXT NOT NULL, subject TEXT NOT NULL, generation TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, spec_json TEXT NOT NULL, PRIMARY KEY(service_url,subject,generation,request_id), UNIQUE(service_url,subject,generation,digest))`;
  if (!initialized.length) {
    yield* sql`INSERT OR IGNORE INTO team_roster(user_id,role) SELECT DISTINCT user_id,'member' FROM team_members`;
    yield* sql`INSERT INTO team_roster_state(singleton) VALUES(1)`;
  }
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE team_file_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL DEFAULT 0, repository_json TEXT)`;
  yield* sql`INSERT INTO team_file_state(singleton) VALUES(1)`;
  yield* sql`CREATE TABLE team_file_blobs (hash TEXT PRIMARY KEY, content TEXT NOT NULL, size INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE team_files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, executable INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE team_file_events (version INTEGER NOT NULL,path TEXT NOT NULL, PRIMARY KEY(version,path))`;
  yield* sql`CREATE TABLE team_git_files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, executable INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE team_file_receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, mutation_json TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE team_git_uploads (id TEXT PRIMARY KEY, actor TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE local_team_file_resolutions (id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES local_team_project_links(link_id) ON DELETE CASCADE, completed INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE local_team_files (link_id TEXT PRIMARY KEY REFERENCES local_team_project_links(link_id) ON DELETE CASCADE, branch TEXT NOT NULL, root_identity TEXT NOT NULL, status TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, manifest_json TEXT NOT NULL DEFAULT '[]', remote_json TEXT NOT NULL DEFAULT '[]', included_json TEXT NOT NULL DEFAULT '[]', pending_json TEXT, conflicts_json TEXT NOT NULL DEFAULT '{}')`;
});

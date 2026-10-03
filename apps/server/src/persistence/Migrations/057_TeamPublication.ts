import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE team_publications (
    publication_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, subject TEXT NOT NULL,
    installation_id TEXT NOT NULL, capability_hash TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL DEFAULT 0, result_sequence INTEGER NOT NULL DEFAULT 0
  )`;

  yield* sql`CREATE TABLE team_publication_batches (
    publication_id TEXT NOT NULL REFERENCES team_publications(publication_id) ON DELETE CASCADE,
    from_revision INTEGER NOT NULL, to_revision INTEGER NOT NULL, digest TEXT NOT NULL,
    result_sequence INTEGER, PRIMARY KEY(publication_id, from_revision)
  )`;
  yield* sql`CREATE TABLE local_team_project_links (
    link_id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, space_id TEXT NOT NULL,
    service_url TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL,
    subject TEXT NOT NULL, generation TEXT NOT NULL, installation_id TEXT NOT NULL,
    workspace_root TEXT NOT NULL, canonical_root TEXT NOT NULL, role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not-synced'
  )`;
  yield* sql`CREATE TABLE local_team_thread_publications (
    publication_id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL REFERENCES local_team_project_links(link_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL UNIQUE, shared_thread_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0, source_cursor INTEGER NOT NULL,
    history_cursor INTEGER NOT NULL DEFAULT 0, history_offset INTEGER NOT NULL DEFAULT 0,
    initial_json TEXT NOT NULL, pending_json TEXT, status TEXT NOT NULL DEFAULT 'not-synced'
  )`;
  // Snapshot only the selected thread's current safe message fields. Paging
  // this private copy avoids retaining a whole conversation in a live queue.
  yield* sql`CREATE TABLE local_team_publication_history (
    publication_id TEXT NOT NULL REFERENCES local_team_thread_publications(publication_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, message_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL,
    text TEXT NOT NULL, is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(publication_id, ordinal)
  )`;
});

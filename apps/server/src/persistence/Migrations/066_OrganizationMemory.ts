import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_memory_records (
    record_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    project_id TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'superseded')),
    superseded_by_id TEXT REFERENCES organization_memory_records(record_id),
    content_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_memory_by_scope
    ON organization_memory_records(organization_id, project_id, updated_at DESC, record_id)`;
  yield* sql`CREATE TABLE organization_memory_revisions (
    mutation_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    record_id TEXT NOT NULL REFERENCES organization_memory_records(record_id),
    version INTEGER NOT NULL CHECK (version > 0),
    action TEXT NOT NULL CHECK (action IN ('create', 'correct', 'archive', 'supersede')),
    actor_subject TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (record_id, version)
  )`;
  yield* sql`CREATE INDEX organization_memory_revisions_by_record
    ON organization_memory_revisions(organization_id, record_id, version)`;
});

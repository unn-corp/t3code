import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_repositories (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(organization_id),
    repository TEXT NOT NULL UNIQUE,
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public', 'internal')),
    github_account_id TEXT,
    auto_sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_sync_enabled IN (0,1)),
    public_exposure_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (public_exposure_acknowledged IN (0,1)),
    next_sync_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_accepted_commit TEXT,
    last_sync_at TEXT,
    last_error TEXT,
    linked_by TEXT NOT NULL,
    linked_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE organization_repository_records (
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    record_key TEXT NOT NULL,
    remote_json TEXT NOT NULL,
    remote_digest TEXT NOT NULL,
    accepted_local_digest TEXT,
    accepted_remote_digest TEXT,
    state TEXT NOT NULL CHECK (state IN ('incoming', 'shared', 'conflict')),
    resolution TEXT CHECK (resolution IN ('local', 'remote')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, record_key)
  )`;
  yield* sql`CREATE INDEX organization_repository_records_by_state
    ON organization_repository_records(organization_id, state, record_key)`;
});

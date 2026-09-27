import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_artifacts (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    artifact_ref TEXT NOT NULL UNIQUE,
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    project_id TEXT NOT NULL,
    base_code_revision TEXT NOT NULL,
    scope_unit_name TEXT NOT NULL,
    scope_invocation_id TEXT NOT NULL,
    scope_verified_stopped_at TEXT NOT NULL,
    exit_code INTEGER NOT NULL CHECK (exit_code = 0),
    exit_signal TEXT CHECK (exit_signal IS NULL),
    timed_out INTEGER NOT NULL CHECK (timed_out = 0),
    output_limit_exceeded INTEGER NOT NULL CHECK (output_limit_exceeded = 0),
    resource_limit_exceeded INTEGER NOT NULL CHECK (resource_limit_exceeded = 0),
    patch_bytes BLOB NOT NULL CHECK (length(patch_bytes) <= 1048576),
    evidence_bytes BLOB NOT NULL CHECK (length(evidence_bytes) <= 262144),
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
    captured_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TRIGGER organization_work_artifact_immutable
    BEFORE UPDATE ON organization_work_artifacts
    BEGIN SELECT RAISE(ABORT, 'Organization work artifact is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_artifact_no_delete
    BEFORE DELETE ON organization_work_artifacts
    BEGIN SELECT RAISE(ABORT, 'Organization work artifact cannot be deleted'); END`;
});

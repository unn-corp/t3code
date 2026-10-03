import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_git_candidate_intents (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    binding_version TEXT NOT NULL,
    base_commit TEXT NOT NULL CHECK (length(base_commit) IN (40, 64)
      AND base_commit NOT GLOB '*[^0-9a-f]*'),
    artifact_ref TEXT NOT NULL,
    artifact_receipt_digest TEXT NOT NULL CHECK (length(artifact_receipt_digest) = 64
      AND artifact_receipt_digest NOT GLOB '*[^0-9a-f]*'),
    reviewed_artifact_digest TEXT NOT NULL CHECK (length(reviewed_artifact_digest) = 64
      AND reviewed_artifact_digest NOT GLOB '*[^0-9a-f]*'),
    relative_path TEXT NOT NULL,
    ref_name TEXT NOT NULL CHECK (
      ref_name = 'refs/t3-organizations/candidates/' || reviewed_artifact_digest),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'retained')),
    result_commit TEXT CHECK (result_commit IS NULL OR
      (length(result_commit) = length(base_commit)
       AND result_commit NOT GLOB '*[^0-9a-f]*')),
    prepared_at TEXT NOT NULL,
    retained_at TEXT,
    CHECK ((status = 'prepared' AND result_commit IS NULL AND retained_at IS NULL)
      OR (status = 'retained' AND result_commit IS NOT NULL AND retained_at IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX organization_git_candidate_intents_prepared
    ON organization_git_candidate_intents(status, prepared_at, attempt_id)`;
  yield* sql`CREATE TRIGGER organization_git_candidate_intent_transition
    BEFORE UPDATE ON organization_git_candidate_intents
    WHEN OLD.status != 'prepared' OR NEW.status != 'retained'
      OR NEW.attempt_id IS NOT OLD.attempt_id
      OR NEW.work_id IS NOT OLD.work_id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.binding_id IS NOT OLD.binding_id
      OR NEW.binding_version IS NOT OLD.binding_version
      OR NEW.base_commit IS NOT OLD.base_commit
      OR NEW.artifact_ref IS NOT OLD.artifact_ref
      OR NEW.artifact_receipt_digest IS NOT OLD.artifact_receipt_digest
      OR NEW.reviewed_artifact_digest IS NOT OLD.reviewed_artifact_digest
      OR NEW.relative_path IS NOT OLD.relative_path
      OR NEW.ref_name IS NOT OLD.ref_name
      OR NEW.prepared_at IS NOT OLD.prepared_at
    BEGIN SELECT RAISE(ABORT, 'Organization candidate intent is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_git_candidate_intent_no_delete
    BEFORE DELETE ON organization_git_candidate_intents
    BEGIN SELECT RAISE(ABORT, 'Organization candidate intent cannot be deleted'); END`;
});

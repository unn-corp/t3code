import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_git_integration_intents (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    binding_version TEXT NOT NULL,
    project_root_digest TEXT NOT NULL CHECK (length(project_root_digest) = 64),
    base_commit TEXT NOT NULL CHECK (length(base_commit) IN (40, 64)),
    result_commit TEXT NOT NULL CHECK (length(result_commit) = length(base_commit)),
    candidate_ref TEXT NOT NULL,
    reviewed_artifact_digest TEXT NOT NULL CHECK (length(reviewed_artifact_digest) = 64),
    artifact_receipt_digest TEXT NOT NULL CHECK (length(artifact_receipt_digest) = 64),
    approval_receipt_digest TEXT NOT NULL CHECK (length(approval_receipt_digest) = 64),
    target_ref TEXT NOT NULL,
    integrator_subject TEXT NOT NULL CHECK (length(integrator_subject) BETWEEN 1 AND 256),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'applied')),
    prepared_at TEXT NOT NULL,
    applied_at TEXT,
    CHECK ((status = 'prepared' AND applied_at IS NULL)
      OR (status = 'applied' AND applied_at IS NOT NULL))
  )`;
  yield* sql`CREATE TRIGGER organization_git_integration_intent_transition
    BEFORE UPDATE ON organization_git_integration_intents
    WHEN OLD.status != 'prepared' OR NEW.status != 'applied'
      OR NEW.attempt_id IS NOT OLD.attempt_id
      OR NEW.work_id IS NOT OLD.work_id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.binding_id IS NOT OLD.binding_id
      OR NEW.binding_version IS NOT OLD.binding_version
      OR NEW.project_root_digest IS NOT OLD.project_root_digest
      OR NEW.base_commit IS NOT OLD.base_commit
      OR NEW.result_commit IS NOT OLD.result_commit
      OR NEW.candidate_ref IS NOT OLD.candidate_ref
      OR NEW.reviewed_artifact_digest IS NOT OLD.reviewed_artifact_digest
      OR NEW.artifact_receipt_digest IS NOT OLD.artifact_receipt_digest
      OR NEW.approval_receipt_digest IS NOT OLD.approval_receipt_digest
      OR NEW.target_ref IS NOT OLD.target_ref
      OR NEW.integrator_subject IS NOT OLD.integrator_subject
      OR NEW.prepared_at IS NOT OLD.prepared_at
    BEGIN SELECT RAISE(ABORT, 'Organization Git integration intent is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_git_integration_intent_no_delete
    BEFORE DELETE ON organization_git_integration_intents
    BEGIN SELECT RAISE(ABORT, 'Organization Git integration intent cannot be deleted'); END`;
});

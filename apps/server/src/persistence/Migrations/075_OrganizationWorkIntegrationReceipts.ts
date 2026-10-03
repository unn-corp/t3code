import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_integration_receipts (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    project_id TEXT NOT NULL,
    base_code_revision TEXT NOT NULL,
    result_code_revision TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
    qa_receipt_digest TEXT NOT NULL CHECK (length(qa_receipt_digest) = 64),
    approval_receipt_digest TEXT NOT NULL CHECK (length(approval_receipt_digest) = 64),
    worker_subject TEXT NOT NULL,
    qa_subject TEXT NOT NULL,
    approver_subject TEXT NOT NULL,
    integrator_subject TEXT NOT NULL CHECK (length(integrator_subject) BETWEEN 1 AND 256),
    receipt_ref TEXT NOT NULL UNIQUE CHECK (length(receipt_ref) BETWEEN 1 AND 512),
    evidence_bytes BLOB NOT NULL CHECK (length(evidence_bytes) BETWEEN 1 AND 262144),
    recorded_at TEXT NOT NULL,
    receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
    CHECK (integrator_subject != worker_subject),
    CHECK (integrator_subject != qa_subject),
    CHECK (integrator_subject != approver_subject)
  )`;
  yield* sql`CREATE TRIGGER organization_work_integration_receipt_immutable
    BEFORE UPDATE ON organization_work_integration_receipts
    BEGIN SELECT RAISE(ABORT, 'Organization work integration receipt is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_integration_receipt_no_delete
    BEFORE DELETE ON organization_work_integration_receipts
    BEGIN SELECT RAISE(ABORT, 'Organization work integration receipt cannot be deleted'); END`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_approval_receipts (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    project_id TEXT NOT NULL,
    base_code_revision TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
    qa_receipt_digest TEXT NOT NULL CHECK (length(qa_receipt_digest) = 64),
    worker_subject TEXT NOT NULL,
    qa_subject TEXT NOT NULL,
    approver_subject TEXT NOT NULL CHECK (length(approver_subject) BETWEEN 1 AND 256),
    approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
    evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512),
    evidence_bytes BLOB NOT NULL CHECK (length(evidence_bytes) BETWEEN 1 AND 262144),
    recorded_at TEXT NOT NULL,
    receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
    CHECK (worker_subject != qa_subject),
    CHECK (approver_subject != worker_subject),
    CHECK (approver_subject != qa_subject)
  )`;
  yield* sql`CREATE TRIGGER organization_work_approval_receipt_immutable
    BEFORE UPDATE ON organization_work_approval_receipts
    BEGIN SELECT RAISE(ABORT, 'Organization work approval receipt is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_approval_receipt_no_delete
    BEFORE DELETE ON organization_work_approval_receipts
    BEGIN SELECT RAISE(ABORT, 'Organization work approval receipt cannot be deleted'); END`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_qa_receipts (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    project_id TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
    worker_subject TEXT NOT NULL,
    reviewer_subject TEXT NOT NULL CHECK (length(reviewer_subject) BETWEEN 1 AND 256),
    accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
    evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512),
    evidence_bytes BLOB NOT NULL CHECK (length(evidence_bytes) BETWEEN 1 AND 262144),
    recorded_at TEXT NOT NULL,
    receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
    CHECK (reviewer_subject != worker_subject)
  )`;
  yield* sql`CREATE TRIGGER organization_work_qa_receipt_immutable
    BEFORE UPDATE ON organization_work_qa_receipts
    BEGIN SELECT RAISE(ABORT, 'Organization work QA receipt is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_qa_receipt_no_delete
    BEFORE DELETE ON organization_work_qa_receipts
    BEGIN SELECT RAISE(ABORT, 'Organization work QA receipt cannot be deleted'); END`;
});

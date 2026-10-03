import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_items (
    work_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    finding_id TEXT NOT NULL REFERENCES organization_intake_findings(finding_id),
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL REFERENCES organization_project_bindings(binding_id),
    binding_version TEXT NOT NULL,
    scope TEXT,
    published_revision INTEGER NOT NULL CHECK (published_revision > 0),
    workflow_id TEXT NOT NULL,
    workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
    code_revision TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','blocked','waiting-approval',
      'retrying','succeeded','failed','canceled','recovering')),
    attempt_limit INTEGER NOT NULL CHECK (attempt_limit BETWEEN 1 AND 3),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    creator_subject TEXT NOT NULL,
    approval_subject TEXT,
    approval_evidence_ref TEXT,
    integration_subject TEXT,
    integration_receipt_ref TEXT,
    result_code_revision TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, finding_id, workflow_id, project_id)
  )`;
  yield* sql`CREATE INDEX organization_work_by_org ON organization_work_items(organization_id, created_at)`;
  yield* sql`CREATE TABLE organization_work_attempts (
    attempt_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    number INTEGER NOT NULL CHECK (number > 0),
    status TEXT NOT NULL CHECK (status IN ('running','submitted','qa-accepted',
      'qa-rejected','expired','canceled')),
    worker_subject TEXT NOT NULL,
    lease_until TEXT NOT NULL,
    artifact_digest TEXT,
    artifact_ref TEXT,
    qa_subject TEXT,
    qa_evidence_ref TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (work_id, number)
  )`;
  yield* sql`CREATE INDEX organization_attempts_by_work ON organization_work_attempts(work_id, number)`;
  yield* sql`CREATE TABLE organization_work_transitions (
    transition_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    action TEXT NOT NULL,
    actor_subject TEXT NOT NULL,
    request_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_work_transitions_by_work
    ON organization_work_transitions(work_id, created_at)`;
});

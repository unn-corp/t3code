import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_proposal_settings (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(organization_id),
    observation_mode_enabled INTEGER NOT NULL CHECK (observation_mode_enabled IN (0, 1)),
    enabled_at TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE organization_work_proposals (
    proposal_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    finding_id TEXT NOT NULL UNIQUE REFERENCES organization_intake_findings(finding_id),
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL REFERENCES organization_project_bindings(binding_id),
    binding_version TEXT NOT NULL,
    published_revision INTEGER NOT NULL CHECK (published_revision > 0),
    evidence_json TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed','acknowledged','rejected','deferred')),
    version INTEGER NOT NULL CHECK (version > 0),
    decided_by TEXT,
    decision_reason TEXT,
    reconsider_after TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_work_proposals_by_org
    ON organization_work_proposals(organization_id, updated_at DESC, proposal_id)`;
  yield* sql`CREATE TABLE organization_proposal_candidates (
    finding_id TEXT PRIMARY KEY REFERENCES organization_intake_findings(finding_id),
    next_attempt_at TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    state TEXT NOT NULL CHECK (state IN ('pending','terminal')),
    last_reason TEXT,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_proposal_candidates_due
    ON organization_proposal_candidates(state, next_attempt_at, finding_id)`;
  yield* sql`CREATE INDEX organization_findings_for_proposal_scan
    ON organization_intake_findings(created_at, finding_id)`;
  yield* sql`CREATE TABLE organization_proposal_mutations (
    mutation_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    proposal_id TEXT,
    action TEXT NOT NULL CHECK (action IN ('observation-mode','acknowledge','reject','defer')),
    actor_subject TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_proposal_mutations_by_org
    ON organization_proposal_mutations(organization_id, created_at)`;
});

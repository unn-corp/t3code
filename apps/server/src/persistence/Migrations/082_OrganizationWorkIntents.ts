import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A durable proposal snapshot. This table grants no execution authority. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_intents (
    intent_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    proposal_id TEXT NOT NULL REFERENCES organization_work_proposals(proposal_id),
    proposal_version INTEGER NOT NULL CHECK (proposal_version > 0),
    finding_id TEXT NOT NULL REFERENCES organization_intake_findings(finding_id),
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
    binding_id TEXT NOT NULL REFERENCES organization_project_bindings(binding_id),
    binding_version TEXT NOT NULL,
    published_revision INTEGER NOT NULL CHECK (published_revision > 0),
    evidence_json TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting-activation'
      CHECK (status = 'awaiting-activation'),
    created_at TEXT NOT NULL,
    UNIQUE (proposal_id, proposal_version)
  )`;
  yield* sql`CREATE INDEX organization_work_intents_by_organization
    ON organization_work_intents(organization_id, created_at, intent_id)`;
  yield* sql`CREATE INDEX organization_work_proposals_for_intent_newest
    ON organization_work_proposals(state, created_at DESC, proposal_id DESC)`;
  yield* sql`CREATE TRIGGER organization_work_intents_immutable
    BEFORE UPDATE ON organization_work_intents
    BEGIN SELECT RAISE(ABORT, 'Organization work intent is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_intents_no_delete
    BEFORE DELETE ON organization_work_intents
    BEGIN SELECT RAISE(ABORT, 'Organization work intent cannot be deleted'); END`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A bounded human grant for one Project and one authenticated HTTP intake source. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_standing_work_authorizations (
    authorization_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
    source_id TEXT NOT NULL REFERENCES organization_intake_sources(source_id),
    binding_id TEXT NOT NULL REFERENCES organization_project_bindings(binding_id),
    binding_version TEXT NOT NULL,
    published_revision INTEGER NOT NULL CHECK (published_revision > 0),
    selection_json TEXT NOT NULL CHECK (json_valid(selection_json)
      AND length(CAST(selection_json AS BLOB)) <= 24576),
    max_activations INTEGER NOT NULL CHECK (max_activations BETWEEN 1 AND 32),
    used_activations INTEGER NOT NULL DEFAULT 0 CHECK (used_activations >= 0
      AND used_activations <= max_activations),
    expires_at TEXT NOT NULL,
    created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 160),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    revocation_reason TEXT CHECK (revocation_reason IN ('manual', 'expired', 'exhausted')),
    CONSTRAINT organization_standing_revocation_pair CHECK (
      (revoked_at IS NULL AND revocation_reason IS NULL)
      OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
    )
  )`;
  yield* sql`CREATE UNIQUE INDEX organization_standing_work_authorizations_active_source
    ON organization_standing_work_authorizations(organization_id, project_id, source_id)
    WHERE revoked_at IS NULL`;
  yield* sql`CREATE INDEX organization_standing_work_authorizations_active_scan
    ON organization_standing_work_authorizations(organization_id, project_id, binding_id,
      binding_version, published_revision, expires_at)
    WHERE revoked_at IS NULL`;
  yield* sql`CREATE TABLE organization_standing_work_activation_uses (
    intent_id TEXT PRIMARY KEY REFERENCES organization_work_intents(intent_id),
    authorization_id TEXT NOT NULL REFERENCES organization_standing_work_authorizations(authorization_id),
    work_id TEXT NOT NULL UNIQUE REFERENCES organization_work_items(work_id),
    used_at TEXT NOT NULL
  )`;
});

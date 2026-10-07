import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_provider_budget_limits (
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'organization', 'project')),
    scope_id TEXT NOT NULL,
    max_concurrent INTEGER NOT NULL CHECK (max_concurrent BETWEEN 0 AND 64),
    max_daily_calls INTEGER NOT NULL CHECK (max_daily_calls BETWEEN 0 AND 10000),
    max_daily_estimated_tokens INTEGER NOT NULL
      CHECK (max_daily_estimated_tokens BETWEEN 0 AND 1000000000),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_kind, scope_id),
    CHECK ((scope_kind = 'global' AND scope_id = '*') OR
      (scope_kind != 'global' AND length(scope_id) BETWEEN 1 AND 256))
  )`;
  // No Organization model call is admitted until all three scopes have explicit capacity.
  yield* sql`INSERT INTO organization_provider_budget_limits
    (scope_kind, scope_id, max_concurrent, max_daily_calls,
     max_daily_estimated_tokens, updated_at)
    VALUES ('global', '*', 0, 0, 0, '1970-01-01T00:00:00.000Z')`;
  yield* sql`CREATE TABLE organization_provider_budget_admissions (
    request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 128),
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    project_id TEXT NOT NULL REFERENCES projection_projects(project_id),
    provider_instance_id TEXT NOT NULL CHECK (length(provider_instance_id) BETWEEN 1 AND 128),
    model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
    estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens BETWEEN 1 AND 1000000),
    day_utc TEXT NOT NULL CHECK (length(day_utc) = 10),
    state TEXT NOT NULL CHECK (state IN
      ('reserved', 'dispatched', 'uncertain', 'released', 'reconciled')),
    lease_until TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    dispatched_at TEXT,
    reconciled_at TEXT,
    disposition TEXT CHECK (disposition IS NULL OR
      disposition IN ('completed', 'not-dispatched')),
    measured_input_tokens INTEGER CHECK (measured_input_tokens IS NULL OR
      measured_input_tokens BETWEEN 0 AND 1000000000),
    measured_output_tokens INTEGER CHECK (measured_output_tokens IS NULL OR
      measured_output_tokens BETWEEN 0 AND 1000000000),
    CHECK ((measured_input_tokens IS NULL) = (measured_output_tokens IS NULL)),
    CHECK ((state IN ('reserved', 'dispatched', 'uncertain') AND
      reconciled_at IS NULL AND disposition IS NULL) OR
      (state = 'released' AND reconciled_at IS NOT NULL AND
        disposition = 'not-dispatched' AND measured_input_tokens IS NULL) OR
      (state = 'reconciled' AND reconciled_at IS NOT NULL AND
        disposition = 'completed'))
  )`;
  yield* sql`CREATE INDEX organization_provider_budget_active
    ON organization_provider_budget_admissions(state, organization_id, project_id)`;
  yield* sql`CREATE INDEX organization_provider_budget_daily
    ON organization_provider_budget_admissions(day_utc, state, organization_id, project_id)`;
  yield* sql`CREATE TRIGGER organization_provider_budget_identity_immutable
    BEFORE UPDATE ON organization_provider_budget_admissions
    WHEN NEW.request_id IS NOT OLD.request_id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
      OR NEW.model_id IS NOT OLD.model_id
      OR NEW.estimated_tokens IS NOT OLD.estimated_tokens
      OR NEW.day_utc IS NOT OLD.day_utc
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'Organization provider admission identity is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_provider_budget_no_delete
    BEFORE DELETE ON organization_provider_budget_admissions
    BEGIN SELECT RAISE(ABORT, 'Organization provider admission cannot be deleted'); END`;
});

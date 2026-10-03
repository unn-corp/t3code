import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_provider_budget_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'organization', 'project')),
    scope_id TEXT NOT NULL,
    actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
    previous_revision TEXT,
    applied_revision TEXT NOT NULL,
    previous_max_concurrent INTEGER,
    previous_max_daily_calls INTEGER,
    previous_max_daily_estimated_tokens INTEGER,
    max_concurrent INTEGER NOT NULL CHECK (max_concurrent BETWEEN 0 AND 64),
    max_daily_calls INTEGER NOT NULL CHECK (max_daily_calls BETWEEN 0 AND 10000),
    max_daily_estimated_tokens INTEGER NOT NULL
      CHECK (max_daily_estimated_tokens BETWEEN 0 AND 1000000000),
    created_at TEXT NOT NULL,
    CHECK ((previous_revision IS NULL AND previous_max_concurrent IS NULL
      AND previous_max_daily_calls IS NULL AND previous_max_daily_estimated_tokens IS NULL)
      OR (previous_revision IS NOT NULL AND previous_max_concurrent IS NOT NULL
      AND previous_max_daily_calls IS NOT NULL AND previous_max_daily_estimated_tokens IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX organization_provider_budget_audit_scope
    ON organization_provider_budget_audit(scope_kind, scope_id, audit_id)`;
  yield* sql`CREATE TRIGGER organization_provider_budget_audit_no_update
    BEFORE UPDATE ON organization_provider_budget_audit
    BEGIN SELECT RAISE(ABORT, 'Provider budget audit is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_provider_budget_audit_no_delete
    BEFORE DELETE ON organization_provider_budget_audit
    BEGIN SELECT RAISE(ABORT, 'Provider budget audit cannot be deleted'); END`;
});

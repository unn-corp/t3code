import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_resource_limits (
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','organization','project')),
    scope_id TEXT NOT NULL,
    max_active INTEGER NOT NULL CHECK (max_active BETWEEN 1 AND 64),
    PRIMARY KEY (scope_kind, scope_id),
    CHECK ((scope_kind = 'global' AND scope_id = '*') OR
      (scope_kind != 'global' AND length(scope_id) > 0))
  )`;
  yield* sql`INSERT INTO organization_work_resource_limits
    (scope_kind, scope_id, max_active) VALUES ('global', '*', 4)`;
  yield* sql`CREATE TABLE organization_work_resource_permits (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    project_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active','released','expired')),
    lease_until TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // Preserve pre-migration running attempts, including expired leases. An expired
  // lease cannot prove the old worker has stopped, so capacity remains occupied
  // until explicit recovery or cancellation reconciles that attempt.
  yield* sql`INSERT INTO organization_work_resource_permits
    (attempt_id, work_id, organization_id, project_id, state, lease_until,
      granted_at, updated_at)
    SELECT a.attempt_id, w.work_id, w.organization_id, w.project_id,
      'active', a.lease_until, a.started_at, a.updated_at
    FROM organization_work_attempts a
    JOIN organization_work_items w ON w.work_id = a.work_id
    WHERE a.status = 'running' AND w.status = 'running'
      AND a.number = w.attempt_count`;
  yield* sql`CREATE UNIQUE INDEX organization_one_active_permit_per_work
    ON organization_work_resource_permits(work_id) WHERE state = 'active'`;
  yield* sql`CREATE INDEX organization_active_resource_permits
    ON organization_work_resource_permits(state, lease_until, organization_id, project_id)`;
  yield* sql`CREATE INDEX organization_resource_permits_by_org
    ON organization_work_resource_permits(organization_id, state, lease_until)`;
  yield* sql`CREATE INDEX organization_resource_permits_by_project
    ON organization_work_resource_permits(project_id, state, lease_until)`;
});

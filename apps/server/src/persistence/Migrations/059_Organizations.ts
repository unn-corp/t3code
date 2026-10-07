import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE organizations (
      organization_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mission TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'archived')),
      draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
      published_revision INTEGER,
      architect_role_id TEXT NOT NULL,
      director_role_id TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      layout_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE organization_project_bindings (
      binding_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
      project_id TEXT NOT NULL,
      access TEXT NOT NULL CHECK (access IN ('read', 'proposal', 'write')),
      capabilities_json TEXT NOT NULL,
      scope TEXT,
      detached_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX organization_one_active_binding_per_project
    ON organization_project_bindings(organization_id, project_id)
    WHERE detached_at IS NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX organization_one_write_steward_per_project
    ON organization_project_bindings(project_id)
    WHERE access = 'write' AND detached_at IS NULL
  `;
  yield* sql`
    CREATE INDEX organization_bindings_by_organization
    ON organization_project_bindings(organization_id, detached_at)
  `;
  yield* sql`
    CREATE TABLE organization_audit (
      mutation_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      applied_revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX organization_audit_by_organization
    ON organization_audit(organization_id, applied_revision)
  `;
  yield* sql`
    CREATE TABLE organization_config_versions (
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
      revision INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, revision)
    )
  `;
});

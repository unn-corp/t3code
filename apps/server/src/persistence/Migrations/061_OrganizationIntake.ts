import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE organization_intake_sources (
      source_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
      project_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('manual', 'generic-http')),
      name TEXT NOT NULL,
      ingest_subject TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      secret_hash TEXT,
      credential_version INTEGER NOT NULL CHECK (credential_version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX organization_intake_sources_by_org
    ON organization_intake_sources(organization_id, created_at)`;
  yield* sql`
    CREATE TABLE organization_intake_observations (
      observation_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
      source_id TEXT NOT NULL REFERENCES organization_intake_sources(source_id),
      project_id TEXT,
      external_event_id TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      UNIQUE (organization_id, source_id, external_event_id),
      UNIQUE (organization_id, source_id, dedup_key)
    )
  `;
  yield* sql`CREATE INDEX organization_intake_observations_by_org
    ON organization_intake_observations(organization_id, received_at)`;
  yield* sql`
    CREATE TABLE organization_intake_findings (
      finding_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
      source_id TEXT NOT NULL REFERENCES organization_intake_sources(source_id),
      dedup_key TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      observation_ids_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state = 'tentative'),
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, source_id, dedup_key)
    )
  `;
  yield* sql`CREATE INDEX organization_intake_findings_by_org
    ON organization_intake_findings(organization_id, created_at)`;
  yield* sql`
    CREATE TABLE organization_intake_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
      source_id TEXT NOT NULL REFERENCES organization_intake_sources(source_id),
      actor_subject TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('register', 'enable', 'disable', 'rotate-secret')),
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX organization_intake_audit_by_org
    ON organization_intake_audit(organization_id, created_at)`;
});

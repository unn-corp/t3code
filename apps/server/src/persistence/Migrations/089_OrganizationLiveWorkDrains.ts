import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Requests fence new phases; claims identify phases already admitted. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_live_work_drains (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(organization_id),
    request_id TEXT NOT NULL UNIQUE,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    completed_at TEXT
  )`;
  yield* sql`CREATE TABLE organization_live_work_phase_claims (
    work_id TEXT PRIMARY KEY REFERENCES organization_work_items(work_id),
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    phase TEXT NOT NULL CHECK (phase IN ('attempt', 'qa', 'integration')),
    owner_epoch TEXT NOT NULL,
    started_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_live_work_phase_claims_by_organization
    ON organization_live_work_phase_claims(organization_id)`;
});

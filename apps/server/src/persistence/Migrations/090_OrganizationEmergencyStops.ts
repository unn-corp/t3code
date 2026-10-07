import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Stop requests fence dispatch immediately; exit receipts do not imply scope cleanup. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_emergency_stops (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(organization_id),
    request_id TEXT NOT NULL UNIQUE,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE organization_emergency_provider_exits (
    work_id TEXT PRIMARY KEY REFERENCES organization_work_items(work_id),
    organization_id TEXT NOT NULL REFERENCES organization_emergency_stops(organization_id),
    process_id INTEGER NOT NULL CHECK (process_id > 0),
    verified_at TEXT NOT NULL
  )`;
});

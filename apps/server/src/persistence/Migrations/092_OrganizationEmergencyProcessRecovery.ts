import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Added after stop requests were first migrated; preserves existing databases. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_emergency_scope_stops (
    operation_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organization_emergency_stops(organization_id),
    work_id TEXT NOT NULL REFERENCES organization_work_items(work_id),
    attempt_id TEXT NOT NULL REFERENCES organization_work_attempts(attempt_id),
    disposition TEXT NOT NULL CHECK (disposition IN ('stopped', 'never-dispatched')),
    identity_json TEXT,
    verified_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE organization_provider_processes (
    work_id TEXT PRIMARY KEY REFERENCES organization_work_items(work_id),
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    state TEXT NOT NULL CHECK (state IN ('launching', 'running', 'exited')),
    process_id INTEGER CHECK (process_id IS NULL OR process_id > 0),
    prepared_at TEXT NOT NULL,
    spawned_at TEXT,
    exited_at TEXT
  )`;
});

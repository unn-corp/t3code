import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Terminal and recoverable phase failures remain visible across process restarts. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_live_work_failures (
    work_id TEXT PRIMARY KEY REFERENCES organization_work_items(work_id),
    phase TEXT NOT NULL CHECK (phase IN ('attempt', 'qa', 'integration')),
    error_code TEXT NOT NULL CHECK (error_code IN (
      'budget_exhausted', 'budget_denied', 'provider_unavailable',
      'authority_changed', 'qa_rejected', 'qa_unavailable',
      'integration_conflict', 'integration_unavailable', 'attempt_unavailable',
      'invalid_artifact', 'unexpected_failure')),
    terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
    recorded_at TEXT NOT NULL
  )`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_intake_correlation_jobs (
    observation_id TEXT PRIMARY KEY REFERENCES organization_intake_observations(observation_id),
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'complete', 'terminal')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT NOT NULL,
    lease_token TEXT,
    lease_expires_at TEXT,
    outcome TEXT,
    last_error_code TEXT,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_intake_correlation_jobs_due
    ON organization_intake_correlation_jobs(state, next_attempt_at, lease_expires_at)`;
  yield* sql`INSERT INTO organization_intake_correlation_jobs
    (observation_id, state, attempts, next_attempt_at, updated_at)
    SELECT observation_id, 'pending', 0, received_at, received_at
    FROM organization_intake_observations`;
});

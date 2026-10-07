import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_scopes (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    unit_name TEXT NOT NULL UNIQUE,
    invocation_id TEXT NOT NULL UNIQUE,
    control_group TEXT NOT NULL UNIQUE,
    sandbox_pid INTEGER NOT NULL CHECK (sandbox_pid > 0),
    pid_namespace INTEGER NOT NULL CHECK (pid_namespace > 0),
    prepared_at TEXT NOT NULL,
    start_requested_at TEXT,
    token_released_at TEXT,
    started_at TEXT,
    stop_requested_at TEXT,
    verified_stopped_at TEXT,
    CHECK (token_released_at IS NULL OR start_requested_at IS NOT NULL),
    CHECK (started_at IS NULL OR token_released_at IS NOT NULL),
    CHECK (verified_stopped_at IS NULL OR stop_requested_at IS NOT NULL)
  )`;
  yield* sql`CREATE INDEX organization_work_scopes_open
    ON organization_work_scopes(verified_stopped_at, prepared_at)`;
  yield* sql`CREATE TRIGGER organization_work_scope_identity_immutable
    BEFORE UPDATE OF unit_name, invocation_id, control_group, sandbox_pid, pid_namespace
    ON organization_work_scopes
    WHEN OLD.unit_name != NEW.unit_name OR OLD.invocation_id != NEW.invocation_id OR
      OLD.control_group != NEW.control_group OR OLD.sandbox_pid != NEW.sandbox_pid OR
      OLD.pid_namespace != NEW.pid_namespace
    BEGIN SELECT RAISE(ABORT, 'Organization work scope identity is immutable'); END`;
});

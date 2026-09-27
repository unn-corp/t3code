import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Records that OS scope creation may have started, even if no identity returns. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_scope_preparations (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_attempts(attempt_id),
    preparation_started_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TRIGGER organization_work_scope_preparation_immutable
    BEFORE UPDATE ON organization_work_scope_preparations
    WHEN OLD.attempt_id != NEW.attempt_id OR
      OLD.preparation_started_at != NEW.preparation_started_at
    BEGIN SELECT RAISE(ABORT, 'Organization scope preparation is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_scope_preparation_retained_while_active
    BEFORE DELETE ON organization_work_scope_preparations
    WHEN EXISTS (SELECT 1 FROM organization_work_resource_permits permit
      WHERE permit.attempt_id = OLD.attempt_id AND permit.state = 'active')
      AND NOT EXISTS (SELECT 1 FROM organization_work_scopes scope
        WHERE scope.attempt_id = OLD.attempt_id
          AND scope.verified_stopped_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'Active scope preparation cannot be erased'); END`;
  // A missing scope identity is ambiguous after preparation starts. Neither an
  // expired lease nor a canceled work item proves that the OS scope has exited.
  yield* sql`CREATE TRIGGER organization_work_scope_preparation_fences_permit_release
    BEFORE UPDATE OF state ON organization_work_resource_permits
    WHEN OLD.state = 'active' AND NEW.state IN ('released','expired')
      AND EXISTS (SELECT 1 FROM organization_work_scope_preparations prep
        WHERE prep.attempt_id = OLD.attempt_id)
      AND NOT EXISTS (SELECT 1 FROM organization_work_scopes scope
        WHERE scope.attempt_id = OLD.attempt_id
          AND scope.verified_stopped_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'Organization scope preparation has no verified stop'); END`;
});

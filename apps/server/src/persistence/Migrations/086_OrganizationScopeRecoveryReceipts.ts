import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** An unscoped permit can be released only after the broker proves no dispatch
 * or an exact stop of a prepared identity. Legacy unknown markers stay held.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_scope_recovery_receipts (
    attempt_id TEXT PRIMARY KEY REFERENCES organization_work_scope_preparations(attempt_id),
    operation_id TEXT NOT NULL UNIQUE,
    unit_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('never-dispatched', 'verified-stopped-unattached')),
    recorded_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TRIGGER organization_work_scope_recovery_receipt_valid
    BEFORE INSERT ON organization_work_scope_recovery_receipts
    WHEN NEW.operation_id != NEW.attempt_id
      OR NEW.kind NOT IN ('never-dispatched', 'verified-stopped-unattached')
      OR NOT EXISTS (SELECT 1 FROM organization_work_scope_preparations prep
        WHERE prep.attempt_id = NEW.attempt_id
          AND prep.unit_name = NEW.unit_name
          AND prep.launch_state IN ('reserved', 'requested'))
      OR EXISTS (SELECT 1 FROM organization_work_scopes scope
        WHERE scope.attempt_id = NEW.attempt_id)
    BEGIN SELECT RAISE(ABORT, 'Organization scope recovery receipt has no matching unlaunched reservation'); END`;
  yield* sql`CREATE TRIGGER organization_work_scope_recovery_receipt_immutable
    BEFORE UPDATE ON organization_work_scope_recovery_receipts
    BEGIN SELECT RAISE(ABORT, 'Organization scope recovery receipt is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_scope_recovery_receipt_no_delete
    BEFORE DELETE ON organization_work_scope_recovery_receipts
    BEGIN SELECT RAISE(ABORT, 'Organization scope recovery receipt cannot be deleted'); END`;
  yield* sql`CREATE TRIGGER organization_work_scope_recovery_fences_late_attach
    BEFORE INSERT ON organization_work_scopes
    WHEN EXISTS (SELECT 1 FROM organization_work_scope_recovery_receipts receipt
      WHERE receipt.attempt_id = NEW.attempt_id)
    BEGIN SELECT RAISE(ABORT, 'Recovered Organization scope cannot attach later'); END`;
  yield* sql`CREATE TRIGGER organization_work_scope_recovery_retains_preparation
    BEFORE DELETE ON organization_work_scope_preparations
    WHEN EXISTS (SELECT 1 FROM organization_work_scope_recovery_receipts receipt
      WHERE receipt.attempt_id = OLD.attempt_id)
    BEGIN SELECT RAISE(ABORT, 'Recovered Organization scope preparation cannot be deleted'); END`;
  yield* sql`DROP TRIGGER organization_work_scope_preparation_fences_permit_release`;
  yield* sql`CREATE TRIGGER organization_work_scope_preparation_fences_permit_release
    BEFORE UPDATE OF state ON organization_work_resource_permits
    WHEN OLD.state = 'active' AND NEW.state IN ('released','expired')
      AND EXISTS (SELECT 1 FROM organization_work_scope_preparations prep
        WHERE prep.attempt_id = OLD.attempt_id)
      AND NOT EXISTS (SELECT 1 FROM organization_work_scopes scope
        WHERE scope.attempt_id = OLD.attempt_id
          AND scope.verified_stopped_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM organization_work_scope_recovery_receipts receipt
        JOIN organization_work_scope_preparations prep
          ON prep.attempt_id = receipt.attempt_id
        WHERE receipt.attempt_id = OLD.attempt_id
          AND receipt.operation_id = OLD.attempt_id
          AND receipt.unit_name = prep.unit_name
          AND receipt.kind IN ('never-dispatched', 'verified-stopped-unattached')
          AND NOT EXISTS (SELECT 1 FROM organization_work_scopes scope
            WHERE scope.attempt_id = OLD.attempt_id))
    BEGIN SELECT RAISE(ABORT, 'Organization scope preparation has no verified stop'); END`;
});

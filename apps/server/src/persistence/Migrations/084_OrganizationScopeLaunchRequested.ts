import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A one-time durable marker separates a reservation from the first OS launch call. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE organization_work_scope_preparations
    ADD COLUMN launch_requested_at TEXT`;
  // Rows already present at migration time have unknown launch provenance.
  yield* sql`ALTER TABLE organization_work_scope_preparations
    ADD COLUMN launch_state TEXT NOT NULL DEFAULT 'legacy-unknown'
      CHECK (launch_state IN ('legacy-unknown', 'reserved', 'requested')
        AND ((launch_state = 'requested') = (launch_requested_at IS NOT NULL)))`;
  yield* sql`CREATE TRIGGER organization_work_scope_launch_requested_no_insert
    BEFORE INSERT ON organization_work_scope_preparations
    WHEN NEW.launch_state = 'requested' OR NEW.launch_requested_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Organization scope launch request requires a reservation'); END`;
  yield* sql`CREATE TRIGGER organization_work_scope_launch_requested_immutable
    BEFORE UPDATE OF launch_state, launch_requested_at ON organization_work_scope_preparations
    WHEN NOT ((OLD.launch_state IS NEW.launch_state
      AND OLD.launch_requested_at IS NEW.launch_requested_at)
      OR (OLD.launch_state = 'reserved' AND NEW.launch_state = 'requested'
        AND OLD.launch_requested_at IS NULL AND NEW.launch_requested_at IS NOT NULL
        AND OLD.unit_name IS NOT NULL))
    BEGIN SELECT RAISE(ABORT, 'Organization scope launch request is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_scope_launch_requested_no_delete
    BEFORE DELETE ON organization_work_scope_preparations
    WHEN OLD.launch_state = 'requested' OR OLD.launch_requested_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Organization scope launch request cannot be deleted'); END`;
});

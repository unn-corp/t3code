import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Reserve the systemd unit name before any host launch. InvocationID is OS assigned later. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE organization_work_scope_preparations ADD COLUMN unit_name TEXT`;
  // A prior version may already have attached a verified scope. Preserve its
  // actual unit identity; unattached legacy markers remain ambiguous and held.
  yield* sql`UPDATE organization_work_scope_preparations
    SET unit_name = (SELECT scope.unit_name FROM organization_work_scopes scope
      WHERE scope.attempt_id = organization_work_scope_preparations.attempt_id)
    WHERE EXISTS (SELECT 1 FROM organization_work_scopes scope
      WHERE scope.attempt_id = organization_work_scope_preparations.attempt_id)`;
  yield* sql`CREATE UNIQUE INDEX organization_work_scope_preparations_unit_name
    ON organization_work_scope_preparations(unit_name) WHERE unit_name IS NOT NULL`;
  yield* sql`CREATE TRIGGER organization_work_scope_preparation_unit_immutable
    BEFORE UPDATE OF unit_name ON organization_work_scope_preparations
    WHEN OLD.unit_name IS NOT NEW.unit_name
    BEGIN SELECT RAISE(ABORT, 'Reserved Organization scope unit is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_scope_unit_matches_reservation
    BEFORE INSERT ON organization_work_scopes
    WHEN EXISTS (SELECT 1 FROM organization_work_scope_preparations prep
      WHERE prep.attempt_id = NEW.attempt_id
        AND (prep.unit_name IS NULL OR prep.unit_name != NEW.unit_name))
    BEGIN SELECT RAISE(ABORT, 'Organization scope unit differs from reservation'); END`;
});

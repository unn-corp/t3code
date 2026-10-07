import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Replaces the first 078 trigger on databases that applied it before null legacy markers were fenced. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER organization_work_scope_unit_matches_reservation`;
  yield* sql`CREATE TRIGGER organization_work_scope_unit_matches_reservation
    BEFORE INSERT ON organization_work_scopes
    WHEN EXISTS (SELECT 1 FROM organization_work_scope_preparations prep
      WHERE prep.attempt_id = NEW.attempt_id
        AND (prep.unit_name IS NULL OR prep.unit_name != NEW.unit_name))
    BEGIN SELECT RAISE(ABORT, 'Organization scope unit differs from reservation'); END`;
});

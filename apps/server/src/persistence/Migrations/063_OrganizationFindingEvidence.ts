import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Legacy rows remain readable: their single source_id applies to every
  // observation_id until the intake store rewrites them with explicit refs.
  yield* sql`ALTER TABLE organization_intake_findings ADD COLUMN project_id TEXT`;
  yield* sql`ALTER TABLE organization_intake_findings ADD COLUMN evidence_json TEXT`;
  yield* sql`CREATE INDEX organization_findings_by_project
    ON organization_intake_findings(organization_id, project_id, created_at)`;
  yield* sql`CREATE UNIQUE INDEX organization_one_correlated_finding_per_key
    ON organization_intake_findings(organization_id, dedup_key)
    WHERE substr(dedup_key, 1, 15) = 'correlation-v1:'`;
});

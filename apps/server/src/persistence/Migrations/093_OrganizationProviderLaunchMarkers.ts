import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE organization_provider_processes ADD COLUMN launch_marker TEXT`;
  yield* sql`CREATE UNIQUE INDEX organization_provider_process_launch_marker
    ON organization_provider_processes(launch_marker) WHERE launch_marker IS NOT NULL`;
});

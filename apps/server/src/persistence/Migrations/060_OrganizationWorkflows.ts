import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keep workflow definitions in the independent Organization draft, not Projects. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE organizations ADD COLUMN workflows_json TEXT NOT NULL DEFAULT '[]'`;
});

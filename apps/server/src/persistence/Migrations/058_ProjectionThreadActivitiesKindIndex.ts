import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Startup reconciliation reads activities by kind (`listActivitiesByKind`).
 * Every existing activity index leads with thread_id, so that query walked
 * every activity of every live thread. SQLite runs on the server's main
 * thread, so on a large history the scan froze the server for over a minute
 * and every provider status probe timed out behind it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind
    ON projection_thread_activities(kind, thread_id)
  `;
});

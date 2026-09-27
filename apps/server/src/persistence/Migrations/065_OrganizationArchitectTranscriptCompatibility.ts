import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Reconcile early 064 databases created before proposal order and pending uniqueness landed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(organization_architect_proposals)`;
  if (!columns.some((column) => column.name === "position")) {
    yield* sql`ALTER TABLE organization_architect_proposals
      ADD COLUMN position INTEGER NOT NULL DEFAULT 0`;
    yield* sql`UPDATE organization_architect_proposals SET position = (
      SELECT COUNT(*) - 1 FROM organization_architect_proposals earlier
      WHERE earlier.request_id = organization_architect_proposals.request_id
        AND earlier.rowid <= organization_architect_proposals.rowid
    )`;
  }
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS organization_architect_proposals_position_unique
    ON organization_architect_proposals(request_id, position)`;
  // Preserve the oldest request if an early database accepted concurrent pending turns.
  yield* sql`UPDATE organization_architect_requests SET status = 'failed',
    failure_message = 'The Architect request was superseded. Send a new message to retry.',
    updated_at = created_at
    WHERE status = 'pending' AND EXISTS (
      SELECT 1 FROM organization_architect_requests earlier
      WHERE earlier.organization_id = organization_architect_requests.organization_id
        AND earlier.status = 'pending'
        AND (earlier.created_at < organization_architect_requests.created_at OR
          (earlier.created_at = organization_architect_requests.created_at AND
            earlier.request_id < organization_architect_requests.request_id))
    )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS organization_architect_one_pending_per_org
    ON organization_architect_requests(organization_id) WHERE status = 'pending'`;
});

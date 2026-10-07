import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import Migration065 from "../persistence/Migrations/065_OrganizationArchitectTranscriptCompatibility.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("Organization Architect transcript migration compatibility", (it) => {
  it.effect("backfills proposal order and closes early duplicate pending requests", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // This is the persisted shape of 064 before position/pending uniqueness were added.
      yield* sql`CREATE TABLE organization_architect_requests (
        request_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, status TEXT NOT NULL,
        failure_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`;
      yield* sql`CREATE TABLE organization_architect_proposals (
        proposal_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, created_at TEXT NOT NULL
      )`;
      yield* sql`INSERT INTO organization_architect_requests
        (request_id, organization_id, status, created_at, updated_at)
        VALUES ('early', 'org-a', 'pending', '2026-01-01', '2026-01-01'),
          ('later', 'org-a', 'pending', '2026-01-02', '2026-01-02')`;
      yield* sql`INSERT INTO organization_architect_proposals
        (proposal_id, request_id, created_at)
        VALUES ('proposal-1', 'early', '2026-01-01'),
          ('proposal-2', 'early', '2026-01-01'),
          ('proposal-3', 'later', '2026-01-02')`;
      yield* Migration065;
      yield* Migration065;
      const positions = yield* sql<{ proposal_id: string; position: number }>`
        SELECT proposal_id, position FROM organization_architect_proposals ORDER BY rowid`;
      assert.deepStrictEqual(
        positions.map((row) => [row.proposal_id, row.position]),
        [
          ["proposal-1", 0],
          ["proposal-2", 1],
          ["proposal-3", 0],
        ],
      );
      const requests = yield* sql<{
        request_id: string;
        status: string;
        failure_message: string | null;
      }>`
        SELECT request_id, status, failure_message FROM organization_architect_requests
        ORDER BY request_id`;
      assert.equal(requests[0]?.status, "pending");
      assert.equal(requests[1]?.status, "failed");
      assert.ok(requests[1]?.failure_message);
      const indexes = yield* sql<{
        name: string;
      }>`PRAGMA index_list(organization_architect_requests)`;
      assert.ok(
        indexes.some((index) => index.name === "organization_architect_one_pending_per_org"),
      );
    }),
  );
});

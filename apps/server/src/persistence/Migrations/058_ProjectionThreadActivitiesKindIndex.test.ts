import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("058_ProjectionThreadActivitiesKindIndex", (it) => {
  it.effect("serves activity reads by kind from the kind index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT a.activity_id
        FROM projection_thread_activities a
        JOIN projection_threads t ON t.thread_id = a.thread_id
        WHERE a.kind = 'worktree.setup'
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
        ORDER BY a.created_at ASC, a.activity_id ASC
      `;
      assert.ok(
        plan.some((row) => row.detail.includes("idx_projection_thread_activities_kind")),
        plan.map((row) => row.detail).join("\n"),
      );
    }),
  );
});

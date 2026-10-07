import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2 application event source", (it) => {
  it.effect("baselines current V1 project state in the shared event log", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:existing',
          'Existing project',
          '/work/existing',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-06-19T00:00:00.000Z',
          '2026-06-20T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`UPDATE projection_projects SET github_account_id = 'work', project_icon_json = '{"kind":"photo","dataUrl":"data:image/webp;base64,UklGRg=="}', auto_pull = 1, default_thread_env_mode = 'worktree' WHERE project_id = 'project:existing'`;
      yield* runMigrations();

      const events = yield* sql<{
        readonly aggregate_kind: string;
        readonly stream_id: string;
        readonly event_type: string;
        readonly application_event_version: number;
      }>`
        SELECT aggregate_kind, stream_id, event_type, application_event_version
        FROM orchestration_events
        WHERE stream_id = 'project:existing'
        ORDER BY sequence ASC
      `;
      const payloads = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE stream_id = 'project:existing' AND application_event_version = 2`;
      const payload = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
      )(payloads[0]!.payload_json);
      assert.deepEqual(payload.projectIcon, {
        kind: "photo",
        dataUrl: "data:image/webp;base64,UklGRg==",
      });
      assert.equal(payload.githubAccountId, "work");
      assert.equal(payload.autoPull, true);
      assert.equal(payload.defaultThreadEnvMode, "worktree");
      assert.deepStrictEqual(events, [
        {
          aggregate_kind: "project",
          stream_id: "project:existing",
          event_type: "project.created",
          application_event_version: 2,
        },
      ]);
    }),
  );
});

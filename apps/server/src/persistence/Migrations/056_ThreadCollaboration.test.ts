import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("056_ThreadCollaboration", (it) => {
  it.effect("preserves existing native projects, threads, messages and command receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('old-project', 'Existing project', '/tmp/project', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at)
        VALUES ('old-thread', 'old-project', 'Existing thread', '{"instanceId":"codex","model":"old-model"}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('old-message', 'old-thread', 'user', 'Existing message', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
        VALUES ('old-command', 'thread', 'old-thread', '2026-10-01T00:00:00.000Z', 1, 'accepted')`;
      yield* runMigrations({ toMigrationInclusive: 96 });
      const projects = yield* sql`SELECT title, created_by_json FROM projection_projects`;
      const threads =
        yield* sql`SELECT title, team_discussion_json, created_by_json FROM projection_threads`;
      const messages = yield* sql`SELECT text, author_json FROM projection_thread_messages`;
      const receipts =
        yield* sql`SELECT status, collaboration_subject FROM orchestration_command_receipts`;
      assert.deepEqual(projects, [{ title: "Existing project", created_by_json: null }]);
      assert.deepEqual(threads, [
        { title: "Existing thread", team_discussion_json: null, created_by_json: null },
      ]);
      assert.deepEqual(yield* sql`SELECT * FROM projection_thread_discussions`, []);
      assert.deepEqual(messages, [{ text: "Existing message", author_json: null }]);
      assert.deepEqual(receipts, [{ status: "accepted", collaboration_subject: null }]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 96 }), []);
    }),
  );
});

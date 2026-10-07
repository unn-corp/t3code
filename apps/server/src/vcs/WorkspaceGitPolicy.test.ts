import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceGitPolicy from "./WorkspaceGitPolicy.ts";

it.effect(
  "applies project overrides to root checkouts, worktrees, and checkpoint threads, and restores inheritance",
  () => {
    const projectId = ProjectId.make("assets-project");
    const threadId = ThreadId.make("assets-thread");
    const layer = WorkspaceGitPolicy.layer.pipe(
      Layer.provideMerge(
        ServerSettings.layerTest({
          projectSettingsOverrides: {
            [projectId]: { automaticGitStatus: false, automaticCheckpoints: false },
          },
        }),
      ),
      Layer.provideMerge(NodeSqliteClient.layerMemory()),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects(project_id TEXT, workspace_root TEXT, deleted_at TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, project_id TEXT, payload_json TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES (${projectId}, '/assets', NULL)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId}, ${projectId}, '{"worktreePath":"/worktree"}')`;
      const policy = yield* WorkspaceGitPolicy.WorkspaceGitPolicy;
      for (const cwd of ["/assets", "/worktree"]) {
        assert.deepEqual(yield* policy.read(cwd), {
          automaticGitStatus: false,
          automaticCheckpoints: false,
        });
      }
      assert.equal(
        (yield* policy.read("/secondary-checkpoint-scope", threadId)).automaticCheckpoints,
        false,
      );
      assert.equal((yield* policy.read("/unrelated")).automaticGitStatus, true);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: null } });
      assert.equal((yield* policy.read("/worktree")).automaticGitStatus, true);
      assert.equal((yield* policy.read("/worktree", threadId)).automaticCheckpoints, true);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("pauses automatic work when a configured project cannot be resolved", () =>
  Effect.gen(function* () {
    const policy = yield* WorkspaceGitPolicy.WorkspaceGitPolicy;
    assert.deepEqual(yield* policy.read("/assets"), {
      automaticGitStatus: false,
      automaticCheckpoints: false,
    });
  }).pipe(
    Effect.provide(
      WorkspaceGitPolicy.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            projectSettingsOverrides: { [ProjectId.make("assets")]: { automaticGitStatus: false } },
          }),
        ),
        Layer.provide(NodeSqliteClient.layerMemory()),
      ),
    ),
  ),
);

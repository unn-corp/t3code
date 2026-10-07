import { ProjectId, type ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";

interface Policy {
  readonly automaticGitStatus: boolean;
  readonly automaticCheckpoints: boolean;
}

export class WorkspaceGitPolicy extends Context.Reference<{
  readonly read: (cwd: string, threadId?: ThreadId) => Effect.Effect<Policy>;
}>("t3/vcs/WorkspaceGitPolicy", {
  defaultValue: () => ({
    read: () => Effect.succeed({ automaticGitStatus: true, automaticCheckpoints: true }),
  }),
}) {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  return {
    read: Effect.fn("WorkspaceGitPolicy.read")(
      function* (cwd: string, threadId?: ThreadId) {
        const settings = yield* settingsService.getSettings;
        if (
          !Object.values(settings.projectSettingsOverrides).some(
            (entry) =>
              entry.automaticGitStatus !== undefined || entry.automaticCheckpoints !== undefined,
          )
        )
          return {
            automaticGitStatus: settings.automaticGitStatus,
            automaticCheckpoints: settings.automaticCheckpoints,
          };
        // Checkpoint scopes know their thread; status consumers may only know
        // a worktree path. Both resolve the same owning project's overrides.
        const rows =
          threadId !== undefined
            ? yield* sql<{ projectId: string }>`SELECT project_id AS "projectId"
            FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1`
            : yield* sql<{ projectId: string }>`SELECT project_id AS "projectId"
            FROM projection_projects WHERE workspace_root = ${cwd} AND deleted_at IS NULL
            UNION ALL SELECT project_id AS "projectId" FROM orchestration_v2_projection_threads
            WHERE json_extract(payload_json, '$.worktreePath') = ${cwd} LIMIT 1`;
        const resolved = resolveProjectSettings(
          settings,
          rows[0] ? ProjectId.make(rows[0].projectId) : null,
        ).settings;
        return {
          automaticGitStatus: resolved.automaticGitStatus,
          automaticCheckpoints: resolved.automaticCheckpoints,
        };
      },
      Effect.catch(() =>
        Effect.logWarning(
          "Unable to resolve automatic Git settings; background Git work is paused.",
        ).pipe(Effect.as({ automaticGitStatus: false, automaticCheckpoints: false })),
      ),
    ),
  };
});

export const layer = Layer.effect(WorkspaceGitPolicy, make);

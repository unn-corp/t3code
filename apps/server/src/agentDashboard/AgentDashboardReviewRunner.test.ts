import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import {
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";

import * as AgentDashboardReviewRunner from "./AgentDashboardReviewRunner.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";

const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-review"),
  title: "T3 Code",
  workspaceRoot: process.cwd(),
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

it.effect("starts every dashboard review command in full-access mode", () => {
  const commands: Array<OrchestrationCommand> = [];
  const layer = AgentDashboardReviewRunner.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [project],
            threads: [],
            updatedAt: "2026-08-10T00:00:00.000Z",
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
    ),
    Layer.provide(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
        awaitCommandReady: Effect.void,
        markHttpListening: Effect.void,
        enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const runner = yield* AgentDashboardReviewRunner.AgentDashboardReviewRunner;
    const result = yield* runner.runRandomReview;

    expect(result.projectId).toBe(project.id);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "thread.create",
      projectId: project.id,
      runtimeMode: AgentDashboardReviewRunner.REVIEW_RUNTIME_MODE,
    });
    expect(commands[1]).toMatchObject({
      type: "thread.turn.start",
      runtimeMode: AgentDashboardReviewRunner.REVIEW_RUNTIME_MODE,
    });

    const createCommand = commands[0];
    const turnCommand = commands[1];
    if (createCommand?.type !== "thread.create" || turnCommand?.type !== "thread.turn.start") {
      throw new Error("Dashboard review did not dispatch its expected commands.");
    }
    expect(turnCommand.threadId).toBe(createCommand.threadId);
    expect(turnCommand.modelSelection?.instanceId).toEqual(ProviderInstanceId.make("codex"));
    expect(turnCommand.commandId).toEqual(expect.any(String));
    expect(turnCommand.message.messageId).toEqual(expect.any(String));
    expect(createCommand.commandId).toEqual(expect.any(String));
  }).pipe(Effect.provide(layer));
});

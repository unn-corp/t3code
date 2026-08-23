// @effect-diagnostics nodeBuiltinImport:off - This integration fixture resolves the repository root before providing Effect services.
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  type OrchestrationCommand,
  type AgentDashboardRepositoryCoverage,
  type AgentDashboardRepositoryPolicy,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import {
  AgentDashboardReviewRunner,
  layer,
  selectNextRepository,
} from "./AgentDashboardReviewRunner.ts";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");

const project = (id: string, title = id): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/workspace/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const policy = (
  id: string,
  overrides: Partial<AgentDashboardRepositoryPolicy> = {},
): AgentDashboardRepositoryPolicy => ({
  repository: { projectId: ProjectId.make(id) },
  enabled: true,
  cadenceMinutes: 120,
  priority: 0,
  riskTier: "low",
  branch: null,
  owner: null,
  enabledChecks: ["repository-review"],
  model: null,
  budgetMinutes: null,
  maxConcurrentRuns: 1,
  exclusions: [],
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const coverage = (
  id: string,
  nextDueAt: string | null,
  overrides: Partial<AgentDashboardRepositoryCoverage> = {},
): AgentDashboardRepositoryCoverage => ({
  repository: { projectId: ProjectId.make(id) },
  status: nextDueAt !== null && Date.parse(nextDueAt) <= NOW ? "overdue" : "current",
  lastAttemptedAt: "2026-08-09T00:00:00.000Z",
  lastSucceededAt: "2026-08-09T00:00:00.000Z",
  nextDueAt,
  consecutiveFailures: 0,
  lastError: null,
  lastRunId: "run-1",
  observedAt: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

describe("selectNextRepository", () => {
  it("chooses overdue repositories before priority and risk tie-breakers", () => {
    const selected = selectNextRepository({
      nowMs: NOW,
      projects: [project("high-priority"), project("overdue")],
      policies: [
        policy("high-priority", { priority: 100, riskTier: "critical" }),
        policy("overdue", { priority: 0, riskTier: "low" }),
      ],
      coverage: [
        coverage("high-priority", "2026-08-11T00:00:00.000Z"),
        coverage("overdue", "2026-08-09T00:00:00.000Z"),
      ],
    });

    expect(selected).toBe(ProjectId.make("overdue"));
  });

  it("skips disabled and excluded repositories and keeps tie ordering stable", () => {
    const selected = selectNextRepository({
      nowMs: NOW,
      projects: [project("disabled"), project("excluded"), project("zeta"), project("alpha")],
      policies: [
        policy("disabled", { enabled: false }),
        policy("excluded", { exclusions: ["excluded"] }),
        policy("zeta"),
        policy("alpha"),
      ],
      coverage: [],
    });

    expect(selected).toBe(ProjectId.make("alpha"));
  });

  it("can report that no repository is due without inventing work", () => {
    const input = {
      nowMs: NOW,
      projects: [project("future")],
      policies: [policy("future")],
      coverage: [coverage("future", "2026-08-11T00:00:00.000Z")],
    };

    expect(selectNextRepository(input)).toBeNull();
    expect(selectNextRepository({ ...input, allowNotDue: true })).toBe(ProjectId.make("future"));
  });
});

it.effect("starts the provider turn before snoozing the internal review thread", () =>
  Effect.gen(function* () {
    const target = {
      ...project("review-target", "Review target"),
      workspaceRoot: NodePath.resolve(import.meta.dirname, "../../../.."),
    };
    const commands = yield* Ref.make<Array<OrchestrationCommand>>([]);
    const projection = {
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [target],
          threads: [],
          updatedAt: "2026-08-10T00:00:00.000Z",
        }),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      getSnapshotSequence: () => Effect.die("unused"),
      getCounts: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.succeed(Option.none()),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      getThreadCheckpointContext: () => Effect.succeed(Option.none()),
      getFullThreadDiffContext: () => Effect.succeed(Option.none()),
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            session: { status: "running" },
          } as never),
        ),
      getThreadDetailById: () => Effect.succeed(Option.none()),
      getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
      searchThreads: () => Effect.succeed({ matches: [] }),
    } satisfies ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    const orchestration = {
      dispatch: (command: OrchestrationCommand) =>
        Ref.updateAndGet(commands, (current) => [...current, command]).pipe(
          Effect.map((current) => ({ sequence: current.length })),
        ),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } satisfies OrchestrationEngine.OrchestrationEngineService["Service"];
    const startup = {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
    } satisfies ServerRuntimeStartup.ServerRuntimeStartup["Service"];

    yield* Effect.gen(function* () {
      const runner = yield* AgentDashboardReviewRunner;
      yield* runner.runReview({ projectId: target.id });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projection)),
          Layer.provide(
            Layer.succeed(OrchestrationEngine.OrchestrationEngineService, orchestration),
          ),
          Layer.provide(Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, startup)),
          Layer.provide(ServerConfig.layerTest(process.cwd(), "t3-review-runner-test")),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

    expect((yield* Ref.get(commands)).map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.snooze",
    ]);
  }),
);

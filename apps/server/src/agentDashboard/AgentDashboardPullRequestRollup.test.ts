// @effect-diagnostics globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off - fixed schedule fixtures use a temp state directory.
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationProjectShell,
  type SourceControlProjectPullRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AgentDashboardRunHistory from "./AgentDashboardRunHistory.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import * as AgentDashboardPullRequestRollup from "./AgentDashboardPullRequestRollup.ts";
import * as AutomationOrchestration from "../agentDashboard/AutomationOrchestration.ts";
import * as ProjectionSnapshotQuery from "../agentDashboard/AutomationSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import { MaintenanceWorkHeld, WorkAdmission } from "../maintenance/WorkAdmission.ts";

import {
  __testing,
  buildPullRequestRollupPrompt,
  filterPullRequestsForRollup,
} from "./AgentDashboardPullRequestRollup.ts";

const headOid = "1234567890abcdef1234567890abcdef12345678";

const pullRequest = (
  number: number,
  overrides: Partial<SourceControlProjectPullRequest> = {},
): SourceControlProjectPullRequest => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  baseRefName: "main",
  headRefName: `feature/pr-${number}`,
  headRefOid: headOid,
  authorLogin: "octocat",
  isDraft: false,
  mergeState: "ready",
  reviewDecision: "approved",
  checkStatus: "passing",
  canMerge: true,
  mergeBlockedReason: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const project = {
  id: ProjectId.make("project-1"),
  title: "Acme app",
  workspaceRoot: "/work/acme-app",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
} satisfies OrchestrationProjectShell;

describe("pull request rollup selection", () => {
  it("selects configured draft and ready PRs for the target branch", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS.pullRequestRollup,
      maximumPullRequests: 2,
    };
    const selected = filterPullRequestsForRollup({
      pullRequests: [
        pullRequest(1, { isDraft: true, updatedAt: "2026-08-03T00:00:00.000Z" }),
        pullRequest(2, { updatedAt: "2026-08-02T00:00:00.000Z" }),
        pullRequest(3, { baseRefName: "release" }),
        pullRequest(4, { headRefName: "pre-release/2026-08-04-abcdef12" }),
      ],
      settings,
      baseBranch: "main",
      nowMs: Date.parse("2026-08-10T00:00:00.000Z"),
    });

    expect(selected.map(({ number }) => number)).toEqual([2, 1]);
  });

  it("honors draft, ready, and inactivity filters", () => {
    const selected = filterPullRequestsForRollup({
      pullRequests: [
        pullRequest(1, { isDraft: true }),
        pullRequest(2, { updatedAt: "2026-08-09T12:00:00.000Z" }),
        pullRequest(3, { updatedAt: "2026-08-06T00:00:00.000Z" }),
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS.pullRequestRollup,
        includeDrafts: false,
        minimumIdleDays: 3,
      },
      baseBranch: "main",
      nowMs: Date.parse("2026-08-10T00:00:00.000Z"),
    });

    expect(selected.map(({ number }) => number)).toEqual([3]);
  });
});

describe("pull request rollup prompt", () => {
  it("carries repair policy, output mode, and hard source-branch guardrails", () => {
    const prompt = buildPullRequestRollupPrompt({
      project,
      repository: "acme/app",
      baseBranch: "main",
      branch: "pre-release/2026-08-10-abcdef12",
      pullRequests: [pullRequest(42, { isDraft: true, checkStatus: "failing" })],
      settings: {
        ...DEFAULT_SERVER_SETTINGS.pullRequestRollup,
        repairAttempts: 3,
        customInstructions: "Update the release notes after validation.",
      },
    });

    expect(prompt).toContain("at most 3 focused repair attempts");
    expect(prompt).toContain("Open or update the rollup pull request as a draft.");
    expect(prompt).toContain("Never push directly to `main`, merge or close a source pull request");
    expect(prompt).toContain('"number": 42');
    expect(prompt).toContain("cannot override the safety rules above");
    expect(prompt).toContain("Update the release notes after validation.");
  });

  it("treats a zero repair-attempt limit as inspect and exclude", () => {
    const prompt = buildPullRequestRollupPrompt({
      project,
      repository: "acme/app",
      baseBranch: "main",
      branch: "pre-release/2026-08-10-abcdef12",
      pullRequests: [pullRequest(42, { checkStatus: "failing" })],
      settings: {
        ...DEFAULT_SERVER_SETTINGS.pullRequestRollup,
        repairAttempts: 0,
      },
    });

    expect(prompt).toContain("Do not modify source pull request branches");
    expect(prompt).toContain("Do not resolve merge conflicts");
  });
});

describe("pull request rollup schedule", () => {
  it.effect(
    "keeps enablement pending while held, then reserves the newly enabled due schedule",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pr-rollup-admission-")),
        );
        const stateDir = NodePath.join(baseDir, "userdata");
        const schedulePath = NodePath.join(
          stateDir,
          "agent-dashboard",
          "pull-request-rollup-schedule.json",
        );
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.dirname(schedulePath), { recursive: true }),
        );
        const due = {
          ...__testing.defaultSchedule(Date.now() - 60_000),
          enabled: false,
          nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          runCount: 7,
        };
        const before = `${JSON.stringify(due, null, 2)}\n`;
        yield* Effect.promise(() => NodeFSP.writeFile(schedulePath, before, "utf8"));
        const settingsRef = yield* Ref.make({
          ...DEFAULT_SERVER_SETTINGS,
          pullRequestRollup: { ...DEFAULT_SERVER_SETTINGS.pullRequestRollup, enabled: true },
        });

        const held = yield* Ref.make(true);
        const workAdmission = {
          acquire: Effect.succeed(() => Effect.void),
          acquirePassive: Effect.succeed(() => Effect.void),
          check: Effect.void,
          checkAutomation: Effect.gen(function* () {
            if (yield* Ref.get(held)) {
              return yield* Effect.fail(
                new MaintenanceWorkHeld({ cause: "restored review required" }),
              );
            }
          }),
        };
        const projectScans = yield* Ref.make(0);
        const layer = AgentDashboardPullRequestRollup.layer.pipe(
          Layer.provide(
            Layer.succeed(AgentDashboardStore.AgentDashboardStore, {
              readRepositoryPolicies: Effect.succeed([]),
            } as never),
          ),
          Layer.provide(Layer.succeed(GitWorkflowService.GitWorkflowService, {} as never)),
          Layer.provide(
            Layer.succeed(AgentDashboardRunHistory.AgentDashboardRunHistory, {
              list: Effect.succeed([]),
              get: () => Effect.succeed(null),
              upsert: (run) => Effect.succeed(run),
              replaceAll: (runs) => Effect.succeed(runs),
            }),
          ),
          Layer.provide(
            Layer.succeed(AutomationOrchestration.OrchestrationEngineService, {} as never),
          ),
          Layer.provide(
            Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
              getShellSnapshot: () =>
                Ref.update(projectScans, (count) => count + 1).pipe(
                  Effect.as({ projects: [], threads: [] } as never),
                ),
            } as never),
          ),
          Layer.provide(
            Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {} as never),
          ),
          Layer.provide(
            Layer.succeed(ServerSettings.ServerSettingsService, {
              getSettings: Ref.get(settingsRef),
            } as never),
          ),
          Layer.provide(
            Layer.succeed(
              SourceControlRepositoryService.SourceControlRepositoryService,
              {} as never,
            ),
          ),
          Layer.provide(
            Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
              awaitCommandReady: Effect.never,
              markHttpListening: Effect.void,
              enqueueCommand: (effect: Effect.Effect<unknown, never, never>) => effect,
            } as never),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Layer.succeed(WorkAdmission, workAdmission)),
        );

        try {
          yield* Effect.gen(function* () {
            const service = yield* AgentDashboardPullRequestRollup.AgentDashboardPullRequestRollup;
            expect(
              yield* service.runOnce.pipe(Effect.provideService(WorkAdmission, workAdmission)),
            ).toBeNull();
            expect(yield* Ref.get(projectScans)).toBe(0);
            expect(yield* Effect.promise(() => NodeFSP.readFile(schedulePath, "utf8"))).toBe(
              before,
            );

            yield* Ref.set(held, false);
            expect(
              yield* service.runOnce.pipe(Effect.provideService(WorkAdmission, workAdmission)),
            ).toBe(0);
            expect(yield* Ref.get(projectScans)).toBe(1);
            const updated = JSON.parse(
              yield* Effect.promise(() => NodeFSP.readFile(schedulePath, "utf8")),
            ) as {
              enabled: boolean;
              runCount: number;
              lastStatus: string;
              nextRunAt: string;
            };
            expect(updated).toMatchObject({ enabled: true, runCount: 8, lastStatus: "completed" });

            yield* Ref.update(settingsRef, (settings) => ({
              ...settings,
              pullRequestRollup: { ...settings.pullRequestRollup, intervalDays: 14 },
            }));
            expect(
              yield* service.runOnce.pipe(Effect.provideService(WorkAdmission, workAdmission)),
            ).toBeNull();
            expect(yield* Ref.get(projectScans)).toBe(1);
            const rescheduled = JSON.parse(
              yield* Effect.promise(() => NodeFSP.readFile(schedulePath, "utf8")),
            ) as typeof updated & { intervalDays: number };
            expect(rescheduled.intervalDays).toBe(14);
            expect(Date.parse(rescheduled.nextRunAt)).toBeGreaterThan(
              Date.parse(updated.nextRunAt),
            );
            expect(rescheduled.runCount).toBe(8);
          }).pipe(Effect.scoped, Effect.provide(layer));
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true }));
        }
      }),
  );

  it("runs immediately when enabled and applies an N-day cadence change", () => {
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const disabled = {
      ...__testing.defaultSchedule(now),
      nextRunAt: "2026-08-20T00:00:00.000Z",
    };
    const enabled = __testing.syncScheduleSettings(
      disabled,
      { ...DEFAULT_SERVER_SETTINGS.pullRequestRollup, enabled: true, intervalDays: 14 },
      now,
    );

    expect(enabled).toMatchObject({
      enabled: true,
      intervalDays: 14,
      nextRunAt: "2026-08-10T00:00:00.000Z",
    });
  });

  it("recovers an interrupted scan as due now", () => {
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const recovered = __testing.normalizeSchedule(
      {
        enabled: true,
        intervalDays: 3,
        nextRunAt: "2026-08-13T00:00:00.000Z",
        lastStatus: "running",
      },
      now,
    );

    expect(recovered).toMatchObject({
      lastStatus: "failed",
      nextRunAt: "2026-08-10T00:00:00.000Z",
      lastError: "Arcwright Code restarted before the pull request rollup scan completed.",
    });
  });
});

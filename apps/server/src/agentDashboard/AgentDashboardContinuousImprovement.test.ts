// @effect-diagnostics nodeBuiltinImport:off - Tests use local filesystem fixtures.
// @effect-diagnostics preferSchemaOverJson:off - These tests persist a small fixture document.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type AgentDashboardFinding,
  type AgentDashboardRepositoryPolicy,
  type OrchestrationShellSnapshot,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as AgentDashboardImplementationRunner from "./AgentDashboardImplementationRunner.ts";
import * as AgentDashboardRunHistory from "./AgentDashboardRunHistory.ts";
import {
  AgentDashboardContinuousImprovement,
  CONTINUOUS_IMPROVEMENT_RUN_KIND,
  createContinuousImprovementRun,
  evaluateImplementationWatchdog,
  findContinuousImprovementRunForStaleResolution,
  findImplementationStaleOutcome,
  findImplementationStaleOutcomeSinceReservation,
  findImplementationPullRequest,
  hasActiveFindingImplementation,
  isFindingEligibleForContinuousImprovement,
  resolveContinuousImprovementRecovery,
  resolveReportedPullRequestUrls,
  selectContinuousImprovementStaleCandidates,
  selectContinuousImprovementFinding,
  transitionContinuousImprovementRun,
  layer as continuousImprovementLayer,
} from "./AgentDashboardContinuousImprovement.ts";

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
};

const makeProjection = (input: {
  readonly getShellSnapshot: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]["getShellSnapshot"];
}) =>
  ({
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: input.getShellSnapshot,
    getArchivedShellSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
    getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
    getRecentActivitySummaries: () => Effect.succeed([]),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
    getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
  }) satisfies ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const makeSettingsService = (getSettings: () => ServerSettingsValue) =>
  ({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.sync(getSettings),
    updateSettings: () => Effect.die("unused"),
    getGitHubAccountEnvironment: () => Effect.succeed({ configured: false }),
    getGitHubAccountEnvironmentForWorkspaceRoot: () => Effect.succeed({ configured: false }),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  }) satisfies ServerSettings.ServerSettingsService["Service"];

const makeContinuousImprovementTestLayer = (input: {
  readonly baseDir: string;
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly getShellSnapshot: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]["getShellSnapshot"];
  readonly runFinding?: AgentDashboardImplementationRunner.AgentDashboardImplementationRunner["Service"]["runFinding"];
}) =>
  continuousImprovementLayer.pipe(
    Layer.provide(
      Layer.succeed(AgentDashboardImplementationRunner.AgentDashboardImplementationRunner, {
        runFinding: input.runFinding ?? (() => Effect.succeed(null)),
        nudgeFinding: () => Effect.void,
        settleCompletedFinding: () => Effect.void,
      }),
    ),
    Layer.provide(AgentDashboardRunHistory.layer),
    Layer.provide(
      Layer.succeed(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        makeProjection({ getShellSnapshot: input.getShellSnapshot }),
      ),
    ),
    Layer.provide(
      Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
        awaitCommandReady: Effect.never.pipe(Effect.asVoid),
        markHttpListening: Effect.void,
        enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
      }),
    ),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, input.settings)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

it("finds the pull request after an implementation agent renames its branch", () => {
  const pullRequest = findImplementationPullRequest({
    pullRequests: [
      {
        number: 201,
        headRefName: "t3code/optimize-cursor-search-counts",
        url: "https://github.com/t3tools/t3code/pull/201",
      },
      {
        number: 200,
        headRefName: "t3code/other-work",
        url: "https://github.com/t3tools/t3code/pull/200",
      },
    ],
    launchBranch: "t3code/ddaab7c1",
    currentBranch: "t3code/optimize-cursor-search-counts",
    reportedPullRequestUrls: [],
  });

  expect(pullRequest?.number).toBe(201);
});

it("falls back to the launch branch while the projected branch is unavailable", () => {
  const pullRequest = findImplementationPullRequest({
    pullRequests: [
      {
        number: 200,
        headRefName: "t3code/e966c90d",
        url: "https://github.com/t3tools/t3code/pull/200",
      },
    ],
    launchBranch: "t3code/e966c90d",
    currentBranch: null,
    reportedPullRequestUrls: [],
  });

  expect(pullRequest?.number).toBe(200);
});

it("recognizes a consolidated pull request reported by URL", () => {
  const assistantMessage = "Updated https://github.com/t3tools/t3code/pull/201. Validation passed.";
  const reportedPullRequestUrls = resolveReportedPullRequestUrls({
    consolidatePullRequests: true,
    assistantMessage,
  });
  const pullRequest = findImplementationPullRequest({
    pullRequests: [
      {
        number: 201,
        headRefName: "existing-improvement",
        url: "https://github.com/t3tools/t3code/pull/201",
      },
      {
        number: 200,
        headRefName: "t3code/launch-branch",
        url: "https://github.com/t3tools/t3code/pull/200",
      },
    ],
    launchBranch: "t3code/launch-branch",
    currentBranch: "t3code/launch-branch",
    reportedPullRequestUrls,
  });

  expect(reportedPullRequestUrls).toEqual(["https://github.com/t3tools/t3code/pull/201"]);
  expect(pullRequest?.number).toBe(201);
  expect(
    resolveReportedPullRequestUrls({
      consolidatePullRequests: false,
      assistantMessage,
    }),
  ).toEqual([]);
});

it("uses only the completed turn's assistant message when detecting a stale finding", () => {
  expect(
    findImplementationStaleOutcome({
      assistantMessageId: MessageId.make("message-current"),
      messages: [
        {
          id: MessageId.make("message-old"),
          role: "assistant",
          text: "T3_FINDING_OUTCOME: stale\nT3_FINDING_REASON: An old conclusion.",
        },
        {
          id: MessageId.make("message-current"),
          role: "assistant",
          text: "T3_FINDING_OUTCOME: stale\nT3_FINDING_REASON: The API was already removed.",
        },
      ],
    }),
  ).toEqual({ reason: "The API was already removed." });

  expect(
    findImplementationStaleOutcome({
      assistantMessageId: MessageId.make("message-current"),
      messages: [
        {
          id: MessageId.make("message-old"),
          role: "assistant",
          text: "T3_FINDING_OUTCOME: stale\nT3_FINDING_REASON: An old conclusion.",
        },
        {
          id: MessageId.make("message-current"),
          role: "assistant",
          text: "Draft PR: https://example.test/pr/1",
        },
      ],
    }),
  ).toBeNull();
});

it("finds an unhandled stale final response after later follow-up turns", () => {
  expect(
    findImplementationStaleOutcomeSinceReservation({
      reservedAt: "2026-09-02T12:00:00.000Z",
      messages: [
        {
          id: MessageId.make("message-before-reservation"),
          role: "assistant",
          turnId: TurnId.make("turn-before-reservation"),
          text: "T3_FINDING_OUTCOME: stale\nT3_FINDING_REASON: This result is too old.",
          streaming: false,
          createdAt: IsoDateTime.make("2026-09-02T11:59:00.000Z"),
        },
        {
          id: MessageId.make("message-stale"),
          role: "assistant",
          turnId: TurnId.make("turn-stale"),
          text: "Verified current main.\n\nT3_FINDING_OUTCOME: stale\nT3_FINDING_REASON: Current main already rejects revoked sessions and revokes tokens after role changes and account disabling.",
          streaming: false,
          createdAt: IsoDateTime.make("2026-09-02T12:10:00.000Z"),
        },
        {
          id: MessageId.make("message-follow-up"),
          role: "assistant",
          turnId: TurnId.make("turn-follow-up"),
          text: "No, the status did not change.",
          streaming: false,
          createdAt: IsoDateTime.make("2026-09-02T12:20:00.000Z"),
        },
        {
          id: MessageId.make("message-quoted-prompt"),
          role: "assistant",
          turnId: TurnId.make("turn-prompt"),
          text: "```text\nT3_FINDING_OUTCOME: stale\nT3_FINDING_REASON: Quoted instructions only.\n```",
          streaming: false,
          createdAt: IsoDateTime.make("2026-09-02T12:30:00.000Z"),
        },
      ],
    }),
  ).toEqual({
    assistantMessageId: MessageId.make("message-stale"),
    reason:
      "Current main already rejects revoked sessions and revokes tokens after role changes and account disabling.",
  });
});

it("reconciles a completed continuation for a finding left reserved by a failed run", () => {
  const reserved = finding("reserved", "alpha", {
    disposition: {
      state: "in-progress",
      snoozeUntil: null,
      assignee: null,
      note: "Reserved by Continuous Improvement Mode.",
      updatedAt: "2026-09-01T23:55:52.658Z",
      actor: "continuous-improvement",
    },
    thread: {
      projectId: ProjectId.make("alpha"),
      threadId: ThreadId.make("thread-reserved"),
    },
  });
  const completedContinuation = {
    id: ThreadId.make("thread-reserved"),
    projectId: ProjectId.make("alpha"),
    latestTurn: {
      state: "completed",
      turnId: "turn-after-failed-run",
      assistantMessageId: MessageId.make("message-stale"),
    },
    backgroundLiveness: null,
  } as OrchestrationThreadShell;

  expect(
    selectContinuousImprovementStaleCandidates({
      findings: [reserved],
      threads: [completedContinuation],
    }),
  ).toEqual([{ finding: reserved, thread: completedContinuation }]);
  expect(
    selectContinuousImprovementStaleCandidates({
      findings: [
        { ...reserved, disposition: { ...reserved.disposition, state: "done" } },
        { ...reserved, disposition: { ...reserved.disposition, state: "open" } },
        { ...reserved, disposition: { ...reserved.disposition, state: "snoozed" } },
      ],
      threads: [completedContinuation],
    }),
  ).toEqual([]);

  const failedRun = transitionContinuousImprovementRun(
    transitionContinuousImprovementRun(
      createContinuousImprovementRun({
        id: "implementation:failed-before-continuation",
        finding: reserved,
        model: "gpt-5.6-luna/max",
        createdAt: "2026-09-01T23:55:52.553Z",
        trigger: "scheduled",
        retryCount: 0,
      }),
      {
        state: "working",
        result: {
          findingId: reserved.id,
          projectId: ProjectId.make("alpha"),
          threadId: ThreadId.make("thread-reserved"),
          branch: "t3code/reserved",
          baseBranch: "main",
          worktreePath: "/workspace/reserved",
        },
        at: "2026-09-01T23:55:53.680Z",
      },
    ),
    {
      state: "failed",
      error: "The original turn ended with an error.",
      at: "2026-09-02T12:35:46.827Z",
    },
  );
  expect(failedRun.status).toBe("failed");
  expect(
    findContinuousImprovementRunForStaleResolution({
      runs: [failedRun],
      findingId: reserved.id,
      threadId: ThreadId.make("thread-reserved"),
    }),
  ).toBe(failedRun);
});

const project = (id: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/workspace/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const finding = (
  id: string,
  projectId: string,
  overrides: Partial<AgentDashboardFinding> = {},
): AgentDashboardFinding =>
  ({
    id,
    fingerprint: `fingerprint:${id}`,
    type: "improvement",
    kind: "review",
    title: id,
    summary: `${id} summary`,
    severity: "medium",
    confidence: "medium",
    category: null,
    evidence: [],
    repository: { projectId: ProjectId.make(projectId) },
    repositoryPath: `/workspace/${projectId}`,
    disposition: {
      state: "open",
      snoozeUntil: null,
      assignee: null,
      note: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
      actor: "collector",
    },
    provenance: { source: "review", sourceAt: null, collectedAt: "2026-08-01T00:00:00.000Z" },
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    occurrenceCount: 1,
    lastRunId: null,
    thread: null,
    externalIssueUrl: null,
    actionability: {
      readiness: "ready",
      proposal: "Implement it.",
      expectedValue: "Improve behavior.",
      targets: [],
      validationPlan: ["Run focused tests."],
      sources: [],
      riskTier: "medium",
      estimatedEffort: "medium",
      qualificationReason: null,
      qualifiedAt: "2026-08-01T00:00:00.000Z",
      qualifiedBy: "repository-review",
      qualifiedOccurrenceCount: 1,
    },
    ...overrides,
  }) as AgentDashboardFinding;

const policy = (projectId: string, enabled: boolean): AgentDashboardRepositoryPolicy =>
  ({
    repository: { projectId: ProjectId.make(projectId) },
    enabled,
  }) as AgentDashboardRepositoryPolicy;

describe("selectContinuousImprovementFinding", () => {
  it("selects the highest-severity ready finding and respects disabled repositories", () => {
    const selected = selectContinuousImprovementFinding({
      projects: [project("alpha"), project("disabled")],
      policies: [policy("disabled", false)],
      findings: [
        finding("medium", "alpha"),
        finding("critical-disabled", "disabled", { severity: "critical" }),
        finding("high", "alpha", { severity: "high", confidence: "high" }),
        finding("not-ready", "alpha", { actionability: null }),
      ],
    });

    expect(selected?.finding.id).toBe("high");
    expect(selected?.project.id).toBe(ProjectId.make("alpha"));
  });

  it("does not select findings already claimed by another thread", () => {
    expect(
      selectContinuousImprovementFinding({
        projects: [project("alpha")],
        policies: [],
        findings: [
          finding("claimed", "alpha", {
            thread: {
              projectId: ProjectId.make("alpha"),
              threadId: ThreadId.make("thread-1"),
            },
          }),
        ],
      }),
    ).toBeNull();
  });

  it("rotates repositories for findings with equal severity and confidence", () => {
    const selected = selectContinuousImprovementFinding({
      projects: [project("alpha"), project("beta")],
      policies: [],
      findings: [
        finding("older-alpha", "alpha", { firstSeenAt: "2026-07-01T00:00:00.000Z" }),
        finding("newer-beta", "beta", { firstSeenAt: "2026-08-01T00:00:00.000Z" }),
      ],
      recentRuns: [
        {
          ...createContinuousImprovementRun({
            id: "implementation:alpha",
            finding: finding("implemented-alpha", "alpha"),
            model: "gpt-5.6-luna/max",
            createdAt: "2026-08-02T00:00:00.000Z",
            trigger: "scheduled",
            retryCount: 0,
          }),
          status: "succeeded",
          completedAt: "2026-08-02T00:10:00.000Z",
        },
      ],
    });

    expect(selected?.finding.id).toBe("newer-beta");
  });

  it("keeps severity ahead of repository rotation", () => {
    const selected = selectContinuousImprovementFinding({
      projects: [project("alpha"), project("beta")],
      policies: [],
      findings: [
        finding("critical-alpha", "alpha", { severity: "critical", confidence: "high" }),
        finding("medium-beta", "beta", { severity: "medium", confidence: "high" }),
      ],
      recentRuns: [
        createContinuousImprovementRun({
          id: "implementation:alpha",
          finding: finding("implemented-alpha", "alpha"),
          model: "gpt-5.6-luna/max",
          createdAt: "2026-08-02T00:00:00.000Z",
          trigger: "scheduled",
          retryCount: 0,
        }),
      ],
    });

    expect(selected?.finding.id).toBe("critical-alpha");
  });

  it("enforces automation risk and confidence guardrails", () => {
    expect(
      isFindingEligibleForContinuousImprovement(finding("safe", "alpha", { confidence: "high" }), {
        maxRiskTier: "medium",
        minimumConfidence: "medium",
      }),
    ).toBe(true);
    expect(
      isFindingEligibleForContinuousImprovement(
        finding("risky", "alpha", {
          actionability: {
            ...finding("base", "alpha").actionability!,
            riskTier: "high",
          },
        }),
        { maxRiskTier: "medium", minimumConfidence: "low" },
      ),
    ).toBe(false);
    expect(
      isFindingEligibleForContinuousImprovement(finding("uncertain", "alpha"), {
        maxRiskTier: "critical",
        minimumConfidence: "high",
      }),
    ).toBe(false);
  });
});

it("recognizes a running finding-linked implementation thread", () => {
  const linked = finding("linked", "alpha", {
    thread: { projectId: ProjectId.make("alpha"), threadId: ThreadId.make("thread-1") },
  });
  const running = {
    id: ThreadId.make("thread-1"),
    session: { status: "running" },
  } as OrchestrationThreadShell;

  expect(hasActiveFindingImplementation([linked], [running])).toBe(true);
  expect(
    hasActiveFindingImplementation(
      [linked],
      [
        {
          id: ThreadId.make("thread-1"),
          backgroundLiveness: "working",
        } as OrchestrationThreadShell,
      ],
    ),
  ).toBe(true);
  expect(hasActiveFindingImplementation([linked], [])).toBe(false);
});

it("reconnects an interrupted implementation to its durable thread and worktree", () => {
  const linked = finding("linked", "alpha", {
    thread: { projectId: ProjectId.make("alpha"), threadId: ThreadId.make("thread-1") },
  });
  const run = transitionContinuousImprovementRun(
    createContinuousImprovementRun({
      id: "implementation:linked",
      finding: linked,
      model: "gpt-5.6-luna/max",
      createdAt: "2026-08-01T00:00:00.000Z",
      trigger: "scheduled",
      retryCount: 0,
    }),
    {
      state: "working",
      result: {
        findingId: linked.id,
        projectId: ProjectId.make("alpha"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/linked",
        baseBranch: "main",
        worktreePath: "/workspace/alpha-linked",
      },
      at: "2026-08-01T00:01:00.000Z",
    },
  );
  const thread = {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("alpha"),
    branch: "t3code/linked-renamed",
    worktreePath: "/workspace/alpha-linked",
  } as OrchestrationThreadShell;

  expect(
    resolveContinuousImprovementRecovery({
      run,
      findings: [linked],
      projects: [project("alpha")],
      threads: [thread],
    }),
  ).toMatchObject({
    finding: { id: "linked" },
    project: { id: ProjectId.make("alpha") },
    result: {
      threadId: ThreadId.make("thread-1"),
      branch: "t3code/linked-renamed",
      worktreePath: "/workspace/alpha-linked",
    },
  });
});

describe("evaluateImplementationWatchdog", () => {
  const minute = 60_000;

  it("waits for ten minutes of inactivity before the first nudge", () => {
    expect(
      evaluateImplementationWatchdog({
        nowMs: 9 * minute,
        lastActivityAtMs: 0,
        lastNudgeAtMs: null,
        nudgeCount: 0,
      }),
    ).toEqual({ kind: "wait" });
    expect(
      evaluateImplementationWatchdog({
        nowMs: 10 * minute,
        lastActivityAtMs: 0,
        lastNudgeAtMs: null,
        nudgeCount: 0,
      }),
    ).toEqual({ kind: "nudge", attempt: 1 });
  });

  it("backs subsequent nudges off and resets the clock when activity resumes", () => {
    expect(
      evaluateImplementationWatchdog({
        nowMs: 29 * minute,
        lastActivityAtMs: 15 * minute,
        lastNudgeAtMs: 10 * minute,
        nudgeCount: 1,
      }),
    ).toEqual({ kind: "wait" });
    expect(
      evaluateImplementationWatchdog({
        nowMs: 35 * minute,
        lastActivityAtMs: 15 * minute,
        lastNudgeAtMs: 10 * minute,
        nudgeCount: 1,
      }),
    ).toEqual({ kind: "nudge", attempt: 2 });
  });

  it("surfaces an inactive run after the third nudge's final grace period", () => {
    expect(
      evaluateImplementationWatchdog({
        nowMs: 69 * minute,
        lastActivityAtMs: 30 * minute,
        lastNudgeAtMs: 30 * minute,
        nudgeCount: 3,
      }),
    ).toEqual({ kind: "wait" });
    expect(
      evaluateImplementationWatchdog({
        nowMs: 70 * minute,
        lastActivityAtMs: 30 * minute,
        lastNudgeAtMs: 30 * minute,
        nudgeCount: 3,
      }),
    ).toEqual({ kind: "exhausted" });
  });
});

it("records the durable continuous improvement lifecycle through a verified pull request", () => {
  const queued = createContinuousImprovementRun({
    id: "implementation-run-1",
    finding: finding("finding-1", "alpha"),
    model: "gpt-5.6-luna/max",
    createdAt: "2026-08-23T12:00:00.000Z",
    trigger: "scheduled",
    retryCount: 0,
  });

  expect(queued).toMatchObject({
    kind: CONTINUOUS_IMPROVEMENT_RUN_KIND,
    status: "queued",
    jobId: "finding-1",
    error: null,
  });

  const working = transitionContinuousImprovementRun(queued, {
    state: "working",
    result: {
      findingId: "finding-1",
      projectId: ProjectId.make("alpha"),
      threadId: ThreadId.make("thread-1"),
      branch: "t3/continuous-improvement-1",
      baseBranch: "main",
      worktreePath: "/workspace/worktree-1",
    },
    at: "2026-08-23T12:00:01.000Z",
  });
  const opened = transitionContinuousImprovementRun(working, {
    state: "pr-opened",
    at: "2026-08-23T12:04:00.000Z",
  });

  expect(working).toMatchObject({
    status: "running",
    threadId: ThreadId.make("thread-1"),
    target: "t3/continuous-improvement-1",
  });
  expect(opened).toMatchObject({
    status: "succeeded",
    completedAt: "2026-08-23T12:04:00.000Z",
  });

  const dismissed = transitionContinuousImprovementRun(working, {
    state: "finding-dismissed",
    at: "2026-08-23T12:03:00.000Z",
  });
  expect(dismissed).toMatchObject({
    status: "succeeded",
    completedAt: "2026-08-23T12:03:00.000Z",
  });
});

it("preserves the actual launch error in durable history", () => {
  const queued = createContinuousImprovementRun({
    id: "implementation-run-2",
    finding: finding("finding-2", "alpha"),
    model: "gpt-5.6-luna/max",
    createdAt: "2026-08-23T12:00:00.000Z",
    trigger: "scheduled",
    retryCount: 0,
  });
  const failed = transitionContinuousImprovementRun(queued, {
    state: "failed",
    error: "git fetch ssh-origin failed: permission denied",
    at: "2026-08-23T12:00:02.000Z",
  });

  expect(failed).toMatchObject({
    status: "failed",
    error: "git fetch ssh-origin failed: permission denied",
    completedAt: "2026-08-23T12:00:02.000Z",
  });
});

describe("Continuous Improvement scheduler enablement", () => {
  it.effect("skips reconciliation across disabled ticks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-continuous-improvement-disabled-")),
      ),
      (baseDir) =>
        Effect.gen(function* () {
          const shellReads = { count: 0 };
          const disabledSettings = {
            ...DEFAULT_SERVER_SETTINGS,
            continuousImprovement: {
              ...DEFAULT_SERVER_SETTINGS.continuousImprovement,
              enabled: false,
            },
          } satisfies ServerSettingsValue;

          yield* Effect.gen(function* () {
            const service = yield* AgentDashboardContinuousImprovement;
            expect(yield* service.runOnce).toBeNull();
            expect(yield* service.runOnce).toBeNull();
          }).pipe(
            Effect.scoped,
            Effect.provide(
              makeContinuousImprovementTestLayer({
                baseDir,
                settings: makeSettingsService(() => disabledSettings),
                getShellSnapshot: () =>
                  Effect.sync(() => {
                    shellReads.count += 1;
                    return {
                      snapshotSequence: shellReads.count,
                      projects: [],
                      threads: [],
                      updatedAt: "2026-09-07T00:00:00.000Z",
                    } satisfies OrchestrationShellSnapshot;
                  }),
              }),
            ),
          );

          expect(shellReads.count).toBe(0);
          expect(
            yield* Effect.promise(() =>
              pathExists(NodePath.join(baseDir, "userdata", "agent-dashboard")),
            ),
          ).toBe(false);
        }),
      (baseDir) => Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true })),
    ),
  );

  it.effect("resumes reconciliation and selection when re-enabled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-continuous-improvement-reenable-")),
      ),
      (baseDir) =>
        Effect.gen(function* () {
          const findingsPath = NodePath.join(
            baseDir,
            "userdata",
            "agent-dashboard",
            "findings.json",
          );
          const shellReads = { count: 0 };
          const implementationLaunches = { count: 0 };
          const settingsState: { value: ServerSettingsValue } = {
            value: {
              ...DEFAULT_SERVER_SETTINGS,
              continuousImprovement: {
                ...DEFAULT_SERVER_SETTINGS.continuousImprovement,
                enabled: false,
              },
            } satisfies ServerSettingsValue,
          };
          const projectShell = {
            ...project("alpha"),
            workspaceRoot: process.cwd(),
          } satisfies OrchestrationProjectShell;

          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.dirname(findingsPath), { recursive: true }),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              findingsPath,
              JSON.stringify({ findings: [finding("eligible", "alpha")] }),
            ),
          );

          yield* Effect.gen(function* () {
            const service = yield* AgentDashboardContinuousImprovement;
            expect(yield* service.runOnce).toBeNull();
            expect(shellReads.count).toBe(0);

            settingsState.value = {
              ...settingsState.value,
              continuousImprovement: {
                ...settingsState.value.continuousImprovement,
                enabled: true,
              },
            };

            expect(yield* service.runOnce).toBeNull();
          }).pipe(
            Effect.scoped,
            Effect.provide(
              makeContinuousImprovementTestLayer({
                baseDir,
                settings: makeSettingsService(() => settingsState.value),
                getShellSnapshot: () =>
                  Effect.sync(() => {
                    shellReads.count += 1;
                    return {
                      snapshotSequence: shellReads.count,
                      projects: [projectShell],
                      threads: [],
                      updatedAt: "2026-09-07T00:00:00.000Z",
                    } satisfies OrchestrationShellSnapshot;
                  }),
                runFinding: () =>
                  Effect.sync(() => {
                    implementationLaunches.count += 1;
                    return null;
                  }),
              }),
            ),
          );

          expect(shellReads.count).toBe(2);
          expect(implementationLaunches.count).toBe(1);
        }),
      (baseDir) => Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true })),
    ),
  );
});

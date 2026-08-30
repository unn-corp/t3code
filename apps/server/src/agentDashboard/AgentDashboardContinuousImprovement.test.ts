import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ThreadId,
  type AgentDashboardFinding,
  type AgentDashboardRepositoryPolicy,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import {
  CONTINUOUS_IMPROVEMENT_RUN_KIND,
  createContinuousImprovementRun,
  evaluateImplementationWatchdog,
  findImplementationStaleOutcome,
  findImplementationPullRequest,
  hasActiveFindingImplementation,
  isFindingEligibleForContinuousImprovement,
  resolveContinuousImprovementRecovery,
  selectContinuousImprovementFinding,
  transitionContinuousImprovementRun,
} from "./AgentDashboardContinuousImprovement.ts";

it("finds the pull request after an implementation agent renames its branch", () => {
  const pullRequest = findImplementationPullRequest({
    pullRequests: [
      { number: 201, headRefName: "t3code/optimize-cursor-search-counts" },
      { number: 200, headRefName: "t3code/other-work" },
    ],
    launchBranch: "t3code/ddaab7c1",
    currentBranch: "t3code/optimize-cursor-search-counts",
  });

  expect(pullRequest?.number).toBe(201);
});

it("falls back to the launch branch while the projected branch is unavailable", () => {
  const pullRequest = findImplementationPullRequest({
    pullRequests: [{ number: 200, headRefName: "t3code/e966c90d" }],
    launchBranch: "t3code/e966c90d",
    currentBranch: null,
  });

  expect(pullRequest?.number).toBe(200);
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
      targets: [
        {
          path: "src/example.ts",
          symbol: "implementIt",
          evidence: "The implementation belongs in this bounded function.",
        },
      ],
      validationPlan: ["Run focused tests."],
      sources: [],
      riskTier: "medium",
      estimatedEffort: "medium",
      qualificationReason: "The change is bounded and locally testable.",
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
    expect(
      isFindingEligibleForContinuousImprovement(
        finding("under-specified", "alpha", {
          actionability: {
            ...finding("base", "alpha").actionability!,
            targets: [],
          },
        }),
        { maxRiskTier: "medium", minimumConfidence: "medium" },
      ),
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

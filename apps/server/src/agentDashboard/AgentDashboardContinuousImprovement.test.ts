import { describe, expect, it } from "@effect/vitest";
import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type AgentDashboardFinding,
  type AgentDashboardRepositoryPolicy,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import {
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
} from "./AgentDashboardContinuousImprovement.ts";

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
      qualifiedBy: "human",
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
  it("does not select a finding qualified only by the review model", () => {
    expect(
      selectContinuousImprovementFinding({
        projects: [project("alpha")],
        policies: [],
        findings: [
          finding("review-qualified", "alpha", {
            actionability: {
              ...finding("review-qualified", "alpha").actionability!,
              qualifiedBy: "repository-review",
            },
          }),
        ],
      }),
    ).toBeNull();
  });

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

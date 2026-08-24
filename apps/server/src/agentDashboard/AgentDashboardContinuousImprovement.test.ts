import { describe, expect, it } from "@effect/vitest";
import {
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
  hasActiveFindingImplementation,
  isFindingEligibleForContinuousImprovement,
  selectContinuousImprovementFinding,
  transitionContinuousImprovementRun,
} from "./AgentDashboardContinuousImprovement.ts";

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
  expect(hasActiveFindingImplementation([linked], [])).toBe(false);
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

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AgentDashboardDispositionActionInput,
  AgentDashboardFinding,
  AgentDashboardMutationResult,
  AgentDashboardSnapshot,
} from "./agentDashboard.ts";
import {
  SourceControlMergeProjectPullRequestInput,
  SourceControlProjectPullRequestsResult,
} from "./sourceControl.ts";

const decodeSnapshot = Schema.decodeUnknownSync(AgentDashboardSnapshot);
const decodeMutationResult = Schema.decodeUnknownSync(AgentDashboardMutationResult);
const decodeFinding = Schema.decodeUnknownSync(AgentDashboardFinding);
const decodeDispositionAction = Schema.decodeUnknownSync(AgentDashboardDispositionActionInput);
const decodeProjectPullRequests = Schema.decodeUnknownSync(SourceControlProjectPullRequestsResult);
const decodePullRequestMerge = Schema.decodeUnknownSync(SourceControlMergeProjectPullRequestInput);

describe("Agent Dashboard pull requests", () => {
  it("decodes project-scoped review and merge signals", () => {
    const result = decodeProjectPullRequests({
      projectId: "project-1",
      provider: "github",
      repository: "pingdotgg/t3code",
      pullRequests: [
        {
          number: 42,
          title: "Add project PR workspace",
          url: "https://github.com/pingdotgg/t3code/pull/42",
          baseRefName: "main",
          headRefName: "feature/pr-workspace",
          headRefOid: "abcdef123456abcdef123456abcdef123456abcd",
          authorLogin: "octocat",
          isDraft: false,
          mergeState: "ready",
          reviewDecision: "approved",
          checkStatus: "passing",
          canMerge: true,
          mergeBlockedReason: null,
          updatedAt: "2026-08-22T12:00:00.000Z",
        },
      ],
    });
    expect(result.pullRequests[0]?.canMerge).toBe(true);

    const merge = decodePullRequestMerge({
      projectId: "project-1",
      number: 42,
      expectedHeadOid: "abcdef123456abcdef123456abcdef123456abcd",
      method: "squash",
    });
    expect(merge.expectedHeadOid).toBe("abcdef123456abcdef123456abcdef123456abcd");
  });
});

describe("AgentDashboardSnapshot", () => {
  it("decodes repository status, worktrees, and agent associations", () => {
    const snapshot = decodeSnapshot({
      snapshotSequence: 12,
      observedAt: "2026-08-09T12:00:00.000Z",
      repositories: [
        {
          projectId: "project-1",
          title: "T3 Code",
          workspaceRoot: "/workspace/t3code",
          repositoryIdentity: {
            canonicalKey: "github.com/pingdotgg/t3code",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/pingdotgg/t3code.git",
            },
            rootPath: "/workspace/t3code",
            provider: "github",
            owner: "pingdotgg",
            name: "t3code",
          },
          vcs: {
            availability: "available",
            isRepo: true,
            state: "dirty",
            branch: "feature/dashboard",
            defaultBranch: "main",
            isDefaultBranch: false,
            hasUpstream: true,
            aheadCount: 2,
            behindCount: 1,
            aheadOfDefaultCount: 2,
          },
          threads: [],
          worktrees: [
            {
              path: "/workspace/t3code/.t3/worktrees/dashboard",
              branch: "feature/dashboard",
              threads: [
                {
                  threadId: "thread-1",
                  title: "Build dashboard",
                  model: "gpt-5-codex",
                  branch: "feature/dashboard",
                  worktreePath: "/workspace/t3code/.t3/worktrees/dashboard",
                  agent: {
                    providerName: "codex",
                    providerInstanceId: "codex",
                    status: "running",
                    activeTurnId: "turn-1",
                    updatedAt: "2026-08-09T11:59:00.000Z",
                  },
                  updatedAt: "2026-08-09T11:59:00.000Z",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(snapshot.repositories[0]?.vcs.behindCount).toBe(1);
    expect(snapshot.repositories[0]?.worktrees[0]?.threads[0]?.agent?.status).toBe("running");
    expect(snapshot.feed).toEqual([]);
    expect(snapshot.research).toEqual([]);
    expect(snapshot.suggestions).toEqual([]);
    // Canonical collections default empty so older snapshots keep decoding.
    expect(snapshot.automationRuns).toEqual([]);
    expect(snapshot.findings).toEqual([]);
    expect(snapshot.repositoryPolicies).toEqual([]);
    expect(snapshot.repositoryCoverage).toEqual([]);
    expect(snapshot.externalActions).toEqual([]);
  });

  it("decodes native feed, research, and actionable suggestion records", () => {
    const snapshot = decodeSnapshot({
      snapshotSequence: 13,
      observedAt: "2026-08-09T12:01:00.000Z",
      repositories: [],
      feed: [
        {
          id: "activity:event-1",
          kind: "activity",
          status: "running",
          summary: "Running tests",
          occurredAt: "2026-08-09T12:00:59.000Z",
          repository: { projectId: "project-1" },
          thread: { projectId: "project-1", threadId: "thread-1" },
          activityId: "event-1",
          activityKind: "tool.started",
          turnId: "turn-1",
        },
      ],
      research: [
        {
          id: "repository:project-1",
          kind: "repository",
          status: "dirty",
          title: "T3 Code",
          summary: "Working tree has local changes",
          observedAt: "2026-08-09T12:00:58.000Z",
          repository: { projectId: "project-1" },
          branch: "feature/dashboard",
          defaultBranch: "main",
          worktreePath: null,
          threadCount: 1,
          activeThreadCount: 1,
          latestThread: { projectId: "project-1", threadId: "thread-1" },
        },
      ],
      suggestions: [
        {
          id: "repository:project-1:review-changes",
          kind: "review-changes",
          status: "actionable",
          action: "open-repository",
          title: "Review local changes",
          summary: "T3 Code has working-tree changes to inspect",
          updatedAt: "2026-08-09T12:00:58.000Z",
          repository: { projectId: "project-1" },
          thread: null,
        },
      ],
    });

    expect(snapshot.feed[0]?.thread?.threadId).toBe("thread-1");
    expect(snapshot.research[0]?.status).toBe("dirty");
    expect(snapshot.research[0]?.latestThread?.threadId).toBe("thread-1");
    expect(snapshot.suggestions[0]?.action).toBe("open-repository");
  });

  it("decodes the migrated durable feed and finding records", () => {
    const snapshot = decodeSnapshot({
      snapshotSequence: 14,
      observedAt: "2026-08-09T12:02:00.000Z",
      repositories: [],
      externalFeed: [
        {
          id: 42,
          ts: 1_754_743_200,
          agent: "research-agent",
          kind: "finding",
          title: "New release",
          text: "A useful upstream change was found.",
          imageUrl: null,
          level: "success",
          tags: ["release"],
          actions: [{ label: "Open source", url: "https://example.com/release" }],
          origin: {
            projectId: "project-1",
            projectName: "T3 Code",
            projectPath: "/workspace/t3code",
            threadId: "thread-1",
          },
        },
      ],
      researchFindings: [
        {
          id: "arxiv:1234",
          title: "A useful paper",
          source: "arxiv",
          url: "https://arxiv.org/abs/1234",
          timestamp: "2026-08-09T12:01:00.000Z",
          abstract: "A concise abstract.",
          authors: ["Author"],
          published: "2026-08-01",
          categories: ["cs.SE"],
          relevanceScore: 91,
          topicContext: "repository research",
          repositories: ["t3code"],
          watchDir: "/workspace/t3code",
          sinceDays: 30,
          pdfUrl: "https://arxiv.org/pdf/1234",
          citationCount: 3,
          occurrences: 1,
        },
      ],
    });

    expect(snapshot.externalFeed[0]?.actions[0]?.label).toBe("Open source");
    expect(snapshot.externalFeed[0]?.origin).toEqual({
      projectId: "project-1",
      projectName: "T3 Code",
      projectPath: "/workspace/t3code",
      threadId: "thread-1",
    });
    expect(snapshot.researchFindings[0]?.relevanceScore).toBe(91);
    expect(snapshot.researchFindings[0]?.repositories).toEqual(["t3code"]);
    expect(snapshot.reviewSuggestions).toEqual([]);
    expect(snapshot.findings).toEqual([]);
  });

  it("decodes canonical automation runs, findings, policy, coverage, and external actions", () => {
    const snapshot = decodeSnapshot({
      snapshotSequence: 15,
      observedAt: "2026-08-10T12:00:00.000Z",
      repositories: [],
      automationRuns: [
        {
          id: "run-1",
          status: "ingesting",
          trigger: "scheduled",
          kind: "repository-review",
          repository: { projectId: "project-1" },
          target: "main",
          threadId: "thread-review-1",
          jobId: "job-abc",
          model: "gpt-5-codex",
          retryCount: 0,
          findingCount: 1,
          costUnits: 12,
          error: null,
          createdAt: "2026-08-10T11:58:00.000Z",
          startedAt: "2026-08-10T11:58:05.000Z",
          updatedAt: "2026-08-10T11:59:30.000Z",
          completedAt: null,
        },
        {
          id: "run-2",
          status: "failed",
          trigger: "manual",
          kind: "repository-review",
          repository: { projectId: "project-1" },
          target: null,
          threadId: null,
          jobId: null,
          model: null,
          retryCount: 1,
          findingCount: 0,
          costUnits: null,
          error: "parse failure",
          createdAt: "2026-08-10T10:00:00.000Z",
          startedAt: "2026-08-10T10:00:01.000Z",
          updatedAt: "2026-08-10T10:05:00.000Z",
          completedAt: "2026-08-10T10:05:00.000Z",
        },
      ],
      findings: [
        {
          id: "finding-1",
          fingerprint: "repo:project-1|kind:review|title:missing-tests|evidence:src/foo.ts",
          kind: "review",
          title: "Missing tests for foo",
          summary: "src/foo.ts has no unit coverage for the error path.",
          severity: "medium",
          confidence: "high",
          category: "testing",
          evidence: ["src/foo.ts:42 handleError"],
          repository: { projectId: "project-1" },
          repositoryPath: "/workspace/t3code",
          disposition: {
            state: "open",
            updatedAt: "2026-08-10T11:59:30.000Z",
            actor: null,
            note: null,
            snoozeUntil: null,
            assignee: null,
          },
          provenance: {
            source: "code_review",
            sourceAt: "2026-08-10T11:59:00.000Z",
            collectedAt: "2026-08-10T11:59:30.000Z",
          },
          firstSeenAt: "2026-08-09T09:00:00.000Z",
          lastSeenAt: "2026-08-10T11:59:30.000Z",
          occurrenceCount: 2,
          lastRunId: "run-1",
          thread: { projectId: "project-1", threadId: "thread-review-1" },
          externalIssueUrl: null,
          actionability: {
            readiness: "ready",
            proposal: "Add focused error-path coverage.",
            expectedValue: "Prevent regressions in failed requests.",
            targets: [
              {
                path: "src/foo.ts",
                symbol: "handleError",
                evidence: "The error branch has no assertion.",
              },
            ],
            validationPlan: ["Run the focused foo unit tests."],
            sources: [
              {
                title: "Upstream error-handling guidance",
                url: "https://example.com/error-handling",
                kind: "documentation",
              },
            ],
          },
        },
      ],
      repositoryPolicies: [
        {
          repository: { projectId: "project-1" },
          enabled: true,
          cadenceMinutes: 120,
          priority: 10,
          riskTier: "high",
          branch: "main",
          owner: "platform",
          enabledChecks: ["repository-review", "security"],
          model: "gpt-5-codex",
          budgetMinutes: 30,
          maxConcurrentRuns: 1,
          exclusions: ["vendor/**"],
          updatedAt: "2026-08-10T08:00:00.000Z",
        },
      ],
      repositoryCoverage: [
        {
          repository: { projectId: "project-1" },
          status: "due",
          lastAttemptedAt: "2026-08-10T11:58:00.000Z",
          lastSucceededAt: "2026-08-09T12:00:00.000Z",
          nextDueAt: "2026-08-10T14:00:00.000Z",
          consecutiveFailures: 0,
          lastError: null,
          lastRunId: "run-1",
          observedAt: "2026-08-10T12:00:00.000Z",
        },
      ],
      externalActions: [
        {
          id: "action-1",
          kind: "create-github-issue",
          status: "succeeded",
          actor: "user@example.com",
          targetId: "42",
          targetUrl: "https://github.com/pingdotgg/t3code/issues/42",
          findingId: "finding-1",
          runId: "run-1",
          result: "created",
          occurredAt: "2026-08-10T12:00:00.000Z",
        },
      ],
    });

    expect(snapshot.automationRuns).toHaveLength(2);
    expect(snapshot.automationRuns[0]?.status).toBe("ingesting");
    expect(snapshot.automationRuns[0]?.jobId).toBe("job-abc");
    expect(snapshot.automationRuns[1]?.status).toBe("failed");
    expect(snapshot.findings[0]?.fingerprint).toBe(
      "repo:project-1|kind:review|title:missing-tests|evidence:src/foo.ts",
    );
    expect(snapshot.findings[0]?.fingerprint).not.toContain("job-abc");
    expect(snapshot.findings[0]?.fingerprint).not.toContain("run-1");
    expect(snapshot.findings[0]?.disposition.state).toBe("open");
    expect(snapshot.findings[0]?.type).toBe("review");
    expect(snapshot.findings[0]?.provenance.collectedAt).toBe("2026-08-10T11:59:30.000Z");
    expect(snapshot.findings[0]?.actionability?.readiness).toBe("ready");
    expect(snapshot.findings[0]?.actionability?.targets[0]?.path).toBe("src/foo.ts");
    expect(snapshot.findings[0]?.actionability).toMatchObject({
      riskTier: "medium",
      estimatedEffort: "medium",
      qualificationReason: null,
      qualifiedAt: null,
      qualifiedBy: null,
      qualifiedOccurrenceCount: 0,
    });
    expect(snapshot.repositoryPolicies[0]?.cadenceMinutes).toBe(120);
    expect(snapshot.repositoryCoverage[0]?.status).toBe("due");
    expect(snapshot.externalActions[0]?.kind).toBe("create-github-issue");
  });

  it("decodes every automation run lifecycle status", () => {
    const statuses = [
      "queued",
      "running",
      "ingesting",
      "succeeded",
      "partial",
      "failed",
      "cancelled",
    ] as const;

    const snapshot = decodeSnapshot({
      snapshotSequence: 16,
      observedAt: "2026-08-10T12:01:00.000Z",
      repositories: [],
      automationRuns: statuses.map((status, index) => ({
        id: `run-${status}`,
        status,
        trigger: index % 2 === 0 ? "manual" : "scheduled",
        kind: "repository-review",
        repository: { projectId: "project-1" },
        target: null,
        threadId: null,
        jobId: null,
        model: null,
        retryCount: 0,
        findingCount: status === "succeeded" || status === "partial" ? 1 : 0,
        costUnits: null,
        error: status === "failed" ? "timeout" : null,
        createdAt: "2026-08-10T12:00:00.000Z",
        startedAt: status === "queued" ? null : "2026-08-10T12:00:01.000Z",
        updatedAt: "2026-08-10T12:00:30.000Z",
        completedAt:
          status === "succeeded" ||
          status === "partial" ||
          status === "failed" ||
          status === "cancelled"
            ? "2026-08-10T12:00:30.000Z"
            : null,
      })),
    });

    expect(snapshot.automationRuns.map((run) => run.status)).toEqual([...statuses]);
  });
});

describe("AgentDashboardMutationResult", () => {
  it("preserves legacy { ok } payloads with applied defaults", () => {
    expect(decodeMutationResult({ ok: true })).toEqual({
      ok: true,
      outcome: "applied",
      message: null,
      targetId: null,
      targetUrl: null,
    });
    expect(decodeMutationResult({ ok: false })).toEqual({
      ok: false,
      outcome: "applied",
      message: null,
      targetId: null,
      targetUrl: null,
    });
  });

  it("decodes truthful outcomes for applied, missing, and failed mutations", () => {
    expect(
      decodeMutationResult({
        ok: true,
        outcome: "applied",
        message: "Dismissed finding",
        targetId: "finding-1",
        targetUrl: null,
      }),
    ).toMatchObject({ ok: true, outcome: "applied", targetId: "finding-1" });

    expect(
      decodeMutationResult({
        ok: false,
        outcome: "not-found",
        message: "Finding no longer exists",
        targetId: "finding-missing",
        targetUrl: null,
      }),
    ).toMatchObject({ ok: false, outcome: "not-found" });

    expect(
      decodeMutationResult({
        ok: false,
        outcome: "failed",
        message: "GitHub API unavailable",
        targetId: "finding-1",
        targetUrl: null,
      }),
    ).toMatchObject({ ok: false, outcome: "failed" });

    expect(
      decodeMutationResult({
        ok: true,
        outcome: "noop",
        message: "Already dismissed",
        targetId: "finding-1",
        targetUrl: null,
      }),
    ).toMatchObject({ ok: true, outcome: "noop" });
  });
});

describe("AgentDashboardFinding fingerprint", () => {
  it("requires a fingerprint independent of job identity", () => {
    const finding = decodeFinding({
      id: "finding-stable",
      fingerprint: "repo:project-1|kind:security|title:secret-in-config",
      kind: "security",
      title: "Secret in config",
      summary: "Hard-coded credential in config.yaml",
      severity: "critical",
      confidence: "high",
      category: "secrets",
      evidence: ["config.yaml:12"],
      repository: { projectId: "project-1" },
      repositoryPath: null,
      disposition: {
        state: "acknowledged",
        updatedAt: "2026-08-10T12:00:00.000Z",
        actor: "reviewer",
        note: null,
        snoozeUntil: null,
        assignee: null,
      },
      provenance: {
        source: "secret-scanning",
        sourceAt: "2026-08-10T11:00:00.000Z",
        collectedAt: "2026-08-10T11:05:00.000Z",
      },
      firstSeenAt: "2026-08-10T11:05:00.000Z",
      lastSeenAt: "2026-08-10T12:00:00.000Z",
      occurrenceCount: 1,
      lastRunId: "run-other",
      thread: null,
      externalIssueUrl: null,
    });

    expect(finding.fingerprint.includes("job")).toBe(false);
    expect(finding.lastRunId).toBe("run-other");
    expect(finding.disposition.state).toBe("acknowledged");
  });
});

describe("AgentDashboardDispositionActionInput", () => {
  it("decodes reversible disposition actions", () => {
    expect(
      decodeDispositionAction({
        id: "finding-1",
        action: "approve",
      }),
    ).toMatchObject({ action: "approve" });

    expect(
      decodeDispositionAction({
        id: "finding-1",
        action: "complete",
      }),
    ).toMatchObject({ action: "complete" });

    expect(
      decodeDispositionAction({
        id: "finding-1",
        action: "snooze",
        snoozeUntil: "2026-08-11T12:00:00.000Z",
      }),
    ).toMatchObject({ action: "snooze", snoozeUntil: "2026-08-11T12:00:00.000Z" });

    expect(
      decodeDispositionAction({
        id: "finding-1",
        action: "reopen",
      }),
    ).toMatchObject({ action: "reopen" });

    expect(
      decodeDispositionAction({
        id: "finding-1",
        action: "assign",
        assignee: "alice",
        note: "Owns this area",
      }),
    ).toMatchObject({ action: "assign", assignee: "alice" });
  });
});

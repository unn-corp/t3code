import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentDashboardFeedCard,
  type AgentDashboardSnapshot,
} from "@t3tools/contracts";

import {
  buildNativeAgentFeedFromDurableCards,
  buildNativeReviewSuggestionsFromSnapshot,
  buildSuggestionWorkPrompt,
  compareDashboardRecency,
} from "./agentDashboardPages";

describe("agent dashboard ordering", () => {
  it("sorts the most recent record first", () => {
    const records = [
      { id: "older", updatedAt: "2026-08-09T12:00:00.000Z" },
      { id: "newer", updatedAt: "2026-08-09T12:05:00.000Z" },
      { id: "middle", updatedAt: "2026-08-09T12:03:00.000Z" },
    ];

    expect(records.toSorted(compareDashboardRecency).map((record) => record.id)).toEqual([
      "newer",
      "middle",
      "older",
    ]);
  });

  it("uses a stable id tie-breaker when timestamps match", () => {
    const records = [
      { id: "agent-a", updatedAt: "2026-08-09T12:00:00.000Z" },
      { id: "agent-c", updatedAt: "2026-08-09T12:00:00.000Z" },
      { id: "agent-b", updatedAt: "2026-08-09T12:00:00.000Z" },
    ];

    expect(records.toSorted(compareDashboardRecency).map((record) => record.id)).toEqual([
      "agent-c",
      "agent-b",
      "agent-a",
    ]);
  });
});

describe("durable agent feed origins", () => {
  it("resolves a card to its project and source chat", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const card: AgentDashboardFeedCard = {
      id: 1,
      ts: Date.parse("2026-08-09T12:05:00.000Z") / 1_000,
      agent: "codex",
      kind: "activity",
      title: "Tests finished",
      text: "The focused test suite passed.",
      imageUrl: null,
      level: "success",
      tags: ["tests"],
      actions: [],
      origin: {
        projectId,
        projectName: null,
        projectPath: "/workspace/t3code",
        threadId,
      },
    };
    const records = buildNativeAgentFeedFromDurableCards(
      [card],
      environmentId,
      [
        {
          environmentId,
          id: projectId,
          title: "T3 Code",
          workspaceRoot: "/workspace/t3code",
        },
      ],
      [
        {
          environmentId,
          id: threadId,
          projectId,
          title: "Agent feed work",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          branch: "feature/feed-origin",
          worktreePath: null,
          updatedAt: "2026-08-09T12:04:00.000Z",
          archivedAt: null,
        },
      ],
    );

    expect(records[0]).toMatchObject({
      projectId,
      projectName: "T3 Code",
      workspaceRoot: "/workspace/t3code",
      threadId,
      branch: "feature/feed-origin",
      provider: "codex",
      model: "gpt-5",
      chatLabel: "Open chat",
    });
  });

  it("uses a matching worktree path when a producer has no thread id", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const records = buildNativeAgentFeedFromDurableCards(
      [
        {
          id: 2,
          ts: Date.parse("2026-08-09T12:05:00.000Z") / 1_000,
          agent: "hermes",
          kind: "activity",
          title: "Worktree update",
          text: "The producer was launched from the active worktree.",
          imageUrl: null,
          level: "info",
          tags: [],
          actions: [],
          origin: {
            projectId: null,
            projectName: null,
            projectPath: "/workspace/t3code/.t3/worktrees/feed",
            threadId: null,
          },
        },
      ],
      environmentId,
      [
        {
          environmentId,
          id: projectId,
          title: "T3 Code",
          workspaceRoot: "/workspace/t3code",
        },
      ],
      [
        {
          environmentId,
          id: threadId,
          projectId,
          title: "Agent feed work",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes" },
          branch: "feature/feed-origin",
          worktreePath: "/workspace/t3code/.t3/worktrees/feed",
          updatedAt: "2026-08-09T12:04:00.000Z",
          archivedAt: null,
        },
      ],
    );

    expect(records[0]).toMatchObject({
      projectName: "T3 Code",
      projectId,
      threadId,
      chatLabel: "Open chat",
    });
  });
});

describe("agent dashboard suggestion actions", () => {
  it("builds an implementation prompt from the research finding", () => {
    const prompt = buildSuggestionWorkPrompt({
      repositoryPath: "/workspace/t3code",
      projectName: "T3 Code",
      category: "bug",
      title: "Handle stale repository metadata",
      description: "The refresh path leaves repository metadata stale.",
      report: "The metadata cache can remain stale after a repository refresh.",
      evidence: [
        "Refresh leaves the previous branch name visible.",
        "The cache has no invalidation path.",
      ],
      nextStep: "Invalidate the cache when the repository snapshot changes.",
    });

    expect(prompt).toContain("Repository: `/workspace/t3code`");
    expect(prompt).toContain("## Finding\nHandle stale repository metadata");
    expect(prompt).toContain("- Refresh leaves the previous branch name visible.");
    expect(prompt).toContain("## Recommended next step");
    expect(prompt).toContain("Run focused validation before you finish.");
  });

  it("does not render a migrated legacy suggestion twice after canonical ingestion", () => {
    const snapshot = {
      repositories: [
        {
          projectId: ProjectId.make("project-1"),
          title: "T3 Code",
          workspaceRoot: "/workspace/t3code",
        },
      ],
      suggestions: [],
      findings: [
        {
          id: "finding:abc",
          fingerprint: "finding:abc",
          kind: "review",
          title: "A canonical review finding",
          summary: "The same finding was normalized from a legacy review.",
          severity: "medium",
          confidence: "high",
          category: "bug",
          evidence: ["src/example.ts:10"],
          repository: { projectId: ProjectId.make("project-1") },
          repositoryPath: "/workspace/t3code",
          disposition: {
            state: "open",
            updatedAt: "2026-08-09T12:00:00.000Z",
            actor: null,
            note: null,
            snoozeUntil: null,
            assignee: null,
          },
          provenance: {
            source: "code_review",
            sourceAt: "2026-08-09T12:00:00.000Z",
            collectedAt: "2026-08-09T12:00:00.000Z",
          },
          firstSeenAt: "2026-08-09T12:00:00.000Z",
          lastSeenAt: "2026-08-09T12:00:00.000Z",
          occurrenceCount: 1,
          lastRunId: "run-1",
          thread: null,
          externalIssueUrl: null,
        },
      ],
      reviewSuggestions: [
        {
          id: "t3-review-abc",
          profile: "t3-random-codebase-review",
          title: "A canonical review finding",
          description: "The same finding was normalized from a legacy review.",
          source: "code_review",
          status: "pending",
          createdAt: "2026-08-09T12:00:00.000Z",
          expiresAt: null,
          repository: {
            name: "T3 Code",
            path: "/workspace/t3code",
            githubRepo: null,
          },
          category: "bug",
          impact: "medium",
          confidence: "high",
          evidence: ["src/example.ts:10"],
          nextStep: "Verify the finding.",
          report: "The same finding was normalized from a legacy review.",
          githubIssue: {
            title: "A canonical review finding",
            body: "The same finding was normalized from a legacy review.",
            url: null,
            number: null,
          },
          jobId: "run-1",
        },
      ],
    } as unknown as AgentDashboardSnapshot;

    const suggestions = buildNativeReviewSuggestionsFromSnapshot(snapshot, "environment-1");

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.findingId).toBe("finding:abc");
  });
});

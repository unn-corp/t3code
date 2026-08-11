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
  it("only adapts code-review results that have an individual run id", () => {
    const snapshot = {
      snapshotSequence: 1,
      observedAt: "2026-08-09T12:00:00.000Z",
      repositories: [],
      feed: [],
      externalFeed: [],
      research: [],
      researchFindings: [],
      suggestions: [
        {
          id: "thread:random:respond",
          kind: "respond-to-thread",
          status: "actionable",
          action: "open-thread",
          title: "Respond to an agent",
          summary: "This is native thread state, not a review result.",
          updatedAt: "2026-08-09T12:00:00.000Z",
          repository: { projectId: ProjectId.make("project-1") },
          thread: null,
        },
        {
          id: "repository:project-1:review-changes",
          kind: "review-changes",
          status: "actionable",
          action: "open-repository",
          title: "Review local changes",
          summary: "Operational repository state, not investigative reporting.",
          updatedAt: "2026-08-09T12:00:01.000Z",
          repository: { projectId: ProjectId.make("project-1") },
          thread: null,
        },
        {
          id: "repository:project-1:sync-branch",
          kind: "sync-branch",
          status: "actionable",
          action: "open-repository",
          title: "Sync from remote",
          summary: "Operational repository state, not investigative reporting.",
          updatedAt: "2026-08-09T12:00:02.000Z",
          repository: { projectId: ProjectId.make("project-1") },
          thread: null,
        },
      ],
      reviewSuggestions: [
        {
          id: "review-run-result",
          profile: "t3-random-codebase-review",
          title: "A real review finding",
          description: "Produced by one repository review run.",
          source: "code_review",
          status: "pending",
          createdAt: "2026-08-09T12:00:00.000Z",
          expiresAt: null,
          repository: { name: "T3 Code", path: "/workspace/t3code", githubRepo: null },
          category: "bug",
          impact: "high",
          confidence: "high",
          evidence: ["src/example.ts:1"],
          nextStep: "Fix it.",
          report: "The report.",
          githubIssue: { title: "Fix it", body: "The report.", url: null, number: null },
          jobId: "review-thread-1",
        },
        {
          id: "legacy-code-review",
          profile: null,
          title: "Legacy review record",
          description: "Older code-review content without T3 run provenance.",
          source: "code_review",
          status: "pending",
          createdAt: "2026-08-09T12:00:30.000Z",
          expiresAt: null,
          repository: { name: "T3 Code", path: "/workspace/t3code", githubRepo: null },
          category: "bug",
          impact: "high",
          confidence: "high",
          evidence: ["src/legacy.ts:1"],
          nextStep: "Ignore it.",
          report: "This legacy record must stay out of Suggestions.",
          githubIssue: { title: "Legacy", body: "Legacy.", url: null, number: null },
          jobId: "legacy-hermes-run",
        },
        {
          id: "native-signal",
          profile: null,
          title: "Native signal",
          description: "Not a code review result.",
          source: "agent_activity",
          status: "pending",
          createdAt: "2026-08-09T12:01:00.000Z",
          expiresAt: null,
          repository: { name: "T3 Code", path: "/workspace/t3code", githubRepo: null },
          category: "insight",
          impact: "medium",
          confidence: "medium",
          evidence: [],
          nextStep: "Ignore it.",
          report: "Not owned by Suggestions.",
          githubIssue: { title: "Native signal", body: "Not a review.", url: null, number: null },
          jobId: "native-run",
        },
        {
          id: "unscoped-review",
          profile: null,
          title: "Unscoped review",
          description: "No individual run id.",
          source: "code_review",
          status: "pending",
          createdAt: "2026-08-09T12:02:00.000Z",
          expiresAt: null,
          repository: { name: "T3 Code", path: "/workspace/t3code", githubRepo: null },
          category: "insight",
          impact: "medium",
          confidence: "medium",
          evidence: [],
          nextStep: "Ignore it.",
          report: "Not a run result.",
          githubIssue: { title: "Unscoped", body: "Not a run.", url: null, number: null },
          jobId: null,
        },
      ],
    } satisfies AgentDashboardSnapshot;

    expect(buildNativeReviewSuggestionsFromSnapshot(snapshot, "environment-1")).toMatchObject([
      { id: "review-run-result", projectId: "/workspace/t3code" },
    ]);
  });

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
});

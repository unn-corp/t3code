import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AgentDashboardSnapshot } from "./agentDashboard.ts";

const decodeSnapshot = Schema.decodeUnknownSync(AgentDashboardSnapshot);

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
  });
});

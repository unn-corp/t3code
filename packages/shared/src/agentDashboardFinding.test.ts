import { expect, it } from "@effect/vitest";
import { ProjectId, type AgentDashboardFinding } from "@t3tools/contracts";

import { buildAgentDashboardFindingPrompt } from "./agentDashboardFinding.ts";

const finding = {
  id: "finding-draft-delivery",
  fingerprint: "fingerprint-draft-delivery",
  type: "improvement",
  kind: "engineering",
  title: "Keep automated pull requests in draft",
  summary: "Automated work should wait for user review before entering the active review queue.",
  severity: "medium",
  confidence: "high",
  category: "automation",
  evidence: ["Automated pull requests currently open as ready for review."],
  repository: { projectId: ProjectId.make("project-draft-delivery") },
  repositoryPath: "/workspace/project-draft-delivery",
  disposition: {
    state: "open",
    updatedAt: "2026-08-23T12:00:00.000Z",
    actor: "repository-review",
    note: null,
    snoozeUntil: null,
    assignee: null,
  },
  provenance: {
    source: "repository-review",
    sourceAt: "2026-08-23T12:00:00.000Z",
    collectedAt: "2026-08-23T12:00:00.000Z",
  },
  firstSeenAt: "2026-08-23T12:00:00.000Z",
  lastSeenAt: "2026-08-23T12:00:00.000Z",
  occurrenceCount: 1,
  lastRunId: null,
  thread: null,
  externalIssueUrl: null,
  actionability: null,
} satisfies AgentDashboardFinding;

it("requires implementation agents to open pull requests as drafts", () => {
  const prompt = buildAgentDashboardFindingPrompt(
    {
      finding,
      type: finding.type,
      projectName: "Draft Delivery",
      repositoryPath: "/workspace/project-draft-delivery",
    },
    { kind: "implement", baseBranch: "main" },
  );

  expect(prompt).toContain("Open one draft pull request targeting `main`");
  expect(prompt).toContain("gh pr create --draft");
  expect(prompt).toContain(
    "Leave the pull request in draft until a user explicitly marks it ready",
  );
  expect(prompt).toContain("the draft pull request is open");
});

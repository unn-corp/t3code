import { expect, it } from "@effect/vitest";
import { ProjectId, type AgentDashboardFinding } from "@t3tools/contracts";

import {
  buildAgentDashboardFindingPrompt,
  parseAgentDashboardStaleOutcome,
} from "./agentDashboardFinding.ts";

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

it("gives stale findings a structured completion path without repository delivery", () => {
  const prompt = buildAgentDashboardFindingPrompt(
    {
      finding,
      type: finding.type,
      projectName: "Draft Delivery",
      repositoryPath: "/workspace/project-draft-delivery",
    },
    { kind: "implement", baseBranch: "main" },
  );

  expect(prompt).toContain("T3_FINDING_OUTCOME: stale");
  expect(prompt).toContain("T3_FINDING_REASON: <one-line reason>");
  expect(prompt).toContain("do not commit, push, or open a pull request");
  expect(prompt).toContain("T3 will dismiss the finding automatically");
});

it("parses only an explicit stale outcome with a reason", () => {
  expect(
    parseAgentDashboardStaleOutcome(
      "The code was removed upstream.\n\nT3_FINDING_OUTCOME: stale\nT3_FINDING_REASON: The affected module no longer exists.",
    ),
  ).toEqual({ reason: "The affected module no longer exists." });
  expect(parseAgentDashboardStaleOutcome("The finding may be stale or invalid.")).toBeNull();
  expect(parseAgentDashboardStaleOutcome("T3_FINDING_OUTCOME: stale")).toBeNull();
});

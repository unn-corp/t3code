import { describe, expect, it } from "@effect/vitest";

import { buildSuggestionWorkPrompt, compareDashboardRecency } from "./agentDashboardPages";

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
});

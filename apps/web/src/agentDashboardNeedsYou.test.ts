import { describe, expect, it } from "@effect/vitest";

import { buildDashboardNeedsYouItems, type DashboardNeedsYouInput } from "./agentDashboardNeedsYou";

const EMPTY_INPUT = {
  threads: [],
  feedInputRequests: [],
  findings: [],
  runs: [],
  coverage: [],
} as const satisfies DashboardNeedsYouInput;

describe("dashboard needs-you queue", () => {
  it("deduplicates a feed input request with its thread and promotes the actionable state", () => {
    const items = buildDashboardNeedsYouItems({
      ...EMPTY_INPUT,
      threads: [
        {
          environmentId: "environment-1",
          threadId: "thread-1",
          title: "Fix the dashboard",
          projectName: "T3 Code",
          state: "error",
          updatedAt: "2026-08-27T12:00:00.000Z",
        },
      ],
      feedInputRequests: [
        {
          environmentId: "environment-1",
          threadId: "thread-1",
          title: "Fallback title",
          projectName: "Fallback project",
          summary: "Approval is required before continuing",
          updatedAt: "2026-08-27T12:05:00.000Z",
        },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "thread",
      state: "needs-input",
      title: "Fix the dashboard",
      projectName: "T3 Code",
      reason: "Approval is required before continuing",
      actionLabel: "Respond",
    });
  });

  it("keeps feed-only requests actionable when they contain an exact thread reference", () => {
    const items = buildDashboardNeedsYouItems({
      ...EMPTY_INPUT,
      feedInputRequests: [
        {
          environmentId: "environment-1",
          threadId: "thread-2",
          title: "Choose an implementation",
          projectName: "Arcwright",
          summary: "The agent is waiting for a decision",
          updatedAt: "2026-08-27T12:00:00.000Z",
        },
        {
          environmentId: "environment-1",
          threadId: null,
          title: "Unaddressable aggregate",
          projectName: "Arcwright",
          summary: "No thread is attached",
          updatedAt: "2026-08-27T12:01:00.000Z",
        },
      ],
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: "thread",
        threadId: "thread-2",
        actionLabel: "Respond",
      }),
    ]);
  });

  it("routes each repository condition through its concrete cause without duplicate failed coverage", () => {
    const items = buildDashboardNeedsYouItems({
      ...EMPTY_INPUT,
      findings: [
        {
          id: "finding-critical",
          projectId: "project-1",
          projectName: "T3 Code",
          title: "Critical regression",
          severity: "critical",
          status: "open",
          updatedAt: "2026-08-27T12:00:00.000Z",
        },
        {
          id: "finding-high",
          projectId: "project-2",
          projectName: "Arcwright",
          title: "Important cleanup",
          severity: "high",
          status: "in-progress",
          updatedAt: "2026-08-27T11:00:00.000Z",
        },
      ],
      runs: [
        {
          id: "run-failed",
          projectId: "project-3",
          projectName: "Relay",
          title: "Relay automation failed",
          status: "failed",
          updatedAt: "2026-08-27T10:00:00.000Z",
        },
      ],
      coverage: [
        {
          projectId: "project-3",
          projectName: "Relay",
          status: "failing",
          lastRunId: "run-failed",
          lastError: "Collector exited early",
          updatedAt: "2026-08-27T10:00:00.000Z",
        },
        {
          projectId: "project-4",
          projectName: "Desktop",
          status: "overdue",
          lastRunId: null,
          lastError: null,
          updatedAt: "2026-08-27T09:00:00.000Z",
        },
      ],
    });

    expect(items.map((item) => [item.kind, item.key])).toEqual([
      ["finding", "finding:finding-critical"],
      ["run", "run:run-failed"],
      ["coverage", "coverage:project-4"],
      ["finding", "repository-findings:project-2"],
    ]);
  });
});

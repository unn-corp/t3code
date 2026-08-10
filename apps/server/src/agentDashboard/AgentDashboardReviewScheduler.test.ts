// @effect-diagnostics globalDate:off - schedule normalization is intentionally tested with fixed timestamps.
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import * as AgentDashboardReviewScheduler from "./AgentDashboardReviewScheduler.ts";

it("keeps the migrated review interval at two hours", () => {
  const now = Date.parse("2026-08-09T23:00:00.000Z");
  const schedule = AgentDashboardReviewScheduler.__testing.defaultSchedule(now);

  expect(AgentDashboardReviewScheduler.__testing.intervalMs).toBe(2 * 60 * 60 * 1_000);
  expect(schedule).toMatchObject({
    enabled: true,
    intervalMinutes: 120,
    nextRunAt: "2026-08-10T01:00:00.000Z",
    lastStatus: "idle",
  });
});

it("makes an interrupted T3 review due immediately after restart", () => {
  const schedule = AgentDashboardReviewScheduler.__testing.normalizeSchedule(
    {
      enabled: true,
      nextRunAt: "2026-08-10T01:00:00.000Z",
      lastStatus: "running",
      heartbeatAt: "2026-08-09T23:30:00.000Z",
      runCount: 2,
    },
    Date.parse("2026-08-10T00:00:00.000Z"),
  );

  expect(schedule).toMatchObject({
    lastStatus: "failed",
    nextRunAt: "2026-08-10T00:00:00.000Z",
    lastError: "T3 restarted before the repository review completed.",
  });
});

it.effect("parses the native metadata contract", () =>
  Effect.sync(() => {
    const findings = AgentDashboardReviewScheduler.__testing.parseReviewMetadata(
      [
        'T3_REVIEW_METADATA: {"findings":[{"title":"Parser bug","category":"bug","summary":"Drops the last item","impact":"Import loss","confidence":"high","evidence":["src/parser.ts:42"],"next_step":"Flush before return","github_issue_title":"Fix parser flush","github_issue_body":"## Problem"}]}',
        "# Random Codebase Review",
      ].join("\n"),
    );

    expect(findings).toEqual([
      {
        title: "Parser bug",
        category: "bug",
        summary: "Drops the last item",
        impact: "Import loss",
        confidence: "high",
        evidence: ["src/parser.ts:42"],
        nextStep: "Flush before return",
        githubIssueTitle: "Fix parser flush",
        githubIssueBody: "## Problem",
      },
    ]);
  }),
);

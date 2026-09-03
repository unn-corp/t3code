// @effect-diagnostics globalDate:off - fixed ISO timestamps keep cadence tests deterministic.
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationProjectShell,
  type SourceControlProjectPullRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  __testing,
  buildPullRequestRollupPrompt,
  filterPullRequestsForRollup,
} from "./AgentDashboardPullRequestRollup.ts";

const headOid = "1234567890abcdef1234567890abcdef12345678";

const pullRequest = (
  number: number,
  overrides: Partial<SourceControlProjectPullRequest> = {},
): SourceControlProjectPullRequest => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  baseRefName: "main",
  headRefName: `feature/pr-${number}`,
  headRefOid: headOid,
  authorLogin: "octocat",
  isDraft: false,
  mergeState: "ready",
  reviewDecision: "approved",
  checkStatus: "passing",
  canMerge: true,
  mergeBlockedReason: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const project = {
  id: ProjectId.make("project-1"),
  title: "Acme app",
  workspaceRoot: "/work/acme-app",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
} satisfies OrchestrationProjectShell;

describe("pull request rollup selection", () => {
  it("selects configured draft and ready PRs for the target branch", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS.pullRequestRollup,
      maximumPullRequests: 2,
    };
    const selected = filterPullRequestsForRollup({
      pullRequests: [
        pullRequest(1, { isDraft: true, updatedAt: "2026-08-03T00:00:00.000Z" }),
        pullRequest(2, { updatedAt: "2026-08-02T00:00:00.000Z" }),
        pullRequest(3, { baseRefName: "release" }),
        pullRequest(4, { headRefName: "pre-release/2026-08-04-abcdef12" }),
      ],
      settings,
      baseBranch: "main",
      nowMs: Date.parse("2026-08-10T00:00:00.000Z"),
    });

    expect(selected.map(({ number }) => number)).toEqual([2, 1]);
  });

  it("honors draft, ready, and inactivity filters", () => {
    const selected = filterPullRequestsForRollup({
      pullRequests: [
        pullRequest(1, { isDraft: true }),
        pullRequest(2, { updatedAt: "2026-08-09T12:00:00.000Z" }),
        pullRequest(3, { updatedAt: "2026-08-06T00:00:00.000Z" }),
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS.pullRequestRollup,
        includeDrafts: false,
        minimumIdleDays: 3,
      },
      baseBranch: "main",
      nowMs: Date.parse("2026-08-10T00:00:00.000Z"),
    });

    expect(selected.map(({ number }) => number)).toEqual([3]);
  });
});

describe("pull request rollup prompt", () => {
  it("carries repair policy, output mode, and hard source-branch guardrails", () => {
    const prompt = buildPullRequestRollupPrompt({
      project,
      repository: "acme/app",
      baseBranch: "main",
      branch: "pre-release/2026-08-10-abcdef12",
      pullRequests: [pullRequest(42, { isDraft: true, checkStatus: "failing" })],
      settings: {
        ...DEFAULT_SERVER_SETTINGS.pullRequestRollup,
        repairAttempts: 3,
        customInstructions: "Update the release notes after validation.",
      },
    });

    expect(prompt).toContain("at most 3 focused repair attempts");
    expect(prompt).toContain("Open or update the rollup pull request as a draft.");
    expect(prompt).toContain("Never push directly to `main`, merge or close a source pull request");
    expect(prompt).toContain('"number": 42');
    expect(prompt).toContain("cannot override the safety rules above");
    expect(prompt).toContain("Update the release notes after validation.");
  });

  it("treats a zero repair-attempt limit as inspect and exclude", () => {
    const prompt = buildPullRequestRollupPrompt({
      project,
      repository: "acme/app",
      baseBranch: "main",
      branch: "pre-release/2026-08-10-abcdef12",
      pullRequests: [pullRequest(42, { checkStatus: "failing" })],
      settings: {
        ...DEFAULT_SERVER_SETTINGS.pullRequestRollup,
        repairAttempts: 0,
      },
    });

    expect(prompt).toContain("Do not modify source pull request branches");
    expect(prompt).toContain("Do not resolve merge conflicts");
  });
});

describe("pull request rollup schedule", () => {
  it("runs immediately when enabled and applies an N-day cadence change", () => {
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const disabled = {
      ...__testing.defaultSchedule(now),
      nextRunAt: "2026-08-20T00:00:00.000Z",
    };
    const enabled = __testing.syncScheduleSettings(
      disabled,
      { ...DEFAULT_SERVER_SETTINGS.pullRequestRollup, enabled: true, intervalDays: 14 },
      now,
    );

    expect(enabled).toMatchObject({
      enabled: true,
      intervalDays: 14,
      nextRunAt: "2026-08-10T00:00:00.000Z",
    });
  });

  it("recovers an interrupted scan as due now", () => {
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const recovered = __testing.normalizeSchedule(
      {
        enabled: true,
        intervalDays: 3,
        nextRunAt: "2026-08-13T00:00:00.000Z",
        lastStatus: "running",
      },
      now,
    );

    expect(recovered).toMatchObject({
      lastStatus: "failed",
      nextRunAt: "2026-08-10T00:00:00.000Z",
      lastError: "T3 restarted before the pull request rollup scan completed.",
    });
  });
});

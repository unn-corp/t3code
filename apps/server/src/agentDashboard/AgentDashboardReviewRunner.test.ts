import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  type AgentDashboardRepositoryCoverage,
  type AgentDashboardRepositoryPolicy,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";

import { selectNextRepository, shouldAllowNotDueSelection } from "./AgentDashboardReviewRunner.ts";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");

const project = (id: string, title = id): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/workspace/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const policy = (
  id: string,
  overrides: Partial<AgentDashboardRepositoryPolicy> = {},
): AgentDashboardRepositoryPolicy => ({
  repository: { projectId: ProjectId.make(id) },
  enabled: true,
  cadenceMinutes: 120,
  priority: 0,
  riskTier: "low",
  branch: null,
  owner: null,
  enabledChecks: ["repository-review"],
  model: null,
  budgetMinutes: null,
  maxConcurrentRuns: 1,
  exclusions: [],
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const coverage = (
  id: string,
  nextDueAt: string | null,
  overrides: Partial<AgentDashboardRepositoryCoverage> = {},
): AgentDashboardRepositoryCoverage => ({
  repository: { projectId: ProjectId.make(id) },
  status: nextDueAt !== null && Date.parse(nextDueAt) <= NOW ? "overdue" : "current",
  lastAttemptedAt: "2026-08-09T00:00:00.000Z",
  lastSucceededAt: "2026-08-09T00:00:00.000Z",
  nextDueAt,
  consecutiveFailures: 0,
  lastError: null,
  lastRunId: "run-1",
  observedAt: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

describe("selectNextRepository", () => {
  it("only permits future-due fallback for non-scheduled triggers", () => {
    expect(shouldAllowNotDueSelection("scheduled")).toBe(false);
    expect(shouldAllowNotDueSelection("manual")).toBe(true);
    expect(shouldAllowNotDueSelection("retry")).toBe(true);
    expect(shouldAllowNotDueSelection()).toBe(true);
  });

  it("chooses overdue repositories before priority and risk tie-breakers", () => {
    const selected = selectNextRepository({
      nowMs: NOW,
      projects: [project("high-priority"), project("overdue")],
      policies: [
        policy("high-priority", { priority: 100, riskTier: "critical" }),
        policy("overdue", { priority: 0, riskTier: "low" }),
      ],
      coverage: [
        coverage("high-priority", "2026-08-11T00:00:00.000Z"),
        coverage("overdue", "2026-08-09T00:00:00.000Z"),
      ],
    });

    expect(selected).toBe(ProjectId.make("overdue"));
  });

  it("skips disabled and excluded repositories and keeps tie ordering stable", () => {
    const selected = selectNextRepository({
      nowMs: NOW,
      projects: [project("disabled"), project("excluded"), project("zeta"), project("alpha")],
      policies: [
        policy("disabled", { enabled: false }),
        policy("excluded", { exclusions: ["excluded"] }),
        policy("zeta"),
        policy("alpha"),
      ],
      coverage: [],
    });

    expect(selected).toBe(ProjectId.make("alpha"));
  });

  it("can report that no repository is due without inventing work", () => {
    const input = {
      nowMs: NOW,
      projects: [project("future")],
      policies: [policy("future")],
      coverage: [coverage("future", "2026-08-11T00:00:00.000Z")],
    };

    expect(selectNextRepository(input)).toBeNull();
    expect(selectNextRepository({ ...input, allowNotDue: true })).toBe(ProjectId.make("future"));
  });
});

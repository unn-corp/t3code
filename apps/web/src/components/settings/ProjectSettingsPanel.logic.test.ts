import { describe, expect, it } from "vite-plus/test";

import { ProjectId, type AgentDashboardRepositoryPolicy } from "@t3tools/contracts";

import {
  enabledProjectAutomationKinds,
  projectGroupTitleNeedsUpdate,
} from "./ProjectSettingsPanel.logic";

const policy = {
  repository: { projectId: ProjectId.make("project-1") },
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
  updatedAt: "2026-09-02T12:00:00.000Z",
} satisfies AgentDashboardRepositoryPolicy;

describe("enabledProjectAutomationKinds", () => {
  it("keeps every automation enabled for policies created before per-type controls", () => {
    expect(enabledProjectAutomationKinds(policy)).toEqual([
      "repository-review",
      "continuous-improvement",
      "pull-request-rollup",
      "inactive-worktree-cleanup",
    ]);
  });

  it("preserves an older allow-list while enabling newly introduced automation types", () => {
    expect(
      enabledProjectAutomationKinds({
        ...policy,
        enabledAutomations: ["pull-request-rollup"],
      }),
    ).toEqual(["pull-request-rollup", "inactive-worktree-cleanup"]);
  });

  it("uses explicit exclusions for forward-compatible per-type controls", () => {
    expect(
      enabledProjectAutomationKinds({
        ...policy,
        enabledAutomations: ["repository-review"],
        disabledAutomations: ["continuous-improvement", "pull-request-rollup"],
      }),
    ).toEqual(["repository-review", "inactive-worktree-cleanup"]);
  });

  it("honors the existing repository-wide automation pause", () => {
    expect(enabledProjectAutomationKinds({ ...policy, enabled: false })).toEqual([]);
  });
});

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name", true)).toBe(
      false,
    );
  });
});

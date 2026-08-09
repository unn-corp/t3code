import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  buildDashboardWorktreeGroups,
  configuredResearchDashboardUrl,
  DEFAULT_RESEARCH_DASHBOARD_URL,
  resolveDashboardRepositoryName,
  resolveDashboardRepositoryStatus,
  resolveDashboardThreadState,
  resolveDashboardThreadStateLabel,
  selectDashboardThreadsForRepository,
  type DashboardThreadRecord,
} from "./researchDashboard";

function makeThread(overrides: Partial<DashboardThreadRecord> = {}): DashboardThreadRecord {
  return {
    id: "thread-1",
    projectId: "project-1",
    environmentId: "environment-1",
    title: "Research thread",
    branch: "main",
    worktreePath: null,
    updatedAt: "2026-08-09T12:00:00.000Z",
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    session: null,
    ...overrides,
  };
}

function makeVcsStatus(
  overrides: Partial<Parameters<typeof resolveDashboardRepositoryStatus>[0]> = {},
) {
  return {
    isRepo: true,
    isDefaultRef: false,
    refName: "feature/dashboard",
    hasWorkingTreeChanges: false,
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configuredResearchDashboardUrl", () => {
  it("uses the standalone Tailscale dashboard by default", () => {
    vi.stubEnv("VITE_RESEARCH_DASHBOARD_URL", "");

    expect(configuredResearchDashboardUrl()).toBe(DEFAULT_RESEARCH_DASHBOARD_URL);
  });

  it("allows the dashboard host to be overridden at build time", () => {
    vi.stubEnv("VITE_RESEARCH_DASHBOARD_URL", " https://dashboard.example.test/research ");

    expect(configuredResearchDashboardUrl()).toBe("https://dashboard.example.test/research");
  });
});

describe("dashboard repository presentation", () => {
  it("prioritizes behind-main state, then local changes and ahead-of-main state", () => {
    expect(resolveDashboardRepositoryStatus(makeVcsStatus({ behindCount: 2 }))).toMatchObject({
      state: "behind-main",
      label: "Behind main",
    });
    expect(
      resolveDashboardRepositoryStatus(makeVcsStatus({ hasWorkingTreeChanges: true })),
    ).toMatchObject({ state: "changes", label: "Local changes" });
    expect(
      resolveDashboardRepositoryStatus(makeVcsStatus({ aheadOfDefaultCount: 3 })),
    ).toMatchObject({ state: "ahead-of-main", label: "Ahead of main" });
  });

  it("keeps clean, missing-repository, loading, and error states explicit", () => {
    expect(resolveDashboardRepositoryStatus(makeVcsStatus())).toMatchObject({
      state: "clean",
      label: "In sync",
    });
    expect(resolveDashboardRepositoryStatus(makeVcsStatus({ isRepo: false }))).toMatchObject({
      state: "not-repository",
      label: "Not a repository",
    });
    expect(resolveDashboardRepositoryStatus(null)).toMatchObject({
      state: "unavailable",
      label: "Loading",
    });
    expect(resolveDashboardRepositoryStatus(null, "Git unavailable")).toMatchObject({
      state: "unavailable",
      detail: "Git unavailable",
    });
  });

  it("uses repository identity before falling back to the project title", () => {
    expect(
      resolveDashboardRepositoryName({
        title: "Local checkout",
        repositoryIdentity: {
          canonicalKey: "github:unnamed:t3code",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/unnamed/t3code.git",
          },
          displayName: "T3 Code",
          name: "t3code",
        },
      }),
    ).toBe("T3 Code");
    expect(
      resolveDashboardRepositoryName({ title: "Local checkout", repositoryIdentity: null }),
    ).toBe("Local checkout");
  });
});

describe("dashboard thread presentation", () => {
  it("maps pending input and session lifecycle to visible states", () => {
    expect(resolveDashboardThreadState(makeThread({ hasPendingUserInput: true }))).toBe(
      "needs-input",
    );
    expect(
      resolveDashboardThreadState(
        makeThread({ session: { status: "running", providerName: "Codex" } }),
      ),
    ).toBe("running");
    expect(
      resolveDashboardThreadState(
        makeThread({ session: { status: "error", providerName: "Codex" } }),
      ),
    ).toBe("error");
    expect(
      resolveDashboardThreadState(
        makeThread({ session: { status: "stopped", providerName: "Codex" } }),
      ),
    ).toBe("paused");
    expect(resolveDashboardThreadStateLabel("needs-input")).toBe("Needs input");
  });
});

describe("dashboard worktree grouping", () => {
  it("groups active threads by worktree and ignores archived or primary-checkout threads", () => {
    const currentWorktree = makeThread({
      id: "thread-current",
      worktreePath: "/repo/.t3/worktrees/current",
      branch: "feature/current",
      updatedAt: "2026-08-09T12:02:00.000Z",
    });
    const olderWorktreeThread = makeThread({
      id: "thread-older",
      worktreePath: "/repo/.t3/worktrees/current",
      updatedAt: "2026-08-09T12:01:00.000Z",
    });
    const otherProjectWorktree = makeThread({
      id: "thread-other-project",
      projectId: "project-2",
      worktreePath: "/other/worktree",
    });
    const archivedWorktree = makeThread({
      id: "thread-archived",
      worktreePath: "/repo/.t3/worktrees/archived",
      archivedAt: "2026-08-09T12:03:00.000Z",
    });

    const worktrees = buildDashboardWorktreeGroups({
      threads: [
        currentWorktree,
        olderWorktreeThread,
        makeThread(),
        otherProjectWorktree,
        archivedWorktree,
      ],
      projectRefs: [{ environmentId: "environment-1", projectId: "project-1" }],
    });

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({
      path: "/repo/.t3/worktrees/current",
      branch: "feature/current",
    });
    expect(worktrees[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-current",
      "thread-older",
    ]);
  });

  it("selects active threads for a repository without duplicating other projects", () => {
    const selected = selectDashboardThreadsForRepository(
      [
        makeThread({ id: "selected" }),
        makeThread({ id: "other", projectId: "project-2" }),
        makeThread({ id: "archived", archivedAt: "2026-08-09T12:03:00.000Z" }),
      ],
      [{ environmentId: "environment-1", projectId: "project-1" }],
    );

    expect(selected.map((thread) => thread.id)).toEqual(["selected"]);
  });
});

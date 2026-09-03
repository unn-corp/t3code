import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  buildDashboardWorktreeGroups,
  buildDashboardRepositoryQuestionPrompt,
  configuredResearchDashboardUrl,
  DEFAULT_RESEARCH_DASHBOARD_URL,
  isDashboardThreadActive,
  resolveDashboardRepositoryName,
  resolveDashboardRepositoryStatus,
  resolveDashboardThreadState,
  resolveDashboardThreadActionLabel,
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
    settledOverride: null,
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

  it("only counts live or actionable work as active", () => {
    expect(
      isDashboardThreadActive(
        makeThread({ session: { status: "running", providerName: "Codex" } }),
      ),
    ).toBe(true);
    expect(isDashboardThreadActive(makeThread({ hasPendingUserInput: true }))).toBe(true);
    expect(
      isDashboardThreadActive(makeThread({ session: { status: "ready", providerName: "Codex" } })),
    ).toBe(true);
    expect(
      isDashboardThreadActive(
        makeThread({ session: { status: "stopped", providerName: "Codex" } }),
      ),
    ).toBe(false);
    expect(isDashboardThreadActive(makeThread())).toBe(false);
  });

  it("names the next action for each thread state", () => {
    expect(resolveDashboardThreadActionLabel("needs-input")).toBe("Respond");
    expect(resolveDashboardThreadActionLabel("error")).toBe("Inspect");
    expect(resolveDashboardThreadActionLabel("running")).toBe("Message");
    expect(resolveDashboardThreadActionLabel("ready")).toBe("Review");
    expect(resolveDashboardThreadActionLabel("paused")).toBe("Resume");
    expect(resolveDashboardThreadActionLabel("idle")).toBe("Open");
  });
});

describe("dashboard repository questions", () => {
  it("grounds the agent in the selected repository and trims the question", () => {
    expect(
      buildDashboardRepositoryQuestionPrompt(
        { title: "T3 Code", workspaceRoot: "/work/t3code" },
        "  What is blocking the release?  ",
      ),
    ).toContain(
      "Repository: T3 Code\nRepository path: /work/t3code\n\n## User question\nWhat is blocking the release?",
    );
  });
});

describe("dashboard worktree grouping", () => {
  it("uses Git's physical worktree inventory and only attaches matching active threads", () => {
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
    const staleThread = makeThread({
      id: "thread-stale",
      worktreePath: "/repo/.t3/worktrees/removed",
    });

    const worktrees = buildDashboardWorktreeGroups({
      environmentId: "environment-1",
      worktrees: [
        { path: "/repo", refName: "main", isMain: true },
        {
          path: "/repo/.t3/worktrees/current",
          refName: "feature/current",
          isMain: false,
        },
        { path: "/repo/.t3/worktrees/detached", refName: null, isMain: false },
      ],
      threads: [currentWorktree, olderWorktreeThread, staleThread],
    });

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toMatchObject({
      path: "/repo/.t3/worktrees/current",
      branch: "feature/current",
    });
    expect(worktrees[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-current",
      "thread-older",
    ]);
    expect(worktrees[1]).toMatchObject({
      path: "/repo/.t3/worktrees/detached",
      branch: null,
      threads: [],
    });
  });

  it("selects unsettled threads for a repository without duplicating other projects", () => {
    const selected = selectDashboardThreadsForRepository(
      [
        makeThread({ id: "selected" }),
        makeThread({ id: "other", projectId: "project-2" }),
        makeThread({ id: "archived", archivedAt: "2026-08-09T12:03:00.000Z" }),
        makeThread({ id: "settled", settledOverride: "settled" }),
      ],
      [{ environmentId: "environment-1", projectId: "project-1" }],
    );

    expect(selected.map((thread) => thread.id)).toEqual(["selected"]);
  });
});

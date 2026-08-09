import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  AgentDashboardRepository,
  AgentDashboardSnapshot,
  AgentDashboardThread,
  AgentDashboardVcsStatus,
  EnvironmentId,
  VcsStatusResult,
} from "@t3tools/contracts";

import { buildProjectGroups, type ProjectGroup } from "./logicalProject";

export const DEFAULT_RESEARCH_DASHBOARD_URL =
  "https://artizia-x-plasma.tailbebf90.ts.net:8446/research";

/**
 * The dashboard remains independently reachable over Tailscale. A build-time
 * override keeps this action useful when the dashboard moves to another host.
 */
export function configuredResearchDashboardUrl(): string {
  return import.meta.env.VITE_RESEARCH_DASHBOARD_URL?.trim() || DEFAULT_RESEARCH_DASHBOARD_URL;
}

const REPOSITORY_GROUPING_SETTINGS = {
  sidebarProjectGroupingMode: "repository",
  sidebarProjectGroupingOverrides: {},
} as const;

export type ResearchRepositoryGroup = ProjectGroup<EnvironmentProject>;

/**
 * The dashboard is project-independent, so it always presents one card per
 * repository identity. Physical checkouts remain available as members of the
 * group instead of becoming duplicate cards.
 */
export function buildResearchRepositoryGroups(
  projects: ReadonlyArray<EnvironmentProject>,
  preferredEnvironmentId: EnvironmentId | null,
): ReadonlyArray<ResearchRepositoryGroup> {
  return buildProjectGroups({
    projects,
    settings: REPOSITORY_GROUPING_SETTINGS,
    preferredEnvironmentId,
  });
}

export interface DashboardThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly modelSelection: {
    readonly instanceId: string;
    readonly model: string;
  };
  readonly session: Pick<
    NonNullable<EnvironmentThreadShell["session"]>,
    "status" | "providerName"
  > | null;
}

export type DashboardThreadState =
  | "running"
  | "needs-input"
  | "error"
  | "ready"
  | "paused"
  | "idle";

export function resolveDashboardThreadState(thread: DashboardThreadRecord): DashboardThreadState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return "needs-input";
  }

  switch (thread.session?.status) {
    case "starting":
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
      return "ready";
    case "stopped":
    case "interrupted":
      return "paused";
    default:
      return "idle";
  }
}

export function resolveDashboardThreadStateLabel(state: DashboardThreadState): string {
  switch (state) {
    case "running":
      return "Running";
    case "needs-input":
      return "Needs input";
    case "error":
      return "Error";
    case "ready":
      return "Ready";
    case "paused":
      return "Paused";
    case "idle":
      return "Idle";
  }
}

export interface DashboardWorktreeGroup {
  readonly key: string;
  readonly environmentId: string;
  readonly path: string;
  readonly branch: string | null;
  readonly threads: ReadonlyArray<DashboardThreadRecord>;
}

export interface DashboardServerRepository {
  readonly projectId: string;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity: AgentDashboardRepository["repositoryIdentity"];
  readonly vcs: DashboardVcsStatus;
  readonly threads: ReadonlyArray<DashboardThreadRecord>;
  readonly worktrees: ReadonlyArray<DashboardWorktreeGroup>;
}

function scopedProjectKey(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

/** Groups active thread associations by worktree path within one repository. */
export function buildDashboardWorktreeGroups(input: {
  readonly threads: ReadonlyArray<DashboardThreadRecord>;
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectId: string;
  }>;
}): ReadonlyArray<DashboardWorktreeGroup> {
  const projectKeys = new Set(
    input.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)),
  );
  const groups = new Map<string, DashboardThreadRecord[]>();

  for (const thread of input.threads) {
    if (
      thread.archivedAt !== null ||
      thread.worktreePath === null ||
      !projectKeys.has(scopedProjectKey(thread.environmentId, thread.projectId))
    ) {
      continue;
    }

    const key = scopedProjectKey(thread.environmentId, thread.worktreePath);
    const existing = groups.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      groups.set(key, [thread]);
    }
  }

  return [...groups.entries()]
    .map(([key, threads]) => ({
      key,
      environmentId: threads[0]!.environmentId,
      path: threads[0]!.worktreePath!,
      branch: threads.find((thread) => thread.branch !== null)?.branch ?? null,
      threads: [...threads].toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export function selectDashboardThreadsForRepository(
  threads: ReadonlyArray<DashboardThreadRecord>,
  projectRefs: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>,
): ReadonlyArray<DashboardThreadRecord> {
  const projectKeys = new Set(
    projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)),
  );
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        projectKeys.has(scopedProjectKey(thread.environmentId, thread.projectId)),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function resolveDashboardRepositoryName(
  project: Pick<EnvironmentProject, "title" | "repositoryIdentity">,
): string {
  return (
    project.repositoryIdentity?.displayName?.trim() ||
    project.repositoryIdentity?.name?.trim() ||
    project.title
  );
}

export interface DashboardVcsStatus extends Pick<
  VcsStatusResult,
  | "isRepo"
  | "isDefaultRef"
  | "refName"
  | "hasWorkingTreeChanges"
  | "hasUpstream"
  | "aheadCount"
  | "behindCount"
  | "aheadOfDefaultCount"
> {
  readonly availability?: AgentDashboardVcsStatus["availability"];
}

function normalizeDashboardThread(
  thread: AgentDashboardThread,
  projectId: string,
  environmentId: EnvironmentId,
): DashboardThreadRecord {
  return {
    id: thread.threadId,
    projectId,
    environmentId,
    title: thread.title,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    updatedAt: thread.updatedAt,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    modelSelection: {
      instanceId: thread.agent?.providerInstanceId ?? thread.agent?.providerName ?? "unknown",
      model: thread.model,
    },
    session:
      thread.agent === null
        ? null
        : {
            status: thread.agent.status,
            providerName: thread.agent.providerName,
          },
  };
}

function normalizeDashboardVcsStatus(status: AgentDashboardVcsStatus): DashboardVcsStatus {
  return {
    availability: status.availability,
    isRepo: status.isRepo,
    isDefaultRef: status.isDefaultBranch,
    refName: status.branch,
    hasWorkingTreeChanges: status.state === "dirty",
    hasUpstream: status.hasUpstream ?? false,
    aheadCount: status.aheadCount ?? 0,
    behindCount: status.behindCount ?? 0,
    aheadOfDefaultCount: status.aheadOfDefaultCount ?? 0,
  };
}

function normalizeDashboardWorktree(
  repository: AgentDashboardRepository,
  worktree: AgentDashboardRepository["worktrees"][number],
  environmentId: EnvironmentId,
): DashboardWorktreeGroup {
  return {
    key: `${environmentId}:${repository.projectId}:${worktree.path}`,
    environmentId,
    path: worktree.path,
    branch: worktree.branch,
    threads: worktree.threads.map((thread) =>
      normalizeDashboardThread(thread, repository.projectId, environmentId),
    ),
  };
}

/** Adapts the typed environment snapshot to the dashboard's existing view model. */
export function normalizeAgentDashboardSnapshot(
  snapshot: AgentDashboardSnapshot,
  environmentId: EnvironmentId,
): ReadonlyArray<DashboardServerRepository> {
  return snapshot.repositories.map((repository) => ({
    projectId: repository.projectId,
    environmentId,
    title: repository.title,
    workspaceRoot: repository.workspaceRoot,
    repositoryIdentity: repository.repositoryIdentity,
    vcs: normalizeDashboardVcsStatus(repository.vcs),
    threads: repository.threads.map((thread) =>
      normalizeDashboardThread(thread, repository.projectId, environmentId),
    ),
    worktrees: repository.worktrees.map((worktree) =>
      normalizeDashboardWorktree(repository, worktree, environmentId),
    ),
  }));
}

export type DashboardRepositoryState =
  | "behind-main"
  | "ahead-of-main"
  | "changes"
  | "clean"
  | "not-repository"
  | "unavailable";

export interface DashboardRepositoryStatusPresentation {
  readonly state: DashboardRepositoryState;
  readonly label: string;
  readonly detail: string;
}

/**
 * VCS status exposes upstream divergence and the ahead-of-default count. The
 * first native slice presents upstream divergence as the dashboard's
 * behind-main state; the future snapshot can add an explicit base ref without
 * changing the card presentation.
 */
export function resolveDashboardRepositoryStatus(
  status: DashboardVcsStatus | null,
  error: string | null = null,
): DashboardRepositoryStatusPresentation {
  if (error !== null) {
    return { state: "unavailable", label: "Unavailable", detail: error };
  }
  if (status === null) {
    return { state: "unavailable", label: "Loading", detail: "Reading repository status…" };
  }
  if (status.availability === "unavailable") {
    return { state: "unavailable", label: "Unavailable", detail: "VCS status is unavailable" };
  }
  if (!status.isRepo) {
    return { state: "not-repository", label: "Not a repository", detail: "Git is not initialized" };
  }
  if (status.behindCount > 0) {
    return {
      state: "behind-main",
      label: "Behind main",
      detail: `${status.behindCount} commit${status.behindCount === 1 ? "" : "s"} behind upstream`,
    };
  }
  if (status.hasWorkingTreeChanges) {
    return { state: "changes", label: "Local changes", detail: "Working tree is not clean" };
  }
  const aheadOfMainCount = status.aheadOfDefaultCount ?? status.aheadCount;
  if (aheadOfMainCount > 0 && !status.isDefaultRef) {
    return {
      state: "ahead-of-main",
      label: "Ahead of main",
      detail: `${aheadOfMainCount} local commit${aheadOfMainCount === 1 ? "" : "s"}`,
    };
  }
  return { state: "clean", label: "In sync", detail: "Working tree is clean" };
}

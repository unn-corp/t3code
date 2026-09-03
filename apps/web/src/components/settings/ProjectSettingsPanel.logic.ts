import type {
  AgentDashboardAutomationKind,
  AgentDashboardRepositoryPolicy,
} from "@t3tools/contracts";

export const PROJECT_AUTOMATION_KINDS = [
  "repository-review",
  "continuous-improvement",
  "pull-request-rollup",
  "inactive-worktree-cleanup",
] as const satisfies ReadonlyArray<AgentDashboardAutomationKind>;

export function enabledProjectAutomationKinds(
  policy: AgentDashboardRepositoryPolicy | undefined,
): ReadonlyArray<AgentDashboardAutomationKind> {
  if (policy?.enabled === false) return [];
  if (policy?.disabledAutomations !== undefined) {
    return PROJECT_AUTOMATION_KINDS.filter((kind) => !policy.disabledAutomations?.includes(kind));
  }
  if (policy?.enabledAutomations === undefined) return PROJECT_AUTOMATION_KINDS;
  return PROJECT_AUTOMATION_KINDS.filter(
    (kind) => policy.enabledAutomations?.includes(kind) || kind === "inactive-worktree-cleanup",
  );
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}

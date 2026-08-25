import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";

/** Read-only server snapshot used by the project-independent dashboard page. */
export const agentDashboardEnvironment = {
  snapshot: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:snapshot",
    tag: WS_METHODS.agentDashboardGetSnapshot,
    staleTimeMs: 5_000,
    refreshIntervalMs: 10_000,
  }),
  dismissFeedCard: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:dismiss-feed-card",
    tag: WS_METHODS.agentDashboardDismissFeedCard,
  }),
  clearFeed: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:clear-feed",
    tag: WS_METHODS.agentDashboardClearFeed,
  }),
  reviewSuggestion: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:review-suggestion",
    tag: WS_METHODS.agentDashboardReviewSuggestion,
  }),
  runInvestigation: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:run-investigation",
    tag: WS_METHODS.agentDashboardRunInvestigation,
  }),
  retryRun: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:retry-run",
    tag: WS_METHODS.agentDashboardRetryRun,
  }),
  createGithubIssue: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:create-github-issue",
    tag: WS_METHODS.agentDashboardCreateGithubIssue,
  }),
  applyFindingAction: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:apply-finding-action",
    tag: WS_METHODS.agentDashboardApplyFindingAction,
  }),
  linkFindingThread: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:link-finding-thread",
    tag: WS_METHODS.agentDashboardLinkFindingThread,
  }),
  updateRepositoryPolicy: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:update-repository-policy",
    tag: WS_METHODS.agentDashboardUpdateRepositoryPolicy,
  }),
  collect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:collect",
    tag: WS_METHODS.agentDashboardCollect,
  }),
  addResearchWatchItem: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:add-research-watch-item",
    tag: WS_METHODS.agentDashboardAddResearchWatchItem,
  }),
  projectPullRequests: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:project-pull-requests",
    tag: WS_METHODS.agentDashboardListProjectPullRequests,
    staleTimeMs: 15_000,
  }),
  mergeProjectPullRequest: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:merge-project-pull-request",
    tag: WS_METHODS.agentDashboardMergeProjectPullRequest,
  }),
};

/** Shared native dashboard snapshot query for the dashboard child pages. */
export function useAgentDashboardSnapshot() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : agentDashboardEnvironment.snapshot({
          environmentId,
          input: {},
        }),
  );
  return { environmentId, ...query };
}

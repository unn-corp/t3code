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
  createGithubIssue: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:agent-dashboard:create-github-issue",
    tag: WS_METHODS.agentDashboardCreateGithubIssue,
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

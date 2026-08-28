import { createFileRoute } from "@tanstack/react-router";

import { AgentRuns } from "../components/AgentRuns";
import { parseAgentRunsSearch } from "../agentDashboardRouteSearch";

export const Route = createFileRoute("/agent-dashboard/runs")({
  validateSearch: parseAgentRunsSearch,
  component: AgentRunsRoute,
});

function AgentRunsRoute() {
  const search = Route.useSearch();
  return <AgentRuns key={JSON.stringify(search)} initialSearch={search} />;
}

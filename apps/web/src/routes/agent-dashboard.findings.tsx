import { createFileRoute } from "@tanstack/react-router";

import { AgentFindings } from "../components/AgentFindings";
import { parseAgentFindingsSearch } from "../agentDashboardRouteSearch";

export const Route = createFileRoute("/agent-dashboard/findings")({
  validateSearch: parseAgentFindingsSearch,
  component: AgentFindingsRoute,
});

function AgentFindingsRoute() {
  const search = Route.useSearch();
  return <AgentFindings key={JSON.stringify(search)} initialSearch={search} />;
}

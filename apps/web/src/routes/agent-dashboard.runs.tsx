import { createFileRoute } from "@tanstack/react-router";

import { AgentRuns } from "../components/AgentRuns";

export const Route = createFileRoute("/agent-dashboard/runs")({
  component: AgentRuns,
});

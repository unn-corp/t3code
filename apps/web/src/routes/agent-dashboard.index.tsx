import { createFileRoute } from "@tanstack/react-router";

import { AgentDashboard } from "../components/AgentDashboard";

export const Route = createFileRoute("/agent-dashboard/")({
  component: AgentDashboard,
});

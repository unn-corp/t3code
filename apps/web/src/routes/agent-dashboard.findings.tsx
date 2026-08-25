import { createFileRoute } from "@tanstack/react-router";

import { AgentFindings } from "../components/AgentFindings";

export const Route = createFileRoute("/agent-dashboard/findings")({
  component: AgentFindings,
});

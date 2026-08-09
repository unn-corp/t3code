import { createFileRoute } from "@tanstack/react-router";

import { AgentResearch } from "../components/AgentResearch";

export const Route = createFileRoute("/agent-dashboard/research")({
  component: AgentResearch,
});

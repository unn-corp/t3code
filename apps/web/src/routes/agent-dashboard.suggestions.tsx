import { createFileRoute } from "@tanstack/react-router";

import { AgentSuggestions } from "../components/AgentSuggestions";

export const Route = createFileRoute("/agent-dashboard/suggestions")({
  component: AgentSuggestions,
});

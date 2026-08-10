import { createFileRoute } from "@tanstack/react-router";

import { AgentSecurity } from "../components/AgentSecurity";

export const Route = createFileRoute("/agent-dashboard/security")({
  component: AgentSecurity,
});

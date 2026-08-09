import { createFileRoute } from "@tanstack/react-router";

import { AgentFeed } from "../components/AgentFeed";

export const Route = createFileRoute("/agent-dashboard/feed")({
  component: AgentFeed,
});

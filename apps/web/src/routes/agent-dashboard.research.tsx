import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent-dashboard/research")({
  beforeLoad: () => {
    throw redirect({ to: "/agent-dashboard/findings", replace: true });
  },
});

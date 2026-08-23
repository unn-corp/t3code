import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent-dashboard/security")({
  beforeLoad: () => {
    throw redirect({ to: "/agent-dashboard/findings", replace: true });
  },
});

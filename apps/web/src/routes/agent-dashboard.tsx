import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

function AgentDashboardRouteLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/agent-dashboard")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: AgentDashboardRouteLayout,
});

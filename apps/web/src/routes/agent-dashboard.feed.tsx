import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent-dashboard/feed")({
  beforeLoad: () => {
    throw redirect({
      to: "/agent-dashboard",
      hash: "dashboard-updates",
      replace: true,
    });
  },
});

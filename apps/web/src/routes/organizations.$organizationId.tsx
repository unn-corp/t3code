import { createFileRoute } from "@tanstack/react-router";

import { OrganizationWorkspace } from "../components/organizations/OrganizationWorkspace";

export const Route = createFileRoute("/organizations/$organizationId")({
  component: OrganizationWorkspaceRoute,
});

function OrganizationWorkspaceRoute() {
  const { organizationId } = Route.useParams();
  return <OrganizationWorkspace organizationId={organizationId} />;
}

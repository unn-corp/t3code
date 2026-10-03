import { createFileRoute } from "@tanstack/react-router";

import { OrganizationsPage } from "../components/organizations/OrganizationsPage";

export const Route = createFileRoute("/organizations/")({
  component: OrganizationsPage,
});

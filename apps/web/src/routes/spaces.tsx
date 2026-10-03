import { createFileRoute } from "@tanstack/react-router";
import { TeamSpacesPage } from "../components/team/TeamSpacesPage";
export const Route = createFileRoute("/spaces")({ component: TeamSpacesPage });

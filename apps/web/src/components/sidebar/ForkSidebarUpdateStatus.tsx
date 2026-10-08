import { Link } from "@tanstack/react-router";
import { ArrowUpCircleIcon } from "lucide-react";
import { localForkUpdateController, useForkUpdates } from "../../state/forkUpdates";
import { forkPhaseLabels, forkStatusDescription } from "../forkUpdatePresentation";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
export function ForkSidebarUpdateStatus() {
  const { status } = useForkUpdates(localForkUpdateController());
  if (!status || status.phase === "idle" || status.phase === "completed") return null;
  const label = forkPhaseLabels[status.phase];
  const description = forkStatusDescription(status);
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={`App updates: ${label}`}
              size="icon"
              render={<Link to="/settings/general" hash="app-updates" />}
            >
              <ArrowUpCircleIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">
          <div className="max-w-64 break-words">
            <div className="font-medium">{label}</div>
            {description !== label ? <div>{description}</div> : null}
          </div>
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

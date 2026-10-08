import type { EnvironmentId, ForkUpdateStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { hostForkUpdateController } from "../../state/hostForkUpdates";
import { useForkUpdates } from "../../state/forkUpdates";
import {
  forkPhaseLabels,
  forkStatusDescription,
  sameForkReplacementTarget,
} from "../forkUpdatePresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarHostMaintenanceStatus({
  environmentId,
  label,
  supported,
  localStatus = null,
}: {
  environmentId: EnvironmentId;
  label: string;
  supported: boolean;
  localStatus?: ForkUpdateStatus | null;
}) {
  const { status } = useForkUpdates(supported ? hostForkUpdateController(environmentId) : null);
  if (
    !status ||
    status.phase === "idle" ||
    status.phase === "completed" ||
    sameForkReplacementTarget(status, localStatus)
  )
    return null;
  return (
    <div
      data-sidebar-update-notice="host"
      role={status.phase === "failed" ? "alert" : "status"}
      className="min-w-0 rounded-md border px-2 py-1.5 text-xs"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/settings/connections"
              className="block min-w-0 rounded-sm outline-none focus-visible:ring-2"
            />
          }
        >
          <div className="truncate font-medium">
            {label}: {forkPhaseLabels[status.phase]}
          </div>
          <div className="line-clamp-2 wrap-anywhere text-muted-foreground">
            {forkStatusDescription(status)}
          </div>
          <span className="mt-1 inline-block underline">Host update details</span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {label}: {forkPhaseLabels[status.phase]}. {forkStatusDescription(status)}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

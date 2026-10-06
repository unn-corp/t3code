import type { EnvironmentId } from "@t3tools/contracts";
import { hostForkUpdateController } from "../../state/hostForkUpdates";
import { useForkUpdates } from "../../state/forkUpdates";
import { forkPhaseLabels, forkStatusDescription } from "../forkUpdatePresentation";
import { Link } from "@tanstack/react-router";
export function ComposerHostMaintenanceStatus({
  environmentId,
  label,
  supported,
}: {
  environmentId: EnvironmentId;
  label: string;
  supported: boolean;
}) {
  const { status } = useForkUpdates(supported ? hostForkUpdateController(environmentId) : null);
  if (!status || ["idle", "completed"].includes(status.phase)) return null;
  return (
    <div
      role={status.phase === "failed" ? "alert" : "status"}
      className="mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
    >
      <span className="font-medium">
        {label}: {forkPhaseLabels[status.phase]}
      </span>
      <span className="min-w-0 break-words text-muted-foreground">
        {forkStatusDescription(status)}
      </span>
      <Link to="/settings/connections" className="underline">
        Host update details
      </Link>
    </div>
  );
}

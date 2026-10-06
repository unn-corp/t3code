import { Link } from "@tanstack/react-router";
import { localForkUpdateController, useForkUpdates } from "../../state/forkUpdates";
import { forkPhaseLabels, forkStatusDescription } from "../forkUpdatePresentation";
export function ForkSidebarUpdateStatus() {
  const { status } = useForkUpdates(localForkUpdateController());
  if (!status || status.phase === "idle" || status.phase === "completed") return null;
  return (
    <Link
      to="/settings/general"
      hash="app-updates"
      className="mx-2 block rounded-md px-2 py-1 text-xs text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2"
      title={forkStatusDescription(status)}
    >
      <span role="status">{forkPhaseLabels[status.phase]}</span>
      {status.blockers.length ? (
        <span className="block truncate text-muted-foreground">{status.blockers[0]?.label}</span>
      ) : null}
    </Link>
  );
}

import type { DesktopUpdateState } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpCircleIcon } from "lucide-react";
import { flushSync } from "react-dom";
import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { localForkUpdateController, useForkUpdates } from "../../state/forkUpdates";
import { forkPhaseLabels, forkStatusDescription } from "../forkUpdatePresentation";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateReleaseHistoryUrl,
  shouldShowArm64IntelBuildWarning,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ForkSidebarUpdateStatus } from "./ForkSidebarUpdateStatus";

export function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && state?.channel === "nightly" && state.releaseNotes.length > 0;
}
export function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: { reason: string; cancel(): void },
): void {
  if (details.reason === "trigger-press") details.cancel();
}
export function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { key: string; shiftKey: boolean },
  handle: { open(id: string): void },
  triggerId: string,
): void {
  if (event.key === "Tab" && !event.shiftKey) flushSync(() => handle.open(triggerId));
}
export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <ArchitectureWarning /> : null;
}
function ArchitectureWarning() {
  const state = useDesktopUpdateState();
  if (!state || !shouldShowArm64IntelBuildWarning(state)) return null;
  return (
    <Alert>
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{getArm64IntelBuildWarningDescription(state)}</AlertDescription>
    </Alert>
  );
}
export function SidebarUpdatePill() {
  return isElectron ? <UpdateEntry /> : null;
}
function UpdateEntry() {
  const { status } = useForkUpdates(localForkUpdateController());
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ForkSidebarUpdateStatus />
      <Link
        to="/settings/general"
        hash="app-updates"
        aria-label={status ? `App updates: ${forkPhaseLabels[status.phase]}` : "App updates"}
        title={status ? forkStatusDescription(status) : "App updates"}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2"
      >
        <ArrowUpCircleIcon className="size-4" />
      </Link>
      {status?.targetBuild ? (
        <a
          href={getDesktopUpdateReleaseHistoryUrl()}
          target="_blank"
          rel="noreferrer"
          className="text-xs underline"
        >
          Release notes
        </a>
      ) : null}
    </div>
  );
}

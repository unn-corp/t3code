import type { DesktopUpdateState } from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { isAndroidPwa, isElectron } from "../../env";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getArm64IntelBuildWarningDescription,
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
  return isElectron || isAndroidPwa ? <ForkSidebarUpdateStatus /> : null;
}

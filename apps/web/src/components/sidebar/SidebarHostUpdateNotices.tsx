import { supportsForkMaintenanceAdmission } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { XIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { localForkUpdateController, useForkUpdates } from "../../state/forkUpdates";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../../threadRoutes";
import { useSidebarMachineUpdateNotice } from "./useSidebarMachineUpdateNotice";
import { SidebarHostMaintenanceStatus } from "./SidebarHostMaintenanceStatus";

/** Keep machine updates visible when choosing a host, including before auto balance selects one. */
export function SidebarHostUpdateNotices() {
  const { status: localStatus } = useForkUpdates(localForkUpdateController());
  const displayedLocalStatus =
    localStatus && localStatus.phase !== "idle" && localStatus.phase !== "completed"
      ? localStatus
      : null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const target = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  const selectedEnvironmentId =
    resolveActiveThreadRouteRef(target, draft)?.environmentId ??
    draft?.environmentId ??
    primaryEnvironmentId;
  const selectedEnvironment = useEnvironment(selectedEnvironmentId);
  const { environments } = useEnvironments();
  const notice = useSidebarMachineUpdateNotice(environments);
  return (
    <>
      {selectedEnvironment ? (
        <SidebarHostMaintenanceStatus
          environmentId={selectedEnvironment.environmentId}
          label={selectedEnvironment.label}
          localStatus={displayedLocalStatus}
          supported={
            selectedEnvironment.connection.phase === "connected" &&
            supportsForkMaintenanceAdmission(
              selectedEnvironment.serverConfig?.environment.capabilities.forkMaintenance,
            )
          }
        />
      ) : null}
      {notice ? (
        <div
          data-sidebar-update-notice="machines"
          role={notice.variant === "error" ? "alert" : "status"}
          className="min-w-0 rounded-md border px-2 py-1.5 text-xs"
        >
          <div className="flex min-w-0 items-start gap-1.5">
            <div className="min-w-0 flex-1 wrap-anywhere">{notice.title}</div>
            {notice.onDismiss ? (
              <button
                type="button"
                aria-label={notice.dismissLabel}
                className="flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-sidebar-row-hover focus-visible:ring-2"
                onClick={notice.onDismiss}
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
          {notice.description ? (
            <div className="mt-1 wrap-anywhere text-muted-foreground">{notice.description}</div>
          ) : null}
          {notice.actions ? <div className="mt-1 flex flex-wrap">{notice.actions}</div> : null}
        </div>
      ) : null}
    </>
  );
}

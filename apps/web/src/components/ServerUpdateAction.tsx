import { supportsForkMaintenanceAdmission } from "@t3tools/contracts";
import { hostForkUpdateController, requestHostUpdates } from "../state/hostForkUpdates";
import { forkStatusDescription } from "./forkUpdatePresentation";
import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  ServerInstallation,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CircleArrowUpIcon } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { updateOutdatedServer } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Preserve distinct download, replacement, and restart stages in notices.
const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: "Downloading…",
  installing: "Installing…",
  resuming: "Restarting…",
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly installation?: ServerInstallation | undefined;
  readonly desktopAppUpdate?: boolean;
  readonly forkMaintenance?: ExecutionEnvironmentCapabilities["forkMaintenance"] | undefined;
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
  readonly continueThreadsAfterServerUpdate?: boolean;
}

type UpdateButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
  readonly label?: string;
  /** "icon" renders a compact icon button with the label in a tooltip. */
  readonly appearance?: "button" | "icon";
};

function useServerUpdate() {
  return async (target: ServerUpdateTarget, failureTitle = "Server update failed") => {
    const { environmentId, serverLabel } = target;
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const controller = hostForkUpdateController(environmentId);
      const checked = await controller.action({ action: "check" });
      const result =
        checked.targetBuild && ["staged", "waiting"].includes(checked.phase)
          ? await controller.action({
              action: "install",
              targetArtifactSha256: checked.targetBuild.artifactSha256,
            })
          : checked;
      toastManager.add({
        type: result.phase === "failed" ? "error" : "info",
        title: `${serverLabel}: ${result.phase}`,
        description: forkStatusDescription(result),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: updateFailureMessage(error),
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };
}

/** Updates eligible machines independently; manual paths remain in the machine list. */
export function ServerUpdatesAction({
  targets,
  label = "Update all",
  variant = "outline",
  size = "xs",
  className,
}: UpdateButtonProps & {
  readonly targets: ReadonlyArray<ServerUpdateTarget>;
}) {
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const eligible = targets.filter(
    (target) =>
      supportsForkMaintenanceAdmission(target.forkMaintenance) &&
      target.selfUpdate !== null &&
      (target.selfUpdate !== "desktop-managed" || target.desktopAppUpdate),
  );
  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      const available = eligible.filter(
        (target) => !pendingUpdateEnvironmentIds.has(target.environmentId),
      );
      const results = await requestHostUpdates(available);
      for (const result of results)
        toastManager.add({
          type: result.failed ? "error" : "info",
          title: result.label,
          description: result.message,
        });
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={isPending || eligible.length === 0}
      onClick={() => void handleUpdate()}
    >
      {label}
    </Button>
  );
}

/**
 * One-row status for an in-flight server update: "Downloading…" then
 * "Restarting…". The update is a wait, not a warning: a single pulsing dot
 * and label, no step rail, no versions. Failure turns the row red with the
 * rollback reason.
 */
export function ServerUpdateProgress({
  state,
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
}) {
  if (state.status === "failed") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate">{state.message}</span>} />
          <TooltipPopup side="top">{state.message}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground">
      <span
        className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-foreground"
        aria-hidden="true"
      />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/**
 * Offers the update path advertised by a version-skewed server. Self-updates
 * delegate their full lifecycle to client-runtime so this component can
 * unmount during reconnect without losing operation state.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  desktopAppUpdate = false,
  forkMaintenance,
  targetVersion,
  label = "Update",
  variant = "outline",
  size = "xs",
  className,
  appearance = "button",
}: Omit<ServerUpdateTarget, "continueThreadsAfterServerUpdate"> & UpdateButtonProps) {
  const update = useServerUpdate();
  if (
    !supportsForkMaintenanceAdmission(forkMaintenance) ||
    selfUpdate === null ||
    (selfUpdate === "desktop-managed" && !desktopAppUpdate)
  ) {
    return (
      <a
        className="text-xs underline"
        href="https://github.com/unn-corp/t3code/blob/main/docs/user/updating.md"
        target="_blank"
        rel="noreferrer"
      >
        Bootstrap updater on {serverLabel}
      </a>
    );
  }
  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    if (selfUpdate === "desktop-managed") {
      const confirmed = await requestConfirmDialog(
        `Request an update on ${serverLabel}? Installation waits for all registered work to stop, then the desktop app closes and relaunches.`,
      );
      if (confirmed === false) return;
    }
    await update({
      environmentId,
      serverLabel,
      selfUpdate,
      desktopAppUpdate,
      forkMaintenance,
      targetVersion,
    });
  };
  if (appearance === "icon")
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className={className}
              aria-label={`${label} for ${serverLabel}`}
              onClick={() => void handleUpdate()}
            />
          }
        >
          <CircleArrowUpIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  return (
    <Button size={size} variant={variant} className={className} onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}

export function OutdatedServerUpdateAction({
  environmentId,
  serverLabel,
  fromVersion,
  targetVersion,
  label = "Update",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly fromVersion: string | undefined;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const update = useAtomCommand(updateOutdatedServer, { reportFailure: false });
  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const result = await update({
        environmentId,
        input: { targetVersion },
        ...(fromVersion === undefined ? {} : { fromVersion }),
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `${serverLabel}: updater bootstrap required`,
        description: updateFailureMessage(error),
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };
  return (
    <Button size="xs" variant="outline" onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}

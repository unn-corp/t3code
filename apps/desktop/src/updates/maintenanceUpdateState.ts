import type { DesktopRuntimeInfo, DesktopUpdateState, ForkUpdateStatus } from "@t3tools/contracts";

import { createInitialDesktopUpdateState } from "./updateMachine.ts";

/** Phases in which an update payload is verified and staged on this device. */
const STAGED_PHASES: ReadonlySet<ForkUpdateStatus["phase"]> = new Set([
  "staged",
  "downloaded",
  "waiting",
  "installing",
  "verifying",
]);
/** An update action holds the controller; a second one is refused rather than queued behind it. */
export const ACTIVE_PHASES: ReadonlySet<ForkUpdateStatus["phase"]> = new Set([
  "checking",
  "downloading",
  "installing",
  "verifying",
]);
export const INSTALL_PHASES: ReadonlySet<ForkUpdateStatus["phase"]> = new Set([
  "installing",
  "verifying",
]);

/**
 * The legacy DesktopUpdateState shape (older renderers, the remote-update flow) derived from the one
 * controller. It is a view: nothing here decides whether an update may install, and there is no second
 * copy of update state to drift from the controller's.
 */
export function toDesktopUpdateState(input: {
  readonly status: ForkUpdateStatus;
  readonly currentVersion: string;
  readonly runtimeInfo: DesktopRuntimeInfo;
  readonly checkedAt: string | null;
  readonly disabledReason: string | null;
}): DesktopUpdateState {
  const { status } = input;
  const channel = status.policy.channel === "stable" ? "latest" : "nightly";
  const base = {
    ...createInitialDesktopUpdateState(input.currentVersion, input.runtimeInfo, channel),
    checkedAt: input.checkedAt,
  };
  if (input.disabledReason !== null) return { ...base, message: input.disabledReason };
  const target = status.targetBuild;
  const staged = target !== null && STAGED_PHASES.has(status.phase);
  const enabled = { ...base, enabled: true };
  if (status.phase === "checking") return { ...enabled, status: "checking" };
  if (status.phase === "downloading" && target !== null)
    return { ...enabled, status: "downloading", availableVersion: target.version };
  if (staged) {
    // A staged build that cannot install yet says why; the controller, not this view, enforces it.
    const waiting = status.blockers[0]?.label ?? null;
    return {
      ...enabled,
      status: "downloaded",
      availableVersion: target.version,
      downloadedVersion: target.version,
      downloadPercent: 100,
      message: waiting,
      canRetry: true,
    };
  }
  if (status.phase === "available" && target !== null)
    return { ...enabled, status: "available", availableVersion: target.version, canRetry: true };
  if (status.phase === "failed" || status.phase === "recovery") {
    return {
      ...enabled,
      status: "error",
      message: status.lastError ?? "The update did not complete.",
      errorContext: "install",
      canRetry: false,
    };
  }
  if (status.lastError !== undefined && status.lastError !== null) {
    const download = status.lastError.startsWith("Download failed");
    return {
      ...enabled,
      status: "error",
      message: status.lastError,
      errorContext: download ? "download" : "check",
      canRetry: target !== null,
    };
  }
  if (status.phase === "pinned")
    return {
      ...enabled,
      status: "up-to-date",
      message: "Updates are held on the build you rolled back to.",
    };
  return { ...enabled, status: input.checkedAt === null ? "idle" : "up-to-date" };
}

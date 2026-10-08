import type { ForkUpdateStatus } from "@t3tools/contracts";
import { formatBuildVersion } from "@t3tools/shared/buildVersion";

/** A coordinator may own multiple installations; aliases suppress only an explicitly identical target. */
export function sameForkReplacementTarget(
  left: ForkUpdateStatus | null,
  right: ForkUpdateStatus | null,
): boolean {
  return Boolean(
    left?.coordinatorId &&
    left.controllerId &&
    right?.coordinatorId === left.coordinatorId &&
    right.controllerId === left.controllerId,
  );
}

export const forkPhaseLabels: Record<ForkUpdateStatus["phase"], string> = {
  idle: "Up to date",
  checking: "Checking…",
  available: "Update available",
  downloading: "Downloading…",
  downloaded: "Downloaded; verification pending",
  staged: "Verified and ready to install",
  waiting: "Waiting to install",
  installing: "Installing…",
  verifying: "Verifying installation…",
  completed: "Update completed",
  failed: "Update failed",
  recovery: "Recovering…",
  pinned: "Build pinned",
};
export const forkWaitingLabels: Record<ForkUpdateStatus["blockers"][number]["reason"], string> = {
  "active-agents": "Agents are still working",
  "background-work": "Child or background work is running",
  commands: "A command has not finished",
  "unknown-participant": "A registered runtime cannot be verified",
  "idle-window": "Waiting for the idle window",
  "input-active": "Recent input on this device",
  uploads: "Uploads are unfinished",
  storage: "Insufficient recovery storage",
  launcher: "The installed launcher needs an upgrade",
  authorization: "Operating system authorization is needed",
  offline: "Release eligibility cannot be checked offline",
  transaction: "Another maintenance transaction is running",
  bootstrap: "This installation needs updater bootstrap",
  "automation-review": "Restored automation needs review",
};

/** Completed and pinned statuses describe the installed build; other transitions describe the target. */
export function forkStatusDisplayBuild(
  status: ForkUpdateStatus,
): ForkUpdateStatus["currentBuild"] | null {
  if (status.phase === "pinned" || status.phase === "completed") return status.currentBuild;
  return status.targetBuild;
}

/** Show a useful label when the pin identifies the installed build, retaining a short ref otherwise. */
export function forkPinnedBuildLabel(status: ForkUpdateStatus): string | null {
  const pinnedBuild = status.policy.pinnedBuild;
  if (pinnedBuild === null) return null;
  return pinnedBuild === status.currentBuild.artifactSha256
    ? `Pinned: ${formatBuildVersion(status.currentBuild)}`
    : `Pinned: ${pinnedBuild.slice(0, 12)}`;
}

export function forkStatusDescription(status: ForkUpdateStatus): string {
  if (status.lastError) return status.lastError;
  if (status.blockers.length)
    return status.blockers
      .map((blocker) => `${forkWaitingLabels[blocker.reason]}: ${blocker.label}`)
      .join("; ");
  return forkPhaseLabels[status.phase];
}
/** Settings renders the phase and alert separately; detail should add information rather than repeat either. */
export function forkStatusDetail(status: ForkUpdateStatus): string | null {
  if (!status.blockers.length) return null;
  return status.blockers
    .map((blocker) => `${forkWaitingLabels[blocker.reason]}: ${blocker.label}`)
    .join("; ");
}
/** Confirmation identity includes every restore cutoff; an asynchronously changed option is rejected. */
export function recoveryFingerprint(option: ForkUpdateStatus["recoveryOptions"][number]): string {
  return JSON.stringify([
    option.id,
    option.transactionId,
    option.build.artifactSha256,
    option.requiresDataRestore,
    [...option.homes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((home) => [
        home.id,
        home.restoreTimestamp,
        home.binaryCompatible,
        home.requiresPairing,
        home.additionalBytes,
      ]),
  ]);
}

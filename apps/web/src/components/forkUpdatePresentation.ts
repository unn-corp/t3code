import type { ForkUpdateStatus } from "@t3tools/contracts";
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
export function forkStatusDescription(status: ForkUpdateStatus): string {
  if (status.lastError) return status.lastError;
  if (status.blockers.length)
    return status.blockers
      .map((blocker) => `${forkWaitingLabels[blocker.reason]}: ${blocker.label}`)
      .join("; ");
  return forkPhaseLabels[status.phase];
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

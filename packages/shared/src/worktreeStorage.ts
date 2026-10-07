import type { WorktreeStorageSupport } from "@t3tools/contracts";

/** All selected hosts must support the setting before a shared control can enable it. */
export function worktreeStorageUnavailableReason(
  supports: readonly (WorktreeStorageSupport | null | undefined)[],
): string | null {
  if (supports.length === 0) return "Connect an environment to check copy-on-write support.";
  for (const support of supports) {
    if (support == null)
      return "Update the selected Arcwright Code server to a version that supports space-efficient worktrees.";
    if (!support.supported)
      return support.reason ?? "Copy-on-write file copies are unavailable on a selected server.";
  }
  return null;
}

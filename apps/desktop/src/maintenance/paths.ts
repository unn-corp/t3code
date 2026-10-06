// @effect-diagnostics nodeBuiltinImport:off — pure path arithmetic shared with the (non-Effect) maintenance core.
import * as NodePath from "node:path";

/**
 * Everything the maintenance controller keeps for this device lives under one
 * directory beside the data home, never inside the application directory an
 * installer replaces. Restore points are separate: they live in each data home
 * (`<home>/maintenance/restore-points`) next to the state they protect.
 */
export interface MaintenancePaths {
  readonly root: string;
  /** Update policy: channel, automatic installation, pin, failed digests. */
  readonly policy: string;
  /** Verified installer payloads, one directory per artifact digest. */
  readonly artifacts: string;
  /** Verified recovery helper and its Node runtime (shared forkRecoveryCache). */
  readonly recovery: string;
  /** One owner-only handoff plan per transaction, read by the external helper. */
  readonly handoff: string;
  /** Build identity digest to the verified installer cached for it. */
  readonly installerIndex: string;
  /** Build identity digest to the WSL runtime tree that build used. */
  readonly wslRuntimes: string;
  /** Confirmed WSL cohort membership. */
  readonly members: string;
  /** Digest and commit of the installation the last successful transaction recorded. */
  readonly installedBuild: string;
  /**
   * The desktop process registers as a participant of its own. Its "home" is this
   * directory, not a data home, so it never collides with the bundled server's home.
   */
  readonly processHome: string;
}

export const maintenancePaths = (
  baseDir: string,
  path: Pick<typeof NodePath, "join"> = NodePath,
): MaintenancePaths => {
  const root = path.join(baseDir, "maintenance");
  return {
    root,
    policy: path.join(root, "policy.json"),
    artifacts: path.join(root, "artifacts"),
    recovery: path.join(root, "recovery"),
    handoff: path.join(root, "handoff"),
    installerIndex: path.join(root, "installer-index.json"),
    wslRuntimes: path.join(root, "wsl-runtimes.json"),
    members: path.join(root, "wsl-members.json"),
    installedBuild: path.join(root, "installed-build.json"),
    processHome: path.join(root, "desktop-process"),
  };
};

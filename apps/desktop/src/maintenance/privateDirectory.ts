// @effect-diagnostics nodeBuiltinImport:off — a private directory is a filesystem fact decided by the host OS.
import * as NodeFSP from "node:fs/promises";
import { restrictWindowsAcl, type RestrictAccess } from "@t3tools/shared/forkMaintenanceSnapshot";

export interface PrivateDirectoryHost {
  readonly platform: NodeJS.Platform;
  readonly restrictWindows: RestrictAccess;
}

const hostDefaults: PrivateDirectoryHost = {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Non-Effect maintenance module: a Windows ACL or a POSIX mode is chosen by the host OS.
  platform: process.platform,
  restrictWindows: restrictWindowsAcl,
};

/**
 * A directory only the current user can enter, for everything the maintenance controller keeps (policy, payloads, handoff
 * plans, membership). A POSIX mode is not enough on Windows: there the helper cannot check ownership of a plan it reads, so
 * the plan is only as private as the ACL its directory hands down to every file created in it. Failing to make it private
 * is an error, never a warning: nothing is written into a directory that others can reach.
 */
export async function ensurePrivateDirectory(
  directory: string,
  host: PrivateDirectoryHost = hostDefaults,
): Promise<void> {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    if (host.platform === "win32") await host.restrictWindows(directory);
    else await NodeFSP.chmod(directory, 0o700);
  } catch (cause) {
    throw new Error(
      `${directory} could not be made private to this user: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

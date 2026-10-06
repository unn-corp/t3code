// @effect-diagnostics nodeBuiltinImport:off — the explicit Windows-to-distribution control channel is a wsl.exe invocation.
import * as NodeChildProcess from "node:child_process";
import type { Exec } from "@t3tools/shared/forkMaintenanceWsl";

/**
 * The Windows desktop reaches a WSL distribution through exactly one channel: `wsl.exe -d <distro> -- <t3>
 * maintenance ...`, the distribution's own staged `t3`. No hostname, address or `\\wsl$` path is used, and the
 * protocol spoken over it belongs to the shared coordinator (forkMaintenanceWsl). This module only runs commands
 * and learns where a managed distribution's runtime lives.
 */
export interface WslCommand {
  /** `-d <distro>` or empty for the default distribution. */
  readonly distroArgs: ReadonlyArray<string>;
  /** Login-shell PATH the backend runs with. */
  readonly path: string;
  /** The staged runtime: `[t3]` (self-contained) or `[node, entry]` (a source tree, development only). */
  readonly command: ReadonlyArray<string>;
}

/**
 * Recovers the runtime command from the start config of the running WSL backend:
 * `[...distroArgs, "--exec", "env", "PATH=...", ...command, "--bootstrap-fd", "0", ...]`.
 * Anything else is unrecognised and yields null, so a changed launch shape fails closed.
 */
export function wslCommandFromStartArgs(args: ReadonlyArray<string>): WslCommand | null {
  const exec = args.indexOf("--exec");
  const bootstrap = args.indexOf("--bootstrap-fd");
  if (exec < 0 || bootstrap < 0 || args[exec + 1] !== "env") return null;
  const pathEntry = args[exec + 2];
  if (pathEntry === undefined || !pathEntry.startsWith("PATH=")) return null;
  const command = args.slice(exec + 3, bootstrap);
  if (command.length === 0 || command.some((part) => part.length === 0)) return null;
  const distroArgs = args.slice(0, exec);
  if (
    distroArgs.length !== 0 &&
    (distroArgs.length !== 2 || distroArgs[0] !== "-d" || distroArgs[1]!.length === 0)
  )
    return null;
  return { distroArgs, path: pathEntry.slice("PATH=".length), command };
}

/** Only a self-contained runtime can run `maintenance` verbs on its own; a source tree needs a Node that may change. */
export const executableOf = (command: WslCommand | null): string | null =>
  command !== null && command.command.length === 1 && command.command[0]!.startsWith("/")
    ? command.command[0]!
    : null;

const execFileAsync = (command: string, args: ReadonlyArray<string>, timeout: number) =>
  new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    (resolve) => {
      NodeChildProcess.execFile(
        command,
        [...args],
        { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    },
  );

/** Copying databases is slow; status and fence verbs must not be. */
const SLOW_VERBS = new Set(["snapshot", "rescue", "restore", "verify", "prune"]);
export const DEFAULT_DISTRO_TIMEOUT_MS = 2 * 60_000;
export const LONG_DISTRO_TIMEOUT_MS = 20 * 60_000;

/** A failed or timed-out command is a result with a non-zero code, never a throw: the protocol turns it into a failure of the whole cohort. */
export const wslExec: Exec = (command, args) =>
  execFileAsync(
    command,
    args,
    args.some((arg) => SLOW_VERBS.has(arg)) ? LONG_DISTRO_TIMEOUT_MS : DEFAULT_DISTRO_TIMEOUT_MS,
  );

/**
 * The canonical home of the server running in a distribution: the real path of $T3CODE_HOME or ~/.t3, as the
 * distribution itself sees it. The same path identifies the home in snapshots and journals.
 */
export async function resolveWslHome(distro: string, exec: Exec = wslExec): Promise<string | null> {
  const script = 'dir="${T3CODE_HOME:-$HOME/.t3}"; cd "$dir" 2>/dev/null && pwd -P';
  const result = await exec("wsl.exe", ["-d", distro, "--exec", "sh", "-c", script]);
  const line = result.code === 0 ? (result.stdout.trim().split("\n").at(-1)?.trim() ?? "") : "";
  return line.startsWith("/") ? line : null;
}

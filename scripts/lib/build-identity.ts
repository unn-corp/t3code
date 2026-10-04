// @effect-diagnostics nodeBuiltinImport:off globalDate:off — build configuration executes before Effect services exist.
import * as NodeChildProcess from "node:child_process";

/** Resolve once at build time; installed clients never need a Git checkout. */
export function buildIdentity(version: string) {
  let commit: string | null = process.env.APP_BUILD_COMMIT?.trim() || null;
  let dirty = false;
  if (!commit) {
    try {
      commit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      dirty =
        NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() !== "";
    } catch {
      /* Release builders can supply APP_BUILD_COMMIT without Git. */
    }
  }
  return {
    version,
    commit,
    dirty,
    builtAt: process.env.APP_BUILD_DATE?.trim() || new Date().toISOString(),
    label: process.env.APP_BUILD_LABEL?.trim() || null,
  };
}

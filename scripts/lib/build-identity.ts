// @effect-diagnostics nodeBuiltinImport:off globalDate:off — build configuration executes before Effect services exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export function forkUpstreamIdentity(
  file: URL = new URL("../../fork-upstream.json", import.meta.url),
): { upstreamVersion?: string; upstreamCommit?: string } {
  try {
    const metadata: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      !("upstreamVersion" in metadata) ||
      typeof metadata.upstreamVersion !== "string" ||
      !("upstreamCommit" in metadata) ||
      typeof metadata.upstreamCommit !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(metadata.upstreamVersion) ||
      !/^[a-f0-9]{40}$/.test(metadata.upstreamCommit)
    )
      throw new Error("Invalid included upstream identity");
    return { upstreamVersion: metadata.upstreamVersion, upstreamCommit: metadata.upstreamCommit };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

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
    ...forkUpstreamIdentity(),
    ...(() => {
      const nightly = /-nightly\.\d{8}\.(\d+)$/.exec(version);
      const number = Number(nightly?.[1] ?? process.env.ARCWRIGHT_BUILD_NUMBER);
      return Number.isSafeInteger(number) && number > 0 ? { forkBuildNumber: number } : {};
    })(),
    commit,
    dirty,
    builtAt: process.env.APP_BUILD_DATE?.trim() || new Date().toISOString(),
    label: process.env.APP_BUILD_LABEL?.trim() || null,
  };
}

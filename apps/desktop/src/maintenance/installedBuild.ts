// @effect-diagnostics nodeBuiltinImport:off globalDate:off — the record is one small file beside the data home.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ForkBuildIdentity } from "@t3tools/contracts";
import { deriveBuildIdentity } from "@t3tools/shared/forkMaintenanceController";
import * as Schema from "effect/Schema";
import { ensurePrivateDirectory } from "./privateDirectory.ts";

const Recorded = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  artifactSha256: Schema.String,
  installationSequence: Schema.Int,
});
export type RecordedBuild = typeof Recorded.Type;
const decodeRecorded = Schema.decodeUnknownSync(Recorded);

export async function readRecordedBuild(file: string): Promise<RecordedBuild | null> {
  try {
    return decodeRecorded(JSON.parse(await NodeFSP.readFile(file, "utf8")));
  } catch {
    // Unreadable or absent: the identity is then derived, which still pins and restores correctly.
    return null;
  }
}

export async function writeRecordedBuild(file: string, build: RecordedBuild): Promise<void> {
  await ensurePrivateDirectory(NodePath.dirname(file));
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(build));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
}

/**
 * The running build. A recorded digest is trusted only for the version it was recorded for: after a
 * manual reinstall of another version the record is stale and the identity is derived again.
 */
export function resolveCurrentBuild(input: {
  readonly version: string;
  readonly commit: string | null;
  readonly recorded: RecordedBuild | null;
}): ForkBuildIdentity {
  const matches = input.recorded !== null && input.recorded.version === input.version;
  const identity = deriveBuildIdentity({
    version: input.version,
    commit: matches ? input.recorded!.commit : input.commit,
    recordedArtifactSha256: matches ? input.recorded!.artifactSha256 : null,
  });
  return matches
    ? { ...identity, installationSequence: input.recorded!.installationSequence }
    : identity;
}

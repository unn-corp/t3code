// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Fixed-argv Git reads require raw bounded bytes and a kill timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";

const GIT = "/usr/bin/git";
const GIT_TIMEOUT_MS = 5_000;
const MAX_ARTIFACT_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 4 * 1024;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface OrganizationGitResultProofInput {
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly reviewedArtifactBytes: Uint8Array;
}

export interface OrganizationGitResultProof {
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly relativePath: string;
  readonly reviewedArtifactDigest: string;
}

export class OrganizationGitResultProofError extends Schema.TaggedError<OrganizationGitResultProofError>()(
  "OrganizationGitResultProofError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationGitResultProofError["code"], message: string) =>
  new OrganizationGitResultProofError({ code, message });
const isProofError = Schema.is(OrganizationGitResultProofError);

/** Git receives fixed options and bounded stdout. Neither shell nor hooks are used. */
function git(cwd: string, args: readonly string[], maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(GIT, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let error: OrganizationGitResultProofError | null = null;
    const timer = setTimeout(() => {
      error = failure("unavailable", "Pinned Git result verification timed out.");
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (error) return;
      length += chunk.byteLength;
      if (length > maxBytes) {
        error = failure("invalid", "Pinned Git result exceeds its byte limit.");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr?.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(failure("unavailable", "Pinned Git result could not be read."));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (exitCode !== 0)
        reject(failure("not_found", "Pinned Git result or commit was not found."));
      else resolve(Buffer.concat(chunks, length));
    });
  });
}

/**
 * Read-only proof for a single-file candidate commit. A caller must separately
 * recheck current Project authority and branch state before any integration.
 */
export function proveOrganizationGitResult(
  callerInput: OrganizationGitResultProofInput,
): Effect.Effect<OrganizationGitResultProof, OrganizationGitResultProofError> {
  if (
    !(callerInput.reviewedArtifactBytes instanceof Uint8Array) ||
    callerInput.reviewedArtifactBytes.byteLength === 0 ||
    callerInput.reviewedArtifactBytes.byteLength > MAX_ARTIFACT_BYTES
  )
    return Effect.fail(failure("invalid", "Reviewed artifact bytes are invalid or oversized."));
  const input = {
    projectRoot: callerInput.projectRoot,
    baseCommit: callerInput.baseCommit,
    resultCommit: callerInput.resultCommit,
    reviewedArtifactBytes: Uint8Array.from(callerInput.reviewedArtifactBytes),
  } satisfies OrganizationGitResultProofInput;
  if (
    !NodePath.isAbsolute(input.projectRoot) ||
    !FULL_OID.test(input.baseCommit) ||
    !FULL_OID.test(input.resultCommit) ||
    input.baseCommit === input.resultCommit ||
    input.reviewedArtifactBytes.byteLength === 0
  )
    return Effect.fail(failure("invalid", "Git result proof input is invalid."));
  let artifact: ReturnType<typeof decodeOrganizationSingleFileArtifact>;
  try {
    artifact = decodeOrganizationSingleFileArtifact(input.reviewedArtifactBytes);
  } catch {
    return Effect.fail(failure("invalid", "Reviewed single-file artifact is invalid."));
  }
  if (artifact.baseCommit !== input.baseCommit)
    return Effect.fail(failure("conflict", "Reviewed artifact has a different pinned base."));
  const read = (cwd: string, args: readonly string[], maxBytes: number) =>
    Effect.tryPromise({
      try: () => git(cwd, args, maxBytes),
      catch: (cause) =>
        isProofError(cause)
          ? cause
          : failure("unavailable", "Pinned Git result could not be read."),
    });
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.projectRoot),
      catch: () => failure("unavailable", "Project root could not be resolved."),
    });
    const top = (yield* read(root, ["rev-parse", "--show-toplevel"], MAX_METADATA_BYTES))
      .toString("utf8")
      .trim();
    if (!NodePath.isAbsolute(top))
      return yield* failure("conflict", "Project root is not the Git repository root.");
    const canonicalTop = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(top),
      catch: () => failure("unavailable", "Git repository root could not be resolved."),
    });
    if (root !== canonicalTop)
      return yield* failure("conflict", "Project root is not the Git repository root.");
    for (const commit of [input.baseCommit, input.resultCommit]) {
      const type = (yield* read(root, ["cat-file", "-t", commit], 32)).toString("ascii").trim();
      if (type !== "commit")
        return yield* failure("conflict", "Pinned revision is not a Git commit.");
    }
    // Read the raw commit object: rev-list can honor local grafts.
    const rawCommit = yield* read(root, ["cat-file", "-p", input.resultCommit], 16 * 1024);
    const headerEnd = rawCommit.indexOf("\n\n");
    if (headerEnd < 0) return yield* failure("conflict", "Result commit has invalid Git headers.");
    const parents = rawCommit
      .subarray(0, headerEnd)
      .toString("ascii")
      .split("\n")
      .filter((line) => line.startsWith("parent "));
    if (parents.length !== 1 || parents[0] !== `parent ${input.baseCommit}`)
      return yield* failure("conflict", "Result commit is not a direct child of the pinned base.");
    const changed = (yield* read(
      root,
      [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "-r",
        "-z",
        input.baseCommit,
        input.resultCommit,
      ],
      MAX_METADATA_BYTES,
    ))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (changed.length !== 1 || changed[0] !== artifact.relativePath)
      return yield* failure("conflict", "Result commit changes files outside the reviewed path.");
    const treeEntry = (commit: string) =>
      read(
        root,
        ["ls-tree", "-z", "--full-tree", commit, "--", artifact.relativePath],
        MAX_METADATA_BYTES,
      );
    const parseEntry = (raw: Buffer) => {
      const listing = raw.toString("utf8").split("\0").filter(Boolean);
      if (listing.length !== 1) return null;
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(
        listing[0] ?? "",
      );
      const mode = match?.[1];
      const oid = match?.[2];
      if (!mode || !oid || match?.[3] !== artifact.relativePath) return null;
      return { mode, oid };
    };
    const baseEntry = parseEntry(yield* treeEntry(input.baseCommit));
    const resultEntry = parseEntry(yield* treeEntry(input.resultCommit));
    if (
      !baseEntry ||
      !resultEntry ||
      baseEntry.mode !== artifact.baseMode ||
      resultEntry.mode !== artifact.baseMode ||
      baseEntry.oid !== artifact.baseBlobOid
    )
      return yield* failure(
        "conflict",
        "Result file mode or pinned blob differs from the reviewed artifact.",
      );
    for (const entry of [baseEntry, resultEntry]) {
      const objectType = (yield* read(root, ["cat-file", "-t", entry.oid], 32))
        .toString("ascii")
        .trim();
      if (objectType !== "blob")
        return yield* failure("conflict", "Reviewed file entry does not reference a Git blob.");
    }
    const baseBytes = yield* read(root, ["cat-file", "-p", baseEntry.oid], MAX_SOURCE_BYTES + 1);
    if (NodeCrypto.createHash("sha256").update(baseBytes).digest("hex") !== artifact.baseSha256)
      return yield* failure(
        "conflict",
        "Pinned base file bytes differ from the reviewed artifact.",
      );
    const resultBytes = yield* read(
      root,
      ["cat-file", "-p", resultEntry.oid],
      MAX_SOURCE_BYTES + 1,
    );
    if (!resultBytes.equals(Buffer.from(artifact.replacementBytes)))
      return yield* failure(
        "conflict",
        "Result commit does not contain the reviewed replacement bytes.",
      );
    return {
      baseCommit: input.baseCommit,
      resultCommit: input.resultCommit,
      relativePath: artifact.relativePath,
      reviewedArtifactDigest: NodeCrypto.createHash("sha256")
        .update(input.reviewedArtifactBytes)
        .digest("hex"),
    } satisfies OrganizationGitResultProof;
  });
}

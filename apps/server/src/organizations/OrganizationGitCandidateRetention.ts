// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Fixed-argv Git ref commands need bounded raw output and an OS kill timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  proveOrganizationGitResult,
  type OrganizationGitResultProof,
} from "./OrganizationGitResultProof.ts";

const GIT = "/usr/bin/git";
const GIT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 4 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PRIVATE_REF_PREFIX = "refs/t3-organizations/candidates/";
const SAFE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
  "-c",
  "core.logAllRefUpdates=false",
] as const;

export interface OrganizationGitCandidateRetentionInput {
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly reviewedArtifactBytes: Uint8Array;
}
export interface OrganizationGitCandidateRetentionResult {
  readonly refName: string;
  readonly resultCommit: string;
  readonly proof: OrganizationGitResultProof;
  readonly created: boolean;
}
export interface OrganizationGitCandidateRefInspectionInput {
  readonly projectRoot: string;
  readonly reviewedArtifactBytes: Uint8Array;
}
export type OrganizationGitCandidateRefInspection =
  | { readonly status: "absent"; readonly refName: string }
  | { readonly status: "present"; readonly refName: string; readonly resultCommit: string };

export class OrganizationGitCandidateRetentionError extends Schema.TaggedError<OrganizationGitCandidateRetentionError>()(
  "OrganizationGitCandidateRetentionError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationGitCandidateRetentionError["code"], message: string) =>
  new OrganizationGitCandidateRetentionError({ code, message });
const isRetentionError = Schema.is(OrganizationGitCandidateRetentionError);

type GitResult = { readonly exitCode: number; readonly stdout: Buffer };
/** Ref commands use only fixed arguments and a clean environment; stderr is never returned. */
function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(GIT, [...SAFE_CONFIG, ...args], {
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
    let size = 0;
    let commandError: OrganizationGitCandidateRetentionError | null = null;
    const timer = setTimeout(() => {
      commandError = failure("unavailable", "Git candidate retention timed out.");
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (commandError) return;
      size += chunk.byteLength;
      if (size > MAX_OUTPUT_BYTES) {
        commandError = failure("unavailable", "Git ref output exceeded its bound.");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr?.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(failure("unavailable", "Git candidate retention could not start."));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (commandError) reject(commandError);
      else if (exitCode === null)
        reject(failure("unavailable", "Git ref command was interrupted."));
      else resolve({ exitCode, stdout: Buffer.concat(chunks, size) });
    });
  });
}

async function assertSafeRefPath(root: string, gitCommonDir: string, digest: string) {
  const gitEntry = await NodeFSP.lstat(NodePath.join(root, ".git")).catch(() => {
    throw failure("conflict", "Project Git metadata is unavailable.");
  });
  if (!gitEntry.isDirectory() || gitEntry.isSymbolicLink())
    throw failure("conflict", "Project Git metadata is not a private directory.");
  const expected = await NodeFSP.realpath(NodePath.join(root, ".git")).catch(() => {
    throw failure("conflict", "Project Git metadata could not be resolved.");
  });
  const common = await NodeFSP.realpath(gitCommonDir).catch(() => {
    throw failure("conflict", "Git common directory could not be resolved.");
  });
  if (common !== expected)
    throw failure("conflict", "Git common directory is outside the Project repository.");
  const refs = await NodeFSP.lstat(NodePath.join(common, "refs")).catch(() => {
    throw failure("conflict", "Git files ref directory is unavailable.");
  });
  if (!refs.isDirectory() || refs.isSymbolicLink())
    throw failure("conflict", "Git files ref directory is not a real directory.");

  const check = async (parts: readonly string[], leafIsFile = false) => {
    let path = common;
    for (let index = 0; index < parts.length; index++) {
      path = NodePath.join(path, parts[index]!);
      const stat = await NodeFSP.lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw failure("unavailable", "Git ref metadata could not be inspected.");
      });
      if (stat === null) return;
      if (stat.isSymbolicLink())
        throw failure("conflict", "Git ref metadata contains a symbolic link.");
      const isLeaf = index === parts.length - 1;
      if (isLeaf && leafIsFile ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
        throw failure("conflict", "Git ref metadata has an unexpected file type.");
    }
  };
  await check(["refs", "t3-organizations", "candidates", digest], true);
  await check(["logs", "refs", "t3-organizations", "candidates", digest], true);
  await check(["packed-refs"], true);
}

/** Reads only the exact private ref after checking the files backend and static ref paths. */
export function inspectOrganizationGitCandidateRef(
  callerInput: OrganizationGitCandidateRefInspectionInput,
): Effect.Effect<OrganizationGitCandidateRefInspection, OrganizationGitCandidateRetentionError> {
  if (
    typeof callerInput.projectRoot !== "string" ||
    !NodePath.isAbsolute(callerInput.projectRoot) ||
    !(callerInput.reviewedArtifactBytes instanceof Uint8Array) ||
    callerInput.reviewedArtifactBytes.byteLength === 0 ||
    callerInput.reviewedArtifactBytes.byteLength > MAX_ARTIFACT_BYTES
  )
    return Effect.fail(failure("invalid", "Candidate ref inspection input is invalid."));
  const projectRoot = callerInput.projectRoot;
  const digest = NodeCrypto.createHash("sha256")
    .update(Uint8Array.from(callerInput.reviewedArtifactBytes))
    .digest("hex");
  const refName = `${PRIVATE_REF_PREFIX}${digest}`;
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(projectRoot),
      catch: () => failure("unavailable", "Project root could not be resolved."),
    });
    const git = (args: readonly string[]) =>
      Effect.tryPromise({
        try: () => runGit(root, args),
        catch: (cause) =>
          isRetentionError(cause) ? cause : failure("unavailable", "Git ref command failed."),
      });
    const topResult = yield* git(["rev-parse", "--show-toplevel"]);
    const top = topResult.stdout.toString("utf8").trim();
    if (topResult.exitCode !== 0 || !NodePath.isAbsolute(top))
      return yield* failure("conflict", "Project root is not the Git repository root.");
    const canonicalTop = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(top),
      catch: () => failure("unavailable", "Git repository root could not be resolved."),
    });
    if (canonicalTop !== root)
      return yield* failure("conflict", "Project root is not the Git repository root.");
    const format = yield* git(["rev-parse", "--show-ref-format"]);
    if (format.exitCode !== 0 || format.stdout.toString("ascii").trim() !== "files")
      return yield* failure("conflict", "Only the Git files ref format is supported.");
    const commonResult = yield* git(["rev-parse", "--git-common-dir"]);
    const commonText = commonResult.stdout.toString("utf8").trim();
    if (commonResult.exitCode !== 0 || !commonText || commonText.includes("\0"))
      return yield* failure("conflict", "Git common directory is invalid.");
    const common = NodePath.resolve(root, commonText);
    yield* Effect.tryPromise({
      try: () => assertSafeRefPath(root, common, digest),
      catch: (cause) =>
        isRetentionError(cause) ? cause : failure("unavailable", "Git ref path check failed."),
    });
    const state = yield* git([
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(symref)",
      refName,
    ]);
    if (state.exitCode !== 0)
      return yield* failure("unavailable", "Private candidate ref could not be inspected.");
    if (state.stdout.byteLength === 0) {
      const looseExists = yield* Effect.tryPromise({
        try: () =>
          NodeFSP.lstat(NodePath.join(common, "refs", "t3-organizations", "candidates", digest))
            .then(() => true)
            .catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
              throw error;
            }),
        catch: () => failure("unavailable", "Private candidate ref could not be inspected."),
      });
      if (looseExists)
        return yield* failure("conflict", "Private candidate ref exists but Git cannot read it.");
      return { status: "absent", refName };
    }
    const [savedRef, savedCommit, symref, extra] = state.stdout
      .toString("ascii")
      .trimEnd()
      .split("\0");
    if (savedRef !== refName || !FULL_OID.test(savedCommit ?? "") || extra !== undefined)
      return yield* failure("unavailable", "Private candidate ref is malformed.");
    if (symref) return yield* failure("conflict", "Private candidate ref is symbolic.");
    return { status: "present", refName, resultCommit: savedCommit! };
  });
}

/** No transport or live authority mounts this primitive. Only a private, never-overwritten ref is written. */
export function retainOrganizationGitCandidate(
  callerInput: OrganizationGitCandidateRetentionInput,
): Effect.Effect<OrganizationGitCandidateRetentionResult, OrganizationGitCandidateRetentionError> {
  if (
    typeof callerInput.projectRoot !== "string" ||
    !NodePath.isAbsolute(callerInput.projectRoot) ||
    !FULL_OID.test(callerInput.baseCommit) ||
    !FULL_OID.test(callerInput.resultCommit) ||
    callerInput.baseCommit.length !== callerInput.resultCommit.length ||
    !(callerInput.reviewedArtifactBytes instanceof Uint8Array) ||
    callerInput.reviewedArtifactBytes.byteLength === 0 ||
    callerInput.reviewedArtifactBytes.byteLength > MAX_ARTIFACT_BYTES
  )
    return Effect.fail(failure("invalid", "Candidate retention input is invalid."));
  const input = {
    projectRoot: callerInput.projectRoot,
    baseCommit: callerInput.baseCommit,
    resultCommit: callerInput.resultCommit,
    reviewedArtifactBytes: Uint8Array.from(callerInput.reviewedArtifactBytes),
  } satisfies OrganizationGitCandidateRetentionInput;
  const artifactDigest = NodeCrypto.createHash("sha256")
    .update(input.reviewedArtifactBytes)
    .digest("hex");
  const refName = `${PRIVATE_REF_PREFIX}${artifactDigest}`;
  return Effect.gen(function* () {
    // Proof rereads exact Git objects and canonical artifact before any ref write.
    const proof = yield* proveOrganizationGitResult(input).pipe(
      Effect.mapError((error) => failure(error.code, error.message)),
    );
    if (
      proof.baseCommit !== input.baseCommit ||
      proof.resultCommit !== input.resultCommit ||
      proof.reviewedArtifactDigest !== artifactDigest
    )
      return yield* failure("conflict", "Candidate proof does not match the requested ref.");
    const before = yield* inspectOrganizationGitCandidateRef(input);
    if (before.refName !== refName)
      return yield* failure("conflict", "Candidate ref name differs from reviewed bytes.");
    if (before.status === "present") {
      if (before.resultCommit !== input.resultCommit)
        return yield* failure("conflict", "Private candidate ref already names another commit.");
      return { refName, resultCommit: input.resultCommit, proof, created: false };
    }
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.projectRoot),
      catch: () => failure("unavailable", "Project root could not be resolved."),
    });
    const git = (args: readonly string[]) =>
      Effect.tryPromise({
        try: () => runGit(root, args),
        catch: (cause) =>
          isRetentionError(cause) ? cause : failure("unavailable", "Git ref command failed."),
      });
    // --no-deref protects the ref itself; the path check rejects pre-existing filesystem pivots.
    // Concurrent same-UID mutation of .git internals is outside this local primitive's trust boundary.
    const created = yield* git([
      "update-ref",
      "--no-deref",
      refName,
      input.resultCommit,
      "0".repeat(input.resultCommit.length),
    ]);
    const after = yield* inspectOrganizationGitCandidateRef(input);
    if (after.status !== "present" || after.resultCommit !== input.resultCommit)
      return yield* failure("conflict", "Private candidate ref already names another commit.");
    return { refName, resultCommit: input.resultCommit, proof, created: created.exitCode === 0 };
  });
}

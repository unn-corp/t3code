// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Fixed-argv Git plumbing needs raw stdin/stdout and an OS kill timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  proveOrganizationGitResult,
  type OrganizationGitResultProof,
} from "./OrganizationGitResultProof.ts";
import { readOrganizationPatchSource } from "./OrganizationPatchSourceReader.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";

const GIT = "/usr/bin/git";
const MAX_ARTIFACT_BYTES = 128 * 1024;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
] as const;

export interface OrganizationGitCandidateBuilderInput {
  readonly projectRoot: string;
  readonly reviewedArtifactBytes: Uint8Array;
}
export interface OrganizationGitCandidateBuilderResult {
  readonly resultCommit: string;
  readonly proof: OrganizationGitResultProof;
}

export class OrganizationGitCandidateBuilderError extends Schema.TaggedError<OrganizationGitCandidateBuilderError>()(
  "OrganizationGitCandidateBuilderError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationGitCandidateBuilderError["code"], message: string) =>
  new OrganizationGitCandidateBuilderError({ code, message });
const isBuilderError = Schema.is(OrganizationGitCandidateBuilderError);

/** No inherited Git variables, repo scripts, user identity, shell, or remote access. */
function runGit(
  cwd: string,
  args: readonly string[],
  indexFile: string,
  stdin?: Uint8Array,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(GIT, [...SAFE_CONFIG, ...args], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_INDEX_FILE: indexFile,
        GIT_AUTHOR_NAME: "T3 Organization Candidate",
        GIT_AUTHOR_EMAIL: "organization-candidate@t3.invalid",
        GIT_COMMITTER_NAME: "T3 Organization Candidate",
        GIT_COMMITTER_EMAIL: "organization-candidate@t3.invalid",
      },
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let error: OrganizationGitCandidateBuilderError | null = null;
    const timer = setTimeout(() => {
      error = failure("unavailable", "Git candidate construction timed out.");
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (error) return;
      length += chunk.byteLength;
      if (length > MAX_GIT_OUTPUT_BYTES) {
        error = failure("unavailable", "Git candidate command output exceeded its bound.");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr?.on("data", () => {}); // Drain without exposing repository paths.
    child.stdin?.on("error", () => {}); // Git can exit before consuming stdin.
    child.once("error", () => {
      clearTimeout(timer);
      reject(failure("unavailable", "Git candidate command could not start."));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (exitCode !== 0) reject(failure("unavailable", "Git candidate command failed."));
      else resolve(Buffer.concat(chunks, length));
    });
    child.stdin?.end(stdin ? Buffer.from(stdin) : undefined);
  });
}

/** Creates an unreachable candidate commit; the Project's refs, index and checkout stay untouched. */
export function buildOrganizationGitCandidate(
  callerInput: OrganizationGitCandidateBuilderInput,
): Effect.Effect<OrganizationGitCandidateBuilderResult, OrganizationGitCandidateBuilderError> {
  if (
    typeof callerInput.projectRoot !== "string" ||
    !NodePath.isAbsolute(callerInput.projectRoot) ||
    !(callerInput.reviewedArtifactBytes instanceof Uint8Array) ||
    callerInput.reviewedArtifactBytes.byteLength === 0 ||
    callerInput.reviewedArtifactBytes.byteLength > MAX_ARTIFACT_BYTES
  )
    return Effect.fail(failure("invalid", "Candidate input is invalid or oversized."));
  // Capture caller-owned bytes before the first asynchronous operation.
  const input = {
    projectRoot: callerInput.projectRoot,
    reviewedArtifactBytes: Uint8Array.from(callerInput.reviewedArtifactBytes),
  } satisfies OrganizationGitCandidateBuilderInput;
  let artifact: ReturnType<typeof decodeOrganizationSingleFileArtifact>;
  try {
    artifact = decodeOrganizationSingleFileArtifact(input.reviewedArtifactBytes);
  } catch {
    return Effect.fail(failure("invalid", "Reviewed single-file artifact is invalid."));
  }
  if (artifact.replacementSha256 === artifact.baseSha256)
    return Effect.fail(failure("conflict", "Replacement does not change the pinned file."));
  return Effect.gen(function* () {
    const source = yield* readOrganizationPatchSource(
      { projectRoot: input.projectRoot, baseCommit: artifact.baseCommit },
      artifact.relativePath,
    ).pipe(Effect.mapError((error) => failure(error.code, error.message)));
    if (
      source.baseCommit !== artifact.baseCommit ||
      source.relativePath !== artifact.relativePath ||
      source.blobOid !== artifact.baseBlobOid ||
      source.baseMode !== artifact.baseMode ||
      source.sha256 !== artifact.baseSha256
    )
      return yield* failure("conflict", "Pinned source differs from the reviewed artifact.");
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.projectRoot),
      catch: () => failure("unavailable", "Project root could not be resolved."),
    });
    const privateDir = yield* Effect.tryPromise({
      try: () => NodeFSP.mkdtemp("/tmp/t3-org-candidate-index-"),
      catch: () => failure("unavailable", "Private Git index could not be allocated."),
    });
    const indexFile = NodePath.join(privateDir, "index");
    const git = (args: readonly string[], stdin?: Uint8Array) =>
      Effect.tryPromise({
        try: () => runGit(root, args, indexFile, stdin),
        catch: (cause) =>
          isBuilderError(cause) ? cause : failure("unavailable", "Git candidate command failed."),
      });
    return yield* Effect.gen(function* () {
      const blobOid = (yield* git(["hash-object", "-w", "--stdin"], artifact.replacementBytes))
        .toString("ascii")
        .trim();
      if (!FULL_OID.test(blobOid) || blobOid.length !== artifact.baseCommit.length)
        return yield* failure("unavailable", "Git returned an invalid replacement object ID.");
      yield* git(["read-tree", artifact.baseCommit]);
      yield* git([
        "update-index",
        "--add",
        "--cacheinfo",
        `${artifact.baseMode},${blobOid},${artifact.relativePath}`,
      ]);
      const treeOid = (yield* git(["write-tree"])).toString("ascii").trim();
      if (!FULL_OID.test(treeOid) || treeOid.length !== artifact.baseCommit.length)
        return yield* failure("unavailable", "Git returned an invalid candidate tree ID.");
      const resultCommit = (yield* git([
        "commit-tree",
        treeOid,
        "-p",
        artifact.baseCommit,
        "-m",
        "T3 Organization candidate",
      ]))
        .toString("ascii")
        .trim();
      if (!FULL_OID.test(resultCommit) || resultCommit.length !== artifact.baseCommit.length)
        return yield* failure("unavailable", "Git returned an invalid candidate commit ID.");
      const proof = yield* proveOrganizationGitResult({
        projectRoot: root,
        baseCommit: artifact.baseCommit,
        resultCommit,
        reviewedArtifactBytes: input.reviewedArtifactBytes,
      }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
      return { resultCommit, proof } satisfies OrganizationGitCandidateBuilderResult;
    }).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () => NodeFSP.rm(privateDir, { recursive: true, force: true }),
          catch: () => failure("unavailable", "Private Git index cleanup failed."),
        }).pipe(Effect.orDie),
      ),
    );
  });
}

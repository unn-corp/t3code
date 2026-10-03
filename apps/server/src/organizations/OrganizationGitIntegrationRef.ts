// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Fixed-argv Git commands use bounded raw output and an OS kill timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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

export class OrganizationGitIntegrationRefError extends Schema.TaggedError<OrganizationGitIntegrationRefError>()(
  "OrganizationGitIntegrationRefError",
  { code: Schema.Literals(["invalid", "conflict", "unavailable"]), message: Schema.String },
) {}
const failure = (code: OrganizationGitIntegrationRefError["code"], message: string) =>
  new OrganizationGitIntegrationRefError({ code, message });
const isRefError = Schema.is(OrganizationGitIntegrationRefError);

export interface OrganizationGitIntegrationRefInput {
  readonly projectRoot: string;
  readonly targetRef: string;
  readonly baseCommit: string;
  readonly resultCommit: string;
  /** Only a caller with a matching durable intent from an earlier invocation may adopt this state. */
  readonly allowAlreadyApplied: boolean;
}
export interface OrganizationGitIntegrationRefResult {
  readonly targetRef: string;
  readonly previousCommit: string;
  readonly resultCommit: string;
  readonly appliedNow: boolean;
}
export type OrganizationGitIntegrationAppliedInput = Omit<
  OrganizationGitIntegrationRefInput,
  "allowAlreadyApplied"
>;

function runGit(cwd: string, args: readonly string[], maxBytes = 8192) {
  return new Promise<{ exitCode: number; stdout: Buffer }>((resolve, reject) => {
    const child = NodeChildProcess.spawn("/usr/bin/git", [...SAFE_CONFIG, ...args], {
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
    let commandError: OrganizationGitIntegrationRefError | null = null;
    const timer = setTimeout(() => {
      commandError = failure("unavailable", "Git target operation timed out.");
      child.kill("SIGKILL");
    }, 5000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (commandError) return;
      length += chunk.byteLength;
      if (length > maxBytes) {
        commandError = failure("unavailable", "Git target output exceeded its limit.");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr?.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(failure("unavailable", "Git target command could not start."));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (commandError) reject(commandError);
      else if (exitCode === null) reject(failure("unavailable", "Git target command stopped."));
      else resolve({ exitCode, stdout: Buffer.concat(chunks, length) });
    });
  });
}

async function assertSafeMetadata(root: string, commonText: string, targetRef: string) {
  const gitEntry = await NodeFSP.lstat(NodePath.join(root, ".git"));
  if (!gitEntry.isDirectory() || gitEntry.isSymbolicLink())
    throw failure("conflict", "Project Git metadata is not a private directory.");
  const expected = await NodeFSP.realpath(NodePath.join(root, ".git"));
  const common = await NodeFSP.realpath(NodePath.resolve(root, commonText));
  if (common !== expected)
    throw failure("conflict", "Git common directory is outside the Project repository.");
  const refs = await NodeFSP.lstat(NodePath.join(common, "refs"));
  if (!refs.isDirectory() || refs.isSymbolicLink())
    throw failure("conflict", "Git refs directory is unsafe.");
  const branch = targetRef.slice("refs/heads/".length);
  for (const parts of [
    ["refs", "heads", branch],
    ["logs", "refs", "heads", branch],
    ["packed-refs"],
  ]) {
    let path = common;
    for (let index = 0; index < parts.length; index++) {
      path = NodePath.join(path, parts[index]!);
      const stat = await NodeFSP.lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!stat) break;
      if (stat.isSymbolicLink()) throw failure("conflict", "Git target metadata is symbolic.");
      if (index === parts.length - 1) {
        if (!stat.isFile() || stat.nlink !== 1)
          throw failure("conflict", "Git target metadata is not a private regular file.");
      } else if (!stat.isDirectory())
        throw failure("conflict", "Git target metadata has an unsafe ancestor.");
    }
  }
}

/** Disconnected target-ref CAS. No transport, runtime layer, or production caller mounts it. */
export function compareAndSwapOrganizationGitTarget(
  callerInput: OrganizationGitIntegrationRefInput,
): Effect.Effect<OrganizationGitIntegrationRefResult, OrganizationGitIntegrationRefError> {
  return targetOperation(callerInput, false);
}

/** Uses the same repository, worktree and symbolic-ref checks; never issues update-ref. */
export function verifyOrganizationGitTargetApplied(
  input: OrganizationGitIntegrationAppliedInput,
): Effect.Effect<OrganizationGitIntegrationRefResult, OrganizationGitIntegrationRefError> {
  return targetOperation({ ...input, allowAlreadyApplied: true }, true);
}

/** Admission preflight uses the same bounded Git and metadata checks as CAS, without writing a ref. */
export function preflightOrganizationGitTarget(input: {
  readonly projectRoot: string;
  readonly targetRef: string;
  readonly baseCommit: string;
}): Effect.Effect<void, OrganizationGitIntegrationRefError> {
  if (
    !NodePath.isAbsolute(input.projectRoot) ||
    !TARGET_REF.test(input.targetRef) ||
    input.targetRef.endsWith(".") ||
    input.targetRef.endsWith(".lock") ||
    input.targetRef.includes("..") ||
    !FULL_OID.test(input.baseCommit)
  )
    return Effect.fail(failure("invalid", "Git target preflight input is invalid."));
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.projectRoot),
      catch: () => failure("unavailable", "Project root could not be resolved."),
    });
    const git = (args: readonly string[], maxBytes?: number) =>
      Effect.tryPromise({
        try: () => runGit(root, args, maxBytes),
        catch: (cause) =>
          isRefError(cause) ? cause : failure("unavailable", "Git target command failed."),
      });
    const top = yield* git(["rev-parse", "--show-toplevel"]);
    if (top.exitCode !== 0 || !NodePath.isAbsolute(top.stdout.toString("utf8").trim()))
      return yield* failure("conflict", "Project is not a Git repository root.");
    const canonicalTop = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(top.stdout.toString("utf8").trim()),
      catch: () => failure("unavailable", "Git repository root could not be resolved."),
    });
    if (canonicalTop !== root)
      return yield* failure("conflict", "Project is not the Git repository root.");
    const format = yield* git(["rev-parse", "--show-ref-format"]);
    if (format.exitCode !== 0 || format.stdout.toString("ascii").trim() !== "files")
      return yield* failure("conflict", "Only Git files refs are supported.");
    const common = yield* git(["rev-parse", "--git-common-dir"]);
    const commonText = common.stdout.toString("utf8").trim();
    if (common.exitCode !== 0 || !commonText || commonText.includes("\0"))
      return yield* failure("conflict", "Git common directory is invalid.");
    yield* Effect.tryPromise({
      try: () => assertSafeMetadata(root, commonText, input.targetRef),
      catch: (cause) =>
        isRefError(cause) ? cause : failure("unavailable", "Git target path inspection failed."),
    });
    const worktrees = yield* git(["worktree", "list", "--porcelain", "-z"], 64 * 1024);
    if (worktrees.exitCode !== 0)
      return yield* failure("unavailable", "Git worktrees could not be inspected.");
    const fields = worktrees.stdout.toString("utf8").split("\0");
    if (
      !fields.some((field) => field.startsWith("worktree ")) ||
      fields.some((field) => field === `branch ${input.targetRef}`)
    )
      return yield* failure(
        "conflict",
        "Target branch is checked out or worktree state is invalid.",
      );
    const state = yield* git([
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(symref)",
      input.targetRef,
    ]);
    const [ref, oid, symref, extra] = state.stdout.toString("ascii").trimEnd().split("\0");
    if (
      state.exitCode !== 0 ||
      ref !== input.targetRef ||
      oid !== input.baseCommit ||
      symref ||
      extra !== undefined
    )
      return yield* failure("conflict", "Target branch is missing, symbolic, or changed.");
  });
}

function targetOperation(
  callerInput: OrganizationGitIntegrationRefInput,
  verifyOnly: boolean,
): Effect.Effect<OrganizationGitIntegrationRefResult, OrganizationGitIntegrationRefError> {
  const input = { ...callerInput };
  if (
    typeof input.projectRoot !== "string" ||
    !NodePath.isAbsolute(input.projectRoot) ||
    typeof input.targetRef !== "string" ||
    !TARGET_REF.test(input.targetRef) ||
    input.targetRef.endsWith(".") ||
    input.targetRef.endsWith(".lock") ||
    input.targetRef.includes("..") ||
    !FULL_OID.test(input.baseCommit) ||
    !FULL_OID.test(input.resultCommit) ||
    input.baseCommit.length !== input.resultCommit.length ||
    input.baseCommit === input.resultCommit ||
    typeof input.allowAlreadyApplied !== "boolean"
  )
    return Effect.fail(failure("invalid", "Git target CAS input is invalid."));
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.projectRoot),
      catch: () => failure("unavailable", "Project root could not be resolved."),
    });
    const git = (args: readonly string[], maxBytes?: number) =>
      Effect.tryPromise({
        try: () => runGit(root, args, maxBytes),
        catch: (cause) =>
          isRefError(cause) ? cause : failure("unavailable", "Git target command failed."),
      });
    const top = yield* git(["rev-parse", "--show-toplevel"]);
    if (top.exitCode !== 0 || !NodePath.isAbsolute(top.stdout.toString("utf8").trim()))
      return yield* failure("conflict", "Project is not a Git repository root.");
    const canonicalTop = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(top.stdout.toString("utf8").trim()),
      catch: () => failure("unavailable", "Git repository root could not be resolved."),
    });
    if (canonicalTop !== root)
      return yield* failure("conflict", "Project is not a Git repository root.");
    const format = yield* git(["rev-parse", "--show-ref-format"]);
    if (format.exitCode !== 0 || format.stdout.toString("ascii").trim() !== "files")
      return yield* failure("conflict", "Only Git files refs are supported.");
    const common = yield* git(["rev-parse", "--git-common-dir"]);
    const commonText = common.stdout.toString("utf8").trim();
    if (common.exitCode !== 0 || !commonText || commonText.includes("\0"))
      return yield* failure("conflict", "Git common directory is invalid.");
    yield* Effect.tryPromise({
      try: () => assertSafeMetadata(root, commonText, input.targetRef),
      catch: (cause) =>
        isRefError(cause) ? cause : failure("unavailable", "Git target path inspection failed."),
    });
    const worktrees = yield* git(["worktree", "list", "--porcelain", "-z"], 64 * 1024);
    if (worktrees.exitCode !== 0)
      return yield* failure("unavailable", "Git worktrees could not be inspected.");
    const fields = worktrees.stdout.toString("utf8").split("\0");
    if (
      !fields.some((field) => field.startsWith("worktree ")) ||
      fields.some((field) => field === `branch ${input.targetRef}`)
    )
      return yield* failure(
        "conflict",
        "Target branch is checked out or worktree state is invalid.",
      );
    const readRef = () =>
      git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", input.targetRef]);
    const state = yield* readRef();
    const [ref, oid, symref, extra] = state.stdout.toString("ascii").trimEnd().split("\0");
    if (
      state.exitCode !== 0 ||
      ref !== input.targetRef ||
      !FULL_OID.test(oid ?? "") ||
      symref ||
      extra !== undefined
    )
      return yield* failure("conflict", "Target branch is missing, symbolic, or malformed.");
    if (oid === input.resultCommit) {
      if (!input.allowAlreadyApplied)
        return yield* failure(
          "conflict",
          "Target already names the result without a prior intent.",
        );
      return {
        targetRef: input.targetRef,
        previousCommit: input.baseCommit,
        resultCommit: input.resultCommit,
        appliedNow: false,
      };
    }
    if (verifyOnly)
      return yield* failure("conflict", "Target branch no longer names the integrated result.");
    if (oid !== input.baseCommit)
      return yield* failure("conflict", "Target branch moved from the approved base.");
    const updated = yield* git([
      "update-ref",
      "--no-deref",
      input.targetRef,
      input.resultCommit,
      input.baseCommit,
    ]);
    if (updated.exitCode !== 0)
      return yield* failure("conflict", "Target branch compare-and-swap failed.");
    const after = yield* readRef();
    const [afterRef, afterOid, afterSymref, afterExtra] = after.stdout
      .toString("ascii")
      .trimEnd()
      .split("\0");
    if (
      after.exitCode !== 0 ||
      afterRef !== input.targetRef ||
      afterOid !== input.resultCommit ||
      afterSymref ||
      afterExtra !== undefined
    )
      return yield* failure("conflict", "Target branch changed after compare-and-swap.");
    return {
      targetRef: input.targetRef,
      previousCommit: input.baseCommit,
      resultCommit: input.resultCommit,
      appliedNow: true,
    };
  });
}

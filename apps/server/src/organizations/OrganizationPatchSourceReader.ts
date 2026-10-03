// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Binary-safe fixed-argv Git reads need raw process bytes and a bounded OS kill timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { OrganizationWorkLaunchPlan } from "./OrganizationWorkLaunchPlanner.ts";

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_METADATA_BYTES = 4 * 1024;
const GIT_TIMEOUT_MS = 5_000;
// A fixed system binary avoids resolving a repository-controlled PATH entry.
const GIT_BINARY = "/usr/bin/git";
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface OrganizationPatchSource {
  readonly relativePath: string;
  readonly baseCommit: string;
  readonly blobOid: string;
  readonly baseMode: "100644" | "100755";
  readonly content: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export class OrganizationPatchSourceError extends Schema.TaggedError<OrganizationPatchSourceError>()(
  "OrganizationPatchSourceError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}
const sourceError = (code: OrganizationPatchSourceError["code"], message: string) =>
  new OrganizationPatchSourceError({ code, message });
const isSourceError = Schema.is(OrganizationPatchSourceError);

function validPath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    Buffer.byteLength(relativePath, "utf8") <= MAX_PATH_BYTES &&
    !relativePath.includes("\\") &&
    !relativePath.includes("\0") &&
    !NodePath.isAbsolute(relativePath) &&
    relativePath.split("/").length <= 16 &&
    relativePath
      .split("/")
      .every(
        (part) => part !== "." && part !== ".." && part !== ".git" && PATH_COMPONENT.test(part),
      )
  );
}

/** Fixed argv, no shell and no inherited Git overrides. Output stays raw bytes. */
function runGitRaw(cwd: string, args: readonly string[], maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(GIT_BINARY, [...args], {
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
    let failure: OrganizationPatchSourceError | null = null;
    const timer = setTimeout(() => {
      failure = sourceError("unavailable", "Pinned Git object read timed out.");
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        failure = sourceError("invalid", "Pinned Git object exceeds its byte limit.");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    // Drain stderr but never return it: Git diagnostics can expose local paths.
    child.stderr?.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(sourceError("unavailable", "Pinned Git object could not be read."));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (exitCode !== 0)
        reject(sourceError("not_found", "Pinned Git object or file was not found."));
      else resolve(Buffer.concat(chunks, size));
    });
  });
}

export const readOrganizationPatchSource = (
  plan: Pick<OrganizationWorkLaunchPlan, "projectRoot" | "baseCommit">,
  relativePath: string,
): Effect.Effect<OrganizationPatchSource, OrganizationPatchSourceError> => {
  const root = plan.projectRoot;
  const commit = plan.baseCommit;
  const selectedPath = relativePath;
  if (!NodePath.isAbsolute(root) || !FULL_OID.test(commit) || !validPath(selectedPath))
    return Effect.fail(
      sourceError("invalid", "Pinned commit, Project root, or source path is invalid."),
    );
  const git = (cwd: string, args: readonly string[], limit: number) =>
    Effect.tryPromise({
      try: () => runGitRaw(cwd, args, limit),
      catch: (cause) =>
        isSourceError(cause)
          ? cause
          : sourceError("unavailable", "Pinned Git object could not be read."),
    });
  return Effect.gen(function* () {
    const canonicalRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(root),
      catch: () => sourceError("unavailable", "Project root could not be resolved."),
    });
    // rev-parse inspects repository metadata only. Refuse a Project that is
    // merely a subdirectory of a larger repository before reading any object.
    const topLevel = (yield* git(
      canonicalRoot,
      ["rev-parse", "--show-toplevel"],
      MAX_METADATA_BYTES,
    ))
      .toString("utf8")
      .trim();
    if (!NodePath.isAbsolute(topLevel))
      return yield* sourceError("conflict", "Project root is not the Git repository root.");
    const canonicalTopLevel = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(topLevel),
      catch: () => sourceError("unavailable", "Git repository root could not be resolved."),
    });
    if (canonicalTopLevel !== canonicalRoot)
      return yield* sourceError("conflict", "Project root is not the Git repository root.");
    const type = (yield* git(canonicalRoot, ["cat-file", "-t", commit], 32))
      .toString("ascii")
      .trim();
    if (type !== "commit")
      return yield* sourceError("conflict", "Pinned revision is not a Git commit.");
    const listing = yield* git(
      canonicalRoot,
      ["ls-tree", "-r", "-z", "--full-tree", commit, "--", selectedPath],
      MAX_METADATA_BYTES,
    );
    const entries = listing.toString("utf8").split("\0").filter(Boolean);
    if (entries.length !== 1)
      return yield* sourceError(
        "not_found",
        "Selected file is absent or ambiguous at the pinned commit.",
      );
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(entries[0] ?? "");
    if (!match || match[3] !== selectedPath)
      return yield* sourceError("invalid", "Selected path is not a regular Git blob.");
    const blobOid = match[2] ?? "";
    const sizeText = (yield* git(canonicalRoot, ["cat-file", "-s", blobOid], 32))
      .toString("ascii")
      .trim();
    const expectedSize = Number(sizeText);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_SOURCE_BYTES)
      return yield* sourceError("invalid", "Pinned file is larger than 64 KiB.");
    const bytes = yield* git(canonicalRoot, ["cat-file", "blob", blobOid], MAX_SOURCE_BYTES);
    if (bytes.byteLength !== expectedSize || bytes.includes(0))
      return yield* sourceError("invalid", "Pinned file bytes are invalid or changed.");
    const content = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: () => sourceError("invalid", "Pinned file is not valid UTF-8."),
    });
    if (!Buffer.from(content, "utf8").equals(bytes))
      return yield* sourceError("invalid", "Pinned file is not canonical UTF-8 text.");
    return {
      relativePath: selectedPath,
      baseCommit: commit,
      blobOid,
      baseMode: match[1] === "100755" ? "100755" : "100644",
      content,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    };
  });
};

export class OrganizationPatchSourceReader extends Context.Service<
  OrganizationPatchSourceReader,
  { readonly read: typeof readOrganizationPatchSource }
>()("t3/organizations/OrganizationPatchSourceReader") {}
export const OrganizationPatchSourceReaderLive = Layer.succeed(OrganizationPatchSourceReader, {
  read: readOrganizationPatchSource,
});

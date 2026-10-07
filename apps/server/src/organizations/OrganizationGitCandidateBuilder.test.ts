// @effect-diagnostics nodeBuiltinImport:off - Disposable Git fixtures inspect raw index and object bytes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { buildOrganizationGitCandidate } from "./OrganizationGitCandidateBuilder.ts";
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";

const gitEnv = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await NodeFSP.mkdtemp("/tmp/t3-org-candidate-test-");
  const git = (args: readonly string[]) =>
    NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
      cwd: root,
      env: gitEnv,
      encoding: "buffer",
    });
  git(["init", "-q", "-b", "main"]);
  const baseBytes = Buffer.from("export const answer = 1;\n");
  const replacementBytes = Buffer.from("export const answer = 2;\n");
  await NodeFSP.writeFile(NodePath.join(root, "source.mjs"), baseBytes);
  git(["add", "--", "source.mjs"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  const baseCommit = git(["rev-parse", "HEAD"]).toString("ascii").trim();
  const listing = git(["ls-tree", "-z", baseCommit, "--", "source.mjs"]).toString("ascii");
  const baseBlobOid = /blob ([a-f0-9]{40}|[a-f0-9]{64})\t/.exec(listing)?.[1];
  assert.ok(baseBlobOid);
  const artifactFields = {
    relativePath: "source.mjs",
    baseCommit,
    baseBlobOid,
    baseMode: "100644" as const,
    baseSha256: sha256(baseBytes),
    baseBytes,
    replacementBytes,
  };
  const reviewedArtifactBytes = createOrganizationSingleFileArtifact(artifactFields);
  // A candidate must use the pinned blob even when the user's checkout is dirty.
  await NodeFSP.writeFile(NodePath.join(root, "source.mjs"), "local unsaved edit\n");
  await NodeFSP.writeFile(NodePath.join(root, "untracked.txt"), "keep me\n");
  git(["config", "user.name", "Project User"]);
  git(["config", "user.email", "project-user@example.invalid"]);
  git(["config", "commit.gpgsign", "true"]);
  return { root, git, artifactFields, reviewedArtifactBytes, baseCommit };
}

const state = async (root: string, git: (args: readonly string[]) => Buffer) => ({
  head: git(["rev-parse", "HEAD"]),
  refs: git(["show-ref"]),
  index: await NodeFSP.readFile(NodePath.join(root, ".git", "index")),
  status: git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  dirtyFile: await NodeFSP.readFile(NodePath.join(root, "source.mjs")),
});

it.effect(
  "builds a proven single-file candidate without touching Project branch, index or checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      try {
        const before = yield* Effect.promise(() => state(f.root, f.git));
        const result = yield* buildOrganizationGitCandidate({
          projectRoot: f.root,
          reviewedArtifactBytes: f.reviewedArtifactBytes,
        });
        assert.equal(result.proof.baseCommit, f.baseCommit);
        assert.equal(result.proof.resultCommit, result.resultCommit);
        assert.equal(result.proof.relativePath, "source.mjs");
        assert.equal(result.proof.reviewedArtifactDigest, sha256(f.reviewedArtifactBytes));
        assert.deepEqual(yield* Effect.promise(() => state(f.root, f.git)), before);
        const rawCommit = f.git(["cat-file", "-p", result.resultCommit]).toString("utf8");
        assert.ok(rawCommit.includes(`parent ${f.baseCommit}\n`));
        assert.ok(
          rawCommit.includes(
            "author Arcwright Code Organization Candidate <organization-candidate@t3.invalid>",
          ),
        );
        assert.deepEqual(
          f.git(["show", `${result.resultCommit}:source.mjs`]),
          f.artifactFields.replacementBytes,
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
      }
    }),
);

it.effect("rejects a mismatched pinned source before writing a Git object", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    try {
      const reviewedArtifactBytes = createOrganizationSingleFileArtifact({
        ...f.artifactFields,
        baseBlobOid: "0".repeat(f.artifactFields.baseBlobOid.length),
      });
      const before = yield* Effect.promise(() => state(f.root, f.git));
      const objectCount = f.git(["count-objects", "-v"]);
      const error = yield* buildOrganizationGitCandidate({
        projectRoot: f.root,
        reviewedArtifactBytes,
      }).pipe(Effect.flip);
      assert.equal(error.code, "conflict");
      assert.deepEqual(f.git(["count-objects", "-v"]), objectCount);
      assert.deepEqual(yield* Effect.promise(() => state(f.root, f.git)), before);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
    }
  }),
);

it.effect("rejects a Project subdirectory before writing a Git object", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    try {
      const nested = NodePath.join(f.root, "nested-project");
      yield* Effect.promise(() => NodeFSP.mkdir(nested));
      const before = yield* Effect.promise(() => state(f.root, f.git));
      const objectCount = f.git(["count-objects", "-v"]);
      const error = yield* buildOrganizationGitCandidate({
        projectRoot: nested,
        reviewedArtifactBytes: f.reviewedArtifactBytes,
      }).pipe(Effect.flip);
      assert.equal(error.code, "conflict");
      assert.deepEqual(f.git(["count-objects", "-v"]), objectCount);
      assert.deepEqual(yield* Effect.promise(() => state(f.root, f.git)), before);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
    }
  }),
);

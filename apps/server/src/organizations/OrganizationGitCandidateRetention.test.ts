// @effect-diagnostics nodeBuiltinImport:off - Disposable Git fixtures inspect raw Project state and run local gc.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { buildOrganizationGitCandidate } from "./OrganizationGitCandidateBuilder.ts";
import { retainOrganizationGitCandidate } from "./OrganizationGitCandidateRetention.ts";
import { buildOrganizationPatchArtifact } from "./OrganizationPatchArtifactBuilder.ts";
import { readOrganizationPatchSource } from "./OrganizationPatchSourceReader.ts";

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
  const root = await NodeFSP.mkdtemp("/tmp/t3-org-retention-test-");
  const git = (args: readonly string[]) =>
    NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
      cwd: root,
      env: gitEnv,
      encoding: "buffer",
    });
  git(["init", "-q", "-b", "main"]);
  await NodeFSP.writeFile(NodePath.join(root, "source.mjs"), "export const answer = 1;\n");
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
  await NodeFSP.writeFile(NodePath.join(root, "source.mjs"), "uncommitted local edit\n");
  await NodeFSP.writeFile(NodePath.join(root, "untracked.txt"), "keep me\n");
  return { root, git, baseCommit };
}

const projectState = async (root: string, git: (args: readonly string[]) => Buffer) => ({
  head: git(["rev-parse", "HEAD"]),
  branchRef: git(["rev-parse", "refs/heads/main"]),
  index: await NodeFSP.readFile(NodePath.join(root, ".git", "index")),
  status: git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  dirtyFile: await NodeFSP.readFile(NodePath.join(root, "source.mjs")),
});

const candidate = (f: Awaited<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    const source = yield* readOrganizationPatchSource(
      { projectRoot: f.root, baseCommit: f.baseCommit },
      "source.mjs",
    );
    const reviewedArtifactBytes = buildOrganizationPatchArtifact(source, {
      fileName: "source.mjs",
      baseDigest: source.sha256,
      replacementContent: "export const answer = 2;\n",
      rationale: "Local fixture only",
    });
    const built = yield* buildOrganizationGitCandidate({
      projectRoot: f.root,
      reviewedArtifactBytes,
    });
    return { reviewedArtifactBytes, resultCommit: built.resultCommit, proof: built.proof };
  });

it.effect(
  "retains a real source-to-artifact candidate through gc without changing Project state",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      try {
        const before = yield* Effect.promise(() => projectState(f.root, f.git));
        const built = yield* candidate(f);
        const input = {
          projectRoot: f.root,
          baseCommit: f.baseCommit,
          resultCommit: built.resultCommit,
          reviewedArtifactBytes: built.reviewedArtifactBytes,
        };
        const first = yield* retainOrganizationGitCandidate(input);
        assert.equal(first.created, true);
        assert.equal(
          first.refName,
          `refs/t3-organizations/candidates/${sha256(built.reviewedArtifactBytes)}`,
        );
        assert.deepEqual(first.proof, built.proof);
        assert.equal(
          f.git(["rev-parse", first.refName]).toString("ascii").trim(),
          built.resultCommit,
        );
        f.git(["gc", "--prune=now"]);
        f.git(["cat-file", "-e", built.resultCommit]);
        const replay = yield* retainOrganizationGitCandidate(input);
        assert.equal(replay.created, false);
        assert.equal(replay.refName, first.refName);
        assert.deepEqual(yield* Effect.promise(() => projectState(f.root, f.git)), before);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
      }
    }),
);

it.effect("rejects a different valid candidate at an occupied artifact ref", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    try {
      const built = yield* candidate(f);
      const input = {
        projectRoot: f.root,
        baseCommit: f.baseCommit,
        resultCommit: built.resultCommit,
        reviewedArtifactBytes: built.reviewedArtifactBytes,
      };
      const retained = yield* retainOrganizationGitCandidate(input);
      const tree = f
        .git(["rev-parse", `${built.resultCommit}^{tree}`])
        .toString("ascii")
        .trim();
      const differentCommit = f
        .git([
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit-tree",
          tree,
          "-p",
          f.baseCommit,
          "-m",
          "same reviewed bytes, different candidate commit",
        ])
        .toString("ascii")
        .trim();
      const error = yield* retainOrganizationGitCandidate({
        ...input,
        resultCommit: differentCommit,
      }).pipe(Effect.flip);
      assert.equal(error.code, "conflict");
      assert.equal(
        f.git(["rev-parse", retained.refName]).toString("ascii").trim(),
        built.resultCommit,
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
    }
  }),
);

it.effect("rejects malformed root and artifact before creating a ref", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    try {
      const built = yield* candidate(f);
      const nested = NodePath.join(f.root, "nested-project");
      yield* Effect.promise(() => NodeFSP.mkdir(nested));
      const input = {
        projectRoot: f.root,
        baseCommit: f.baseCommit,
        resultCommit: built.resultCommit,
        reviewedArtifactBytes: built.reviewedArtifactBytes,
      };
      const before = yield* Effect.promise(() => projectState(f.root, f.git));
      assert.equal(
        (yield* retainOrganizationGitCandidate({ ...input, projectRoot: nested }).pipe(Effect.flip))
          .code,
        "conflict",
      );
      assert.equal(
        (yield* retainOrganizationGitCandidate({ ...input, resultCommit: "../main" }).pipe(
          Effect.flip,
        )).code,
        "invalid",
      );
      assert.equal(
        (yield* retainOrganizationGitCandidate({
          ...input,
          reviewedArtifactBytes: Buffer.from('{"version":1}'),
        }).pipe(Effect.flip)).code,
        "invalid",
      );
      assert.deepEqual(
        f.git(["for-each-ref", "refs/t3-organizations/candidates"]),
        Buffer.alloc(0),
      );
      assert.deepEqual(yield* Effect.promise(() => projectState(f.root, f.git)), before);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
    }
  }),
);

it.effect("never follows an occupied symbolic private ref into a Project branch", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    try {
      const built = yield* candidate(f);
      const refName = `refs/t3-organizations/candidates/${sha256(built.reviewedArtifactBytes)}`;
      f.git(["symbolic-ref", refName, "refs/heads/main"]);
      const before = yield* Effect.promise(() => projectState(f.root, f.git));
      const error = yield* retainOrganizationGitCandidate({
        projectRoot: f.root,
        baseCommit: f.baseCommit,
        resultCommit: built.resultCommit,
        reviewedArtifactBytes: built.reviewedArtifactBytes,
      }).pipe(Effect.flip);
      assert.equal(error.code, "conflict");
      assert.deepEqual(yield* Effect.promise(() => projectState(f.root, f.git)), before);
      assert.equal(f.git(["symbolic-ref", refName]).toString("ascii").trim(), "refs/heads/main");
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
    }
  }),
);

it.effect("rejects a symlinked private ref ancestor before creating any branch ref", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    try {
      const built = yield* candidate(f);
      const digest = sha256(built.reviewedArtifactBytes);
      const branchRef = `refs/heads/candidates/${digest}`;
      yield* Effect.promise(() =>
        NodeFSP.symlink("heads", NodePath.join(f.root, ".git", "refs", "t3-organizations")),
      );
      const before = yield* Effect.promise(() => projectState(f.root, f.git));
      const error = yield* retainOrganizationGitCandidate({
        projectRoot: f.root,
        baseCommit: f.baseCommit,
        resultCommit: built.resultCommit,
        reviewedArtifactBytes: built.reviewedArtifactBytes,
      }).pipe(Effect.flip);
      assert.equal(error.code, "conflict");
      assert.deepEqual(yield* Effect.promise(() => projectState(f.root, f.git)), before);
      assert.equal(f.git(["for-each-ref", branchRef]).byteLength, 0);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
    }
  }),
);

for (const location of [
  "refs/t3-organizations/candidates",
  "refs/t3-organizations/candidates/leaf",
  "logs/refs/t3-organizations",
  "logs/refs/t3-organizations/candidates",
] as const) {
  it.effect(`rejects a symlinked Git metadata path at ${location}`, () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      try {
        const built = yield* candidate(f);
        const digest = sha256(built.reviewedArtifactBytes);
        const leaf = NodePath.join(
          f.root,
          ".git",
          "refs",
          "t3-organizations",
          "candidates",
          digest,
        );
        const target = location.endsWith("/leaf") ? leaf : NodePath.join(f.root, ".git", location);
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(target), { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(f.root, ".git", "refs", "heads"), target),
        );
        const before = yield* Effect.promise(() => projectState(f.root, f.git));
        const error = yield* retainOrganizationGitCandidate({
          projectRoot: f.root,
          baseCommit: f.baseCommit,
          resultCommit: built.resultCommit,
          reviewedArtifactBytes: built.reviewedArtifactBytes,
        }).pipe(Effect.flip);
        assert.equal(error.code, "conflict");
        assert.deepEqual(yield* Effect.promise(() => projectState(f.root, f.git)), before);
        assert.equal(f.git(["for-each-ref", `refs/heads/candidates/${digest}`]).byteLength, 0);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
      }
    }),
  );
}

it.effect("rejects a hardlinked private reflog before appending to the main branch reflog", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(fixture);
    try {
      const built = yield* candidate(f);
      const digest = sha256(built.reviewedArtifactBytes);
      const mainLog = NodePath.join(f.root, ".git", "logs", "refs", "heads", "main");
      const privateLog = NodePath.join(
        f.root,
        ".git",
        "logs",
        "refs",
        "t3-organizations",
        "candidates",
        digest,
      );
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(privateLog), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.link(mainLog, privateLog));
      const before = yield* Effect.promise(() => NodeFSP.readFile(mainLog));
      const error = yield* retainOrganizationGitCandidate({
        projectRoot: f.root,
        baseCommit: f.baseCommit,
        resultCommit: built.resultCommit,
        reviewedArtifactBytes: built.reviewedArtifactBytes,
      }).pipe(Effect.flip);
      assert.equal(error.code, "conflict");
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readFile(mainLog)), before);
      assert.equal(f.git(["for-each-ref", `refs/heads/candidates/${digest}`]).byteLength, 0);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(f.root, { recursive: true, force: true }));
    }
  }),
);

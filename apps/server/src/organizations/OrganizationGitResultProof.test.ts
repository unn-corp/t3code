// @effect-diagnostics nodeBuiltinImport:off - Disposable Git fixtures need raw fixed-argv process and file operations.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { proveOrganizationGitResult } from "./OrganizationGitResultProof.ts";
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";

const gitEnv = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
type Options = { readonly extra?: boolean; readonly mode?: boolean; readonly symlink?: boolean };

async function fixture(options: Options = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-result-"));
  const git = (args: readonly string[]) =>
    NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
      cwd: root,
      env: gitEnv,
      encoding: "buffer",
    });
  const commit = (message: string) =>
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
      message,
    ]);
  git(["init", "-q", "-b", "main"]);
  const source = NodePath.join(root, "source.mjs");
  const baseBytes = Buffer.from("export const answer = 1;\n");
  const replacementBytes = Buffer.from("export const answer = 2;\n");
  await NodeFSP.writeFile(source, baseBytes);
  git(["add", "--", "source.mjs"]);
  commit("base");
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
  if (options.symlink) {
    await NodeFSP.rm(source);
    await NodeFSP.symlink("untrusted-target", source);
  } else {
    await NodeFSP.writeFile(source, replacementBytes);
    if (options.mode) await NodeFSP.chmod(source, 0o755);
  }
  git(["add", "--", "source.mjs"]);
  if (options.extra) {
    await NodeFSP.writeFile(NodePath.join(root, "unexpected.txt"), "extra\n");
    git(["add", "--", "unexpected.txt"]);
  }
  commit("result");
  const resultCommit = git(["rev-parse", "HEAD"]).toString("ascii").trim();
  return {
    root,
    git,
    artifactFields,
    input: { projectRoot: root, baseCommit, resultCommit, reviewedArtifactBytes },
  };
}

it.effect("proves one exact reviewed replacement without changing Git state", () =>
  Effect.gen(function* () {
    const { root, git, input } = yield* Effect.promise(() => fixture());
    try {
      const head = git(["rev-parse", "HEAD"]);
      const status = git(["status", "--porcelain", "-z"]);
      const proof = yield* proveOrganizationGitResult(input);
      assert.equal(proof.baseCommit, input.baseCommit);
      assert.equal(proof.resultCommit, input.resultCommit);
      assert.equal(proof.relativePath, "source.mjs");
      assert.equal(proof.reviewedArtifactDigest, sha256(input.reviewedArtifactBytes));
      assert.deepEqual(git(["rev-parse", "HEAD"]), head);
      assert.deepEqual(git(["status", "--porcelain", "-z"]), status);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
    }
  }),
);

it.effect("rejects wrong replacement bytes, extra files, mode changes, and symlinks", () =>
  Effect.gen(function* () {
    const first = yield* Effect.promise(() => fixture());
    try {
      const wrong = createOrganizationSingleFileArtifact({
        ...first.artifactFields,
        replacementBytes: Buffer.from("export const answer = 9;\n"),
      });
      const error = yield* Effect.flip(
        proveOrganizationGitResult({ ...first.input, reviewedArtifactBytes: wrong }),
      );
      assert.equal(error.code, "conflict");
      const wrongBaseBlob = createOrganizationSingleFileArtifact({
        ...first.artifactFields,
        baseBlobOid: "0".repeat(first.artifactFields.baseBlobOid.length),
      });
      assert.equal(
        (yield* Effect.flip(
          proveOrganizationGitResult({
            ...first.input,
            reviewedArtifactBytes: wrongBaseBlob,
          }),
        )).code,
        "conflict",
      );
      const encoded = new TextDecoder().decode(first.input.reviewedArtifactBytes);
      const wrongBaseHash = Buffer.from(
        encoded.replace(first.artifactFields.baseSha256, "0".repeat(64)),
      );
      assert.equal(
        (yield* Effect.flip(
          proveOrganizationGitResult({
            ...first.input,
            reviewedArtifactBytes: wrongBaseHash,
          }),
        )).code,
        "conflict",
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(first.root, { recursive: true, force: true }));
    }
    for (const options of [{ extra: true }, { mode: true }, { symlink: true }]) {
      const next = yield* Effect.promise(() => fixture(options));
      try {
        const error = yield* Effect.flip(proveOrganizationGitResult(next.input));
        assert.equal(error.code, "conflict");
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(next.root, { recursive: true, force: true }));
      }
    }
  }),
);

it.effect("rejects a wrong parent and a Project rooted below the repository", () =>
  Effect.gen(function* () {
    const { root, git, input } = yield* Effect.promise(() => fixture());
    try {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "source.mjs"), "export const answer = 3;\n"),
      );
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
        "later",
      ]);
      const later = git(["rev-parse", "HEAD"]).toString("ascii").trim();
      assert.equal(
        (yield* Effect.flip(proveOrganizationGitResult({ ...input, resultCommit: later }))).code,
        "conflict",
      );
      const nested = NodePath.join(root, "nested");
      yield* Effect.promise(() => NodeFSP.mkdir(nested));
      assert.equal(
        (yield* Effect.flip(proveOrganizationGitResult({ ...input, projectRoot: nested }))).code,
        "conflict",
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
    }
  }),
);

it.effect("does not lazily fetch missing blobs from a partial clone", () =>
  Effect.gen(function* () {
    const source = yield* Effect.promise(() => fixture());
    const partial = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-partial-")),
    );
    const objectMissing = () =>
      NodeChildProcess.spawnSync(
        "/usr/bin/git",
        ["cat-file", "-e", source.artifactFields.baseBlobOid],
        { cwd: partial, env: { ...gitEnv, GIT_NO_LAZY_FETCH: "1" } },
      ).status !== 0;
    try {
      source.git(["config", "uploadpack.allowFilter", "true"]);
      NodeChildProcess.execFileSync(
        "/usr/bin/git",
        [
          "-c",
          "protocol.file.allow=always",
          "clone",
          "-q",
          "--filter=blob:none",
          "--no-checkout",
          `file://${source.root}`,
          partial,
        ],
        { env: gitEnv, encoding: "buffer" },
      );
      assert.equal(objectMissing(), true);
      const error = yield* Effect.flip(
        proveOrganizationGitResult({ ...source.input, projectRoot: partial }),
      );
      assert.equal(error.code, "not_found");
      assert.equal(objectMissing(), true);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(partial, { recursive: true, force: true }));
      yield* Effect.promise(() => NodeFSP.rm(source.root, { recursive: true, force: true }));
    }
  }),
);

it.effect("rejects a tree entry whose blob mode points to a commit object", () =>
  Effect.gen(function* () {
    const { root, git, input, artifactFields } = yield* Effect.promise(() => fixture());
    try {
      const fakeReplacement = git(["cat-file", "-p", input.resultCommit]);
      const rawTree = Buffer.concat([
        Buffer.from("100644 source.mjs\0", "ascii"),
        Buffer.from(input.resultCommit, "hex"),
      ]);
      const treeOid = NodeChildProcess.execFileSync(
        "/usr/bin/git",
        ["hash-object", "-t", "tree", "-w", "--literally", "--stdin"],
        { cwd: root, env: gitEnv, input: rawTree, encoding: "buffer" },
      )
        .toString("ascii")
        .trim();
      const malformedCommit = git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit-tree",
        treeOid,
        "-p",
        input.baseCommit,
        "-m",
        "malformed tree",
      ])
        .toString("ascii")
        .trim();
      assert.match(
        git(["ls-tree", malformedCommit, "--", "source.mjs"]).toString("ascii"),
        /100644 blob/,
      );
      const reviewedArtifactBytes = createOrganizationSingleFileArtifact({
        ...artifactFields,
        replacementBytes: fakeReplacement,
      });
      const error = yield* Effect.flip(
        proveOrganizationGitResult({
          ...input,
          resultCommit: malformedCommit,
          reviewedArtifactBytes,
        }),
      );
      assert.equal(error.code, "conflict");
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
    }
  }),
);

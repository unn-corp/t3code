// @effect-diagnostics nodeBuiltinImport:off - Disposable Git fixtures need raw filesystem and process setup.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { OrganizationWorkId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { OrganizationWorkLaunchPlan } from "./OrganizationWorkLaunchPlanner.ts";
import { readOrganizationPatchSource } from "./OrganizationPatchSourceReader.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  }).trim();
const commit = (cwd: string) => {
  git(cwd, "add", "--", ".");
  git(
    cwd,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  return git(cwd, "rev-parse", "HEAD");
};
const plan = (projectRoot: string, baseCommit: string): OrganizationWorkLaunchPlan => ({
  workId: OrganizationWorkId.make("work"),
  organizationId: "org",
  projectId: "project",
  bindingId: "binding",
  bindingVersion: "version",
  scope: null,
  publishedRevision: 1,
  workflowId: "workflow",
  workflowVersion: 1,
  baseCommit,
  projectRoot,
  nextAttemptNumber: 1,
  worktreeName: "organization-fixture",
  branchName: "organization/fixture",
});
const withRepo = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-source-"));
          git(directory, "init", "-q");
          return directory;
        }),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      return yield* use(root);
    }),
  );
const rejectedCode = (selectedPlan: OrganizationWorkLaunchPlan, path: string) =>
  readOrganizationPatchSource(selectedPlan, path).pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

it.effect("reads the exact committed bytes despite later working-tree edits", () =>
  withRepo((root) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "src")));
      const committed = "export const answer = 1;\n";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "src", "answer.js"), committed),
      );
      const baseCommit = commit(root);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "src", "answer.js"), "export const answer = 999;\n"),
      );
      const result = yield* readOrganizationPatchSource(plan(root, baseCommit), "src/answer.js");
      assert.equal(result.content, committed);
      assert.equal(result.relativePath, "src/answer.js");
      assert.equal(result.baseCommit, baseCommit);
      assert.equal(result.baseMode, "100644");
      assert.equal(result.byteLength, Buffer.byteLength(committed));
      assert.equal(result.sha256, NodeCrypto.createHash("sha256").update(committed).digest("hex"));
    }),
  ),
);

it.effect("preserves the executable regular-file mode from the pinned tree", () =>
  withRepo((root) =>
    Effect.gen(function* () {
      const file = NodePath.join(root, "script.mjs");
      yield* Effect.promise(() => NodeFSP.writeFile(file, "export const ready = true;\n"));
      yield* Effect.promise(() => NodeFSP.chmod(file, 0o755));
      const selectedPlan = plan(root, commit(root));
      const result = yield* readOrganizationPatchSource(selectedPlan, "script.mjs");
      assert.equal(result.baseMode, "100755");
    }),
  ),
);

it.effect(
  "refuses all pinned reads when the Project is a subdirectory of a larger Git repository",
  () =>
    withRepo((parentRoot) =>
      Effect.gen(function* () {
        const projectRoot = NodePath.join(parentRoot, "project-subdir");
        yield* Effect.promise(() => NodeFSP.mkdir(projectRoot));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(parentRoot, "outside.js"), "outside Project scope\n"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(projectRoot, "inside.js"), "inside Project scope\n"),
        );
        const selectedPlan = plan(projectRoot, commit(parentRoot));

        // Before the root check, --full-tree exposed the parent's outside.js.
        assert.equal(yield* rejectedCode(selectedPlan, "outside.js"), "conflict");
        assert.equal(yield* rejectedCode(selectedPlan, "project-subdir/inside.js"), "conflict");
        assert.equal(yield* rejectedCode(selectedPlan, "inside.js"), "conflict");
      }),
    ),
);

it.effect("rejects traversal, pathspec syntax, absolute paths and missing files", () =>
  withRepo((root) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "answer.js"), "safe\n"));
      const selectedPlan = plan(root, commit(root));
      for (const path of [
        "../answer.js",
        "a/../answer.js",
        "/etc/passwd",
        "a\\b.js",
        "answer*.js",
        "a//b.js",
        ".git/config",
        "a\0b.js",
        "x".repeat(513),
      ]) {
        assert.equal(yield* rejectedCode(selectedPlan, path), "invalid", path);
      }
      assert.equal(yield* rejectedCode(selectedPlan, "missing.js"), "not_found");
    }),
  ),
);

it.effect("rejects symlinks, oversized blobs, invalid UTF-8 and NUL", () =>
  withRepo((root) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "target.js"), "safe\n"));
      yield* Effect.promise(() => NodeFSP.symlink("target.js", NodePath.join(root, "link.js")));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "large.js"), "x".repeat(65_537)),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "binary.js"), Buffer.from([0xff, 0xfe])),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "nul.js"), Buffer.from([65, 0, 66])),
      );
      const selectedPlan = plan(root, commit(root));
      for (const path of ["link.js", "large.js", "binary.js", "nul.js"])
        assert.equal(yield* rejectedCode(selectedPlan, path), "invalid", path);
    }),
  ),
);

it.effect("rejects a noncommit object and a commit absent from the selected repository", () =>
  withRepo((first) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(first, "answer.js"), "safe\n"));
      const baseCommit = commit(first);
      const tree = git(first, "rev-parse", "HEAD^{tree}");
      assert.equal(yield* rejectedCode(plan(first, tree), "answer.js"), "conflict");
      yield* withRepo((second) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(second, "other.js"), "different\n"),
          );
          commit(second);
          assert.equal(yield* rejectedCode(plan(second, baseCommit), "answer.js"), "not_found");
        }),
      );
    }),
  ),
);

it.effect("does not lazily fetch a missing blob from a partial clone", () =>
  withRepo((source) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(source, "answer.js"), "committed bytes\n"),
      );
      const baseCommit = commit(source);
      const blobOid = git(source, "rev-parse", `${baseCommit}:answer.js`);
      git(source, "config", "uploadpack.allowFilter", "true");
      const clone = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-source-partial-")),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      NodeChildProcess.execFileSync(
        "/usr/bin/git",
        [
          "-c",
          "protocol.file.allow=always",
          "clone",
          "-q",
          "--filter=blob:none",
          "--no-checkout",
          `file://${source}`,
          clone,
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        },
      );
      const missing = () =>
        NodeChildProcess.spawnSync("/usr/bin/git", ["cat-file", "-e", blobOid], {
          cwd: clone,
          env: { PATH: "/usr/bin:/bin", GIT_NO_LAZY_FETCH: "1" },
        }).status !== 0;
      assert.equal(missing(), true);
      assert.equal(yield* rejectedCode(plan(clone, baseCommit), "answer.js"), "not_found");
      assert.equal(missing(), true);
    }),
  ),
);

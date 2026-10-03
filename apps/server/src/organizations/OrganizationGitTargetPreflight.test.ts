// @effect-diagnostics nodeBuiltinImport:off - Disposable Git repository verifies read-only admission.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { preflightOrganizationGitTarget } from "./OrganizationGitIntegrationRef.ts";

it.effect("accepts only a current branch not checked out in any worktree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-preflight-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync("/usr/bin/git", args, {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin",
            LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_NO_REPLACE_OBJECTS: "1",
          },
        }).trim();
      git("init", "-q", "-b", "main");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "answer.mjs"), "export const x = 1;\n"),
      );
      git("add", "--", "answer.mjs");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "base",
      );
      const baseCommit = git("rev-parse", "HEAD");
      git("branch", "release");
      const input = { projectRoot: root, targetRef: "refs/heads/release", baseCommit };
      yield* preflightOrganizationGitTarget(input);
      const checkedOut = yield* preflightOrganizationGitTarget({
        ...input,
        targetRef: "refs/heads/main",
      }).pipe(Effect.flip);
      assert.equal(checkedOut.code, "conflict");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-qm",
        "next",
      );
      git("update-ref", "refs/heads/release", git("rev-parse", "HEAD"));
      const moved = yield* preflightOrganizationGitTarget(input).pipe(Effect.flip);
      assert.equal(moved.code, "conflict");
    }),
  ),
);

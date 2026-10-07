// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Disposable Git fixtures and an independent child process need real OS timers; the Effect test clock is virtual.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import Migration071 from "../persistence/Migrations/071_OrganizationWorkScopes.ts";
import Migration072 from "../persistence/Migrations/072_OrganizationWorkArtifacts.ts";
import Migration076 from "../persistence/Migrations/076_OrganizationGitCandidateIntents.ts";
import {
  coordinateOrganizationGitCandidate,
  OrganizationGitCandidateCoordinatorAuthority,
  OrganizationGitCandidateCoordinatorError,
} from "./OrganizationGitCandidateCoordinator.ts";
import {
  OrganizationGitCandidateIntentStore,
  OrganizationGitCandidateIntentStoreWithAuthority,
  OrganizationGitCandidateRetentionAuthority,
} from "./OrganizationGitCandidateIntentStore.ts";
import { buildOrganizationGitCandidate } from "./OrganizationGitCandidateBuilder.ts";
import { retainOrganizationGitCandidate } from "./OrganizationGitCandidateRetention.ts";
import { buildOrganizationPatchArtifact } from "./OrganizationPatchArtifactBuilder.ts";
import { readOrganizationPatchSource } from "./OrganizationPatchSourceReader.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  type OrganizationWorkArtifactCaptureInput,
} from "./OrganizationWorkArtifactStore.ts";

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
async function gitFixture() {
  const root = await NodeFSP.mkdtemp("/tmp/t3-org-coordinator-test-");
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
type GitFixture = Awaited<ReturnType<typeof gitFixture>>;
const projectState = async (fixture: GitFixture) => ({
  head: fixture.git(["rev-parse", "HEAD"]),
  branch: fixture.git(["rev-parse", "refs/heads/main"]),
  index: await NodeFSP.readFile(NodePath.join(fixture.root, ".git", "index")),
  status: fixture.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  source: await NodeFSP.readFile(NodePath.join(fixture.root, "source.mjs")),
});
const patchBytes = (fixture: GitFixture) =>
  Effect.gen(function* () {
    const source = yield* readOrganizationPatchSource(
      { projectRoot: fixture.root, baseCommit: fixture.baseCommit },
      "source.mjs",
    );
    return buildOrganizationPatchArtifact(source, {
      fileName: "source.mjs",
      baseDigest: source.sha256,
      replacementContent: "export const answer = 2;\n",
      rationale: "Fixture only",
    });
  });
const captureInput = (
  fixture: GitFixture,
  bytes: Uint8Array,
): OrganizationWorkArtifactCaptureInput => ({
  attemptId: "attempt-1",
  workId: "work",
  projectId: "project",
  baseCodeRevision: fixture.baseCommit,
  scopeUnitName: "t3-org-sandbox-00000000000000000000000000000001.scope",
  scopeInvocationId: "00000000000000000000000000000001",
  patchBytes: bytes,
  evidenceBytes: Buffer.from("fixture evidence"),
  outcome: {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    resourceLimitExceeded: false,
  },
});
const database = NodeSqliteClient.layerMemory();
const stores = (authorized: boolean, sqlite = database) =>
  OrganizationGitCandidateIntentStoreWithAuthority.pipe(
    Layer.provideMerge(
      Layer.succeed(OrganizationGitCandidateRetentionAuthority, { permits: () => authorized }),
    ),
    Layer.provideMerge(
      OrganizationWorkArtifactStoreWithAuthority.pipe(
        Layer.provideMerge(
          Layer.succeed(OrganizationWorkArtifactCaptureAuthority, { permits: () => true }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(OrganizationGitCandidateCoordinatorAuthority, {
        permitsAttempt: () => authorized,
        permits: () => authorized,
      }),
    ),
    Layer.provideMerge(sqlite),
  );

const revokerSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 5000");
process.stdout.write("attempting\\n");
db.exec("UPDATE organization_project_bindings SET updated_at = 'version-2' WHERE binding_id = 'binding'");
process.stdout.write("done\\n");
db.close();
`;
function spawnBindingRevoker(dbPath: string) {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", revokerSource, dbPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let began!: () => void;
  let failBegin!: (error: Error) => void;
  const attempting = new Promise<void>((resolve, reject) => {
    began = resolve;
    failBegin = reject;
  });
  let finish!: () => void;
  let failFinish!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    failFinish = reject;
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.includes("attempting\n")) began();
  });
  child.once("error", (error) => {
    failBegin(error);
    failFinish(error);
  });
  child.once("exit", (code) => {
    if (code === 0 && output.includes("done\n")) finish();
    else {
      const error = new Error(`Binding revoker exited ${code ?? "without status"}.`);
      failBegin(error);
      failFinish(error);
    }
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 7_000);
  void completed.finally(() => clearTimeout(timeout)).catch(() => {});
  return { child, attempting, completed };
}
const fixture = (git: GitFixture, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE organizations (organization_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)`;
    yield* sql`CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, deleted_at TEXT)`;
    yield* sql`CREATE TABLE organization_project_bindings (
      binding_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL, access TEXT NOT NULL, scope TEXT, detached_at TEXT,
      updated_at TEXT NOT NULL)`;
    yield* sql`CREATE TABLE organization_work_items (
      work_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, binding_version TEXT NOT NULL, scope TEXT,
      code_revision TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL)`;
    yield* sql`CREATE TABLE organization_work_attempts (
      attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, number INTEGER NOT NULL,
      status TEXT NOT NULL, lease_until TEXT NOT NULL, artifact_digest TEXT, artifact_ref TEXT)`;
    yield* sql`CREATE TABLE organization_work_resource_permits (
      attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
    yield* Migration071;
    yield* Migration072;
    yield* Migration076;
    yield* sql`INSERT INTO organizations VALUES ('org', 'active')`;
    yield* sql`INSERT INTO projection_projects VALUES ('project', ${git.root}, NULL)`;
    yield* sql`INSERT INTO organization_project_bindings VALUES
      ('binding', 'org', 'project', 'write', NULL, NULL, 'version-1')`;
    yield* sql`INSERT INTO organization_work_items VALUES
      ('work', 'org', 'project', 'binding', 'version-1', NULL, ${git.baseCommit}, 'running', 1)`;
    yield* sql`INSERT INTO organization_work_attempts VALUES
      ('attempt-1', 'work', 1, 'running', '2099-01-01T00:00:00.000Z', NULL, NULL)`;
    yield* sql`INSERT INTO organization_work_resource_permits VALUES ('attempt-1', 'active')`;
    const input = captureInput(git, bytes);
    yield* sql`INSERT INTO organization_work_scopes
      (attempt_id, unit_name, invocation_id, control_group, sandbox_pid, pid_namespace,
       prepared_at, start_requested_at, token_released_at, started_at,
       stop_requested_at, verified_stopped_at)
      VALUES ('attempt-1', ${input.scopeUnitName}, ${input.scopeInvocationId},
        '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000001.scope',
        1000, 2000, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01',
        '2026-01-01', '2026-01-01')`;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const receipt = yield* artifacts.capture(input);
    yield* sql`UPDATE organization_work_attempts SET status = 'submitted',
      artifact_digest = ${receipt.artifactDigest}, artifact_ref = ${receipt.artifactRef}
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_items SET status = 'blocked' WHERE work_id = 'work'`;
  });

it.effect("retains a proven candidate without changing branch, HEAD, index or checkout", () =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      const bytes = yield* patchBytes(git);
      yield* fixture(git, bytes);
      const before = yield* Effect.promise(() => projectState(git));
      const first = yield* coordinateOrganizationGitCandidate("attempt-1");
      assert.equal(first.createdRef, true);
      assert.equal(first.intent.status, "retained");
      assert.equal(first.proof.resultCommit, first.intent.resultCommit);
      assert.equal(
        git.git(["rev-parse", first.intent.refName]).toString("ascii").trim(),
        first.intent.resultCommit,
      );
      const second = yield* coordinateOrganizationGitCandidate("attempt-1");
      assert.equal(second.createdRef, false);
      assert.equal(second.intent.resultCommit, first.intent.resultCommit);
      assert.deepEqual(yield* Effect.promise(() => projectState(git)), before);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(stores(true))),
);

it.effect("recovers exact ref after failure between Git retention and SQLite acknowledgement", () =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      const bytes = yield* patchBytes(git);
      yield* fixture(git, bytes);
      const store = yield* OrganizationGitCandidateIntentStore;
      let failOnce = true;
      const interruption = yield* coordinateOrganizationGitCandidate("attempt-1", () => {
        if (failOnce) {
          failOnce = false;
          return Effect.fail(
            new OrganizationGitCandidateCoordinatorError({
              code: "unavailable",
              message: "Injected post-ref interruption.",
            }),
          );
        }
        return Effect.void;
      }).pipe(Effect.flip);
      assert.equal(interruption.code, "unavailable");
      const pending = yield* store.get("attempt-1");
      assert.equal(pending?.status, "prepared");
      const savedCommit = git.git(["rev-parse", pending!.refName]).toString("ascii").trim();
      const recovered = yield* coordinateOrganizationGitCandidate("attempt-1");
      assert.equal(recovered.createdRef, false);
      assert.equal(recovered.intent.status, "retained");
      assert.equal(recovered.intent.resultCommit, savedCommit);
      assert.equal(git.git(["rev-parse", pending!.refName]).toString("ascii").trim(), savedCommit);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(stores(true))),
);

it.effect("adopts a valid competing ref created after the second absent inspection", () =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      const bytes = yield* patchBytes(git);
      yield* fixture(git, bytes);
      const before = yield* Effect.promise(() => projectState(git));
      let winnerCommit = "";
      const result = yield* coordinateOrganizationGitCandidate("attempt-1", undefined, () =>
        Effect.gen(function* () {
          const built = yield* buildOrganizationGitCandidate({
            projectRoot: git.root,
            reviewedArtifactBytes: bytes,
          });
          const tree = git
            .git(["rev-parse", `${built.resultCommit}^{tree}`])
            .toString("ascii")
            .trim();
          winnerCommit = git
            .git([
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.invalid",
              "commit-tree",
              tree,
              "-p",
              git.baseCommit,
              "-m",
              "competing valid candidate",
            ])
            .toString("ascii")
            .trim();
          assert.notEqual(winnerCommit, built.resultCommit);
          yield* retainOrganizationGitCandidate({
            projectRoot: git.root,
            baseCommit: git.baseCommit,
            resultCommit: winnerCommit,
            reviewedArtifactBytes: bytes,
          });
        }).pipe(
          Effect.mapError(
            (error) =>
              new OrganizationGitCandidateCoordinatorError({
                code: error.code,
                message: error.message,
              }),
          ),
        ),
      );
      assert.equal(result.createdRef, false);
      assert.equal(result.intent.resultCommit, winnerCommit);
      assert.deepEqual(yield* Effect.promise(() => projectState(git)), before);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(stores(true))),
);

it.effect("denies authority before SQLite or Git mutation", () =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      const bytes = yield* patchBytes(git);
      yield* fixture(git, bytes);
      const before = yield* Effect.promise(() => projectState(git));
      assert.equal(
        (yield* coordinateOrganizationGitCandidate("attempt-1").pipe(Effect.flip)).code,
        "forbidden",
      );
      const intents = yield* OrganizationGitCandidateIntentStore;
      assert.equal(yield* intents.get("attempt-1"), null);
      assert.equal(git.git(["for-each-ref", "refs/t3-organizations/candidates"]).byteLength, 0);
      assert.deepEqual(yield* Effect.promise(() => projectState(git)), before);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(stores(false))),
);

it.effect("rejects stale Project binding before Git writes", () =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      const bytes = yield* patchBytes(git);
      yield* fixture(git, bytes);
      const before = yield* Effect.promise(() => projectState(git));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_project_bindings SET updated_at = 'version-2'
        WHERE binding_id = 'binding'`;
      assert.equal(
        (yield* coordinateOrganizationGitCandidate("attempt-1").pipe(Effect.flip)).code,
        "conflict",
      );
      assert.equal(git.git(["for-each-ref", "refs/t3-organizations/candidates"]).byteLength, 0);
      assert.deepEqual(yield* Effect.promise(() => projectState(git)), before);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(stores(true))),
);

it.effect("rejects revocation injected immediately before the SQLite write fence", () =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      const bytes = yield* patchBytes(git);
      yield* fixture(git, bytes);
      const sql = yield* SqlClient.SqlClient;
      const result = yield* coordinateOrganizationGitCandidate("attempt-1", undefined, () =>
        sql`UPDATE organization_project_bindings SET updated_at = 'version-2'
          WHERE binding_id = 'binding'`.pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new OrganizationGitCandidateCoordinatorError({
                code: "unavailable",
                message: "Test binding update failed.",
              }),
          ),
        ),
      ).pipe(Effect.flip);
      assert.equal(result.code, "conflict");
      assert.equal(git.git(["for-each-ref", "refs/t3-organizations/candidates"]).byteLength, 0);
      assert.equal(
        (yield* (yield* OrganizationGitCandidateIntentStore).get("attempt-1"))?.status,
        "prepared",
      );
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(stores(true))),
);

it.effect("holds the SQLite write fence across Git retention and acknowledgement", () => {
  const tempDir = NodeFS.mkdtempSync("/tmp/t3-org-fence-db-");
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const insideFence = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let revoker: ReturnType<typeof spawnBindingRevoker> | null = null;
    try {
      const bytes = yield* patchBytes(git);
      yield* fixture(git, bytes);
      const coordinating = yield* coordinateOrganizationGitCandidate("attempt-1", () =>
        Effect.promise(async () => {
          entered();
          await hold;
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Coordinator did not reach the fence hook.")),
              5_000,
            );
            void insideFence.then(() => {
              clearTimeout(timeout);
              resolve();
            });
          }),
      );
      revoker = spawnBindingRevoker(dbPath);
      yield* Effect.promise(() => revoker!.attempting);
      let revoked = false;
      void revoker.completed.then(() => {
        revoked = true;
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
      assert.equal(revoked, false);
      release();
      const retained = yield* Fiber.join(coordinating);
      assert.equal(retained.intent.status, "retained");
      yield* Effect.promise(() => revoker!.completed);
      const sql = yield* SqlClient.SqlClient;
      const binding = (yield* sql<{ updated_at: string }>`SELECT updated_at
        FROM organization_project_bindings WHERE binding_id = 'binding'`)[0];
      assert.equal(binding?.updated_at, "version-2");
      assert.equal(
        (yield* (yield* OrganizationGitCandidateIntentStore).get("attempt-1"))?.status,
        "retained",
      );
    } finally {
      release();
      revoker?.child.kill("SIGKILL");
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(
    Effect.provide(stores(true, NodeSqliteClient.layer({ filename: dbPath }))),
    Effect.ensuring(Effect.promise(() => NodeFSP.rm(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("rejects altered saved artifact before Git writes", () =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      const bytes = yield* patchBytes(git);
      yield* fixture(git, bytes);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TRIGGER organization_work_artifact_immutable`;
      yield* sql`UPDATE organization_work_artifacts SET patch_bytes = ${Buffer.from("altered")}
        WHERE attempt_id = 'attempt-1'`;
      assert.equal(
        (yield* coordinateOrganizationGitCandidate("attempt-1").pipe(Effect.flip)).code,
        "conflict",
      );
      assert.equal(git.git(["for-each-ref", "refs/t3-organizations/candidates"]).byteLength, 0);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(stores(true))),
);

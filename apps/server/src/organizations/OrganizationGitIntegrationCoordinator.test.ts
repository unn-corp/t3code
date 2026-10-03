// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Disposable Git repositories exercise branch CAS without touching production refs.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import Migration079 from "../persistence/Migrations/079_OrganizationGitIntegrationIntents.ts";
import {
  OrganizationGitCandidateIntentStore,
  type OrganizationGitCandidateIntent,
} from "./OrganizationGitCandidateIntentStore.ts";
import {
  coordinateOrganizationGitIntegration,
  OrganizationGitIntegrationAuthority,
  OrganizationGitIntegrationCoordinatorError,
} from "./OrganizationGitIntegrationCoordinator.ts";
import { buildOrganizationPatchArtifact } from "./OrganizationPatchArtifactBuilder.ts";
import { readOrganizationPatchSource } from "./OrganizationPatchSourceReader.ts";
import {
  OrganizationWorkApprovalReceiptStore,
  type OrganizationWorkApprovalReceiptRecord,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkArtifactStore,
  type OrganizationWorkArtifactRecord,
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
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
async function gitFixture() {
  const root = await NodeFSP.mkdtemp("/tmp/t3-org-integration-test-");
  const git = (args: readonly string[]) =>
    NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
      cwd: root,
      env: gitEnv,
      encoding: "utf8",
    }).trim();
  git(["init", "-q", "-b", "main"]);
  await NodeFSP.writeFile(NodePath.join(root, "source.mjs"), "export const answer = 1;\n");
  git(["add", "--", "source.mjs"]);
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
  commit("base");
  const baseCommit = git(["rev-parse", "HEAD"]);
  git(["branch", "release", "main"]);
  git(["switch", "-q", "-c", "candidate"]);
  await NodeFSP.writeFile(NodePath.join(root, "source.mjs"), "export const answer = 2;\n");
  git(["add", "--", "source.mjs"]);
  commit("candidate");
  const resultCommit = git(["rev-parse", "HEAD"]);
  git(["switch", "-q", "main"]);
  return { root, git, baseCommit, resultCommit };
}
type GitFixture = Awaited<ReturnType<typeof gitFixture>>;

const request = {
  attemptId: "attempt-1",
  targetRef: "refs/heads/release",
  integratorSubject: "integrator",
};
const artifactRef = "artifact-ref";
const artifactDigest = "a".repeat(64);
const qaReceiptDigest = "b".repeat(64);
const approvalReceiptDigest = "c".repeat(64);

function fixture(git: GitFixture, options?: { approvalRoot?: string; permission?: boolean }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE organizations (organization_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)`;
    yield* sql`CREATE TABLE organization_emergency_stops (organization_id TEXT PRIMARY KEY)`;
    yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL, deleted_at TEXT)`;
    yield* sql`CREATE TABLE organization_project_bindings (binding_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, access TEXT NOT NULL,
      scope TEXT, detached_at TEXT, updated_at TEXT NOT NULL,
      capabilities_json TEXT NOT NULL)`;
    yield* sql`CREATE TABLE organization_work_items (work_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      binding_version TEXT NOT NULL, scope TEXT, code_revision TEXT NOT NULL,
      status TEXT NOT NULL, attempt_count INTEGER NOT NULL, approval_subject TEXT,
      approval_evidence_ref TEXT)`;
    yield* sql`CREATE TABLE organization_work_attempts (attempt_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL, number INTEGER NOT NULL, status TEXT NOT NULL,
      worker_subject TEXT NOT NULL, qa_subject TEXT, artifact_ref TEXT, artifact_digest TEXT)`;
    yield* Migration079;
    yield* sql`INSERT INTO organizations VALUES ('org', 'active')`;
    yield* sql`INSERT INTO projection_projects VALUES ('project', ${git.root}, NULL)`;
    yield* sql`INSERT INTO organization_project_bindings VALUES
      ('binding', 'org', 'project', 'write', NULL, NULL, 'version-1',
        '["read-files","write-files","run-tests"]')`;
    yield* sql`INSERT INTO organization_work_items VALUES
      ('work', 'org', 'project', 'binding', 'version-1', NULL, ${git.baseCommit},
        'blocked', 1, 'approver', 'approval-evidence')`;
    yield* sql`INSERT INTO organization_work_attempts VALUES
      ('attempt-1', 'work', 1, 'qa-accepted', 'worker', 'qa', ${artifactRef}, ${artifactDigest})`;
    const source = yield* readOrganizationPatchSource(
      { projectRoot: git.root, baseCommit: git.baseCommit },
      "source.mjs",
    );
    const bytes = buildOrganizationPatchArtifact(source, {
      fileName: "source.mjs",
      baseDigest: source.sha256,
      replacementContent: "export const answer = 2;\n",
      rationale: "fixture",
    });
    const candidateRef = `refs/t3-organizations/candidates/${digest(bytes)}`;
    git.git(["update-ref", candidateRef, git.resultCommit]);
    const candidate: OrganizationGitCandidateIntent = {
      attemptId: "attempt-1",
      workId: "work",
      organizationId: "org",
      projectId: "project",
      bindingId: "binding",
      bindingVersion: "version-1",
      baseCommit: git.baseCommit,
      artifactRef,
      artifactReceiptDigest: artifactDigest,
      reviewedArtifactDigest: digest(bytes),
      relativePath: "source.mjs",
      refName: candidateRef,
      status: "retained",
      resultCommit: git.resultCommit,
      preparedAt: "2026-01-01",
      retainedAt: "2026-01-01",
    };
    const artifact: OrganizationWorkArtifactRecord = {
      attemptId: "attempt-1",
      workId: "work",
      projectId: "project",
      baseCodeRevision: git.baseCommit,
      artifactRef,
      artifactDigest,
      scopeUnitName: "unit",
      scopeInvocationId: "invocation",
      scopeVerifiedStoppedAt: "time",
      outcome: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimitExceeded: false,
        resourceLimitExceeded: false,
      },
      patchBytes: bytes,
      evidenceBytes: Buffer.from("test"),
      capturedAt: "2026-01-01",
    };
    const approval: OrganizationWorkApprovalReceiptRecord = {
      attemptId: "attempt-1",
      workId: "work",
      projectId: "project",
      baseCodeRevision: git.baseCommit,
      artifactRef,
      artifactDigest,
      qaReceiptDigest,
      workerSubject: "worker",
      qaSubject: "qa",
      approvalSubject: "approver",
      approved: true,
      evidenceRef: "approval-evidence",
      evidenceBytes: Buffer.from(
        JSON.stringify({
          version: 1,
          canonicalProjectRoot: options?.approvalRoot ?? git.root,
          approved: true,
          attemptId: "attempt-1",
          artifactDigest,
          qaReceiptDigest,
        }),
      ),
      recordedAt: "2026-01-01",
      receiptDigest: approvalReceiptDigest,
    };
    const services = Layer.mergeAll(
      Layer.succeed(OrganizationGitCandidateIntentStore, {
        get: () => Effect.succeed(candidate),
        prepare: () => Effect.succeed(candidate),
        markRetained: () => Effect.succeed(candidate),
        listPrepared: () => Effect.succeed([]),
      }),
      Layer.succeed(OrganizationWorkArtifactStore, {
        get: () => Effect.succeed(artifact),
        capture: () => Effect.succeed(artifact),
        verifySubmitted: () => Effect.void,
      }),
      Layer.succeed(OrganizationWorkApprovalReceiptStore, {
        get: () => Effect.succeed(approval),
        capture: () => Effect.succeed(approval),
        verifyApproval: () => Effect.void,
      }),
      Layer.succeed(OrganizationGitIntegrationAuthority, {
        permitsAttempt: () => options?.permission !== false,
        permits: () => options?.permission !== false,
      }),
    );
    return { services, candidate, artifact, approval };
  });
}

const run = <E>(body: (git: GitFixture) => Effect.Effect<void, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      yield* body(git);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("CAS integrates a retained approved candidate and exact replay is idempotent", () =>
  run((git) =>
    Effect.gen(function* () {
      const { services } = yield* fixture(git);
      const index = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(git.root, ".git", "index")),
      );
      const first = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
      );
      assert.equal(first.appliedNow, true);
      assert.equal(git.git(["rev-parse", "refs/heads/release"]), git.resultCommit);
      assert.equal(git.git(["rev-parse", "HEAD"]), git.baseCommit);
      assert.deepEqual(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(git.root, ".git", "index"))),
        index,
      );
      const retry = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
      );
      assert.equal(retry.appliedNow, false);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        status: string;
      }>`SELECT status FROM organization_git_integration_intents`;
      assert.equal(rows[0]?.status, "applied");
    }),
  ),
);

it.effect("a committed emergency stop fences Git CAS", () =>
  run((git) =>
    Effect.gen(function* () {
      const { services } = yield* fixture(git);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO organization_emergency_stops (organization_id) VALUES ('org')`;
      const denied = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
        Effect.flip,
      );
      assert.equal(denied.code, "conflict");
      assert.equal(git.git(["rev-parse", "refs/heads/release"]), git.baseCommit);
    }),
  ),
);

it.effect("recovers a Git success after SQLite acknowledgement fails", () =>
  run((git) =>
    Effect.gen(function* () {
      const { services } = yield* fixture(git);
      const failed = yield* coordinateOrganizationGitIntegration(request, () =>
        Effect.fail(
          new OrganizationGitIntegrationCoordinatorError({
            code: "unavailable",
            message: "injected crash after Git",
          }),
        ),
      ).pipe(Effect.provide(services), Effect.flip);
      assert.equal(failed.code, "unavailable");
      assert.equal(git.git(["rev-parse", "refs/heads/release"]), git.resultCommit);
      const sql = yield* SqlClient.SqlClient;
      const pending = yield* sql<{
        status: string;
      }>`SELECT status FROM organization_git_integration_intents`;
      assert.equal(pending[0]?.status, "prepared");
      const recovered = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
      );
      assert.equal(recovered.appliedNow, false);
      const done = yield* sql<{
        status: string;
      }>`SELECT status FROM organization_git_integration_intents`;
      assert.equal(done[0]?.status, "applied");
    }),
  ),
);

it.effect("rejects a target already moved without a prior durable intent", () =>
  run((git) =>
    Effect.gen(function* () {
      const { services } = yield* fixture(git);
      git.git(["update-ref", "refs/heads/release", git.resultCommit]);
      const moved = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
        Effect.flip,
      );
      assert.equal(moved.code, "conflict");
      assert.equal(git.git(["rev-parse", "refs/heads/release"]), git.resultCommit);
    }),
  ),
);

it.effect("rejects approval evidence pinned to another Project root", () =>
  run((git) =>
    Effect.gen(function* () {
      const { services } = yield* fixture(git, { approvalRoot: "/different/root" });
      const stale = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
        Effect.flip,
      );
      assert.equal(stale.code, "conflict");
      assert.equal(git.git(["rev-parse", "refs/heads/release"]), git.baseCommit);
    }),
  ),
);

it.effect("rejects a symbolic target ref without moving its destination", () =>
  run((git) =>
    Effect.gen(function* () {
      const { services } = yield* fixture(git);
      git.git(["symbolic-ref", "refs/heads/release", "refs/heads/main"]);
      const rejected = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
        Effect.flip,
      );
      assert.equal(rejected.code, "conflict");
      assert.equal(git.git(["rev-parse", "refs/heads/main"]), git.baseCommit);
      assert.equal(git.git(["symbolic-ref", "refs/heads/release"]), "refs/heads/main");
    }),
  ),
);

it.effect("rejects a changed private candidate ref without touching the target", () =>
  run((git) =>
    Effect.gen(function* () {
      const { services, candidate } = yield* fixture(git);
      git.git(["update-ref", candidate.refName, git.baseCommit, git.resultCommit]);
      const rejected = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
        Effect.flip,
      );
      assert.equal(rejected.code, "conflict");
      assert.equal(git.git(["rev-parse", "refs/heads/release"]), git.baseCommit);
    }),
  ),
);

it.effect("rejects a checked-out linked worktree and a revoked binding", () =>
  run((git) =>
    Effect.gen(function* () {
      const { services } = yield* fixture(git);
      const linked = `${git.root}-linked`;
      git.git(["worktree", "add", "-q", linked, "release"]);
      try {
        const checkedOut = yield* coordinateOrganizationGitIntegration(request).pipe(
          Effect.provide(services),
          Effect.flip,
        );
        assert.equal(checkedOut.code, "conflict");
        assert.equal(git.git(["rev-parse", "refs/heads/release"]), git.baseCommit);
      } finally {
        git.git(["worktree", "remove", "--force", linked]);
        yield* Effect.promise(() => NodeFSP.rm(linked, { recursive: true, force: true }));
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_project_bindings SET updated_at = 'revoked' WHERE binding_id = 'binding'`;
      const revoked = yield* coordinateOrganizationGitIntegration(request).pipe(
        Effect.provide(services),
        Effect.flip,
      );
      assert.equal(revoked.code, "conflict");
      assert.equal(git.git(["rev-parse", "refs/heads/release"]), git.baseCommit);
    }),
  ),
);

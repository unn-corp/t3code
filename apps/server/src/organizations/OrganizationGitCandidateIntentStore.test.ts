import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration071 from "../persistence/Migrations/071_OrganizationWorkScopes.ts";
import Migration072 from "../persistence/Migrations/072_OrganizationWorkArtifacts.ts";
import Migration076 from "../persistence/Migrations/076_OrganizationGitCandidateIntents.ts";
import {
  OrganizationGitCandidateIntentStore,
  OrganizationGitCandidateIntentStoreLive,
  OrganizationGitCandidateIntentStoreWithAuthority,
  OrganizationGitCandidateRetentionAuthority,
} from "./OrganizationGitCandidateIntentStore.ts";
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  type OrganizationWorkArtifactCaptureInput,
} from "./OrganizationWorkArtifactStore.ts";

const baseCommit = "a".repeat(40);
const resultCommit = "c".repeat(40);
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const canonicalBytes = (artifactBaseCommit = baseCommit) => {
  const baseBytes = Buffer.from("export const answer = 1;\n");
  return createOrganizationSingleFileArtifact({
    relativePath: "source.mjs",
    baseCommit: artifactBaseCommit,
    baseBlobOid: "b".repeat(40),
    baseMode: "100644",
    baseSha256: sha256(baseBytes),
    baseBytes,
    replacementBytes: Buffer.from("export const answer = 2;\n"),
  });
};
const captureInput = (patchBytes: Uint8Array): OrganizationWorkArtifactCaptureInput => ({
  attemptId: "attempt-1",
  workId: "work",
  projectId: "project",
  baseCodeRevision: baseCommit,
  scopeUnitName: "t3-org-sandbox-00000000000000000000000000000001.scope",
  scopeInvocationId: "00000000000000000000000000000001",
  patchBytes,
  evidenceBytes: Buffer.from("fixture evidence"),
  outcome: {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    resourceLimitExceeded: false,
  },
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organizations (organization_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)`;
  yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
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
  yield* sql`INSERT INTO projection_projects VALUES ('project', NULL)`;
  yield* sql`INSERT INTO organization_project_bindings VALUES
    ('binding', 'org', 'project', 'write', NULL, NULL, 'version-1')`;
  yield* sql`INSERT INTO organization_work_items VALUES
    ('work', 'org', 'project', 'binding', 'version-1', NULL, ${baseCommit}, 'running', 1)`;
  yield* sql`INSERT INTO organization_work_attempts VALUES
    ('attempt-1', 'work', 1, 'running', '2099-01-01T00:00:00.000Z', NULL, NULL)`;
  yield* sql`INSERT INTO organization_work_resource_permits VALUES ('attempt-1', 'active')`;
  const input = captureInput(canonicalBytes());
  yield* sql`INSERT INTO organization_work_scopes
    (attempt_id, unit_name, invocation_id, control_group, sandbox_pid, pid_namespace,
     prepared_at, start_requested_at, token_released_at, started_at,
     stop_requested_at, verified_stopped_at)
    VALUES ('attempt-1', ${input.scopeUnitName}, ${input.scopeInvocationId},
      '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000001.scope',
      1000, 2000, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01',
      '2026-01-01', '2026-01-01')`;
});
const database = NodeSqliteClient.layerMemory();
const stores = (allowRetention: boolean) =>
  (allowRetention
    ? OrganizationGitCandidateIntentStoreWithAuthority.pipe(
        Layer.provideMerge(
          Layer.succeed(OrganizationGitCandidateRetentionAuthority, { permits: () => true }),
        ),
      )
    : OrganizationGitCandidateIntentStoreLive
  ).pipe(
    Layer.provideMerge(
      OrganizationWorkArtifactStoreWithAuthority.pipe(
        Layer.provideMerge(
          Layer.succeed(OrganizationWorkArtifactCaptureAuthority, { permits: () => true }),
        ),
      ),
    ),
    Layer.provideMerge(database),
  );
const submitted = (patchBytes: Uint8Array) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const receipt = yield* artifacts.capture(captureInput(patchBytes));
    yield* sql`UPDATE organization_work_attempts SET status = 'submitted',
      artifact_digest = ${receipt.artifactDigest}, artifact_ref = ${receipt.artifactRef}
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_items SET status = 'blocked' WHERE work_id = 'work'`;
    return receipt;
  });

it.effect("migration 76 applies after the full Organization migration chain", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 76 });
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{
      name: string;
    }>`PRAGMA table_info(organization_git_candidate_intents)`;
    assert.ok(columns.some((column) => column.name === "reviewed_artifact_digest"));
    assert.ok(columns.some((column) => column.name === "retained_at"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("prepares exact canonical submitted evidence, replays, and records retention once", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const receipt = yield* submitted(canonicalBytes());
    const store = yield* OrganizationGitCandidateIntentStore;
    const first = yield* store.prepare("attempt-1");
    assert.equal(first.status, "prepared");
    assert.equal(first.artifactReceiptDigest, receipt.artifactDigest);
    assert.equal(first.reviewedArtifactDigest, sha256(receipt.patchBytes));
    assert.equal(first.refName, `refs/t3-organizations/candidates/${sha256(receipt.patchBytes)}`);
    assert.deepEqual(yield* store.prepare("attempt-1"), first);
    assert.deepEqual(yield* store.listPrepared(10), [first]);
    const retained = yield* store.markRetained("attempt-1", resultCommit, first.refName);
    assert.equal(retained.status, "retained");
    assert.equal(retained.resultCommit, resultCommit);
    assert.deepEqual(yield* store.markRetained("attempt-1", resultCommit, first.refName), retained);
    assert.deepEqual(yield* store.get("attempt-1"), retained);
    assert.deepEqual(yield* store.listPrepared(10), []);
    assert.equal(
      (yield* store.markRetained("attempt-1", baseCommit, first.refName).pipe(Effect.flip)).code,
      "conflict",
    );
    assert.equal(
      (yield* store.markRetained("attempt-1", resultCommit, "refs/heads/main").pipe(Effect.flip))
        .code,
      "invalid",
    );
    const immutability = yield* sql`UPDATE organization_git_candidate_intents
      SET project_id = 'other' WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip);
    assert.ok(immutability);
  }).pipe(Effect.provide(stores(true))),
);

it.effect("denies live retention even for a prepared intent", () =>
  Effect.gen(function* () {
    yield* fixture;
    yield* submitted(canonicalBytes());
    const store = yield* OrganizationGitCandidateIntentStore;
    const prepared = yield* store.prepare("attempt-1");
    assert.equal(
      (yield* store.markRetained("attempt-1", resultCommit, prepared.refName).pipe(Effect.flip))
        .code,
      "forbidden",
    );
    assert.equal((yield* store.get("attempt-1"))?.status, "prepared");
  }).pipe(Effect.provide(stores(false))),
);

it.effect("rejects stale binding, older attempt, and noncanonical or mismatched artifact", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* submitted(canonicalBytes());
    const store = yield* OrganizationGitCandidateIntentStore;
    yield* sql`UPDATE organization_project_bindings SET updated_at = 'version-2'
      WHERE binding_id = 'binding'`;
    assert.equal((yield* store.prepare("attempt-1").pipe(Effect.flip)).code, "conflict");
    yield* sql`UPDATE organization_project_bindings SET updated_at = 'version-1'
      WHERE binding_id = 'binding'`;
    yield* sql`UPDATE organization_work_items SET attempt_count = 2 WHERE work_id = 'work'`;
    assert.equal((yield* store.prepare("attempt-1").pipe(Effect.flip)).code, "conflict");
    yield* sql`UPDATE organization_work_items SET attempt_count = 1 WHERE work_id = 'work'`;
    yield* sql`DROP TRIGGER organization_work_artifact_immutable`;
    yield* sql`UPDATE organization_work_artifacts SET patch_bytes = ${Buffer.from("tampered")}
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.prepare("attempt-1").pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(stores(true))),
);

it.effect("rejects intact noncanonical artifact", () =>
  Effect.gen(function* () {
    yield* fixture;
    yield* submitted(Buffer.from("not canonical"));
    const store = yield* OrganizationGitCandidateIntentStore;
    assert.equal((yield* store.prepare("attempt-1").pipe(Effect.flip)).code, "invalid");
    assert.equal(yield* store.get("attempt-1"), null);
  }).pipe(Effect.provide(stores(true))),
);

it.effect("rejects a canonical artifact for a different pinned base commit", () =>
  Effect.gen(function* () {
    yield* fixture;
    yield* submitted(canonicalBytes("d".repeat(40)));
    const store = yield* OrganizationGitCandidateIntentStore;
    assert.equal((yield* store.prepare("attempt-1").pipe(Effect.flip)).code, "conflict");
    assert.equal(yield* store.get("attempt-1"), null);
  }).pipe(Effect.provide(stores(true))),
);

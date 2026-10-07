import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration071 from "../persistence/Migrations/071_OrganizationWorkScopes.ts";
import Migration072 from "../persistence/Migrations/072_OrganizationWorkArtifacts.ts";
import Migration073 from "../persistence/Migrations/073_OrganizationWorkQAReceipts.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  type OrganizationWorkArtifactCaptureInput,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkQAReceiptCaptureAuthority,
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreLive,
  OrganizationWorkQAReceiptStoreWithAuthority,
  OrganizationWorkEvaluationVerifierFromQAReceipts,
  type OrganizationWorkQAReceiptCaptureInput,
} from "./OrganizationWorkQAReceiptStore.ts";
import { OrganizationWorkEvaluationVerifier } from "./OrganizationWorkStore.ts";

const artifactInput = (): OrganizationWorkArtifactCaptureInput => ({
  attemptId: "attempt-1",
  workId: "work",
  projectId: "project",
  baseCodeRevision: "revision-1",
  scopeUnitName: "t3-org-sandbox-00000000000000000000000000000001.scope",
  scopeInvocationId: "00000000000000000000000000000001",
  patchBytes: new TextEncoder().encode("diff --git a/a b/a\n+safe\n"),
  evidenceBytes: new TextEncoder().encode("tests passed"),
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
  const artifactStore = yield* OrganizationWorkArtifactStore;
  yield* sql`CREATE TABLE organizations (organization_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)`;
  yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
  yield* sql`CREATE TABLE organization_project_bindings (
    binding_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL, access TEXT NOT NULL, capabilities_json TEXT NOT NULL,
    scope TEXT, detached_at TEXT, updated_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_items (
    work_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL, binding_version TEXT NOT NULL, scope TEXT,
    code_revision TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_attempts (
    attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, number INTEGER NOT NULL,
    status TEXT NOT NULL, worker_subject TEXT NOT NULL, artifact_digest TEXT,
    artifact_ref TEXT, lease_until TEXT NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_resource_permits (
    attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
  yield* Migration071;
  yield* Migration072;
  yield* Migration073;
  yield* sql`INSERT INTO organizations VALUES ('org', 'active')`;
  yield* sql`INSERT INTO projection_projects VALUES ('project', NULL)`;
  yield* sql`INSERT INTO organization_project_bindings VALUES
    ('binding', 'org', 'project', 'write', '["read-files","write-files","run-tests"]',
     NULL, NULL, 'version-1')`;
  yield* sql`INSERT INTO organization_work_items VALUES
    ('work', 'org', 'project', 'binding', 'version-1', NULL,
     'revision-1', 'running', 1)`;
  yield* sql`INSERT INTO organization_work_attempts VALUES
    ('attempt-1', 'work', 1, 'running', 'worker-a', NULL, NULL,
     '2099-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO organization_work_resource_permits VALUES ('attempt-1', 'active')`;
  const attempt = artifactInput();
  yield* sql`INSERT INTO organization_work_scopes
    (attempt_id, unit_name, invocation_id, control_group, sandbox_pid, pid_namespace,
     prepared_at, start_requested_at, token_released_at, started_at,
     stop_requested_at, verified_stopped_at)
    VALUES ('attempt-1', ${attempt.scopeUnitName}, ${attempt.scopeInvocationId},
      '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000001.scope',
      1000, 2000, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01',
      '2026-01-01', '2026-01-01')`;
  const artifact = yield* artifactStore.capture(artifactInput());
  yield* sql`UPDATE organization_work_attempts
    SET status = 'submitted', artifact_digest = ${artifact.artifactDigest},
      artifact_ref = ${artifact.artifactRef} WHERE attempt_id = 'attempt-1'`;
  yield* sql`UPDATE organization_work_items SET status = 'blocked' WHERE work_id = 'work'`;
  yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
    WHERE attempt_id = 'attempt-1'`;
  return artifact;
});
const qaInput = (
  artifact: { artifactDigest: string; artifactRef: string },
  accepted = true,
): OrganizationWorkQAReceiptCaptureInput => ({
  workId: "work",
  attemptId: "attempt-1",
  projectId: "project",
  artifactDigest: artifact.artifactDigest,
  artifactRef: artifact.artifactRef,
  workerSubject: "worker-a",
  reviewerSubject: "reviewer-b",
  accepted,
  evidenceRef: "qa-evidence:fixture",
  evidenceBytes: new TextEncoder().encode("Independent tests: pass"),
});
const database = NodeSqliteClient.layerMemory();
const artifactPermitted = OrganizationWorkArtifactStoreWithAuthority.pipe(
  Layer.provide(Layer.succeed(OrganizationWorkArtifactCaptureAuthority, { permits: () => true })),
);
const permitted = OrganizationWorkQAReceiptStoreWithAuthority.pipe(
  Layer.provide(Layer.succeed(OrganizationWorkQAReceiptCaptureAuthority, { permits: () => true })),
  Layer.provideMerge(artifactPermitted),
  Layer.provideMerge(database),
);
const denied = OrganizationWorkQAReceiptStoreLive.pipe(
  Layer.provideMerge(artifactPermitted),
  Layer.provideMerge(database),
);

it.effect("migration 73 adds immutable bounded receipt columns", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 73 });
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(organization_work_qa_receipts)`;
    assert.ok(columns.some((column) => column.name === "evidence_bytes"));
    assert.ok(columns.some((column) => column.name === "receipt_digest"));
  }).pipe(Effect.provide(database)),
);

for (const accepted of [true, false])
  it.effect(
    `captures and verifies immutable ${accepted ? "accepted" : "rejected"} QA evidence`,
    () =>
      Effect.gen(function* () {
        const artifact = yield* fixture;
        const store = yield* OrganizationWorkQAReceiptStore;
        const input = qaInput(artifact, accepted);
        const saved = yield* store.capture(input);
        assert.equal(saved.accepted, accepted);
        assert.match(saved.receiptDigest, /^[a-f0-9]{64}$/);
        assert.deepEqual(saved.evidenceBytes, input.evidenceBytes);
        yield* store.verifyEvaluation(input);
        const verifier = yield* OrganizationWorkEvaluationVerifier;
        yield* verifier.verifyEvaluation(input);
        assert.equal((yield* store.capture(input)).receiptDigest, saved.receiptDigest);
        assert.equal(
          (yield* store.capture({ ...input, evidenceRef: "different" }).pipe(Effect.flip)).code,
          "conflict",
        );
        assert.equal(
          (yield* store.verifyEvaluation({ ...input, accepted: !accepted }).pipe(Effect.flip)).code,
          "conflict",
        );
      }).pipe(
        Effect.provide(
          OrganizationWorkEvaluationVerifierFromQAReceipts.pipe(Layer.provideMerge(permitted)),
        ),
      ),
  );

it.effect("rejects tampered bytes and mismatched artifact or reviewer", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkQAReceiptStore;
    const input = qaInput(artifact);
    yield* store.capture(input);
    for (const target of [
      { ...input, reviewerSubject: "other" },
      { ...input, artifactDigest: "f".repeat(64) },
      { ...input, artifactRef: "other" },
      { ...input, workId: "other" },
    ])
      assert.equal((yield* store.verifyEvaluation(target).pipe(Effect.flip)).code, "conflict");
    yield* sql`DROP TRIGGER organization_work_qa_receipt_immutable`;
    yield* sql`UPDATE organization_work_qa_receipts SET evidence_bytes = ${Buffer.from("tampered")}
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.verifyEvaluation(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(permitted)),
);

it.effect("replays an identical receipt after evaluation without accepting a new one", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkQAReceiptStore;
    const input = qaInput(artifact);
    const first = yield* store.capture(input);
    yield* sql`UPDATE organization_work_attempts SET status = 'qa-accepted'
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_items SET status = 'waiting-approval'
      WHERE work_id = 'work'`;
    assert.equal((yield* store.capture(input)).receiptDigest, first.receiptDigest);
    assert.equal(
      (yield* store.capture({ ...input, evidenceRef: "other" }).pipe(Effect.flip)).code,
      "conflict",
    );
  }).pipe(Effect.provide(permitted)),
);

it.effect("rejects a saved QA receipt when its underlying artifact bytes are tampered", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkQAReceiptStore;
    const input = qaInput(artifact);
    yield* store.capture(input);
    yield* store.verifyEvaluation(input);
    yield* sql`DROP TRIGGER organization_work_artifact_immutable`;
    yield* sql`UPDATE organization_work_artifacts SET patch_bytes = ${Buffer.from("tampered")}
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.verifyEvaluation(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(permitted)),
);

it.effect("rejects stale bindings, paused lifecycle, self review and oversized evidence", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkQAReceiptStore;
    const input = qaInput(artifact);
    assert.equal(
      (yield* store.capture({ ...input, reviewerSubject: "worker-a" }).pipe(Effect.flip)).code,
      "forbidden",
    );
    assert.equal(
      (yield* store.capture({ ...input, evidenceBytes: new Uint8Array(262_145) }).pipe(Effect.flip))
        .code,
      "invalid",
    );
    assert.equal(
      (yield* store.capture({ ...input, evidenceBytes: new Uint8Array() }).pipe(Effect.flip)).code,
      "invalid",
    );
    yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-01'
      WHERE binding_id = 'binding'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
    yield* sql`UPDATE organization_project_bindings SET detached_at = NULL
      WHERE binding_id = 'binding'`;
    yield* sql`UPDATE organizations SET lifecycle = 'paused' WHERE organization_id = 'org'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(permitted)),
);

it.effect("refuses QA capture when the attempt is not submitted or artifact bytes changed", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkQAReceiptStore;
    const input = qaInput(artifact);
    yield* sql`UPDATE organization_work_attempts SET status = 'running'
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
    yield* sql`UPDATE organization_work_attempts SET status = 'submitted'
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`DROP TRIGGER organization_work_artifact_immutable`;
    yield* sql`UPDATE organization_work_artifacts SET patch_bytes = ${Buffer.from("tampered")}
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(permitted)),
);

it.effect("default capture authority denies an otherwise valid QA receipt", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture;
    const store = yield* OrganizationWorkQAReceiptStore;
    assert.equal((yield* store.capture(qaInput(artifact)).pipe(Effect.flip)).code, "forbidden");
  }).pipe(Effect.provide(denied)),
);

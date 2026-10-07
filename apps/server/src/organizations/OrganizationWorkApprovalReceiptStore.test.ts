import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration071 from "../persistence/Migrations/071_OrganizationWorkScopes.ts";
import Migration072 from "../persistence/Migrations/072_OrganizationWorkArtifacts.ts";
import Migration073 from "../persistence/Migrations/073_OrganizationWorkQAReceipts.ts";
import Migration074 from "../persistence/Migrations/074_OrganizationWorkApprovalReceipts.ts";
import {
  OrganizationWorkApprovalCaptureAuthority,
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreLive,
  OrganizationWorkApprovalReceiptStoreWithAuthority,
  OrganizationWorkApprovalVerifierFromReceipts,
  type OrganizationWorkApprovalReceiptCaptureInput,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  type OrganizationWorkArtifactCaptureInput,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkQAReceiptCaptureAuthority,
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreWithAuthority,
} from "./OrganizationWorkQAReceiptStore.ts";
import { OrganizationWorkApprovalVerifier } from "./OrganizationWorkStore.ts";

const artifactInput: OrganizationWorkArtifactCaptureInput = {
  attemptId: "attempt-1",
  workId: "work",
  projectId: "project",
  baseCodeRevision: "revision-1",
  scopeUnitName: "t3-org-sandbox-00000000000000000000000000000001.scope",
  scopeInvocationId: "00000000000000000000000000000001",
  patchBytes: new TextEncoder().encode("diff --git a/a b/a\n+safe\n"),
  evidenceBytes: new TextEncoder().encode("sandbox tests passed"),
  outcome: {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    resourceLimitExceeded: false,
  },
};

const fixture = (withQA = true) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const qa = yield* OrganizationWorkQAReceiptStore;
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
      status TEXT NOT NULL, worker_subject TEXT NOT NULL, qa_subject TEXT,
      qa_evidence_ref TEXT, artifact_digest TEXT, artifact_ref TEXT,
      lease_until TEXT NOT NULL)`;
    yield* sql`CREATE TABLE organization_work_resource_permits (
      attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
    yield* Migration071;
    yield* Migration072;
    yield* Migration073;
    yield* Migration074;
    yield* sql`INSERT INTO organizations VALUES ('org', 'active')`;
    yield* sql`INSERT INTO projection_projects VALUES ('project', NULL)`;
    yield* sql`INSERT INTO organization_project_bindings VALUES
      ('binding', 'org', 'project', 'write', '["read-files","write-files","run-tests"]',
       NULL, NULL, 'version-1')`;
    yield* sql`INSERT INTO organization_work_items VALUES
      ('work', 'org', 'project', 'binding', 'version-1', NULL,
       'revision-1', 'running', 1)`;
    yield* sql`INSERT INTO organization_work_attempts VALUES
      ('attempt-1', 'work', 1, 'running', 'worker-a', NULL, NULL, NULL, NULL,
       '2099-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO organization_work_resource_permits VALUES ('attempt-1', 'active')`;
    yield* sql`INSERT INTO organization_work_scopes
      (attempt_id, unit_name, invocation_id, control_group, sandbox_pid, pid_namespace,
       prepared_at, start_requested_at, token_released_at, started_at,
       stop_requested_at, verified_stopped_at)
      VALUES ('attempt-1', ${artifactInput.scopeUnitName}, ${artifactInput.scopeInvocationId},
        '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000001.scope',
        1000, 2000, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01',
        '2026-01-01', '2026-01-01')`;
    const artifact = yield* artifacts.capture(artifactInput);
    yield* sql`UPDATE organization_work_attempts
      SET status = 'submitted', artifact_digest = ${artifact.artifactDigest},
        artifact_ref = ${artifact.artifactRef} WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_items SET status = 'blocked' WHERE work_id = 'work'`;
    yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
      WHERE attempt_id = 'attempt-1'`;
    if (withQA)
      yield* qa.capture({
        attemptId: "attempt-1",
        workId: "work",
        projectId: "project",
        artifactDigest: artifact.artifactDigest,
        artifactRef: artifact.artifactRef,
        workerSubject: "worker-a",
        reviewerSubject: "reviewer-b",
        accepted: true,
        evidenceRef: "qa-evidence:fixture",
        evidenceBytes: new TextEncoder().encode("Independent QA passed"),
      });
    yield* sql`UPDATE organization_work_attempts
      SET status = 'qa-accepted', qa_subject = 'reviewer-b',
        qa_evidence_ref = 'qa-evidence:fixture' WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_items SET status = 'waiting-approval'
      WHERE work_id = 'work'`;
    return artifact;
  });

const approvalInput = (
  artifact: { artifactRef: string; artifactDigest: string },
  approved = true,
): OrganizationWorkApprovalReceiptCaptureInput => ({
  attemptId: "attempt-1",
  workId: "work",
  projectId: "project",
  baseCodeRevision: "revision-1",
  artifactDigest: artifact.artifactDigest,
  artifactRef: artifact.artifactRef,
  workerSubject: "worker-a",
  qaSubject: "reviewer-b",
  approvalSubject: "human-c",
  approved,
  evidenceRef: "approval-evidence:fixture",
  evidenceBytes: new TextEncoder().encode("Human reviewed the accepted QA evidence"),
});

const database = NodeSqliteClient.layerMemory();
const artifactPermitted = OrganizationWorkArtifactStoreWithAuthority.pipe(
  Layer.provide(Layer.succeed(OrganizationWorkArtifactCaptureAuthority, { permits: () => true })),
);
const qaPermitted = OrganizationWorkQAReceiptStoreWithAuthority.pipe(
  Layer.provide(Layer.succeed(OrganizationWorkQAReceiptCaptureAuthority, { permits: () => true })),
  Layer.provideMerge(artifactPermitted),
);
const approvalPermitted = OrganizationWorkApprovalReceiptStoreWithAuthority.pipe(
  Layer.provide(
    Layer.succeed(OrganizationWorkApprovalCaptureAuthority, {
      permitsAuthenticatedHuman: () => true,
    }),
  ),
  Layer.provideMerge(qaPermitted),
  Layer.provideMerge(database),
);
const approvalDenied = OrganizationWorkApprovalReceiptStoreLive.pipe(
  Layer.provideMerge(qaPermitted),
  Layer.provideMerge(database),
);

it.effect("migration 74 applies after the full schema and adds bounded immutable receipts", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 74 });
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{
      name: string;
    }>`PRAGMA table_info(organization_work_approval_receipts)`;
    assert.ok(columns.some((column) => column.name === "qa_receipt_digest"));
    assert.ok(columns.some((column) => column.name === "evidence_bytes"));
  }).pipe(Effect.provide(database)),
);

for (const approved of [true, false])
  it.effect(`captures and verifies immutable ${approved ? "approval" : "rejection"}`, () =>
    Effect.gen(function* () {
      const artifact = yield* fixture();
      const store = yield* OrganizationWorkApprovalReceiptStore;
      const input = approvalInput(artifact, approved);
      const saved = yield* store.capture(input);
      assert.equal(saved.approved, approved);
      assert.match(saved.receiptDigest, /^[a-f0-9]{64}$/);
      assert.match(saved.qaReceiptDigest, /^[a-f0-9]{64}$/);
      yield* store.verifyApproval(input);
      const verifier = yield* OrganizationWorkApprovalVerifier;
      yield* verifier.verifyApproval(input);
      assert.equal((yield* store.capture(input)).receiptDigest, saved.receiptDigest);
      assert.equal(
        (yield* store.capture({ ...input, approved: !approved }).pipe(Effect.flip)).code,
        "conflict",
      );
    }).pipe(
      Effect.provide(
        OrganizationWorkApprovalVerifierFromReceipts.pipe(Layer.provideMerge(approvalPermitted)),
      ),
    ),
  );

it.effect("replays exact receipt after transition but rejects a changed decision", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkApprovalReceiptStore;
    const input = approvalInput(artifact);
    const first = yield* store.capture(input);
    yield* sql`UPDATE organization_work_items SET status = 'blocked' WHERE work_id = 'work'`;
    assert.equal((yield* store.capture(input)).receiptDigest, first.receiptDigest);
    assert.equal(
      (yield* store.capture({ ...input, evidenceRef: "other" }).pipe(Effect.flip)).code,
      "conflict",
    );
  }).pipe(Effect.provide(approvalPermitted)),
);

it.effect("rejects missing QA, stale binding, self approval and oversized evidence", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture(false);
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkApprovalReceiptStore;
    const input = approvalInput(artifact);
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
    assert.equal(
      (yield* store.capture({ ...input, approvalSubject: "worker-a" }).pipe(Effect.flip)).code,
      "forbidden",
    );
    assert.equal(
      (yield* store.capture({ ...input, approvalSubject: "reviewer-b" }).pipe(Effect.flip)).code,
      "forbidden",
    );
    assert.equal(
      (yield* store.capture({ ...input, evidenceBytes: new Uint8Array() }).pipe(Effect.flip)).code,
      "invalid",
    );
    assert.equal(
      (yield* store.capture({ ...input, evidenceBytes: new Uint8Array(262_145) }).pipe(Effect.flip))
        .code,
      "invalid",
    );
    yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-01'
      WHERE binding_id = 'binding'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(approvalPermitted)),
);

it.effect("rejects target replay and tampered saved approval bytes", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkApprovalReceiptStore;
    const input = approvalInput(artifact);
    yield* store.capture(input);
    for (const target of [
      { ...input, projectId: "other" },
      { ...input, artifactRef: "other" },
      { ...input, approvalSubject: "other" },
      { ...input, approved: false },
    ])
      assert.equal((yield* store.verifyApproval(target).pipe(Effect.flip)).code, "conflict");
    yield* sql`DROP TRIGGER organization_work_approval_receipt_immutable`;
    yield* sql`UPDATE organization_work_approval_receipts
      SET evidence_bytes = ${Buffer.from("tampered")} WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.verifyApproval(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(approvalPermitted)),
);

it.effect("rejects approval when underlying QA evidence bytes are tampered", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkApprovalReceiptStore;
    const input = approvalInput(artifact);
    yield* store.capture(input);
    yield* sql`DROP TRIGGER organization_work_qa_receipt_immutable`;
    yield* sql`UPDATE organization_work_qa_receipts
      SET evidence_bytes = ${Buffer.from("tampered QA")}
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.verifyApproval(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(approvalPermitted)),
);

it.effect("requires current binding and waiting approval for a new receipt", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkApprovalReceiptStore;
    const input = approvalInput(artifact);
    yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-01'
      WHERE binding_id = 'binding'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
    yield* sql`UPDATE organization_project_bindings SET detached_at = NULL
      WHERE binding_id = 'binding'`;
    yield* sql`UPDATE organization_work_items SET status = 'blocked' WHERE work_id = 'work'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(approvalPermitted)),
);

it.effect("live authority denies an otherwise valid human approval", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const store = yield* OrganizationWorkApprovalReceiptStore;
    assert.equal(
      (yield* store.capture(approvalInput(artifact)).pipe(Effect.flip)).code,
      "forbidden",
    );
  }).pipe(Effect.provide(approvalDenied)),
);

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration071 from "../persistence/Migrations/071_OrganizationWorkScopes.ts";
import Migration072 from "../persistence/Migrations/072_OrganizationWorkArtifacts.ts";
import Migration073 from "../persistence/Migrations/073_OrganizationWorkQAReceipts.ts";
import Migration074 from "../persistence/Migrations/074_OrganizationWorkApprovalReceipts.ts";
import Migration075 from "../persistence/Migrations/075_OrganizationWorkIntegrationReceipts.ts";
import {
  OrganizationWorkApprovalCaptureAuthority,
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreWithAuthority,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  type OrganizationWorkArtifactCaptureInput,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkIntegrationCaptureAuthority,
  OrganizationWorkIntegrationReceiptStore,
  OrganizationWorkIntegrationReceiptStoreLive,
  OrganizationWorkIntegrationReceiptStoreWithAuthority,
  OrganizationWorkIntegrationVerifierFromReceipts,
  type OrganizationWorkIntegrationReceiptCaptureInput,
} from "./OrganizationWorkIntegrationReceiptStore.ts";
import {
  OrganizationWorkQAReceiptCaptureAuthority,
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreWithAuthority,
} from "./OrganizationWorkQAReceiptStore.ts";
import { OrganizationWorkIntegrationVerifier } from "./OrganizationWorkStore.ts";

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

const fixture = (withApproval = true) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const qa = yield* OrganizationWorkQAReceiptStore;
    const approvals = yield* OrganizationWorkApprovalReceiptStore;
    yield* sql`CREATE TABLE organizations (organization_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)`;
    yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
    yield* sql`CREATE TABLE organization_project_bindings (
      binding_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL, access TEXT NOT NULL, capabilities_json TEXT NOT NULL,
      scope TEXT, detached_at TEXT, updated_at TEXT NOT NULL)`;
    yield* sql`CREATE TABLE organization_work_items (
      work_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, binding_version TEXT NOT NULL, scope TEXT,
      code_revision TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL,
      approval_subject TEXT, approval_evidence_ref TEXT)`;
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
    yield* Migration075;
    yield* sql`INSERT INTO organizations VALUES ('org', 'active')`;
    yield* sql`INSERT INTO projection_projects VALUES ('project', NULL)`;
    yield* sql`INSERT INTO organization_project_bindings VALUES
      ('binding', 'org', 'project', 'write', '["read-files","write-files","run-tests"]',
       NULL, NULL, 'version-1')`;
    yield* sql`INSERT INTO organization_work_items VALUES
      ('work', 'org', 'project', 'binding', 'version-1', NULL,
       'revision-1', 'running', 1, NULL, NULL)`;
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
    if (withApproval)
      yield* approvals.capture({
        attemptId: "attempt-1",
        workId: "work",
        projectId: "project",
        baseCodeRevision: "revision-1",
        artifactDigest: artifact.artifactDigest,
        artifactRef: artifact.artifactRef,
        workerSubject: "worker-a",
        qaSubject: "reviewer-b",
        approvalSubject: "human-c",
        approved: true,
        evidenceRef: "approval-evidence:fixture",
        evidenceBytes: new TextEncoder().encode("Human approved the QA result"),
      });
    yield* sql`UPDATE organization_work_items
      SET status = 'blocked', approval_subject = 'human-c',
        approval_evidence_ref = 'approval-evidence:fixture' WHERE work_id = 'work'`;
    return artifact;
  });

const integrationInput = (artifact: {
  artifactRef: string;
  artifactDigest: string;
}): OrganizationWorkIntegrationReceiptCaptureInput => ({
  attemptId: "attempt-1",
  workId: "work",
  projectId: "project",
  baseCodeRevision: "revision-1",
  resultCodeRevision: "revision-2",
  artifactDigest: artifact.artifactDigest,
  artifactRef: artifact.artifactRef,
  workerSubject: "worker-a",
  qaSubject: "reviewer-b",
  approvalSubject: "human-c",
  integratorSubject: "integrator-d",
  receiptRef: "integration-receipt:fixture",
  evidenceBytes: new TextEncoder().encode("Trusted integration fixture evidence"),
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
);
const permitted = OrganizationWorkIntegrationReceiptStoreWithAuthority.pipe(
  Layer.provide(
    Layer.succeed(OrganizationWorkIntegrationCaptureAuthority, {
      permitsTrustedProducer: () => true,
    }),
  ),
  Layer.provideMerge(approvalPermitted),
  Layer.provideMerge(database),
);
const denied = OrganizationWorkIntegrationReceiptStoreLive.pipe(
  Layer.provideMerge(approvalPermitted),
  Layer.provideMerge(database),
);

it.effect("migration 75 applies after the full schema with bounded immutable receipts", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 75 });
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{
      name: string;
    }>`PRAGMA table_info(organization_work_integration_receipts)`;
    assert.ok(columns.some((column) => column.name === "approval_receipt_digest"));
    assert.ok(columns.some((column) => column.name === "evidence_bytes"));
  }).pipe(Effect.provide(database)),
);

it.effect("captures and verifies exact approved artifact with immutable upstream digests", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const store = yield* OrganizationWorkIntegrationReceiptStore;
    const input = integrationInput(artifact);
    const saved = yield* store.capture(input);
    assert.match(saved.receiptDigest, /^[a-f0-9]{64}$/);
    assert.match(saved.qaReceiptDigest, /^[a-f0-9]{64}$/);
    assert.match(saved.approvalReceiptDigest, /^[a-f0-9]{64}$/);
    yield* store.verifyIntegration(input);
    const verifier = yield* OrganizationWorkIntegrationVerifier;
    yield* verifier.verifyIntegration(input);
    assert.equal((yield* store.capture(input)).receiptDigest, saved.receiptDigest);
    assert.equal(
      (yield* store.capture({ ...input, resultCodeRevision: "other" }).pipe(Effect.flip)).code,
      "conflict",
    );
  }).pipe(
    Effect.provide(
      OrganizationWorkIntegrationVerifierFromReceipts.pipe(Layer.provideMerge(permitted)),
    ),
  ),
);

it.effect("rejects missing approval and self integration", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture(false);
    const store = yield* OrganizationWorkIntegrationReceiptStore;
    const input = integrationInput(artifact);
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
    for (const integratorSubject of ["worker-a", "reviewer-b", "human-c"])
      assert.equal(
        (yield* store.capture({ ...input, integratorSubject }).pipe(Effect.flip)).code,
        "forbidden",
      );
  }).pipe(Effect.provide(permitted)),
);

it.effect("rejects stale binding and mismatched saved approval identity", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkIntegrationReceiptStore;
    const input = integrationInput(artifact);
    yield* sql`UPDATE organization_work_items SET approval_evidence_ref = 'other'
      WHERE work_id = 'work'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
    yield* sql`UPDATE organization_work_items SET approval_evidence_ref = 'approval-evidence:fixture'
      WHERE work_id = 'work'`;
    yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-01'
      WHERE binding_id = 'binding'`;
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(permitted)),
);

it.effect("rejects mismatched target and tampered integration or approval bytes", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkIntegrationReceiptStore;
    const input = integrationInput(artifact);
    yield* store.capture(input);
    for (const target of [
      { ...input, projectId: "other" },
      { ...input, artifactRef: "other" },
      { ...input, receiptRef: "other" },
      { ...input, resultCodeRevision: "other" },
    ])
      assert.equal((yield* store.verifyIntegration(target).pipe(Effect.flip)).code, "conflict");
    yield* sql`DROP TRIGGER organization_work_integration_receipt_immutable`;
    yield* sql`UPDATE organization_work_integration_receipts
      SET evidence_bytes = ${Buffer.from("tampered")}
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.verifyIntegration(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(permitted)),
);

it.effect("rejects corrupted approval evidence before integration capture", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkIntegrationReceiptStore;
    yield* sql`DROP TRIGGER organization_work_approval_receipt_immutable`;
    yield* sql`UPDATE organization_work_approval_receipts
      SET evidence_bytes = ${Buffer.from("tampered approval")}
      WHERE attempt_id = 'attempt-1'`;
    assert.equal(
      (yield* store.capture(integrationInput(artifact)).pipe(Effect.flip)).code,
      "conflict",
    );
  }).pipe(Effect.provide(permitted)),
);

it.effect("live capture denies and evidence bytes are bounded", () =>
  Effect.gen(function* () {
    const artifact = yield* fixture();
    const store = yield* OrganizationWorkIntegrationReceiptStore;
    const input = integrationInput(artifact);
    assert.equal((yield* store.capture(input).pipe(Effect.flip)).code, "forbidden");
    assert.equal(
      (yield* store.capture({ ...input, evidenceBytes: new Uint8Array() }).pipe(Effect.flip)).code,
      "invalid",
    );
    assert.equal(
      (yield* store.capture({ ...input, evidenceBytes: new Uint8Array(262_145) }).pipe(Effect.flip))
        .code,
      "invalid",
    );
  }).pipe(Effect.provide(denied)),
);

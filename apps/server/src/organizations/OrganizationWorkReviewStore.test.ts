// @effect-diagnostics nodeBuiltinImport:off - Disposable fixtures use Node UUIDs to create unique isolated database and filesystem data.
import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  OrganizationWorkApprovalCaptureAuthority,
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreWithAuthority,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkQAReceiptCaptureAuthority,
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreWithAuthority,
} from "./OrganizationWorkQAReceiptStore.ts";
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import {
  OrganizationWorkReviewStore,
  OrganizationWorkReviewStoreWithEvidence,
  reviewOrganizationWorkForSession,
} from "./OrganizationWorkReviewStore.ts";

const organizationId = OrganizationId.make("review-org");
const projectId = ProjectId.make("review-project");
const bindingId = OrganizationBindingId.make("review-binding");
const workId = OrganizationWorkId.make("review-work");
const attemptId = OrganizationWorkAttemptId.make("review-attempt");
const time = "2026-01-01T00:00:00.000Z";
const baseCommit = "a".repeat(40);
const unitName = "t3-org-sandbox-00000000000000000000000000000001.scope";
const invocationId = "00000000000000000000000000000001";
const input = { organizationId, workId, attemptId };

const replacement = 'export const answer = () => "sk-abcdefghijklmnop";\n';
const artifactBytes = (content = replacement) => {
  const baseBytes = Buffer.from("export const answer = () => 1;\n");
  return createOrganizationSingleFileArtifact({
    relativePath: "answer.mjs",
    baseCommit,
    baseBlobOid: "b".repeat(40),
    baseMode: "100644",
    baseSha256: NodeCrypto.createHash("sha256").update(baseBytes).digest("hex"),
    baseBytes,
    replacementBytes: Buffer.from(content),
  });
};

const artifactLayer = OrganizationWorkArtifactStoreWithAuthority.pipe(
  Layer.provide(Layer.succeed(OrganizationWorkArtifactCaptureAuthority, { permits: () => true })),
);
const qaLayer = OrganizationWorkQAReceiptStoreWithAuthority.pipe(
  Layer.provide(Layer.succeed(OrganizationWorkQAReceiptCaptureAuthority, { permits: () => true })),
  Layer.provideMerge(artifactLayer),
);
const approvalLayer = OrganizationWorkApprovalReceiptStoreWithAuthority.pipe(
  Layer.provide(
    Layer.succeed(OrganizationWorkApprovalCaptureAuthority, {
      permitsAuthenticatedHuman: () => true,
    }),
  ),
  Layer.provideMerge(qaLayer),
);
const testLayer = OrganizationWorkReviewStoreWithEvidence.pipe(
  Layer.provideMerge(approvalLayer),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);

const seed = (content = replacement) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const qaStore = yield* OrganizationWorkQAReceiptStore;
    const approvalStore = yield* OrganizationWorkApprovalReceiptStore;
    yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Review Project', ${NodeOS.tmpdir()}, '[]', ${time}, ${time})`;
    yield* sql`INSERT INTO organizations
    (organization_id, title, mission, lifecycle, draft_revision, published_revision,
     architect_role_id, director_role_id, graph_json, layout_json, created_at, updated_at)
    VALUES (${organizationId}, 'Review Org', 'Review', 'active', 1, 1,
      'architect', 'director', '{}', '{}', ${time}, ${time})`;
    yield* sql`INSERT INTO organization_project_bindings
    (binding_id, organization_id, project_id, access, capabilities_json, scope,
     detached_at, created_at, updated_at)
    VALUES (${bindingId}, ${organizationId}, ${projectId}, 'write',
      '["read-files","write-files","run-tests"]', NULL, NULL, ${time}, ${time})`;
    yield* sql`INSERT INTO organization_intake_sources
    (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
     credential_version, created_at, updated_at)
    VALUES ('review-source', ${organizationId}, ${projectId}, 'manual', 'Fixture',
      'human', 1, 1, ${time}, ${time})`;
    yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
     observation_ids_json, state, created_at)
    VALUES ('review-finding', ${organizationId}, 'review-source', 'review-dedup',
      'Fixture', '', '[]', 'tentative', ${time})`;
    yield* sql`INSERT INTO organization_work_items
    (work_id, request_id, request_json, organization_id, finding_id, project_id,
     binding_id, binding_version, scope, published_revision, workflow_id,
     workflow_version, code_revision, status, attempt_limit, attempt_count,
     creator_subject, created_at, updated_at)
    VALUES (${workId}, 'review-request', '{}', ${organizationId}, 'review-finding',
      ${projectId}, ${bindingId}, ${time}, NULL, 1, 'review-workflow', 1,
      ${baseCommit}, 'running', 1, 1, 'creator', ${time}, ${time})`;
    yield* sql`INSERT INTO organization_work_attempts
    (attempt_id, work_id, number, status, worker_subject, lease_until, started_at, updated_at)
    VALUES (${attemptId}, ${workId}, 1, 'running', 'worker-a',
      '2099-01-01T00:00:00.000Z', ${time}, ${time})`;
    yield* sql`INSERT INTO organization_work_resource_permits
    (attempt_id, work_id, organization_id, project_id, state, lease_until, granted_at, updated_at)
    VALUES (${attemptId}, ${workId}, ${organizationId}, ${projectId}, 'active',
      '2099-01-01T00:00:00.000Z', ${time}, ${time})`;
    yield* sql`INSERT INTO organization_work_scopes
    (attempt_id, unit_name, invocation_id, control_group, sandbox_pid, pid_namespace,
     prepared_at, start_requested_at, token_released_at, started_at,
     stop_requested_at, verified_stopped_at)
    VALUES (${attemptId}, ${unitName}, ${invocationId},
      '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000001.scope',
      1000, 2000, ${time}, ${time}, ${time}, ${time}, ${time}, ${time})`;
    const artifact = yield* artifacts.capture({
      attemptId,
      workId,
      projectId,
      baseCodeRevision: baseCommit,
      scopeUnitName: unitName,
      scopeInvocationId: invocationId,
      patchBytes: artifactBytes(content),
      evidenceBytes: Buffer.from("syntax check passed"),
      outcome: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimitExceeded: false,
        resourceLimitExceeded: false,
      },
    });
    yield* sql`UPDATE organization_work_attempts SET status = 'submitted',
    artifact_digest = ${artifact.artifactDigest}, artifact_ref = ${artifact.artifactRef}
    WHERE attempt_id = ${attemptId}`;
    yield* sql`UPDATE organization_work_items SET status = 'blocked' WHERE work_id = ${workId}`;
    yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
    WHERE attempt_id = ${attemptId}`;
    const qa = yield* qaStore.capture({
      attemptId,
      workId,
      projectId,
      artifactDigest: artifact.artifactDigest,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      reviewerSubject: "reviewer-b",
      accepted: true,
      evidenceRef: "qa:fixture",
      evidenceBytes: Buffer.from("QA result Bearer secret-review-token"),
    });
    yield* sql`UPDATE organization_work_attempts SET status = 'qa-accepted',
    qa_subject = 'reviewer-b', qa_evidence_ref = 'qa:fixture' WHERE attempt_id = ${attemptId}`;
    yield* sql`UPDATE organization_work_items SET status = 'waiting-approval' WHERE work_id = ${workId}`;
    const approval = yield* approvalStore.capture({
      attemptId,
      workId,
      projectId,
      baseCodeRevision: baseCommit,
      artifactDigest: artifact.artifactDigest,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      qaSubject: "reviewer-b",
      approvalSubject: "human-c",
      approved: true,
      evidenceRef: "approval:fixture",
      evidenceBytes: Buffer.from("Approved password=secret-approval-token"),
    });
    return { artifact, qa, approval };
  });

it.effect("returns only verified, bounded and redacted evidence for a current reader", () =>
  Effect.gen(function* () {
    const expected = yield* seed();
    const review = yield* OrganizationWorkReviewStore;
    const result = yield* review.get(input);
    assert.equal(result.artifact.digest, expected.artifact.artifactDigest);
    assert.match(result.projectRootDigest, /^[a-f0-9]{64}$/);
    assert.equal(result.artifact.relativePath, "answer.mjs");
    assert.equal(result.artifact.replacementBytes, Buffer.byteLength(replacement));
    assert.ok(result.artifact.replacementPreview?.includes("[REDACTED]"));
    assert.equal(result.artifact.reviewComplete, false);
    assert.equal(result.qa?.receiptDigest, expected.qa.receiptDigest);
    assert.equal(result.approval?.receiptDigest, expected.approval.receiptDigest);
    assert.ok(result.qa?.evidencePreview?.includes("[REDACTED]"));
    assert.ok(result.approval?.evidencePreview?.includes("[REDACTED]"));
    assert.ok(!result.qa?.evidencePreview?.includes("secret-review-token"));
    assert.ok(!result.approval?.evidencePreview?.includes("secret-approval-token"));
    assert.ok(!result.artifact.replacementPreview?.includes("abcdefghijklmnop"));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("caps replacement preview bytes while retaining the exact saved byte count", () =>
  Effect.gen(function* () {
    const content = `export const answer = () => "${"x".repeat(5_000)}";\n`;
    yield* seed(content);
    const review = yield* OrganizationWorkReviewStore;
    const result = yield* review.get(input);
    assert.equal(result.artifact.replacementBytes, Buffer.byteLength(content));
    assert.equal(result.artifact.previewTruncated, true);
    assert.equal(result.artifact.reviewComplete, false);
    assert.ok(result.artifact.replacementPreview);
    assert.ok(Buffer.byteLength(result.artifact.replacementPreview, "utf8") <= 4_096);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("marks a fully visible unchanged replacement reviewable", () =>
  Effect.gen(function* () {
    yield* seed("export const answer = () => 42;\n");
    const review = yield* OrganizationWorkReviewStore;
    const result = yield* review.get(input);
    assert.equal(result.artifact.reviewComplete, true);
    assert.equal(result.artifact.previewTruncated, false);
    assert.equal(result.artifact.replacementPreview, "export const answer = () => 42;\n");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("denies detached or capability-revoked bindings and rejects tampered evidence", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const review = yield* OrganizationWorkReviewStore;
    yield* sql`UPDATE organization_project_bindings SET capabilities_json = '[]'
      WHERE binding_id = ${bindingId}`;
    assert.equal((yield* review.get(input).pipe(Effect.flip)).code, "forbidden");
    yield* sql`UPDATE organization_project_bindings
      SET capabilities_json = '["read-files"]', detached_at = ${time}
      WHERE binding_id = ${bindingId}`;
    assert.equal((yield* review.get(input).pipe(Effect.flip)).code, "forbidden");
    yield* sql`UPDATE organization_project_bindings SET detached_at = NULL
      WHERE binding_id = ${bindingId}`;
    yield* sql`DROP TRIGGER organization_work_qa_receipt_immutable`;
    yield* sql`UPDATE organization_work_qa_receipts
      SET evidence_bytes = ${Buffer.from("tampered")} WHERE attempt_id = ${attemptId}`;
    assert.equal((yield* review.get(input).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects delegated sessions before evidence storage is called", () =>
  Effect.gen(function* () {
    let called = false;
    const error = yield* reviewOrganizationWorkForSession(
      { method: "bearer-access-token", subject: "delegated-agent" },
      {
        get: () => {
          called = true;
          return Effect.die("must not read");
        },
      },
      input,
    ).pipe(Effect.flip);
    assert.equal(error.code, "forbidden");
    assert.equal(called, false);
  }),
);

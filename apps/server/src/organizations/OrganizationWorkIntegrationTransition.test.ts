import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrganizationTentativeFindingId } from "../../../../packages/contracts/src/organizationIntake.ts";
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
  OrganizationWorkIntegrationCaptureAuthority,
  OrganizationWorkIntegrationReceiptStore,
  OrganizationWorkIntegrationReceiptStoreWithAuthority,
  OrganizationWorkIntegrationVerifierFromReceipts,
} from "./OrganizationWorkIntegrationReceiptStore.ts";
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
import {
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

const organizationId = OrganizationId.make("integration-transition-org");
const projectId = ProjectId.make("integration-transition-project");
const bindingId = OrganizationBindingId.make("integration-transition-binding");
const findingId = OrganizationTentativeFindingId.make("integration-transition-finding");
const workId = OrganizationWorkId.make("integration-transition-work");
const attemptId = OrganizationWorkAttemptId.make("integration-transition-attempt");
const updatedAt = "2026-01-01T00:00:00.000Z";
const scopeUnit = "t3-org-sandbox-00000000000000000000000000000001.scope";
const scopeInvocation = "00000000000000000000000000000001";
const integrator = { subject: "integrator-d" };

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
const integrationLayer = OrganizationWorkIntegrationReceiptStoreWithAuthority.pipe(
  Layer.provide(
    Layer.succeed(OrganizationWorkIntegrationCaptureAuthority, {
      permitsTrustedProducer: () => true,
    }),
  ),
  Layer.provideMerge(approvalLayer),
);
const verifierLayer = OrganizationWorkIntegrationVerifierFromReceipts.pipe(
  Layer.provideMerge(integrationLayer),
);
const appLayer = OrganizationWorkStoreLayer.pipe(
  Layer.provideMerge(verifierLayer),
  Layer.provide(OrganizationWorkArtifactVerifierDisabled),
  Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
  Layer.provide(OrganizationWorkApprovalVerifierDisabled),
  Layer.provide(
    Layer.succeed(OrganizationWorkExecutionAuthority, {
      permits: (action, principal, target) =>
        action === "integrate" &&
        principal.subject === integrator.subject &&
        target.organizationId === organizationId &&
        target.projectId === projectId &&
        target.bindingId === bindingId &&
        target.workId === workId,
    }),
  ),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);

const artifactInput: OrganizationWorkArtifactCaptureInput = {
  attemptId,
  workId,
  projectId,
  baseCodeRevision: "base-revision",
  scopeUnitName: scopeUnit,
  scopeInvocationId: scopeInvocation,
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

const seedApproved = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* OrganizationWorkArtifactStore;
  const qa = yield* OrganizationWorkQAReceiptStore;
  const approvals = yield* OrganizationWorkApprovalReceiptStore;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'QA Project', '/tmp/qa-project', '[]', ${updatedAt}, ${updatedAt})`;
  yield* sql`INSERT INTO organizations
    (organization_id, title, mission, lifecycle, draft_revision, published_revision,
     architect_role_id, director_role_id, graph_json, layout_json, created_at, updated_at)
    VALUES (${organizationId}, 'QA Org', 'Review work', 'active', 1, 1,
      'architect', 'director', '{}', '{}', ${updatedAt}, ${updatedAt})`;
  yield* sql`INSERT INTO organization_project_bindings
    (binding_id, organization_id, project_id, access, capabilities_json, scope,
     detached_at, created_at, updated_at)
    VALUES (${bindingId}, ${organizationId}, ${projectId}, 'write',
      '["read-files","write-files","run-tests"]', NULL, NULL, ${updatedAt}, ${updatedAt})`;
  yield* sql`INSERT INTO organization_intake_sources
    (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
     credential_version, created_at, updated_at)
    VALUES ('qa-source', ${organizationId}, ${projectId}, 'manual', 'Fixture source',
      'human', 1, 1, ${updatedAt}, ${updatedAt})`;
  yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
     observation_ids_json, state, created_at)
    VALUES (${findingId}, ${organizationId}, 'qa-source', 'qa-finding',
      'Fixture finding', '', '[]', 'tentative', ${updatedAt})`;
  yield* sql`INSERT INTO organization_work_items
    (work_id, request_id, request_json, organization_id, finding_id, project_id,
     binding_id, binding_version, scope, published_revision, workflow_id,
     workflow_version, code_revision, status, attempt_limit, attempt_count,
     creator_subject, created_at, updated_at)
    VALUES (${workId}, 'qa-request', '{}', ${organizationId}, ${findingId}, ${projectId},
      ${bindingId}, ${updatedAt}, NULL, 1, 'qa-workflow', 1, 'base-revision',
      'running', 1, 1, 'creator', ${updatedAt}, ${updatedAt})`;
  yield* sql`INSERT INTO organization_work_attempts
    (attempt_id, work_id, number, status, worker_subject, lease_until, started_at, updated_at)
    VALUES (${attemptId}, ${workId}, 1, 'running', 'worker-a',
      '2099-01-01T00:00:00.000Z', ${updatedAt}, ${updatedAt})`;
  yield* sql`INSERT INTO organization_work_resource_permits
    (attempt_id, work_id, organization_id, project_id, state, lease_until, granted_at, updated_at)
    VALUES (${attemptId}, ${workId}, ${organizationId}, ${projectId}, 'active',
      '2099-01-01T00:00:00.000Z', ${updatedAt}, ${updatedAt})`;
  yield* sql`INSERT INTO organization_work_scopes
    (attempt_id, unit_name, invocation_id, control_group, sandbox_pid, pid_namespace,
     prepared_at, start_requested_at, token_released_at, started_at,
     stop_requested_at, verified_stopped_at)
    VALUES (${attemptId}, ${scopeUnit}, ${scopeInvocation},
      '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000001.scope',
      1000, 2000, ${updatedAt}, ${updatedAt}, ${updatedAt}, ${updatedAt},
      ${updatedAt}, ${updatedAt})`;
  const artifact = yield* artifacts.capture(artifactInput);
  yield* sql`UPDATE organization_work_attempts
    SET status = 'submitted', artifact_digest = ${artifact.artifactDigest},
      artifact_ref = ${artifact.artifactRef} WHERE attempt_id = ${attemptId}`;
  yield* sql`UPDATE organization_work_items SET status = 'blocked' WHERE work_id = ${workId}`;
  yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
    WHERE attempt_id = ${attemptId}`;
  yield* qa.capture({
    attemptId,
    workId,
    projectId,
    artifactDigest: artifact.artifactDigest,
    artifactRef: artifact.artifactRef,
    workerSubject: "worker-a",
    reviewerSubject: "reviewer-b",
    accepted: true,
    evidenceRef: "qa-evidence:fixture",
    evidenceBytes: new TextEncoder().encode("Independent QA fixture evidence"),
  });
  yield* sql`UPDATE organization_work_attempts
    SET status = 'qa-accepted', qa_subject = 'reviewer-b',
      qa_evidence_ref = 'qa-evidence:fixture' WHERE attempt_id = ${attemptId}`;
  yield* sql`UPDATE organization_work_items SET status = 'waiting-approval'
    WHERE work_id = ${workId}`;
  yield* approvals.capture({
    attemptId,
    workId,
    projectId,
    baseCodeRevision: "base-revision",
    artifactDigest: artifact.artifactDigest,
    artifactRef: artifact.artifactRef,
    workerSubject: "worker-a",
    qaSubject: "reviewer-b",
    approvalSubject: "human-c",
    approved: true,
    evidenceRef: "approval-evidence:fixture",
    evidenceBytes: new TextEncoder().encode("Authenticated human fixture approval"),
  });
  yield* sql`UPDATE organization_work_items
    SET status = 'blocked', approval_subject = 'human-c',
      approval_evidence_ref = 'approval-evidence:fixture'
    WHERE work_id = ${workId}`;
  return artifact;
});

const integration = (artifactDigest: string, receiptRef = "integration-receipt:fixture") => ({
  workId,
  attemptId,
  transitionId: "integration-once",
  artifactDigest,
  baseCodeRevision: "base-revision",
  resultCodeRevision: "result-revision",
  receiptRef,
});
const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = (yield* sql<{
    status: string;
    integration_subject: string | null;
    integration_receipt_ref: string | null;
    result_code_revision: string | null;
  }>`SELECT status, integration_subject, integration_receipt_ref, result_code_revision
    FROM organization_work_items WHERE work_id = ${workId}`)[0];
  const attempt = (yield* sql<{
    status: string;
    qa_subject: string | null;
    qa_evidence_ref: string | null;
  }>`SELECT status, qa_subject, qa_evidence_ref FROM organization_work_attempts
    WHERE attempt_id = ${attemptId}`)[0];
  const transitions = (yield* sql<{ count: number }>`SELECT count(*) AS count
    FROM organization_work_transitions WHERE work_id = ${workId}`)[0]?.count;
  return { work, attempt, transitions };
});

it.effect("records matching persisted integration exactly once", () =>
  Effect.gen(function* () {
    const artifact = yield* seedApproved;
    const receipts = yield* OrganizationWorkIntegrationReceiptStore;
    const work = yield* OrganizationWorkStore;
    const input = integration(artifact.artifactDigest);
    yield* receipts.capture({
      ...input,
      projectId,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      qaSubject: "reviewer-b",
      approvalSubject: "human-c",
      integratorSubject: integrator.subject,
      evidenceBytes: new TextEncoder().encode("Trusted integration fixture evidence"),
    });
    const first = yield* work.recordIntegration(input, integrator);
    assert.equal(first.work.status, "succeeded");
    assert.equal(first.work.integrationSubject, integrator.subject);
    assert.equal(first.work.integrationReceiptRef, input.receiptRef);
    assert.equal(first.work.resultCodeRevision, input.resultCodeRevision);
    assert.equal(first.attempts[0]?.status, "qa-accepted");
    const repeated = yield* work.recordIntegration(input, integrator);
    assert.deepEqual(repeated, first);
    assert.deepEqual(yield* state, {
      work: {
        status: "succeeded",
        integration_subject: integrator.subject,
        integration_receipt_ref: input.receiptRef,
        result_code_revision: input.resultCodeRevision,
      },
      attempt: {
        status: "qa-accepted",
        qa_subject: "reviewer-b",
        qa_evidence_ref: "qa-evidence:fixture",
      },
      transitions: 1,
    });
  }).pipe(Effect.provide(appLayer)),
);

it.effect("leaves approved blocked work unchanged without an integration receipt", () =>
  Effect.gen(function* () {
    const artifact = yield* seedApproved;
    const work = yield* OrganizationWorkStore;
    const error = yield* work
      .recordIntegration(integration(artifact.artifactDigest), integrator)
      .pipe(Effect.flip);
    assert.equal(error.code, "not_found");
    assert.deepEqual(yield* state, {
      work: {
        status: "blocked",
        integration_subject: null,
        integration_receipt_ref: null,
        result_code_revision: null,
      },
      attempt: {
        status: "qa-accepted",
        qa_subject: "reviewer-b",
        qa_evidence_ref: "qa-evidence:fixture",
      },
      transitions: 0,
    });
  }).pipe(Effect.provide(appLayer)),
);

it.effect("leaves approved blocked work unchanged when integration receipt differs", () =>
  Effect.gen(function* () {
    const artifact = yield* seedApproved;
    const receipts = yield* OrganizationWorkIntegrationReceiptStore;
    const work = yield* OrganizationWorkStore;
    const receipt = integration(artifact.artifactDigest, "integration-receipt:saved");
    yield* receipts.capture({
      ...receipt,
      projectId,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      qaSubject: "reviewer-b",
      approvalSubject: "human-c",
      integratorSubject: integrator.subject,
      evidenceBytes: new TextEncoder().encode("Saved integration fixture evidence"),
    });
    const error = yield* work
      .recordIntegration(
        integration(artifact.artifactDigest, "integration-receipt:claimed"),
        integrator,
      )
      .pipe(Effect.flip);
    assert.equal(error.code, "conflict");
    assert.deepEqual(yield* state, {
      work: {
        status: "blocked",
        integration_subject: null,
        integration_receipt_ref: null,
        result_code_revision: null,
      },
      attempt: {
        status: "qa-accepted",
        qa_subject: "reviewer-b",
        qa_evidence_ref: "qa-evidence:fixture",
      },
      transitions: 0,
    });
  }).pipe(Effect.provide(appLayer)),
);

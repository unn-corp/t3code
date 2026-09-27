// @effect-diagnostics preferSchemaOverJson:off - Fixture inspects versioned approval evidence JSON.
import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
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
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import {
  OrganizationWorkApprovalCaptureAuthority,
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreWithAuthority,
  OrganizationWorkApprovalVerifierFromReceipts,
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
import {
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";
import {
  OrganizationSingleFileApprovalPolicy,
  OrganizationSingleFileApprovalPolicyDisabled,
  runOrganizationSingleFileApproval,
} from "./OrganizationSingleFileApprovalCoordinator.ts";
import { OrganizationSingleFileApprovalRevisionGuard } from "./OrganizationSingleFileApprovalRevision.ts";

const organizationId = OrganizationId.make("approval-coordinator-org");
const projectId = ProjectId.make("approval-coordinator-project");
const bindingId = OrganizationBindingId.make("approval-coordinator-binding");
const findingId = OrganizationTentativeFindingId.make("approval-coordinator-finding");
const workId = OrganizationWorkId.make("approval-coordinator-work");
const attemptId = OrganizationWorkAttemptId.make("approval-coordinator-attempt");
const baseCommit = "a".repeat(40);
const updatedAt = "2026-01-01T00:00:00.000Z";
const scopeUnit = "t3-org-sandbox-00000000000000000000000000000011.scope";
const scopeInvocation = "00000000000000000000000000000011";
const approver = "interactive-human-c";
const request = {
  workId,
  attemptId,
  requestId: "approval-request-one",
  reason: "Reviewed scoped QA evidence",
};
const codeOf = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const base = Buffer.from("export function solve(input) { return input.value; }\n");
const patchBytes = createOrganizationSingleFileArtifact({
  relativePath: "answer.mjs",
  baseCommit,
  baseBlobOid: "b".repeat(40),
  baseMode: "100644",
  baseSha256: hash(base),
  baseBytes: base,
  replacementBytes: Buffer.from("export function solve(input) { return input.value * 2; }\n"),
});

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
      permitsAuthenticatedHuman: (input, context) =>
        input.approvalSubject === approver &&
        context.organizationId === organizationId &&
        context.projectId === projectId,
    }),
  ),
  Layer.provideMerge(qaLayer),
);
const verifierLayer = OrganizationWorkApprovalVerifierFromReceipts.pipe(
  Layer.provideMerge(approvalLayer),
);
const workLayer = (allowApproval: () => boolean) =>
  OrganizationWorkStoreLayer.pipe(
    Layer.provideMerge(verifierLayer),
    Layer.provide(OrganizationWorkArtifactVerifierDisabled),
    Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
    Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
    Layer.provide(
      Layer.succeed(OrganizationWorkExecutionAuthority, {
        permits: (action, principal, target) =>
          action === "approve" &&
          allowApproval() &&
          principal.subject === approver &&
          target.organizationId === organizationId &&
          target.projectId === projectId &&
          target.bindingId === bindingId &&
          target.workId === workId,
      }),
    ),
  );
const policyLayer = (approved: boolean, approvalSubject = approver) =>
  Layer.succeed(OrganizationSingleFileApprovalPolicy, {
    decide: () => Effect.succeed({ approved, approvalSubject }),
  });
const layer = (policy = policyLayer(true), allowApproval: () => boolean = () => true) =>
  Layer.mergeAll(
    workLayer(allowApproval),
    approvalLayer,
    qaLayer,
    artifactLayer,
    policy,
    Layer.succeed(OrganizationSingleFileApprovalRevisionGuard, {
      verifyCurrent: () => Effect.void,
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const seedAccepted = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* OrganizationWorkArtifactStore;
  const qa = yield* OrganizationWorkQAReceiptStore;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', '/tmp/approval-coordinator-project', '[]', ${updatedAt}, ${updatedAt})`;
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
    VALUES ('approval-source', ${organizationId}, ${projectId}, 'manual', 'Fixture source',
      'human', 1, 1, ${updatedAt}, ${updatedAt})`;
  yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
     observation_ids_json, state, created_at)
    VALUES (${findingId}, ${organizationId}, 'approval-source', 'approval-finding',
      'Fixture finding', '', '[]', 'tentative', ${updatedAt})`;
  yield* sql`INSERT INTO organization_work_items
    (work_id, request_id, request_json, organization_id, finding_id, project_id,
     binding_id, binding_version, scope, published_revision, workflow_id,
     workflow_version, code_revision, status, attempt_limit, attempt_count,
     creator_subject, created_at, updated_at)
    VALUES (${workId}, 'approval-work-request', '{}', ${organizationId}, ${findingId}, ${projectId},
      ${bindingId}, ${updatedAt}, NULL, 1, 'qa-workflow', 1, ${baseCommit},
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
      '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000011.scope',
      1011, 2011, ${updatedAt}, ${updatedAt}, ${updatedAt}, ${updatedAt},
      ${updatedAt}, ${updatedAt})`;
  const artifact = yield* artifacts.capture({
    attemptId,
    workId,
    projectId,
    baseCodeRevision: baseCommit,
    scopeUnitName: scopeUnit,
    scopeInvocationId: scopeInvocation,
    patchBytes,
    evidenceBytes: Buffer.from("test-only stopped worker scope"),
    outcome: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputLimitExceeded: false,
      resourceLimitExceeded: false,
    },
  });
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
    evidenceRef: "qa-evidence-fixture",
    evidenceBytes: Buffer.from("test-only independent QA receipt"),
  });
  yield* sql`UPDATE organization_work_attempts
    SET status = 'qa-accepted', qa_subject = 'reviewer-b',
      qa_evidence_ref = 'qa-evidence-fixture' WHERE attempt_id = ${attemptId}`;
  yield* sql`UPDATE organization_work_items SET status = 'waiting-approval'
    WHERE work_id = ${workId}`;
  return artifact;
});

const run = (reason = request.reason) => runOrganizationSingleFileApproval({ ...request, reason });

it.effect("rejects credential-like reasons and approves exact QA-accepted evidence", () =>
  Effect.gen(function* () {
    const artifact = yield* seedAccepted;
    assert.equal(
      codeOf(yield* run("Reviewed. token=sk-abcdefghijklmnop").pipe(Effect.flip)),
      "invalid",
    );
    assert.equal(yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId), null);
    const result = yield* run("Reviewed independent QA evidence");
    assert.equal(result.work.status, "blocked");
    assert.equal(result.work.approvalSubject, approver);
    const receipt = yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId);
    assert.equal(receipt?.approved, true);
    assert.equal(receipt?.artifactDigest, artifact.artifactDigest);
    const evidence = Buffer.from(receipt!.evidenceBytes).toString();
    assert.match(evidence, /"qaReceiptDigest":"[a-f0-9]{64}"/);
    assert.match(evidence, /Reviewed independent QA evidence/);
    assert.equal(/sk-abcdefghijklmnop/.test(evidence), false);
    assert.equal(codeOf(yield* run("Different reviewed evidence").pipe(Effect.flip)), "conflict");
  }).pipe(Effect.provide(layer())),
);

it.effect("rejection records immutable evidence and cancels work", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const result = yield* run();
    assert.equal(result.work.status, "canceled");
    assert.equal(
      (yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId))?.approved,
      false,
    );
  }).pipe(Effect.provide(layer(policyLayer(false)))),
);

it.effect("retry after capture-before-transition reuses exact saved decision", () => {
  let allow = false;
  return Effect.gen(function* () {
    yield* seedAccepted;
    const first = yield* run().pipe(Effect.flip);
    assert.equal(codeOf(first), "forbidden");
    const receipt = yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId);
    assert.equal(receipt?.approved, true);
    const changedReason = yield* run("A different reason").pipe(Effect.flip);
    assert.equal(codeOf(changedReason), "conflict");
    const changedRequest = yield* runOrganizationSingleFileApproval({
      ...request,
      requestId: "approval-request-two",
    }).pipe(Effect.flip);
    assert.equal(codeOf(changedRequest), "conflict");
    allow = true;
    const result = yield* run();
    assert.equal(result.work.status, "blocked");
    assert.equal(
      (yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId))?.receiptDigest,
      receipt?.receiptDigest,
    );
    const transition = (yield* (yield* SqlClient.SqlClient)<{
      count: number;
    }>`SELECT count(*) AS count
      FROM organization_work_transitions WHERE action = 'approve' AND work_id = ${workId}`)[0];
    assert.equal(transition?.count, 1);
  }).pipe(Effect.provide(layer(policyLayer(true), () => allow)));
});

it.effect("replays a completed decision only while the pinned revision is current", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const first = yield* run();
    assert.equal(first.work.status, "blocked");
    const again = yield* run();
    assert.deepEqual(again, first);
    assert.equal(codeOf(yield* run("changed reason").pipe(Effect.flip)), "conflict");
  }).pipe(Effect.provide(layer())),
);

it.effect("disabled policy cannot capture approval", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const denied = yield* run().pipe(Effect.flip);
    assert.equal(codeOf(denied), "forbidden");
    assert.equal(yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer(OrganizationSingleFileApprovalPolicyDisabled))),
);

it.effect("stale binding cannot capture approval", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_project_bindings SET detached_at = ${updatedAt}
      WHERE binding_id = ${bindingId}`;
    const denied = yield* run().pipe(Effect.flip);
    assert.equal(codeOf(denied), "forbidden");
    assert.equal(yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer())),
);

it.effect("does not approve a path-scoped binding without path authorization semantics", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_work_items SET scope = 'src' WHERE work_id = ${workId}`;
    yield* sql`UPDATE organization_project_bindings SET scope = 'src'
      WHERE binding_id = ${bindingId}`;
    const denied = yield* run().pipe(Effect.flip);
    assert.equal(codeOf(denied), "forbidden");
    assert.equal(yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer())),
);

it.effect("changed submitted artifact identity cannot be approved", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_work_attempts SET artifact_digest = ${"0".repeat(64)}
      WHERE attempt_id = ${attemptId}`;
    const denied = yield* run().pipe(Effect.flip);
    assert.equal(codeOf(denied), "conflict");
    assert.equal(yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer())),
);

it.effect("mismatched accepted QA reference cannot be approved", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_work_attempts SET qa_evidence_ref = 'other-qa-evidence'
      WHERE attempt_id = ${attemptId}`;
    const denied = yield* run().pipe(Effect.flip);
    assert.equal(codeOf(denied), "conflict");
    assert.equal(yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer())),
);

it.effect("snapshots mutable authenticated policy decision before evidence and transition", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const result = yield* run();
    assert.equal(result.work.status, "blocked");
    assert.equal(result.work.approvalSubject, approver);
    const receipt = yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId);
    assert.equal(receipt?.approved, true);
  }).pipe(
    Effect.provide(
      layer(
        Layer.succeed(OrganizationSingleFileApprovalPolicy, {
          decide: () => {
            let subjectReads = 0;
            let decisionReads = 0;
            return Effect.succeed({
              get approvalSubject() {
                subjectReads += 1;
                return subjectReads === 1 ? approver : "worker-a";
              },
              get approved() {
                decisionReads += 1;
                return decisionReads === 1;
              },
            });
          },
        }),
      ),
    ),
  ),
);

it.effect("worker or QA subject cannot self-approve", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const denied = yield* run().pipe(Effect.flip);
    assert.equal(codeOf(denied), "forbidden");
    assert.equal(yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer(policyLayer(true, "worker-a")))),
);

it.effect("QA reviewer cannot self-approve", () =>
  Effect.gen(function* () {
    yield* seedAccepted;
    const denied = yield* run().pipe(Effect.flip);
    assert.equal(codeOf(denied), "forbidden");
    assert.equal(yield* (yield* OrganizationWorkApprovalReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer(policyLayer(true, "reviewer-b")))),
);

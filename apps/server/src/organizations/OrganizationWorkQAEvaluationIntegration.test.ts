import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { OrganizationTentativeFindingId } from "../../../../packages/contracts/src/organizationIntake.ts";
import {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import { runMigrations } from "../persistence/Migrations.ts";
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
  OrganizationWorkEvaluationVerifierFromQAReceipts,
} from "./OrganizationWorkQAReceiptStore.ts";
import {
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

const organizationId = OrganizationId.make("qa-integration-org");
const projectId = ProjectId.make("qa-integration-project");
const bindingId = OrganizationBindingId.make("qa-integration-binding");
const findingId = OrganizationTentativeFindingId.make("qa-integration-finding");
const workId = OrganizationWorkId.make("qa-integration-work");
const attemptId = OrganizationWorkAttemptId.make("qa-integration-attempt");
const updatedAt = "2026-01-01T00:00:00.000Z";
const scopeUnit = "t3-org-sandbox-00000000000000000000000000000001.scope";
const scopeInvocation = "00000000000000000000000000000001";
const reviewer = { subject: "reviewer-b" };

const artifactLayer = OrganizationWorkArtifactStoreWithAuthority.pipe(
  Layer.provide(Layer.succeed(OrganizationWorkArtifactCaptureAuthority, { permits: () => true })),
);
const qaLayer = OrganizationWorkQAReceiptStoreWithAuthority.pipe(
  Layer.provide(Layer.succeed(OrganizationWorkQAReceiptCaptureAuthority, { permits: () => true })),
  Layer.provideMerge(artifactLayer),
);
const verifierLayer = OrganizationWorkEvaluationVerifierFromQAReceipts.pipe(
  Layer.provideMerge(qaLayer),
);
const appLayer = OrganizationWorkStoreLayer.pipe(
  Layer.provideMerge(verifierLayer),
  Layer.provide(OrganizationWorkArtifactVerifierDisabled),
  Layer.provide(OrganizationWorkApprovalVerifierDisabled),
  Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
  Layer.provide(
    Layer.succeed(OrganizationWorkExecutionAuthority, {
      permits: (action, principal, target) =>
        action === "evaluate" &&
        principal.subject === reviewer.subject &&
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

const seedSubmitted = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* OrganizationWorkArtifactStore;
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
  return artifact;
});

const evaluation = (artifactDigest: string, evidenceRef = "qa-evidence:fixture") => ({
  workId,
  attemptId,
  transitionId: "qa-evaluate-once",
  artifactDigest,
  accepted: true,
  evidenceRef,
});
const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = (yield* sql<{ status: string }>`SELECT status FROM organization_work_items
    WHERE work_id = ${workId}`)[0]?.status;
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

it.effect("accepts matching persisted QA evidence exactly once", () =>
  Effect.gen(function* () {
    const artifact = yield* seedSubmitted;
    const qa = yield* OrganizationWorkQAReceiptStore;
    const work = yield* OrganizationWorkStore;
    const input = evaluation(artifact.artifactDigest);
    yield* qa.capture({
      ...input,
      projectId,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      reviewerSubject: reviewer.subject,
      evidenceBytes: new TextEncoder().encode("Independent QA fixture evidence"),
    });
    const first = yield* work.evaluateAttempt(input, reviewer);
    assert.equal(first.work.status, "waiting-approval");
    assert.equal(first.attempts[0]?.status, "qa-accepted");
    const repeated = yield* work.evaluateAttempt(input, reviewer);
    assert.deepEqual(repeated, first);
    assert.deepEqual(yield* state, {
      work: "waiting-approval",
      attempt: {
        status: "qa-accepted",
        qa_subject: reviewer.subject,
        qa_evidence_ref: input.evidenceRef,
      },
      transitions: 1,
    });
  }).pipe(Effect.provide(appLayer)),
);

it.effect("leaves submitted work unchanged without a saved QA receipt", () =>
  Effect.gen(function* () {
    const artifact = yield* seedSubmitted;
    const work = yield* OrganizationWorkStore;
    const error = yield* work
      .evaluateAttempt(evaluation(artifact.artifactDigest), reviewer)
      .pipe(Effect.flip);
    assert.equal(error.code, "not_found");
    assert.deepEqual(yield* state, {
      work: "blocked",
      attempt: { status: "submitted", qa_subject: null, qa_evidence_ref: null },
      transitions: 0,
    });
  }).pipe(Effect.provide(appLayer)),
);

it.effect("leaves submitted work unchanged when saved QA evidence differs", () =>
  Effect.gen(function* () {
    const artifact = yield* seedSubmitted;
    const qa = yield* OrganizationWorkQAReceiptStore;
    const work = yield* OrganizationWorkStore;
    const receipt = evaluation(artifact.artifactDigest, "qa-evidence:saved");
    yield* qa.capture({
      ...receipt,
      projectId,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      reviewerSubject: reviewer.subject,
      evidenceBytes: new TextEncoder().encode("Saved QA fixture evidence"),
    });
    const error = yield* work
      .evaluateAttempt(evaluation(artifact.artifactDigest, "qa-evidence:claimed"), reviewer)
      .pipe(Effect.flip);
    assert.equal(error.code, "conflict");
    assert.deepEqual(yield* state, {
      work: "blocked",
      attempt: { status: "submitted", qa_subject: null, qa_evidence_ref: null },
      transitions: 0,
    });
  }).pipe(Effect.provide(appLayer)),
);

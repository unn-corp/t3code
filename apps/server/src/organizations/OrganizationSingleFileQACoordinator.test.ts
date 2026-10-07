// @effect-diagnostics nodeBuiltinImport:off - Disposable fixtures use Node UUIDs to create unique isolated database and filesystem data.
// @effect-diagnostics preferSchemaOverJson:off - Fixture evidence uses the versioned coordinator JSON format.
import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
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
import { createOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import { isOrganizationScopedSandboxAvailable } from "./OrganizationScopedSandboxHost.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  OrganizationWorkArtifactVerifierFromStore,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkQAReceiptCaptureAuthority,
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreWithAuthority,
  OrganizationWorkEvaluationVerifierFromQAReceipts,
} from "./OrganizationWorkQAReceiptStore.ts";
import {
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";
import {
  OrganizationSingleFileQAHost,
  OrganizationSingleFileQAPolicy,
  OrganizationSingleFileQAPolicyDisabled,
  runOrganizationSingleFileQA,
} from "./OrganizationSingleFileQACoordinator.ts";
import { evaluateOrganizationSingleFileQA } from "./OrganizationSingleFileQAEvaluator.ts";

const organizationId = OrganizationId.make("qa-coordinator-org");
const projectId = ProjectId.make("qa-coordinator-project");
const bindingId = OrganizationBindingId.make("qa-coordinator-binding");
const findingId = OrganizationTentativeFindingId.make("qa-coordinator-finding");
const workId = OrganizationWorkId.make("qa-coordinator-work");
const attemptId = OrganizationWorkAttemptId.make("qa-coordinator-attempt");
const secondAttemptId = OrganizationWorkAttemptId.make("qa-coordinator-attempt-2");
const thirdAttemptId = OrganizationWorkAttemptId.make("qa-coordinator-attempt-3");
const baseCommit = "a".repeat(40);
const updatedAt = "2026-01-01T00:00:00.000Z";
const scopeUnit = "t3-org-sandbox-00000000000000000000000000000001.scope";
const scopeInvocation = "00000000000000000000000000000001";
const secondScopeUnit = "t3-org-sandbox-00000000000000000000000000000002.scope";
const secondScopeInvocation = "00000000000000000000000000000002";
const reviewerSubject = "independent-qa-policy";
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const codeOf = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
const base = Buffer.from("export function solve(input) { return input.value; }\n");

const artifactBytes = (replacement: string) =>
  createOrganizationSingleFileArtifact({
    relativePath: "answer.mjs",
    baseCommit,
    baseBlobOid: "b".repeat(40),
    baseMode: "100644",
    baseSha256: hash(base),
    baseBytes: base,
    replacementBytes: Buffer.from(replacement),
  });

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
const artifactVerifierLayer = OrganizationWorkArtifactVerifierFromStore.pipe(
  Layer.provideMerge(artifactLayer),
);
const workLayer = OrganizationWorkStoreLayer.pipe(
  Layer.provideMerge(verifierLayer),
  Layer.provideMerge(artifactVerifierLayer),
  Layer.provide(OrganizationWorkApprovalVerifierDisabled),
  Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
  Layer.provide(
    Layer.succeed(OrganizationWorkExecutionAuthority, {
      permits: (action, principal, target) =>
        ((action === "evaluate" && principal.subject === reviewerSubject) ||
          ((action === "claim" || action === "submit") && principal.subject === "worker-b")) &&
        target.organizationId === organizationId &&
        target.projectId === projectId &&
        target.bindingId === bindingId &&
        target.workId === workId,
    }),
  ),
);
const policyLayer = Layer.succeed(OrganizationSingleFileQAPolicy, {
  select: () =>
    Effect.succeed({
      reviewerSubject,
      plan: {
        version: 1 as const,
        exportName: "solve",
        cases: [
          { input: { value: 3 }, expected: 6 },
          { input: { value: 5 }, expected: 10 },
        ],
      },
    }),
});
const layer = (policy = policyLayer) =>
  Layer.mergeAll(
    workLayer,
    qaLayer,
    artifactLayer,
    policy,
    Layer.succeed(OrganizationSingleFileQAHost, {
      evaluate: (_attemptId, input) => evaluateOrganizationSingleFileQA(input),
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const seed = (replacement: string, attemptLimit = 1) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const artifacts = yield* OrganizationWorkArtifactStore;
    yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'QA Project', '/tmp/qa-coordinator-project', '[]', ${updatedAt}, ${updatedAt})`;
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
    VALUES ('qa-coordinator-source', ${organizationId}, ${projectId}, 'manual', 'Fixture source',
      'human', 1, 1, ${updatedAt}, ${updatedAt})`;
    yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
     observation_ids_json, state, created_at)
    VALUES (${findingId}, ${organizationId}, 'qa-coordinator-source', 'qa-coordinator-finding',
      'Fixture finding', '', '[]', 'tentative', ${updatedAt})`;
    yield* sql`INSERT INTO organization_work_items
    (work_id, request_id, request_json, organization_id, finding_id, project_id,
     binding_id, binding_version, scope, published_revision, workflow_id,
     workflow_version, code_revision, status, attempt_limit, attempt_count,
     creator_subject, created_at, updated_at)
    VALUES (${workId}, 'qa-coordinator-request', '{}', ${organizationId}, ${findingId}, ${projectId},
      ${bindingId}, ${updatedAt}, NULL, 1, 'qa-workflow', 1, ${baseCommit},
        'running', ${attemptLimit}, 1, 'creator', ${updatedAt}, ${updatedAt})`;
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
    const artifact = yield* artifacts.capture({
      attemptId,
      workId,
      projectId,
      baseCodeRevision: baseCommit,
      scopeUnitName: scopeUnit,
      scopeInvocationId: scopeInvocation,
      patchBytes: artifactBytes(replacement),
      evidenceBytes: Buffer.from("fixture scoped evidence"),
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
    return artifact;
  });

const run = runOrganizationSingleFileQA({ workId, attemptId });
const available = isOrganizationScopedSandboxAvailable();

it.effect.skipIf(!available)(
  "rejects faulty replacement and saves rejected receipt plus failed work",
  () =>
    Effect.gen(function* () {
      yield* seed("export function solve(input) { return input.value; }\n");
      const result = yield* run;
      assert.equal(result.work.status, "failed");
      assert.equal(result.attempts[0]?.status, "qa-rejected");
      const receipt = yield* (yield* OrganizationWorkQAReceiptStore).get(attemptId);
      assert.equal(receipt?.accepted, false);
      assert.equal(receipt?.reviewerSubject, reviewerSubject);
      assert.match(Buffer.from(receipt!.evidenceBytes).toString(), /wrong_result/);
    }).pipe(Effect.provide(layer())),
);

it.effect.skipIf(!available)("accepts correct replacement with saved independent QA evidence", () =>
  Effect.gen(function* () {
    yield* seed("export function solve(input) { return input.value * 2; }\n");
    const result = yield* run;
    assert.equal(result.work.status, "waiting-approval");
    assert.equal(result.attempts[0]?.status, "qa-accepted");
    const receipt = yield* (yield* OrganizationWorkQAReceiptStore).get(attemptId);
    assert.equal(receipt?.accepted, true);
    assert.match(Buffer.from(receipt!.evidenceBytes).toString(), /"reason":"passed"/);
  }).pipe(Effect.provide(layer())),
);

it.effect.skipIf(!available)(
  "retries a rejected first attempt, accepts a corrected second, and bars a third",
  () =>
    Effect.gen(function* () {
      yield* seed("export function solve(input) { return input.value; }\n", 2);
      const work = yield* OrganizationWorkStore;
      const artifacts = yield* OrganizationWorkArtifactStore;
      const qa = yield* OrganizationWorkQAReceiptStore;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* run;
      assert.equal(first.work.status, "retrying");
      assert.equal(first.work.attemptCount, 1);
      assert.equal(first.work.attemptLimit, 2);
      assert.equal(first.attempts[0]?.status, "qa-rejected");
      assert.equal((yield* qa.get(attemptId))?.accepted, false);

      const claimed = yield* work.claimAttempt(
        {
          workId,
          attemptId: secondAttemptId,
          transitionId: "qa-retry-claim",
          leaseSeconds: 300,
        },
        { subject: "worker-b" },
      );
      assert.equal(claimed.work.status, "running");
      assert.equal(claimed.work.attemptCount, 2);
      assert.equal(claimed.attempts[1]?.status, "running");

      // Test-only verified-stop fixture for the second worker. The QA evaluator
      // itself still runs in a real scoped sandbox below.
      yield* sql`INSERT INTO organization_work_scopes
      (attempt_id, unit_name, invocation_id, control_group, sandbox_pid, pid_namespace,
       prepared_at, start_requested_at, token_released_at, started_at,
       stop_requested_at, verified_stopped_at)
      VALUES (${secondAttemptId}, ${secondScopeUnit}, ${secondScopeInvocation},
        '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000002.scope',
        1001, 2001, ${updatedAt}, ${updatedAt}, ${updatedAt}, ${updatedAt},
        ${updatedAt}, ${updatedAt})`;
      const corrected = yield* artifacts.capture({
        attemptId: secondAttemptId,
        workId,
        projectId,
        baseCodeRevision: baseCommit,
        scopeUnitName: secondScopeUnit,
        scopeInvocationId: secondScopeInvocation,
        patchBytes: artifactBytes("export function solve(input) { return input.value * 2; }\n"),
        evidenceBytes: Buffer.from("test-only second stopped scope evidence"),
        outcome: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimitExceeded: false,
          resourceLimitExceeded: false,
        },
      });
      const submitted = yield* work.submitAttempt(
        {
          workId,
          attemptId: secondAttemptId,
          transitionId: "qa-retry-submit",
          artifactDigest: corrected.artifactDigest,
          artifactRef: corrected.artifactRef,
        },
        { subject: "worker-b" },
      );
      assert.equal(submitted.work.status, "blocked");
      assert.equal(submitted.attempts[1]?.status, "submitted");

      const accepted = yield* runOrganizationSingleFileQA({ workId, attemptId: secondAttemptId });
      assert.equal(accepted.work.status, "waiting-approval");
      assert.equal(accepted.work.attemptCount, 2);
      assert.equal(accepted.attempts[1]?.status, "qa-accepted");
      assert.equal((yield* qa.get(secondAttemptId))?.accepted, true);
      const third = yield* work
        .claimAttempt(
          {
            workId,
            attemptId: thirdAttemptId,
            transitionId: "qa-third-claim",
            leaseSeconds: 300,
          },
          { subject: "worker-b" },
        )
        .pipe(Effect.flip);
      assert.equal(codeOf(third), "conflict");
      assert.equal((yield* work.getWork(workId)).attempts.length, 2);
    }).pipe(Effect.provide(layer())),
);

it.effect.skipIf(!available)("snapshots a mutable policy plan before hashing and evaluating", () =>
  Effect.gen(function* () {
    yield* seed("export function solve(input) { return input.value * 2; }\n");
    const result = yield* run;
    assert.equal(result.work.status, "waiting-approval");
    const receipt = yield* (yield* OrganizationWorkQAReceiptStore).get(attemptId);
    assert.equal(receipt?.accepted, true);
  }).pipe(
    Effect.provide(
      layer(
        Layer.succeed(OrganizationSingleFileQAPolicy, {
          select: () => {
            let reads = 0;
            return Effect.succeed({
              reviewerSubject,
              plan: {
                version: 1 as const,
                exportName: "solve",
                get cases() {
                  reads += 1;
                  return reads === 1
                    ? [{ input: { value: 3 }, expected: 6 }]
                    : [{ input: { value: 3 }, expected: 999 }];
                },
              },
            });
          },
        }),
      ),
    ),
  ),
);

it.effect("disabled policy cannot transition submitted work", () =>
  Effect.gen(function* () {
    yield* seed("export function solve(input) { return input.value * 2; }\n");
    const rejected = yield* run.pipe(Effect.flip);
    assert.equal(codeOf(rejected), "forbidden");
    const detail = yield* (yield* OrganizationWorkStore).getWork(workId);
    assert.equal(detail.work.status, "blocked");
    assert.equal(yield* (yield* OrganizationWorkQAReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer(OrganizationSingleFileQAPolicyDisabled))),
);

it.effect("stale binding cannot transition", () =>
  Effect.gen(function* () {
    yield* seed("export function solve(input) { return input.value * 2; }\n");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_project_bindings SET detached_at = ${updatedAt}
      WHERE binding_id = ${bindingId}`;
    const rejected = yield* run.pipe(Effect.flip);
    assert.equal(codeOf(rejected), "forbidden");
    const detail = yield* (yield* OrganizationWorkStore).getWork(workId);
    assert.equal(detail.work.status, "blocked");
  }).pipe(Effect.provide(layer())),
);

it.effect("changed submitted artifact identity cannot transition", () =>
  Effect.gen(function* () {
    yield* seed("export function solve(input) { return input.value * 2; }\n");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_work_attempts SET artifact_digest = ${"0".repeat(64)}
      WHERE attempt_id = ${attemptId}`;
    const rejected = yield* run.pipe(Effect.flip);
    assert.equal(codeOf(rejected), "conflict");
    const detail = yield* (yield* OrganizationWorkStore).getWork(workId);
    assert.equal(detail.work.status, "blocked");
    assert.equal(yield* (yield* OrganizationWorkQAReceiptStore).get(attemptId), null);
  }).pipe(Effect.provide(layer())),
);

it.effect("saved receipt from a different server policy plan cannot be replayed", () =>
  Effect.gen(function* () {
    const artifact = yield* seed("export function solve(input) { return input.value * 2; }\n");
    const qa = yield* OrganizationWorkQAReceiptStore;
    yield* qa.capture({
      workId,
      attemptId,
      projectId,
      artifactDigest: artifact.artifactDigest,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      reviewerSubject,
      accepted: true,
      evidenceRef: "qa-old-plan",
      evidenceBytes: Buffer.from(JSON.stringify({ version: 1, policyPlanSha256: "0".repeat(64) })),
    });
    const rejected = yield* run.pipe(Effect.flip);
    assert.equal(codeOf(rejected), "conflict");
    const detail = yield* (yield* OrganizationWorkStore).getWork(workId);
    assert.equal(detail.work.status, "blocked");
  }).pipe(Effect.provide(layer())),
);

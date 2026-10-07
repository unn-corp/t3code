// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Disposable Git and exact versioned evidence fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
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
  OrganizationGitCandidateIntentStore,
  OrganizationGitCandidateIntentStoreLive,
} from "./OrganizationGitCandidateIntentStore.ts";
import {
  completeOrganizationGitIntegration,
  OrganizationGitIntegrationCompletionAuthority,
  OrganizationGitIntegrationCompletionError,
} from "./OrganizationGitIntegrationCompletion.ts";
import {
  coordinateOrganizationGitIntegration,
  OrganizationGitIntegrationAuthority,
} from "./OrganizationGitIntegrationCoordinator.ts";
import { buildOrganizationPatchArtifact } from "./OrganizationPatchArtifactBuilder.ts";
import { readOrganizationPatchSource } from "./OrganizationPatchSourceReader.ts";
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
import { OrganizationWorkStore, OrganizationWorkStoreLive } from "./OrganizationWorkStore.ts";

const organizationId = OrganizationId.make("completion-org");
const projectId = ProjectId.make("completion-project");
const bindingId = OrganizationBindingId.make("completion-binding");
const findingId = OrganizationTentativeFindingId.make("completion-finding");
const workId = OrganizationWorkId.make("completion-work");
const attemptId = OrganizationWorkAttemptId.make("completion-attempt");
const time = "2026-01-01T00:00:00.000Z";
const scopeUnit = "t3-org-sandbox-00000000000000000000000000000001.scope";
const scopeInvocation = "00000000000000000000000000000001";
const request = { attemptId, targetRef: "refs/heads/release", integratorSubject: "integrator-d" };
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
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
async function gitFixture() {
  const root = await NodeFSP.mkdtemp("/tmp/t3-org-completion-test-");
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
const candidateLayer = OrganizationGitCandidateIntentStoreLive.pipe(
  Layer.provideMerge(artifactLayer),
);
const services = Layer.mergeAll(
  artifactLayer,
  qaLayer,
  approvalLayer,
  candidateLayer,
  Layer.succeed(OrganizationGitIntegrationCompletionAuthority, {
    permitsAttempt: () => true,
    permits: () => true,
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const seed = (git: GitFixture) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const qa = yield* OrganizationWorkQAReceiptStore;
    const approvals = yield* OrganizationWorkApprovalReceiptStore;
    yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Completion Project', ${git.root}, '[]', ${time}, ${time})`;
    yield* sql`INSERT INTO organizations
    (organization_id, title, mission, lifecycle, draft_revision, published_revision,
     architect_role_id, director_role_id, graph_json, layout_json, created_at, updated_at)
    VALUES (${organizationId}, 'Completion Org', 'Fixture', 'active', 1, 1,
      'architect', 'director', '{}', '{}', ${time}, ${time})`;
    yield* sql`INSERT INTO organization_project_bindings
    (binding_id, organization_id, project_id, access, capabilities_json, scope,
     detached_at, created_at, updated_at)
    VALUES (${bindingId}, ${organizationId}, ${projectId}, 'write',
      '["read-files","write-files","run-tests"]', NULL, NULL, ${time}, ${time})`;
    yield* sql`INSERT INTO organization_intake_sources
    (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
     credential_version, created_at, updated_at)
    VALUES ('completion-source', ${organizationId}, ${projectId}, 'manual', 'Fixture source',
      'human', 1, 1, ${time}, ${time})`;
    yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
     observation_ids_json, state, created_at)
    VALUES (${findingId}, ${organizationId}, 'completion-source', 'completion-finding',
      'Fixture finding', '', '[]', 'tentative', ${time})`;
    yield* sql`INSERT INTO organization_work_items
    (work_id, request_id, request_json, organization_id, finding_id, project_id,
     binding_id, binding_version, scope, published_revision, workflow_id,
     workflow_version, code_revision, status, attempt_limit, attempt_count,
     creator_subject, created_at, updated_at)
    VALUES (${workId}, 'completion-request', '{}', ${organizationId}, ${findingId}, ${projectId},
      ${bindingId}, ${time}, NULL, 1, 'completion-workflow', 1, ${git.baseCommit},
      'running', 1, 1, 'creator', ${time}, ${time})`;
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
    VALUES (${attemptId}, ${scopeUnit}, ${scopeInvocation},
      '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000001.scope',
      1000, 2000, ${time}, ${time}, ${time}, ${time}, ${time}, ${time})`;
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
    const artifact = yield* artifacts.capture({
      attemptId,
      workId,
      projectId,
      baseCodeRevision: git.baseCommit,
      scopeUnitName: scopeUnit,
      scopeInvocationId: scopeInvocation,
      patchBytes: bytes,
      evidenceBytes: Buffer.from("scoped syntax fixture"),
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
    const qaReceipt = yield* qa.capture({
      attemptId,
      workId,
      projectId,
      artifactDigest: artifact.artifactDigest,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      reviewerSubject: "reviewer-b",
      accepted: true,
      evidenceRef: "qa-evidence:completion",
      evidenceBytes: Buffer.from("Independent QA fixture"),
    });
    yield* sql`UPDATE organization_work_attempts SET status = 'qa-accepted',
    qa_subject = 'reviewer-b', qa_evidence_ref = 'qa-evidence:completion'
    WHERE attempt_id = ${attemptId}`;
    yield* sql`UPDATE organization_work_items SET status = 'waiting-approval'
    WHERE work_id = ${workId}`;
    const approval = yield* approvals.capture({
      attemptId,
      workId,
      projectId,
      baseCodeRevision: git.baseCommit,
      artifactDigest: artifact.artifactDigest,
      artifactRef: artifact.artifactRef,
      workerSubject: "worker-a",
      qaSubject: "reviewer-b",
      approvalSubject: "human-c",
      approved: true,
      evidenceRef: "approval-evidence:completion",
      evidenceBytes: Buffer.from(
        JSON.stringify({
          version: 1,
          canonicalProjectRoot: git.root,
          approved: true,
          attemptId,
          artifactDigest: artifact.artifactDigest,
          qaReceiptDigest: qaReceipt.receiptDigest,
        }),
      ),
    });
    yield* sql`UPDATE organization_work_items SET status = 'blocked',
    approval_subject = 'human-c', approval_evidence_ref = 'approval-evidence:completion'
    WHERE work_id = ${workId}`;
    const privateRef = `refs/t3-organizations/candidates/${sha256(bytes)}`;
    git.git(["update-ref", privateRef, git.resultCommit]);
    yield* sql`INSERT INTO organization_git_candidate_intents
    (attempt_id, work_id, organization_id, project_id, binding_id, binding_version,
     base_commit, artifact_ref, artifact_receipt_digest, reviewed_artifact_digest,
     relative_path, ref_name, status, result_commit, prepared_at, retained_at)
    VALUES (${attemptId}, ${workId}, ${organizationId}, ${projectId}, ${bindingId}, ${time},
      ${git.baseCommit}, ${artifact.artifactRef}, ${artifact.artifactDigest}, ${sha256(bytes)},
      'source.mjs', ${privateRef}, 'retained', ${git.resultCommit}, ${time}, ${time})`;
    const rootDigest = NodeCrypto.createHash("sha256")
      .update(`t3-org-project-root-v1\0${git.root}`)
      .digest("hex");
    yield* sql`INSERT INTO organization_git_integration_intents
    (attempt_id, work_id, organization_id, project_id, binding_id, binding_version,
     project_root_digest, base_commit, result_commit, candidate_ref,
     reviewed_artifact_digest, artifact_receipt_digest, approval_receipt_digest,
     target_ref, integrator_subject, status, prepared_at, applied_at)
    VALUES (${attemptId}, ${workId}, ${organizationId}, ${projectId}, ${bindingId}, ${time},
      ${rootDigest}, ${git.baseCommit}, ${git.resultCommit}, ${privateRef},
      ${sha256(bytes)}, ${artifact.artifactDigest}, ${approval.receiptDigest},
      ${request.targetRef}, ${request.integratorSubject}, 'applied', ${time}, ${time})`;
    git.git(["update-ref", "refs/heads/release", git.resultCommit, git.baseCommit]);
    return { artifact, approval, privateRef };
  });

const run = <E>(
  body: (
    git: GitFixture,
  ) => Effect.Effect<
    void,
    E,
    | SqlClient.SqlClient
    | OrganizationWorkArtifactStore
    | OrganizationWorkQAReceiptStore
    | OrganizationWorkApprovalReceiptStore
    | OrganizationGitCandidateIntentStore
    | OrganizationGitIntegrationCompletionAuthority
  >,
) =>
  Effect.gen(function* () {
    const git = yield* Effect.promise(gitFixture);
    try {
      yield* seed(git);
      yield* body(git);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(git.root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(services));

const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = (yield* sql<{ status: string; integration_receipt_ref: string | null }>`SELECT
    status, integration_receipt_ref FROM organization_work_items WHERE work_id = ${workId}`)[0];
  const receipts = (yield* sql<{ count: number }>`SELECT count(*) AS count
    FROM organization_work_integration_receipts WHERE attempt_id = ${attemptId}`)[0]?.count;
  const transitions = (yield* sql<{ count: number }>`SELECT count(*) AS count
    FROM organization_work_transitions WHERE work_id = ${workId} AND action = 'integrate'`)[0]
    ?.count;
  return { work, receipts, transitions };
});

it.effect("captures exact integration evidence, records success once, and replays exactly", () =>
  run(() =>
    Effect.gen(function* () {
      const first = yield* completeOrganizationGitIntegration(request);
      assert.equal(first.status, "succeeded");
      const again = yield* completeOrganizationGitIntegration(request);
      assert.deepEqual(again, first);
      const saved = yield* state;
      assert.equal(saved.work?.status, "succeeded");
      assert.equal(saved.receipts, 1);
      assert.equal(saved.transitions, 1);
      const sql = yield* SqlClient.SqlClient;
      const evidence = (yield* sql<{ evidence_bytes: Uint8Array }>`SELECT evidence_bytes
      FROM organization_work_integration_receipts WHERE attempt_id = ${attemptId}`)[0];
      const parsed = JSON.parse(Buffer.from(evidence!.evidence_bytes).toString("utf8"));
      assert.equal(parsed.targetRef, request.targetRef);
      assert.equal(parsed.expectedBaseOid.length, 40);
      assert.equal(parsed.resultOid, first.resultCommit);
      assert.equal(parsed.approvalReceiptDigest.length, 64);
      assert.equal(parsed.artifactReceiptDigest.length, 64);
      assert.equal(parsed.intentDigest.length, 64);
    }),
  ),
);

it.effect("uses request-local integrate authority when an outer deny WorkStore is mounted", () =>
  run(() =>
    Effect.gen(function* () {
      // The outer instance matches the default deny layer used by callers.
      yield* OrganizationWorkStore;
      const completed = yield* completeOrganizationGitIntegration(request);
      assert.equal(completed.status, "succeeded");
      assert.equal((yield* state).transitions, 1);
    }).pipe(Effect.provide(OrganizationWorkStoreLive)),
  ),
);

it.effect(
  "persists receipt before an injected transition fault and retries without ref writes",
  () =>
    run((git) =>
      Effect.gen(function* () {
        const failed = yield* completeOrganizationGitIntegration(request, () =>
          Effect.fail(
            new OrganizationGitIntegrationCompletionError({
              code: "unavailable",
              message: "injected after capture",
            }),
          ),
        ).pipe(Effect.flip);
        assert.equal(failed.code, "unavailable");
        const pending = yield* state;
        assert.equal(pending.work?.status, "blocked");
        assert.equal(pending.receipts, 1);
        assert.equal(pending.transitions, 0);
        const before = git.git(["rev-parse", request.targetRef]);
        const recovered = yield* completeOrganizationGitIntegration(request);
        assert.equal(recovered.status, "succeeded");
        assert.equal(git.git(["rev-parse", request.targetRef]), before);
      }),
    ),
);

it.effect(
  "replays the existing Git CAS intent after completion fails before WorkStore success",
  () =>
    run((git) =>
      Effect.gen(function* () {
        const failed = yield* completeOrganizationGitIntegration(request, () =>
          Effect.fail(
            new OrganizationGitIntegrationCompletionError({
              code: "unavailable",
              message: "injected completion fault",
            }),
          ),
        ).pipe(Effect.flip);
        assert.equal(failed.code, "unavailable");
        assert.equal((yield* state).work?.status, "blocked");
        const casHead = git.git(["rev-parse", request.targetRef]);
        const replay = yield* coordinateOrganizationGitIntegration(request).pipe(
          Effect.provideService(OrganizationGitIntegrationAuthority, {
            permitsAttempt: (input) =>
              input.attemptId === request.attemptId &&
              input.targetRef === request.targetRef &&
              input.integratorSubject === request.integratorSubject,
            permits: (input, context) =>
              input.attemptId === request.attemptId &&
              input.targetRef === request.targetRef &&
              input.integratorSubject === request.integratorSubject &&
              context.workId === workId &&
              context.organizationId === organizationId &&
              context.projectId === projectId &&
              context.bindingId === bindingId,
          }),
        );
        assert.equal(replay.appliedNow, false);
        assert.equal(git.git(["rev-parse", request.targetRef]), casHead);
        const completed = yield* completeOrganizationGitIntegration(request);
        assert.equal(completed.status, "succeeded");
        assert.equal(git.git(["rev-parse", request.targetRef]), casHead);
        assert.deepEqual(yield* state, {
          work: { status: "succeeded", integration_receipt_ref: completed.receiptRef },
          receipts: 1,
          transitions: 1,
        });
      }),
    ),
);

it.effect("leaves work blocked if target moves after CAS or after receipt capture", () =>
  run((git) =>
    Effect.gen(function* () {
      git.git(["update-ref", request.targetRef, git.baseCommit, git.resultCommit]);
      const moved = yield* completeOrganizationGitIntegration(request).pipe(Effect.flip);
      assert.equal(moved.code, "conflict");
      assert.equal((yield* state).work?.status, "blocked");
      git.git(["update-ref", request.targetRef, git.resultCommit, git.baseCommit]);
      const afterCapture = yield* completeOrganizationGitIntegration(request, () =>
        Effect.sync(() => {
          git.git(["update-ref", request.targetRef, git.baseCommit, git.resultCommit]);
        }),
      ).pipe(Effect.flip);
      assert.equal(afterCapture.code, "conflict");
      const pending = yield* state;
      assert.equal(pending.work?.status, "blocked");
      assert.equal(pending.receipts, 1);
      assert.equal(pending.transitions, 0);
    }),
  ),
);

it.effect("rejects tampered saved evidence and changed replay input", () =>
  run(() =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changed = yield* completeOrganizationGitIntegration({
        ...request,
        integratorSubject: "other-integrator",
      }).pipe(Effect.flip);
      assert.equal(changed.code, "conflict");
      const first = yield* completeOrganizationGitIntegration(request);
      const changedAfter = yield* completeOrganizationGitIntegration({
        ...request,
        targetRef: "refs/heads/other",
      }).pipe(Effect.flip);
      assert.equal(changedAfter.code, "conflict");
      yield* sql`DROP TRIGGER organization_work_integration_receipt_immutable`;
      yield* sql`UPDATE organization_work_integration_receipts SET evidence_bytes = X'00'
      WHERE attempt_id = ${attemptId}`;
      const tampered = yield* completeOrganizationGitIntegration(request).pipe(Effect.flip);
      assert.equal(tampered.code, "conflict");
      assert.equal(first.status, "succeeded");
    }),
  ),
);

it.effect("rejects an altered applied intent before receipt capture or work success", () =>
  run(() =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TRIGGER organization_git_integration_intent_transition`;
      yield* sql`UPDATE organization_git_integration_intents
        SET approval_receipt_digest = ${"d".repeat(64)} WHERE attempt_id = ${attemptId}`;
      const rejected = yield* completeOrganizationGitIntegration(request).pipe(Effect.flip);
      assert.equal(rejected.code, "conflict");
      const current = yield* state;
      assert.equal(current.work?.status, "blocked");
      assert.equal(current.receipts, 0);
    }),
  ),
);

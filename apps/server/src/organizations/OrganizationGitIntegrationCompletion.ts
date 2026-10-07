// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off tryCatchInEffectGen:off - The versioned evidence payload binds exact persisted Git and approval operands.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { OrganizationGitCandidateIntentStore } from "./OrganizationGitCandidateIntentStore.ts";
import { inspectOrganizationGitCandidateRef } from "./OrganizationGitCandidateRetention.ts";
import { verifyOrganizationGitTargetApplied } from "./OrganizationGitIntegrationRef.ts";
import { proveOrganizationGitResult } from "./OrganizationGitResultProof.ts";
import {
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreWithQAReceiptsLive,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import { OrganizationWorkArtifactStore } from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkIntegrationCaptureAuthority,
  OrganizationWorkIntegrationReceiptStore,
  OrganizationWorkIntegrationReceiptStoreWithAuthority,
  OrganizationWorkIntegrationVerifierFromReceipts,
  type OrganizationWorkIntegrationReceiptCaptureInput,
} from "./OrganizationWorkIntegrationReceiptStore.ts";
import {
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TARGET = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const hash = (value: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

export class OrganizationGitIntegrationCompletionError extends Schema.TaggedError<OrganizationGitIntegrationCompletionError>()(
  "OrganizationGitIntegrationCompletionError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationGitIntegrationCompletionError["code"], message: string) =>
  new OrganizationGitIntegrationCompletionError({ code, message });
const isCompletionError = Schema.is(OrganizationGitIntegrationCompletionError);
const unavailable = () => failure("unavailable", "Git integration completion is unavailable.");

export interface OrganizationGitIntegrationCompletionRequest {
  readonly attemptId: string;
  readonly targetRef: string;
  readonly integratorSubject: string;
}
export interface OrganizationGitIntegrationCompletionResult {
  readonly workId: string;
  readonly attemptId: string;
  readonly targetRef: string;
  readonly resultCommit: string;
  readonly receiptRef: string;
  readonly receiptDigest: string;
  readonly status: "succeeded";
}
/** A server-owned caller must bind one integrator and one applied intent before mounting capture. */
export class OrganizationGitIntegrationCompletionAuthority extends Context.Service<
  OrganizationGitIntegrationCompletionAuthority,
  {
    readonly permitsAttempt: (request: OrganizationGitIntegrationCompletionRequest) => boolean;
    readonly permits: (
      request: OrganizationGitIntegrationCompletionRequest,
      context: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly bindingId: string;
        readonly workId: string;
        readonly baseCommit: string;
        readonly resultCommit: string;
        readonly approvalReceiptDigest: string;
      },
    ) => boolean;
  }
>()(
  "t3/organizations/OrganizationGitIntegrationCompletion/OrganizationGitIntegrationCompletionAuthority",
) {}

type IntentRow = {
  attempt_id: string;
  work_id: string;
  organization_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  project_root_digest: string;
  base_commit: string;
  result_commit: string;
  candidate_ref: string;
  reviewed_artifact_digest: string;
  artifact_receipt_digest: string;
  approval_receipt_digest: string;
  target_ref: string;
  integrator_subject: string;
  status: "prepared" | "applied";
  prepared_at: string;
  applied_at: string | null;
};
type TargetRow = {
  attempt_id: string;
  attempt_status: string;
  attempt_number: number;
  worker_subject: string;
  qa_subject: string | null;
  artifact_ref: string | null;
  artifact_digest: string | null;
  work_id: string;
  work_status: string;
  attempt_count: number;
  organization_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  scope: string | null;
  code_revision: string;
  approval_subject: string | null;
  approval_evidence_ref: string | null;
  integration_subject: string | null;
  integration_receipt_ref: string | null;
  result_code_revision: string | null;
  binding_organization_id: string | null;
  binding_project_id: string | null;
  binding_updated_at: string | null;
  binding_access: string | null;
  binding_capabilities_json: string | null;
  binding_scope: string | null;
  binding_detached_at: string | null;
  workspace_root: string | null;
  project_deleted_at: string | null;
  lifecycle: string | null;
};

const intentIdentity = (intent: IntentRow) =>
  hash(
    Buffer.from(
      JSON.stringify([
        "t3-organization-git-integration-intent-v1",
        intent.attempt_id,
        intent.work_id,
        intent.organization_id,
        intent.project_id,
        intent.binding_id,
        intent.binding_version,
        intent.project_root_digest,
        intent.base_commit,
        intent.result_commit,
        intent.candidate_ref,
        intent.reviewed_artifact_digest,
        intent.artifact_receipt_digest,
        intent.approval_receipt_digest,
        intent.target_ref,
        intent.integrator_subject,
        intent.prepared_at,
      ]),
      "utf8",
    ),
  );

/** Does not call CAS. Only an already applied immutable intent can complete work. */
export function completeOrganizationGitIntegration(
  callerRequest: OrganizationGitIntegrationCompletionRequest,
  afterReceiptCaptured?: () => Effect.Effect<void, OrganizationGitIntegrationCompletionError>,
): Effect.Effect<
  OrganizationGitIntegrationCompletionResult,
  OrganizationGitIntegrationCompletionError,
  | SqlClient.SqlClient
  | OrganizationGitCandidateIntentStore
  | OrganizationWorkArtifactStore
  | OrganizationWorkApprovalReceiptStore
  | OrganizationGitIntegrationCompletionAuthority
> {
  const request = { ...callerRequest };
  if (
    typeof request.attemptId !== "string" ||
    !request.attemptId ||
    request.attemptId.length > 256 ||
    typeof request.targetRef !== "string" ||
    !TARGET.test(request.targetRef) ||
    request.targetRef.includes("..") ||
    request.targetRef.endsWith(".") ||
    request.targetRef.endsWith(".lock") ||
    typeof request.integratorSubject !== "string" ||
    !request.integratorSubject.trim() ||
    Buffer.byteLength(request.integratorSubject, "utf8") > 256
  )
    return Effect.fail(failure("invalid", "Integration completion request is invalid."));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const candidates = yield* OrganizationGitCandidateIntentStore;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const approvals = yield* OrganizationWorkApprovalReceiptStore;
    const authority = yield* OrganizationGitIntegrationCompletionAuthority;
    if (!authority.permitsAttempt(request))
      return yield* failure("forbidden", "Integration completion is not authorized.");
    const targetFor = () => sql<TargetRow>`SELECT
      a.attempt_id, a.status AS attempt_status, a.number AS attempt_number,
      a.worker_subject, a.qa_subject, a.artifact_ref, a.artifact_digest,
      w.work_id, w.status AS work_status, w.attempt_count, w.organization_id,
      w.project_id, w.binding_id, w.binding_version, w.scope, w.code_revision,
      w.approval_subject, w.approval_evidence_ref, w.integration_subject,
      w.integration_receipt_ref, w.result_code_revision,
      b.organization_id AS binding_organization_id, b.project_id AS binding_project_id,
      b.updated_at AS binding_updated_at, b.access AS binding_access,
      b.capabilities_json AS binding_capabilities_json, b.scope AS binding_scope,
      b.detached_at AS binding_detached_at,
      p.workspace_root, p.deleted_at AS project_deleted_at, o.lifecycle
      FROM organization_work_attempts a
      JOIN organization_work_items w ON w.work_id = a.work_id
      LEFT JOIN organization_project_bindings b ON b.binding_id = w.binding_id
      LEFT JOIN projection_projects p ON p.project_id = w.project_id
      LEFT JOIN organizations o ON o.organization_id = w.organization_id
      WHERE a.attempt_id = ${request.attemptId}`;
    const intentFor = () => sql<IntentRow>`SELECT * FROM organization_git_integration_intents
      WHERE attempt_id = ${request.attemptId}`;
    const prepare = () =>
      Effect.gen(function* () {
        const row = (yield* targetFor())[0];
        const intent = (yield* intentFor())[0];
        if (!row || !intent)
          return yield* failure("not_found", "Applied integration intent was not found.");
        let capabilities: unknown;
        try {
          capabilities = JSON.parse(row.binding_capabilities_json ?? "");
        } catch {
          /* Fail closed. */
        }
        if (
          intent.status !== "applied" ||
          !intent.applied_at ||
          intent.attempt_id !== request.attemptId ||
          intent.target_ref !== request.targetRef ||
          intent.integrator_subject !== request.integratorSubject ||
          intent.work_id !== row.work_id ||
          intent.organization_id !== row.organization_id ||
          intent.project_id !== row.project_id ||
          intent.binding_id !== row.binding_id ||
          intent.binding_version !== row.binding_version ||
          intent.base_commit !== row.code_revision ||
          !OID.test(intent.base_commit) ||
          !OID.test(intent.result_commit) ||
          intent.result_commit.length !== intent.base_commit.length ||
          !SHA256.test(intent.reviewed_artifact_digest) ||
          !SHA256.test(intent.artifact_receipt_digest) ||
          !SHA256.test(intent.approval_receipt_digest) ||
          row.attempt_status !== "qa-accepted" ||
          row.attempt_number !== row.attempt_count ||
          (row.work_status !== "blocked" && row.work_status !== "succeeded") ||
          row.lifecycle !== "active" ||
          row.binding_organization_id !== row.organization_id ||
          row.binding_project_id !== row.project_id ||
          row.binding_updated_at !== row.binding_version ||
          row.binding_access !== "write" ||
          row.binding_scope !== row.scope ||
          row.binding_detached_at !== null ||
          row.project_deleted_at !== null ||
          !row.workspace_root ||
          !NodePath.isAbsolute(row.workspace_root) ||
          row.scope !== null ||
          !row.approval_subject ||
          !row.approval_evidence_ref ||
          !row.artifact_ref ||
          row.artifact_digest !== intent.artifact_receipt_digest ||
          !row.qa_subject ||
          [row.worker_subject, row.qa_subject, row.approval_subject].includes(
            request.integratorSubject,
          ) ||
          !Array.isArray(capabilities) ||
          !["read-files", "write-files", "run-tests"].every((name) => capabilities.includes(name))
        )
          return yield* failure("conflict", "Current work, binding, or applied intent differs.");
        const root = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(row.workspace_root!),
          catch: () => failure("unavailable", "Project root could not be resolved."),
        });
        if (hash(`t3-org-project-root-v1\0${root}`) !== intent.project_root_digest)
          return yield* failure("conflict", "Project root differs from the applied intent.");
        const candidate = yield* candidates
          .get(request.attemptId)
          .pipe(Effect.mapError((error) => failure(error.code, error.message)));
        const artifact = yield* artifacts
          .get(request.attemptId)
          .pipe(Effect.mapError((error) => failure(error.code, error.message)));
        const approval = yield* approvals
          .get(request.attemptId)
          .pipe(Effect.mapError((error) => failure(error.code, error.message)));
        if (
          !candidate ||
          candidate.status !== "retained" ||
          candidate.resultCommit !== intent.result_commit ||
          candidate.refName !== intent.candidate_ref ||
          candidate.reviewedArtifactDigest !== intent.reviewed_artifact_digest ||
          candidate.artifactReceiptDigest !== intent.artifact_receipt_digest ||
          candidate.baseCommit !== intent.base_commit ||
          candidate.workId !== row.work_id ||
          candidate.projectId !== row.project_id ||
          candidate.organizationId !== row.organization_id ||
          candidate.bindingId !== row.binding_id ||
          candidate.bindingVersion !== row.binding_version ||
          candidate.artifactRef !== row.artifact_ref ||
          !artifact ||
          artifact.workId !== row.work_id ||
          artifact.projectId !== row.project_id ||
          artifact.baseCodeRevision !== intent.base_commit ||
          artifact.artifactRef !== row.artifact_ref ||
          artifact.artifactDigest !== row.artifact_digest ||
          hash(artifact.patchBytes) !== intent.reviewed_artifact_digest ||
          !approval ||
          !approval.approved ||
          approval.receiptDigest !== intent.approval_receipt_digest ||
          approval.workId !== row.work_id ||
          approval.projectId !== row.project_id ||
          approval.baseCodeRevision !== intent.base_commit ||
          approval.artifactRef !== row.artifact_ref ||
          approval.artifactDigest !== row.artifact_digest ||
          approval.workerSubject !== row.worker_subject ||
          approval.qaSubject !== row.qa_subject ||
          approval.approvalSubject !== row.approval_subject ||
          approval.evidenceRef !== row.approval_evidence_ref
        )
          return yield* failure(
            "conflict",
            "Candidate, artifact, or approval differs from the applied intent.",
          );
        yield* approvals
          .verifyApproval(approval)
          .pipe(
            Effect.mapError(() =>
              failure("conflict", "Approval, QA or artifact receipt is invalid."),
            ),
          );
        let approvalEvidence: unknown;
        try {
          approvalEvidence = JSON.parse(Buffer.from(approval.evidenceBytes).toString("utf8"));
        } catch {
          /* Fail closed. */
        }
        if (
          typeof approvalEvidence !== "object" ||
          approvalEvidence === null ||
          !("version" in approvalEvidence) ||
          approvalEvidence.version !== 1 ||
          !("canonicalProjectRoot" in approvalEvidence) ||
          approvalEvidence.canonicalProjectRoot !== root ||
          !("approved" in approvalEvidence) ||
          approvalEvidence.approved !== true ||
          !("attemptId" in approvalEvidence) ||
          approvalEvidence.attemptId !== request.attemptId ||
          !("artifactDigest" in approvalEvidence) ||
          approvalEvidence.artifactDigest !== row.artifact_digest ||
          !("qaReceiptDigest" in approvalEvidence) ||
          approvalEvidence.qaReceiptDigest !== approval.qaReceiptDigest
        )
          return yield* failure(
            "conflict",
            "Approval did not pin the applied Project and artifact.",
          );
        if (
          !authority.permits(request, {
            organizationId: row.organization_id,
            projectId: row.project_id,
            bindingId: row.binding_id,
            workId: row.work_id,
            baseCommit: intent.base_commit,
            resultCommit: intent.result_commit,
            approvalReceiptDigest: intent.approval_receipt_digest,
          })
        )
          return yield* failure("forbidden", "Integration completion is not authorized.");
        const bytes = Uint8Array.from(artifact.patchBytes);
        const intentDigest = intentIdentity(intent);
        const evidenceBytes = Buffer.from(
          JSON.stringify({
            version: 1,
            intentDigest,
            attemptId: intent.attempt_id,
            workId: intent.work_id,
            organizationId: intent.organization_id,
            projectId: intent.project_id,
            bindingId: intent.binding_id,
            bindingVersion: intent.binding_version,
            projectRootDigest: intent.project_root_digest,
            targetRef: intent.target_ref,
            expectedBaseOid: intent.base_commit,
            resultOid: intent.result_commit,
            candidateRef: intent.candidate_ref,
            reviewedArtifactDigest: intent.reviewed_artifact_digest,
            artifactReceiptDigest: intent.artifact_receipt_digest,
            approvalReceiptDigest: intent.approval_receipt_digest,
            integratorSubject: intent.integrator_subject,
          }),
          "utf8",
        );
        const receiptRef = `integration-${hash(evidenceBytes)}`;
        if (
          row.work_status === "succeeded" &&
          (row.integration_subject !== request.integratorSubject ||
            row.integration_receipt_ref !== receiptRef ||
            row.result_code_revision !== intent.result_commit)
        )
          return yield* failure("conflict", "Succeeded work differs from the applied intent.");
        return {
          row,
          intent,
          root,
          workspaceRoot: row.workspace_root,
          bytes,
          approval,
          receiptRef,
          evidenceBytes,
          intentDigest,
        };
      });
    const first = yield* prepare();
    const identity = first.intentDigest;
    const receiptInput: OrganizationWorkIntegrationReceiptCaptureInput = {
      attemptId: request.attemptId,
      workId: first.row.work_id,
      projectId: first.row.project_id,
      baseCodeRevision: first.intent.base_commit,
      resultCodeRevision: first.intent.result_commit,
      artifactRef: first.row.artifact_ref!,
      artifactDigest: first.intent.artifact_receipt_digest,
      workerSubject: first.row.worker_subject,
      qaSubject: first.row.qa_subject!,
      approvalSubject: first.row.approval_subject!,
      integratorSubject: request.integratorSubject,
      receiptRef: first.receiptRef,
      evidenceBytes: first.evidenceBytes,
    };
    const approvalLayer = OrganizationWorkApprovalReceiptStoreWithQAReceiptsLive;
    const receiptLayer = OrganizationWorkIntegrationReceiptStoreWithAuthority.pipe(
      Layer.provide(
        Layer.succeed(OrganizationWorkIntegrationCaptureAuthority, {
          permitsTrustedProducer: (candidate, context) =>
            context.organizationId === first.row.organization_id &&
            context.projectId === first.row.project_id &&
            context.bindingId === first.row.binding_id &&
            context.workId === first.row.work_id &&
            context.attemptId === request.attemptId &&
            candidate.attemptId === receiptInput.attemptId &&
            candidate.workId === receiptInput.workId &&
            candidate.projectId === receiptInput.projectId &&
            candidate.baseCodeRevision === receiptInput.baseCodeRevision &&
            candidate.resultCodeRevision === receiptInput.resultCodeRevision &&
            candidate.artifactRef === receiptInput.artifactRef &&
            candidate.artifactDigest === receiptInput.artifactDigest &&
            candidate.workerSubject === receiptInput.workerSubject &&
            candidate.qaSubject === receiptInput.qaSubject &&
            candidate.approvalSubject === receiptInput.approvalSubject &&
            candidate.integratorSubject === receiptInput.integratorSubject &&
            candidate.receiptRef === receiptInput.receiptRef &&
            Buffer.from(candidate.evidenceBytes).equals(first.evidenceBytes),
        }),
      ),
      Layer.provideMerge(approvalLayer),
    );
    const verifierLayer = OrganizationWorkIntegrationVerifierFromReceipts.pipe(
      Layer.provideMerge(receiptLayer),
    );
    const workLayer = OrganizationWorkStoreLayer.pipe(
      Layer.provideMerge(verifierLayer),
      Layer.provide(OrganizationWorkArtifactVerifierDisabled),
      Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
      Layer.provide(OrganizationWorkApprovalVerifierDisabled),
      Layer.provide(
        Layer.succeed(OrganizationWorkExecutionAuthority, {
          permits: (action, principal, target) =>
            action === "integrate" &&
            principal.subject === request.integratorSubject &&
            target.organizationId === first.row.organization_id &&
            target.projectId === first.row.project_id &&
            target.bindingId === first.row.binding_id &&
            target.scope === first.row.scope &&
            target.workId === first.row.work_id,
        }),
      ),
    );
    // A caller may already have a deny-by-default WorkStoreLayer in the same scope.
    // Force this narrowly authorized request layer to build its own instance.
    const local = Layer.fresh(Layer.mergeAll(receiptLayer, workLayer));
    const withLocal = <A, E>(
      effect: Effect.Effect<A, E, OrganizationWorkIntegrationReceiptStore | OrganizationWorkStore>,
    ) => effect.pipe(Effect.provide(local));
    const transaction = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      sql
        .withTransaction(effect.pipe(Effect.provideService(SqlClient.SqlClient, sql)))
        .pipe(Effect.mapError((error) => (isCompletionError(error) ? error : unavailable())));
    const withLock = (prepared: typeof first) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ binding_id: string }>`UPDATE organization_project_bindings
        SET updated_at = updated_at WHERE binding_id = ${prepared.intent.binding_id}
          AND organization_id = ${prepared.intent.organization_id}
          AND project_id = ${prepared.intent.project_id}
          AND updated_at = ${prepared.intent.binding_version}
          AND access = 'write' AND detached_at IS NULL
          AND EXISTS (SELECT 1 FROM organizations o
            WHERE o.organization_id = ${prepared.intent.organization_id} AND o.lifecycle = 'active')
          AND EXISTS (SELECT 1 FROM projection_projects p
            WHERE p.project_id = ${prepared.intent.project_id} AND p.deleted_at IS NULL
              AND p.workspace_root = ${prepared.workspaceRoot}) RETURNING binding_id`;
        if (!rows[0])
          return yield* failure("conflict", "Current binding no longer permits completion.");
        const checked = yield* prepare();
        if (
          checked.intentDigest !== identity ||
          checked.root !== first.root ||
          checked.receiptRef !== first.receiptRef ||
          !checked.evidenceBytes.equals(first.evidenceBytes)
        )
          return yield* failure("conflict", "Applied intent or approved evidence changed.");
        const currentRoot = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(checked.workspaceRoot),
          catch: () => failure("unavailable", "Project root could not be resolved."),
        });
        if (currentRoot !== checked.root)
          return yield* failure("conflict", "Project root changed during completion.");
        const privateRef = yield* inspectOrganizationGitCandidateRef({
          projectRoot: checked.root,
          reviewedArtifactBytes: checked.bytes,
        }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
        if (
          privateRef.status !== "present" ||
          privateRef.refName !== checked.intent.candidate_ref ||
          privateRef.resultCommit !== checked.intent.result_commit
        )
          return yield* failure("conflict", "Retained candidate ref changed.");
        const proof = yield* proveOrganizationGitResult({
          projectRoot: checked.root,
          baseCommit: checked.intent.base_commit,
          resultCommit: checked.intent.result_commit,
          reviewedArtifactBytes: checked.bytes,
        }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
        if (proof.reviewedArtifactDigest !== checked.intent.reviewed_artifact_digest)
          return yield* failure("conflict", "Result no longer matches reviewed artifact.");
        yield* verifyOrganizationGitTargetApplied({
          projectRoot: checked.root,
          targetRef: checked.intent.target_ref,
          baseCommit: checked.intent.base_commit,
          resultCommit: checked.intent.result_commit,
        }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
        return checked;
      });
    const saved = yield* Effect.uninterruptible(
      transaction(
        Effect.gen(function* () {
          const checked = yield* withLock(first);
          const receipt = yield* withLocal(
            Effect.gen(function* () {
              const store = yield* OrganizationWorkIntegrationReceiptStore;
              return yield* store.capture(receiptInput);
            }),
          ).pipe(Effect.mapError((error) => failure(error.code, error.message)));
          if (
            !Buffer.from(receipt.evidenceBytes).equals(checked.evidenceBytes) ||
            receipt.receiptRef !== checked.receiptRef ||
            receipt.approvalReceiptDigest !== checked.intent.approval_receipt_digest ||
            receipt.resultCodeRevision !== checked.intent.result_commit
          )
            return yield* failure(
              "conflict",
              "Saved integration receipt differs from applied intent.",
            );
          return receipt;
        }),
      ),
    );
    if (afterReceiptCaptured) yield* afterReceiptCaptured();
    return yield* Effect.uninterruptible(
      transaction(
        Effect.gen(function* () {
          const checked = yield* withLock(first);
          const verified = yield* withLocal(
            Effect.gen(function* () {
              const store = yield* OrganizationWorkIntegrationReceiptStore;
              yield* store.verifyIntegration(receiptInput);
              return yield* store.get(request.attemptId);
            }),
          ).pipe(Effect.mapError((error) => failure(error.code, error.message)));
          if (
            !verified ||
            verified.receiptDigest !== saved.receiptDigest ||
            !Buffer.from(verified.evidenceBytes).equals(checked.evidenceBytes) ||
            verified.receiptRef !== checked.receiptRef
          )
            return yield* failure("conflict", "Saved integration evidence changed before success.");
          const detail = yield* withLocal(
            Effect.gen(function* () {
              const work = yield* OrganizationWorkStore;
              return yield* work.recordIntegration(
                {
                  workId: OrganizationWorkId.make(checked.row.work_id),
                  attemptId: OrganizationWorkAttemptId.make(request.attemptId),
                  transitionId: checked.receiptRef,
                  artifactDigest: checked.intent.artifact_receipt_digest,
                  baseCodeRevision: checked.intent.base_commit,
                  resultCodeRevision: checked.intent.result_commit,
                  receiptRef: checked.receiptRef,
                },
                { subject: request.integratorSubject },
              );
            }),
          ).pipe(Effect.mapError((error) => failure(error.code, error.message)));
          if (
            detail.work.status !== "succeeded" ||
            detail.work.integrationSubject !== request.integratorSubject ||
            detail.work.integrationReceiptRef !== checked.receiptRef ||
            detail.work.resultCodeRevision !== checked.intent.result_commit
          )
            return yield* failure(
              "conflict",
              "Work transition did not record the integrated result.",
            );
          return {
            workId: checked.row.work_id,
            attemptId: request.attemptId,
            targetRef: checked.intent.target_ref,
            resultCommit: checked.intent.result_commit,
            receiptRef: checked.receiptRef,
            receiptDigest: verified.receiptDigest,
            status: "succeeded" as const,
          } satisfies OrganizationGitIntegrationCompletionResult;
        }),
      ),
    );
  }).pipe(Effect.mapError((error) => (isCompletionError(error) ? error : unavailable())));
}

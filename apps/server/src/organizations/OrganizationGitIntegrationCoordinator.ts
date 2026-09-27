// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off tryCatchInEffectGen:off - Canonical Project roots and versioned approval evidence are checked before ref mutation.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrganizationGitCandidateIntentStore } from "./OrganizationGitCandidateIntentStore.ts";
import { inspectOrganizationGitCandidateRef } from "./OrganizationGitCandidateRetention.ts";
import { proveOrganizationGitResult } from "./OrganizationGitResultProof.ts";
import { compareAndSwapOrganizationGitTarget } from "./OrganizationGitIntegrationRef.ts";
import { OrganizationWorkApprovalReceiptStore } from "./OrganizationWorkApprovalReceiptStore.ts";
import { OrganizationWorkArtifactStore } from "./OrganizationWorkArtifactStore.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export class OrganizationGitIntegrationCoordinatorError extends Schema.TaggedError<OrganizationGitIntegrationCoordinatorError>()(
  "OrganizationGitIntegrationCoordinatorError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationGitIntegrationCoordinatorError["code"], message: string) =>
  new OrganizationGitIntegrationCoordinatorError({ code, message });
const isCoordinatorError = Schema.is(OrganizationGitIntegrationCoordinatorError);
const unavailable = () => failure("unavailable", "Git integration coordination is unavailable.");

export interface OrganizationGitIntegrationRequest {
  readonly attemptId: string;
  readonly targetRef: string;
  readonly integratorSubject: string;
}
export interface OrganizationGitIntegrationResult {
  readonly attemptId: string;
  readonly targetRef: string;
  readonly baseCommit: string;
  readonly resultCommit: string;
  readonly approvalReceiptDigest: string;
  readonly reviewedArtifactDigest: string;
  readonly appliedNow: boolean;
}
/** An explicitly mounted, server-owned policy must bind the integrator and target branch. */
export class OrganizationGitIntegrationAuthority extends Context.Service<
  OrganizationGitIntegrationAuthority,
  {
    readonly permitsAttempt: (input: OrganizationGitIntegrationRequest) => boolean;
    readonly permits: (
      input: OrganizationGitIntegrationRequest,
      context: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly bindingId: string;
        readonly workId: string;
        readonly approvalSubject: string;
        readonly baseCommit: string;
        readonly resultCommit: string;
      },
    ) => boolean;
  }
>()("t3/organizations/OrganizationGitIntegrationCoordinator/OrganizationGitIntegrationAuthority") {}

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
type Prepared = Omit<IntentRow, "status" | "prepared_at" | "applied_at">;
const sameIntent = (row: IntentRow, value: Prepared) =>
  row.attempt_id === value.attempt_id &&
  row.work_id === value.work_id &&
  row.organization_id === value.organization_id &&
  row.project_id === value.project_id &&
  row.binding_id === value.binding_id &&
  row.binding_version === value.binding_version &&
  row.project_root_digest === value.project_root_digest &&
  row.base_commit === value.base_commit &&
  row.result_commit === value.result_commit &&
  row.candidate_ref === value.candidate_ref &&
  row.reviewed_artifact_digest === value.reviewed_artifact_digest &&
  row.artifact_receipt_digest === value.artifact_receipt_digest &&
  row.approval_receipt_digest === value.approval_receipt_digest &&
  row.target_ref === value.target_ref &&
  row.integrator_subject === value.integrator_subject;

/**
 * Disconnected CAS coordinator. The callback is only a test fault point after Git writes
 * and before the SQLite acknowledgement. No server runtime mounts this function.
 */
export function coordinateOrganizationGitIntegration(
  callerInput: OrganizationGitIntegrationRequest,
  afterGitBeforeAck?: () => Effect.Effect<void, OrganizationGitIntegrationCoordinatorError>,
): Effect.Effect<
  OrganizationGitIntegrationResult,
  OrganizationGitIntegrationCoordinatorError,
  | SqlClient.SqlClient
  | OrganizationGitCandidateIntentStore
  | OrganizationWorkArtifactStore
  | OrganizationWorkApprovalReceiptStore
  | OrganizationGitIntegrationAuthority
> {
  const input = { ...callerInput };
  if (
    typeof input.attemptId !== "string" ||
    !input.attemptId ||
    input.attemptId.length > 256 ||
    typeof input.targetRef !== "string" ||
    !TARGET_REF.test(input.targetRef) ||
    input.targetRef.includes("..") ||
    input.targetRef.endsWith(".") ||
    input.targetRef.endsWith(".lock") ||
    typeof input.integratorSubject !== "string" ||
    !input.integratorSubject.trim() ||
    Buffer.byteLength(input.integratorSubject, "utf8") > 256
  )
    return Effect.fail(failure("invalid", "Integration request is invalid."));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const candidates = yield* OrganizationGitCandidateIntentStore;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const approvals = yield* OrganizationWorkApprovalReceiptStore;
    const authority = yield* OrganizationGitIntegrationAuthority;
    if (!authority.permitsAttempt(input))
      return yield* failure("forbidden", "Git integration is not authorized.");
    const targetFor = () => sql<TargetRow>`SELECT
      a.attempt_id, a.status AS attempt_status, a.number AS attempt_number,
      a.worker_subject, a.qa_subject, a.artifact_ref, a.artifact_digest,
      w.work_id, w.status AS work_status, w.attempt_count, w.organization_id,
      w.project_id, w.binding_id, w.binding_version, w.scope, w.code_revision,
      w.approval_subject, w.approval_evidence_ref,
      b.organization_id AS binding_organization_id,
      b.project_id AS binding_project_id, b.updated_at AS binding_updated_at,
      b.access AS binding_access, b.capabilities_json AS binding_capabilities_json,
      b.scope AS binding_scope, b.detached_at AS binding_detached_at,
      p.workspace_root, p.deleted_at AS project_deleted_at, o.lifecycle
      FROM organization_work_attempts a
      JOIN organization_work_items w ON w.work_id = a.work_id
      LEFT JOIN organization_project_bindings b ON b.binding_id = w.binding_id
      LEFT JOIN projection_projects p ON p.project_id = w.project_id
      LEFT JOIN organizations o ON o.organization_id = w.organization_id
      WHERE a.attempt_id = ${input.attemptId}`;
    const intentFor = () => sql<IntentRow>`SELECT * FROM organization_git_integration_intents
      WHERE attempt_id = ${input.attemptId}`;
    const prepare = () =>
      Effect.gen(function* () {
        const row = (yield* targetFor())[0];
        if (!row) return yield* failure("not_found", "Integration attempt was not found.");
        const stopped = yield* sql<{ organization_id: string }>`SELECT organization_id
          FROM organization_emergency_stops WHERE organization_id = ${row.organization_id}`;
        if (stopped.length > 0)
          return yield* failure("conflict", "Emergency stop holds Git integration.");
        let capabilities: unknown;
        try {
          capabilities = JSON.parse(row.binding_capabilities_json ?? "");
        } catch {
          /* Fail closed. */
        }
        if (
          row.attempt_status !== "qa-accepted" ||
          row.work_status !== "blocked" ||
          row.attempt_number !== row.attempt_count ||
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
          !row.artifact_digest ||
          !SHA256.test(row.artifact_digest) ||
          !row.qa_subject ||
          !FULL_OID.test(row.code_revision) ||
          !Array.isArray(capabilities) ||
          !["read-files", "write-files", "run-tests"].every((name) => capabilities.includes(name))
        )
          return yield* failure("conflict", "Current work, binding, or Project is ineligible.");
        if (
          [row.worker_subject, row.qa_subject, row.approval_subject].includes(
            input.integratorSubject,
          )
        )
          return yield* failure("forbidden", "Integrator identity must be independent.");
        const root = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(row.workspace_root!),
          catch: () => failure("unavailable", "Project root could not be resolved."),
        });
        const candidate = yield* candidates
          .get(input.attemptId)
          .pipe(Effect.mapError((error) => failure(error.code, error.message)));
        const artifact = yield* artifacts
          .get(input.attemptId)
          .pipe(Effect.mapError((error) => failure(error.code, error.message)));
        const approval = yield* approvals
          .get(input.attemptId)
          .pipe(Effect.mapError((error) => failure(error.code, error.message)));
        if (
          !candidate ||
          candidate.status !== "retained" ||
          !candidate.resultCommit ||
          candidate.workId !== row.work_id ||
          candidate.organizationId !== row.organization_id ||
          candidate.projectId !== row.project_id ||
          candidate.bindingId !== row.binding_id ||
          candidate.bindingVersion !== row.binding_version ||
          candidate.baseCommit !== row.code_revision ||
          candidate.artifactRef !== row.artifact_ref ||
          candidate.artifactReceiptDigest !== row.artifact_digest ||
          candidate.refName !==
            `refs/t3-organizations/candidates/${candidate.reviewedArtifactDigest}` ||
          !artifact ||
          artifact.workId !== row.work_id ||
          artifact.projectId !== row.project_id ||
          artifact.baseCodeRevision !== row.code_revision ||
          artifact.artifactRef !== row.artifact_ref ||
          artifact.artifactDigest !== row.artifact_digest ||
          sha256(artifact.patchBytes) !== candidate.reviewedArtifactDigest ||
          !approval ||
          !approval.approved ||
          approval.workId !== row.work_id ||
          approval.projectId !== row.project_id ||
          approval.baseCodeRevision !== row.code_revision ||
          approval.artifactRef !== row.artifact_ref ||
          approval.artifactDigest !== row.artifact_digest ||
          approval.workerSubject !== row.worker_subject ||
          approval.qaSubject !== row.qa_subject ||
          approval.approvalSubject !== row.approval_subject ||
          approval.evidenceRef !== row.approval_evidence_ref
        )
          return yield* failure(
            "conflict",
            "Retained candidate or approval differs from current work.",
          );
        yield* approvals
          .verifyApproval(approval)
          .pipe(
            Effect.mapError(() =>
              failure("conflict", "Approval, QA or artifact evidence is invalid."),
            ),
          );
        let evidence: unknown;
        try {
          evidence = JSON.parse(Buffer.from(approval.evidenceBytes).toString("utf8"));
        } catch {
          /* Fail closed. */
        }
        if (
          typeof evidence !== "object" ||
          evidence === null ||
          !("version" in evidence) ||
          evidence.version !== 1 ||
          !("canonicalProjectRoot" in evidence) ||
          evidence.canonicalProjectRoot !== root ||
          !("approved" in evidence) ||
          evidence.approved !== true ||
          !("attemptId" in evidence) ||
          evidence.attemptId !== input.attemptId ||
          !("artifactDigest" in evidence) ||
          evidence.artifactDigest !== row.artifact_digest ||
          !("qaReceiptDigest" in evidence) ||
          evidence.qaReceiptDigest !== approval.qaReceiptDigest
        )
          return yield* failure(
            "conflict",
            "Approval did not pin this canonical Project and artifact.",
          );
        if (
          !authority.permits(input, {
            organizationId: row.organization_id,
            projectId: row.project_id,
            bindingId: row.binding_id,
            workId: row.work_id,
            approvalSubject: row.approval_subject,
            baseCommit: row.code_revision,
            resultCommit: candidate.resultCommit,
          })
        )
          return yield* failure("forbidden", "Git integration is not authorized.");
        return {
          prepared: {
            attempt_id: input.attemptId,
            work_id: row.work_id,
            organization_id: row.organization_id,
            project_id: row.project_id,
            binding_id: row.binding_id,
            binding_version: row.binding_version,
            project_root_digest: sha256(`t3-org-project-root-v1\0${root}`),
            base_commit: row.code_revision,
            result_commit: candidate.resultCommit,
            candidate_ref: candidate.refName,
            reviewed_artifact_digest: candidate.reviewedArtifactDigest,
            artifact_receipt_digest: row.artifact_digest,
            approval_receipt_digest: approval.receiptDigest,
            target_ref: input.targetRef,
            integrator_subject: input.integratorSubject,
          } satisfies Prepared,
          root,
          workspaceRoot: row.workspace_root,
          bytes: Uint8Array.from(artifact.patchBytes),
        };
      });
    const lock = (value: Prepared, workspaceRoot: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ binding_id: string }>`UPDATE organization_project_bindings
        SET updated_at = updated_at WHERE binding_id = ${value.binding_id}
          AND organization_id = ${value.organization_id}
          AND project_id = ${value.project_id}
          AND access = 'write' AND detached_at IS NULL
          AND updated_at = ${value.binding_version}
          AND EXISTS (SELECT 1 FROM organizations o WHERE o.organization_id = ${value.organization_id}
            AND o.lifecycle = 'active')
          AND NOT EXISTS (SELECT 1 FROM organization_emergency_stops stop
            WHERE stop.organization_id = ${value.organization_id})
          AND EXISTS (SELECT 1 FROM projection_projects p WHERE p.project_id = ${value.project_id}
            AND p.deleted_at IS NULL AND p.workspace_root = ${workspaceRoot})
        RETURNING binding_id`;
        if (!rows[0])
          return yield* failure("conflict", "Current binding no longer permits integration.");
      });
    const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.mapError((error): OrganizationGitIntegrationCoordinatorError =>
            isCoordinatorError(error) ? error : unavailable(),
          ),
        );
    // The first transaction durably records all immutable CAS operands before Git is touched.
    const initial = yield* prepare();
    const hadIntent = yield* transaction(
      Effect.gen(function* () {
        yield* lock(initial.prepared, initial.workspaceRoot);
        const checked = yield* prepare();
        if (
          JSON.stringify(checked.prepared) !== JSON.stringify(initial.prepared) ||
          checked.root !== initial.root
        )
          return yield* failure(
            "conflict",
            "Integration target changed before intent preparation.",
          );
        const prior = (yield* intentFor())[0];
        if (prior) {
          if (!sameIntent(prior, initial.prepared))
            return yield* failure(
              "conflict",
              "Existing integration intent has different operands.",
            );
          return true;
        }
        const time = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const value = initial.prepared;
        yield* sql`INSERT INTO organization_git_integration_intents
        (attempt_id, work_id, organization_id, project_id, binding_id, binding_version,
         project_root_digest, base_commit, result_commit, candidate_ref,
         reviewed_artifact_digest, artifact_receipt_digest, approval_receipt_digest,
         target_ref, integrator_subject, status, prepared_at, applied_at)
        VALUES (${value.attempt_id}, ${value.work_id}, ${value.organization_id},
          ${value.project_id}, ${value.binding_id}, ${value.binding_version},
          ${value.project_root_digest}, ${value.base_commit}, ${value.result_commit},
          ${value.candidate_ref}, ${value.reviewed_artifact_digest},
          ${value.artifact_receipt_digest}, ${value.approval_receipt_digest},
          ${value.target_ref}, ${value.integrator_subject}, 'prepared', ${time}, NULL)`;
        return false;
      }),
    );
    // Hold SQLite's binding write lock through final proof, Git CAS, and acknowledgement.
    return yield* Effect.uninterruptible(
      transaction(
        Effect.gen(function* () {
          yield* lock(initial.prepared, initial.workspaceRoot);
          const checked = yield* prepare();
          if (
            JSON.stringify(checked.prepared) !== JSON.stringify(initial.prepared) ||
            checked.root !== initial.root
          )
            return yield* failure("conflict", "Integration target changed before Git CAS.");
          const intent = (yield* intentFor())[0];
          if (!intent || !sameIntent(intent, checked.prepared))
            return yield* failure("conflict", "Durable integration intent is missing or changed.");
          const currentRoot = yield* Effect.tryPromise({
            try: () => NodeFSP.realpath(checked.workspaceRoot),
            catch: () => failure("unavailable", "Project root could not be resolved."),
          });
          if (currentRoot !== checked.root)
            return yield* failure("conflict", "Project root changed before Git CAS.");
          const privateRef = yield* inspectOrganizationGitCandidateRef({
            projectRoot: checked.root,
            reviewedArtifactBytes: checked.bytes,
          }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
          if (
            privateRef.status !== "present" ||
            privateRef.refName !== checked.prepared.candidate_ref ||
            privateRef.resultCommit !== checked.prepared.result_commit
          )
            return yield* failure(
              "conflict",
              "Retained candidate ref no longer names the approved result.",
            );
          const proof = yield* proveOrganizationGitResult({
            projectRoot: checked.root,
            baseCommit: checked.prepared.base_commit,
            resultCommit: checked.prepared.result_commit,
            reviewedArtifactBytes: checked.bytes,
          }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
          if (proof.reviewedArtifactDigest !== checked.prepared.reviewed_artifact_digest)
            return yield* failure("conflict", "Candidate proof differs from reviewed bytes.");
          const result = yield* compareAndSwapOrganizationGitTarget({
            projectRoot: checked.root,
            targetRef: checked.prepared.target_ref,
            baseCommit: checked.prepared.base_commit,
            resultCommit: checked.prepared.result_commit,
            allowAlreadyApplied: hadIntent,
          }).pipe(Effect.mapError((error) => failure(error.code, error.message)));
          if (afterGitBeforeAck) yield* afterGitBeforeAck();
          if (intent.status === "prepared") {
            const time = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            yield* sql`UPDATE organization_git_integration_intents
          SET status = 'applied', applied_at = ${time}
          WHERE attempt_id = ${input.attemptId} AND status = 'prepared'`;
          }
          return {
            attemptId: input.attemptId,
            targetRef: result.targetRef,
            baseCommit: result.previousCommit,
            resultCommit: result.resultCommit,
            approvalReceiptDigest: checked.prepared.approval_receipt_digest,
            reviewedArtifactDigest: checked.prepared.reviewed_artifact_digest,
            appliedNow: result.appliedNow,
          } satisfies OrganizationGitIntegrationResult;
        }),
      ),
    );
  }).pipe(Effect.mapError((error) => (isCoordinatorError(error) ? error : unavailable())));
}

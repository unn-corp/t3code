// @effect-diagnostics nodeBuiltinImport:off - A Project target is identified by the host's canonical filesystem path.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ProjectId } from "../../../../packages/contracts/src/baseSchemas.ts";
import type { ServerAuthSessionMethod } from "../../../../packages/contracts/src/auth.ts";
import { OrganizationWorkError } from "../../../../packages/contracts/src/organizationWork.ts";
import {
  type OrganizationWorkReviewInput,
  type OrganizationWorkReviewResult,
} from "../../../../packages/contracts/src/organizationWorkReview.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreWithQAReceiptsLive,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreLive,
} from "./OrganizationWorkArtifactStore.ts";
import { redactKnownCredentials } from "./CredentialRedaction.ts";
import {
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreWithArtifactsLive,
} from "./OrganizationWorkQAReceiptStore.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import { organizationSingleFileApprovalProjectRootDigest } from "./OrganizationSingleFileApprovalRevision.ts";
import { isInteractiveOrganizationSession } from "../auth/OrganizationGovernanceAuthorization.ts";

const MAX_PREVIEW_BYTES = 4_096;
const decodeProjectId = Schema.decodeUnknownEffect(ProjectId);
const denied = () =>
  new OrganizationWorkError({
    code: "forbidden",
    message: "Current Organization and Project read access is required.",
  });
const conflict = (message: string) => new OrganizationWorkError({ code: "conflict", message });
const unavailable = () =>
  new OrganizationWorkError({ code: "unavailable", message: "Work review is unavailable." });
const isWorkError = Schema.is(OrganizationWorkError);
const receiptError = (error: {
  readonly code: OrganizationWorkError["code"];
  readonly message: string;
}) => new OrganizationWorkError({ code: error.code, message: error.message });

type AccessRow = {
  project_id: string;
  code_revision: string;
  worker_subject: string;
  artifact_digest: string | null;
  artifact_ref: string | null;
  attempt_status: string;
  workspace_root: string;
};

/** Decode and redact the entire bounded stored value before limiting the wire preview. */
const preview = (bytes: Uint8Array) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const redacted = Buffer.from(redactKnownCredentials(text), "utf8");
    const truncated = redacted.byteLength > MAX_PREVIEW_BYTES;
    const excerpt = new TextDecoder("utf-8").decode(redacted.subarray(0, MAX_PREVIEW_BYTES));
    return {
      text: excerpt,
      bytes: bytes.byteLength,
      truncated,
      complete: !truncated && Buffer.from(bytes).equals(redacted),
    };
  } catch {
    return { text: null, bytes: bytes.byteLength, truncated: false, complete: false };
  }
};

export interface OrganizationWorkReviewStoreShape {
  readonly get: (
    input: OrganizationWorkReviewInput,
  ) => Effect.Effect<OrganizationWorkReviewResult, OrganizationWorkError>;
}
export class OrganizationWorkReviewStore extends Context.Service<
  OrganizationWorkReviewStore,
  OrganizationWorkReviewStoreShape
>()("t3/organizations/OrganizationWorkReviewStore") {}

export const reviewOrganizationWorkForSession = (
  session: { readonly method: ServerAuthSessionMethod; readonly subject: string },
  store: OrganizationWorkReviewStoreShape,
  input: OrganizationWorkReviewInput,
): Effect.Effect<OrganizationWorkReviewResult, OrganizationWorkError> =>
  isInteractiveOrganizationSession(session)
    ? store.get(input)
    : Effect.fail(
        new OrganizationWorkError({
          code: "forbidden",
          message: "Work evidence review requires an interactive session.",
        }),
      );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const artifacts = yield* OrganizationWorkArtifactStore;
  const qaReceipts = yield* OrganizationWorkQAReceiptStore;
  const approvals = yield* OrganizationWorkApprovalReceiptStore;
  const authorized = (input: OrganizationWorkReviewInput) =>
    sql<AccessRow>`SELECT w.project_id, w.code_revision, p.workspace_root,
      a.worker_subject, a.artifact_digest, a.artifact_ref, a.status AS attempt_status
      FROM organization_work_items w
      JOIN organization_work_attempts a ON a.work_id = w.work_id
      JOIN organization_project_bindings b ON b.binding_id = w.binding_id
      JOIN projection_projects p ON p.project_id = w.project_id
      WHERE w.organization_id = ${input.organizationId}
        AND w.work_id = ${input.workId} AND a.attempt_id = ${input.attemptId}
        AND b.organization_id = w.organization_id AND b.project_id = w.project_id
        AND b.detached_at IS NULL AND b.scope IS w.scope
        AND b.access IN ('read','proposal','write')
        AND EXISTS (SELECT 1 FROM json_each(b.capabilities_json)
          WHERE value = 'read-files')
        AND p.deleted_at IS NULL`;
  const get: OrganizationWorkReviewStoreShape["get"] = (input) =>
    Effect.gen(function* () {
      const row = (yield* authorized(input))[0];
      if (!row) return yield* denied();
      if (!NodePath.isAbsolute(row.workspace_root))
        return yield* conflict("Current Project root is unavailable.");
      const canonicalRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(row.workspace_root),
        catch: () => conflict("Current Project root cannot be resolved."),
      });
      if (
        !row.artifact_digest ||
        !row.artifact_ref ||
        !["submitted", "qa-accepted", "qa-rejected"].includes(row.attempt_status)
      )
        return yield* conflict("This attempt has no submitted artifact to review.");
      const artifact = yield* artifacts.get(input.attemptId).pipe(Effect.mapError(receiptError));
      if (
        !artifact ||
        artifact.workId !== input.workId ||
        artifact.projectId !== row.project_id ||
        artifact.baseCodeRevision !== row.code_revision ||
        artifact.artifactDigest !== row.artifact_digest ||
        artifact.artifactRef !== row.artifact_ref
      )
        return yield* conflict("Submitted artifact identity does not match this attempt.");
      yield* artifacts.verifySubmitted(artifact).pipe(Effect.mapError(receiptError));
      const canonical = yield* Effect.try({
        try: () => decodeOrganizationSingleFileArtifact(artifact.patchBytes),
        catch: () => conflict("Artifact is not a canonical single-file replacement."),
      });
      if (canonical.baseCommit !== row.code_revision)
        return yield* conflict("Artifact base commit does not match the work revision.");
      const replacement = preview(canonical.replacementBytes);
      const qa = yield* qaReceipts.get(input.attemptId).pipe(Effect.mapError(receiptError));
      if (qa) {
        if (
          qa.workId !== input.workId ||
          qa.projectId !== row.project_id ||
          qa.workerSubject !== row.worker_subject ||
          qa.artifactDigest !== artifact.artifactDigest ||
          qa.artifactRef !== artifact.artifactRef
        )
          return yield* conflict("QA evidence does not match this attempt.");
        yield* qaReceipts.verifyEvaluation(qa).pipe(Effect.mapError(receiptError));
      }
      const approval = yield* approvals.get(input.attemptId).pipe(Effect.mapError(receiptError));
      if (approval) {
        if (
          !qa ||
          !qa.accepted ||
          approval.workId !== input.workId ||
          approval.projectId !== row.project_id ||
          approval.workerSubject !== row.worker_subject ||
          approval.artifactDigest !== artifact.artifactDigest ||
          approval.artifactRef !== artifact.artifactRef ||
          approval.qaReceiptDigest !== qa.receiptDigest ||
          approval.qaSubject !== qa.reviewerSubject
        )
          return yield* conflict("Approval evidence does not match this attempt and QA receipt.");
        yield* approvals.verifyApproval(approval).pipe(Effect.mapError(receiptError));
      }
      // Recheck current binding after the receipt reads. A detach or capability
      // revocation during review must not leave a stale authorization decision.
      const current = (yield* authorized(input))[0];
      if (!current) return yield* denied();
      if (!NodePath.isAbsolute(current.workspace_root))
        return yield* conflict("Current Project root is unavailable.");
      const currentRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(current.workspace_root),
        catch: () => conflict("Current Project root cannot be resolved."),
      });
      if (currentRoot !== canonicalRoot)
        return yield* conflict("Project root changed during evidence review.");
      const projectId = yield* decodeProjectId(row.project_id).pipe(
        Effect.mapError(() => unavailable()),
      );
      const qaPreview = qa ? preview(qa.evidenceBytes) : null;
      const approvalPreview = approval ? preview(approval.evidenceBytes) : null;
      return {
        workId: input.workId,
        attemptId: input.attemptId,
        projectId,
        projectRootDigest: organizationSingleFileApprovalProjectRootDigest(canonicalRoot),
        artifact: {
          digest: artifact.artifactDigest,
          ref: artifact.artifactRef,
          baseCodeRevision: artifact.baseCodeRevision,
          relativePath: canonical.relativePath,
          replacementPreview: replacement.text,
          replacementBytes: replacement.bytes,
          previewTruncated: replacement.truncated,
          reviewComplete: replacement.complete,
          outcome: artifact.outcome,
        },
        qa:
          qa && qaPreview
            ? {
                accepted: qa.accepted,
                receiptDigest: qa.receiptDigest,
                reviewerSubject: qa.reviewerSubject,
                evidenceRef: qa.evidenceRef,
                evidencePreview: qaPreview.text,
                evidenceBytes: qaPreview.bytes,
                previewTruncated: qaPreview.truncated,
              }
            : null,
        approval:
          approval && approvalPreview
            ? {
                approved: approval.approved,
                receiptDigest: approval.receiptDigest,
                approvalSubject: approval.approvalSubject,
                evidenceRef: approval.evidenceRef,
                evidencePreview: approvalPreview.text,
                evidenceBytes: approvalPreview.bytes,
                previewTruncated: approvalPreview.truncated,
              }
            : null,
      } satisfies OrganizationWorkReviewResult;
    }).pipe(Effect.mapError((error) => (isWorkError(error) ? error : unavailable())));
  return { get } satisfies OrganizationWorkReviewStoreShape;
});

const evidenceStores = Layer.mergeAll(
  OrganizationWorkArtifactStoreLive,
  OrganizationWorkQAReceiptStoreWithArtifactsLive,
  OrganizationWorkApprovalReceiptStoreWithQAReceiptsLive,
);
export const OrganizationWorkReviewStoreWithEvidence = Layer.effect(
  OrganizationWorkReviewStore,
  make,
);
export const OrganizationWorkReviewStoreLive = OrganizationWorkReviewStoreWithEvidence.pipe(
  Layer.provide(evidenceStores),
);

import * as NodeCrypto from "node:crypto";
import { OrganizationCapability } from "../../../../packages/contracts/src/organizations.ts";
import { OrganizationWorkError } from "../../../../packages/contracts/src/organizationWork.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreLive,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreWithArtifactsLive,
} from "./OrganizationWorkQAReceiptStore.ts";
import {
  OrganizationWorkApprovalVerifier,
  type OrganizationWorkApprovalTarget,
} from "./OrganizationWorkStore.ts";

const MAX_EVIDENCE_BYTES = 262_144;
const MAX_SUBJECT_BYTES = 256;
const MAX_REF_BYTES = 512;

export class OrganizationWorkApprovalReceiptError extends Schema.TaggedError<OrganizationWorkApprovalReceiptError>()(
  "OrganizationWorkApprovalReceiptError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const approvalError = (code: OrganizationWorkApprovalReceiptError["code"], message: string) =>
  new OrganizationWorkApprovalReceiptError({ code, message });
const isApprovalError = Schema.is(OrganizationWorkApprovalReceiptError);
const conflict = (message: string) => approvalError("conflict", message);
const unavailable = () =>
  approvalError("unavailable", "Organization approval receipt storage is unavailable.");

export interface OrganizationWorkApprovalReceiptCaptureInput extends OrganizationWorkApprovalTarget {
  readonly evidenceBytes: Uint8Array;
}
export interface OrganizationWorkApprovalReceiptRecord extends OrganizationWorkApprovalReceiptCaptureInput {
  readonly qaReceiptDigest: string;
  readonly recordedAt: string;
  readonly receiptDigest: string;
}
export interface OrganizationWorkApprovalCaptureContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly workId: string;
  readonly attemptId: string;
}
/** A reviewed server policy must prove approvalSubject is an authenticated interactive human. */
export class OrganizationWorkApprovalCaptureAuthority extends Context.Service<
  OrganizationWorkApprovalCaptureAuthority,
  {
    readonly permitsAuthenticatedHuman: (
      input: OrganizationWorkApprovalReceiptCaptureInput,
      context: OrganizationWorkApprovalCaptureContext,
    ) => boolean;
  }
>()(
  "t3/organizations/OrganizationWorkApprovalReceiptStore/OrganizationWorkApprovalCaptureAuthority",
) {}
export const OrganizationWorkApprovalCaptureDisabled = Layer.succeed(
  OrganizationWorkApprovalCaptureAuthority,
  { permitsAuthenticatedHuman: () => false },
);

type ApprovalRow = {
  attempt_id: string;
  work_id: string;
  project_id: string;
  base_code_revision: string;
  artifact_ref: string;
  artifact_digest: string;
  qa_receipt_digest: string;
  worker_subject: string;
  qa_subject: string;
  approver_subject: string;
  approved: number;
  evidence_ref: string;
  evidence_bytes: Uint8Array;
  recorded_at: string;
  receipt_digest: string;
};
type TargetRow = {
  attempt_id: string;
  attempt_status: string;
  attempt_number: number;
  worker_subject: string;
  qa_subject: string | null;
  qa_evidence_ref: string | null;
  artifact_digest: string | null;
  artifact_ref: string | null;
  work_id: string;
  work_status: string;
  attempt_count: number;
  organization_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  scope: string | null;
  code_revision: string;
  binding_organization_id: string | null;
  binding_project_id: string | null;
  binding_updated_at: string | null;
  binding_access: string | null;
  binding_capabilities_json: string | null;
  binding_scope: string | null;
  binding_detached_at: string | null;
  project_id_present: string | null;
  project_deleted_at: string | null;
  lifecycle: string | null;
};

/** Versioned, length-prefixed digest binds all decision fields and exact evidence bytes. */
const receiptDigest = (value: Omit<OrganizationWorkApprovalReceiptRecord, "receiptDigest">) => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update("t3-organization-work-approval-receipt-v1\0");
  const add = (bytes: Uint8Array) => {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  };
  for (const field of [
    value.attemptId,
    value.workId,
    value.projectId,
    value.baseCodeRevision,
    value.artifactRef,
    value.artifactDigest,
    value.qaReceiptDigest,
    value.workerSubject,
    value.qaSubject,
    value.approvalSubject,
    value.approved ? "1" : "0",
    value.evidenceRef,
    value.recordedAt,
  ])
    add(Buffer.from(field, "utf8"));
  add(value.evidenceBytes);
  return hash.digest("hex");
};
const decode = (row: ApprovalRow): OrganizationWorkApprovalReceiptRecord => ({
  attemptId: row.attempt_id,
  workId: row.work_id,
  projectId: row.project_id,
  baseCodeRevision: row.base_code_revision,
  artifactRef: row.artifact_ref,
  artifactDigest: row.artifact_digest,
  qaReceiptDigest: row.qa_receipt_digest,
  workerSubject: row.worker_subject,
  qaSubject: row.qa_subject,
  approvalSubject: row.approver_subject,
  approved: row.approved === 1,
  evidenceRef: row.evidence_ref,
  evidenceBytes: Uint8Array.from(row.evidence_bytes),
  recordedAt: row.recorded_at,
  receiptDigest: row.receipt_digest,
});
const matches = (
  saved: OrganizationWorkApprovalReceiptRecord,
  target: OrganizationWorkApprovalTarget,
) =>
  saved.attemptId === target.attemptId &&
  saved.workId === target.workId &&
  saved.projectId === target.projectId &&
  saved.baseCodeRevision === target.baseCodeRevision &&
  saved.artifactRef === target.artifactRef &&
  saved.artifactDigest === target.artifactDigest &&
  saved.workerSubject === target.workerSubject &&
  saved.qaSubject === target.qaSubject &&
  saved.approvalSubject === target.approvalSubject &&
  saved.approved === target.approved &&
  saved.evidenceRef === target.evidenceRef;
const decodeCapabilities = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(OrganizationCapability)),
);

export interface OrganizationWorkApprovalReceiptStoreShape {
  readonly capture: (
    input: OrganizationWorkApprovalReceiptCaptureInput,
  ) => Effect.Effect<OrganizationWorkApprovalReceiptRecord, OrganizationWorkApprovalReceiptError>;
  readonly get: (
    attemptId: string,
  ) => Effect.Effect<
    OrganizationWorkApprovalReceiptRecord | null,
    OrganizationWorkApprovalReceiptError
  >;
  readonly verifyApproval: (
    target: OrganizationWorkApprovalTarget,
  ) => Effect.Effect<void, OrganizationWorkApprovalReceiptError>;
}
export class OrganizationWorkApprovalReceiptStore extends Context.Service<
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreShape
>()("t3/organizations/OrganizationWorkApprovalReceiptStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* OrganizationWorkApprovalCaptureAuthority;
  const qaReceipts = yield* OrganizationWorkQAReceiptStore;
  const artifacts = yield* OrganizationWorkArtifactStore;
  const rowFor = (attemptId: string) =>
    sql<ApprovalRow>`SELECT * FROM organization_work_approval_receipts WHERE attempt_id = ${attemptId}`;
  const targetFor = (attemptId: string) =>
    sql<TargetRow>`SELECT a.attempt_id, a.status AS attempt_status,
      a.number AS attempt_number, a.worker_subject, a.qa_subject, a.qa_evidence_ref,
      a.artifact_digest, a.artifact_ref, w.work_id, w.status AS work_status,
      w.attempt_count, w.organization_id, w.project_id, w.binding_id,
      w.binding_version, w.scope, w.code_revision,
      b.organization_id AS binding_organization_id,
      b.project_id AS binding_project_id, b.updated_at AS binding_updated_at,
      b.access AS binding_access, b.capabilities_json AS binding_capabilities_json,
      b.scope AS binding_scope, b.detached_at AS binding_detached_at,
      pr.project_id AS project_id_present, pr.deleted_at AS project_deleted_at,
      o.lifecycle
      FROM organization_work_attempts a
      JOIN organization_work_items w ON w.work_id = a.work_id
      LEFT JOIN organization_project_bindings b ON b.binding_id = w.binding_id
      LEFT JOIN projection_projects pr ON pr.project_id = w.project_id
      LEFT JOIN organizations o ON o.organization_id = w.organization_id
      WHERE a.attempt_id = ${attemptId}`;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error): OrganizationWorkApprovalReceiptError =>
          isApprovalError(error) ? error : unavailable(),
        ),
      );
  const get: OrganizationWorkApprovalReceiptStoreShape["get"] = (attemptId) =>
    rowFor(attemptId).pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(() => unavailable()),
    );
  const verifyPrior = (target: TargetRow, saved: OrganizationWorkApprovalReceiptRecord) =>
    Effect.gen(function* () {
      const qa = yield* qaReceipts
        .get(target.attempt_id)
        .pipe(Effect.mapError(() => unavailable()));
      if (
        !qa ||
        !qa.accepted ||
        qa.workId !== saved.workId ||
        qa.projectId !== saved.projectId ||
        qa.artifactRef !== saved.artifactRef ||
        qa.artifactDigest !== saved.artifactDigest ||
        qa.workerSubject !== saved.workerSubject ||
        qa.reviewerSubject !== saved.qaSubject ||
        qa.evidenceRef !== target.qa_evidence_ref ||
        qa.receiptDigest !== saved.qaReceiptDigest
      )
        return yield* conflict("Accepted QA receipt does not match the submitted attempt.");
      yield* qaReceipts
        .verifyEvaluation(qa)
        .pipe(Effect.mapError(() => conflict("Accepted QA or artifact evidence is invalid.")));
      const artifact = yield* artifacts
        .get(target.attempt_id)
        .pipe(Effect.mapError(() => unavailable()));
      if (
        !artifact ||
        artifact.workId !== saved.workId ||
        artifact.projectId !== saved.projectId ||
        artifact.baseCodeRevision !== saved.baseCodeRevision ||
        artifact.artifactRef !== saved.artifactRef ||
        artifact.artifactDigest !== saved.artifactDigest
      )
        return yield* conflict("Approval artifact does not match pinned work revision.");
      yield* artifacts
        .verifySubmitted(artifact)
        .pipe(Effect.mapError(() => conflict("Approval artifact bytes or scope are invalid.")));
    });
  const capture: OrganizationWorkApprovalReceiptStoreShape["capture"] = (callerInput) => {
    // Snapshot bytes before Effect evaluation to avoid caller mutation across SQL awaits.
    const input: OrganizationWorkApprovalReceiptCaptureInput = {
      attemptId: callerInput.attemptId,
      workId: callerInput.workId,
      projectId: callerInput.projectId,
      baseCodeRevision: callerInput.baseCodeRevision,
      artifactDigest: callerInput.artifactDigest,
      artifactRef: callerInput.artifactRef,
      workerSubject: callerInput.workerSubject,
      qaSubject: callerInput.qaSubject,
      approvalSubject: callerInput.approvalSubject,
      approved: callerInput.approved,
      evidenceRef: callerInput.evidenceRef,
      evidenceBytes: Uint8Array.from(callerInput.evidenceBytes),
    };
    if (
      !input.attemptId ||
      !input.workId ||
      !input.projectId ||
      !input.baseCodeRevision ||
      !input.artifactRef ||
      !/^[a-f0-9]{64}$/.test(input.artifactDigest) ||
      !input.workerSubject.trim() ||
      !input.qaSubject.trim() ||
      !input.approvalSubject.trim() ||
      Buffer.byteLength(input.approvalSubject, "utf8") > MAX_SUBJECT_BYTES ||
      !input.evidenceRef.trim() ||
      Buffer.byteLength(input.evidenceRef, "utf8") > MAX_REF_BYTES ||
      input.evidenceBytes.byteLength === 0 ||
      input.evidenceBytes.byteLength > MAX_EVIDENCE_BYTES ||
      typeof input.approved !== "boolean"
    )
      return Effect.fail(
        approvalError("invalid", "Approval fields or evidence bytes are invalid."),
      );
    if (
      input.workerSubject === input.qaSubject ||
      input.approvalSubject === input.workerSubject ||
      input.approvalSubject === input.qaSubject
    )
      return Effect.fail(approvalError("forbidden", "Approval identities must be independent."));
    return transaction(
      Effect.gen(function* () {
        const target = (yield* targetFor(input.attemptId))[0];
        if (!target) return yield* approvalError("not_found", "Attempt was not found.");
        if (
          target.work_id !== input.workId ||
          target.project_id !== input.projectId ||
          target.code_revision !== input.baseCodeRevision ||
          target.worker_subject !== input.workerSubject ||
          target.qa_subject !== input.qaSubject ||
          target.artifact_digest !== input.artifactDigest ||
          target.artifact_ref !== input.artifactRef
        )
          return yield* conflict("Approval target does not match the saved attempt.");
        if (
          !authority.permitsAuthenticatedHuman(input, {
            organizationId: target.organization_id,
            projectId: target.project_id,
            bindingId: target.binding_id,
            workId: target.work_id,
            attemptId: target.attempt_id,
          })
        )
          return yield* approvalError("forbidden", "Authenticated human approval is required.");
        const prior = (yield* rowFor(input.attemptId))[0];
        if (prior) {
          const saved = decode(prior);
          if (
            !matches(saved, input) ||
            !Buffer.from(saved.evidenceBytes).equals(Buffer.from(input.evidenceBytes)) ||
            receiptDigest(saved) !== saved.receiptDigest
          )
            return yield* conflict("Attempt already has a different or corrupt approval receipt.");
          yield* verifyPrior(target, saved);
          return saved;
        }
        if (
          target.attempt_status !== "qa-accepted" ||
          target.work_status !== "waiting-approval" ||
          target.attempt_number !== target.attempt_count ||
          target.lifecycle !== "active" ||
          target.binding_organization_id !== target.organization_id ||
          target.binding_project_id !== target.project_id ||
          target.binding_updated_at !== target.binding_version ||
          target.binding_access !== "write" ||
          target.binding_scope !== target.scope ||
          target.binding_detached_at !== null ||
          target.project_id_present !== target.project_id ||
          target.project_deleted_at !== null
        )
          return yield* conflict(
            "Current Project binding or work state does not authorize approval.",
          );
        const capabilities = yield* decodeCapabilities(target.binding_capabilities_json).pipe(
          Effect.mapError(() => conflict("Current Project capabilities are invalid.")),
        );
        if (
          !capabilities.includes("read-files") ||
          !capabilities.includes("write-files") ||
          !capabilities.includes("run-tests")
        )
          return yield* conflict("Current Project binding lacks approval capabilities.");
        const qa = yield* qaReceipts
          .get(input.attemptId)
          .pipe(Effect.mapError(() => unavailable()));
        if (!qa) return yield* conflict("Accepted QA receipt is missing.");
        const candidate = {
          ...input,
          qaReceiptDigest: qa.receiptDigest,
          recordedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        };
        yield* verifyPrior(target, { ...candidate, receiptDigest: "" });
        const computedDigest = receiptDigest(candidate);
        yield* sql`INSERT INTO organization_work_approval_receipts
          (attempt_id, work_id, project_id, base_code_revision, artifact_ref,
           artifact_digest, qa_receipt_digest, worker_subject, qa_subject,
           approver_subject, approved, evidence_ref, evidence_bytes,
           recorded_at, receipt_digest)
          VALUES (${input.attemptId}, ${input.workId}, ${input.projectId},
            ${input.baseCodeRevision}, ${input.artifactRef}, ${input.artifactDigest},
            ${qa.receiptDigest}, ${input.workerSubject}, ${input.qaSubject},
            ${input.approvalSubject}, ${input.approved ? 1 : 0}, ${input.evidenceRef},
            ${Buffer.from(input.evidenceBytes)}, ${candidate.recordedAt}, ${computedDigest})`;
        const inserted = (yield* rowFor(input.attemptId))[0];
        if (!inserted) return yield* unavailable();
        return decode(inserted);
      }),
    );
  };
  const verifyApproval: OrganizationWorkApprovalReceiptStoreShape["verifyApproval"] = (target) =>
    Effect.gen(function* () {
      const saved = yield* get(target.attemptId);
      if (!saved) return yield* approvalError("not_found", "Approval receipt was not found.");
      if (!matches(saved, target) || receiptDigest(saved) !== saved.receiptDigest)
        return yield* conflict("Approval receipt does not match persisted evidence or target.");
      const attempt = (yield* targetFor(target.attemptId))[0];
      if (
        !attempt ||
        attempt.work_id !== saved.workId ||
        attempt.project_id !== saved.projectId ||
        attempt.code_revision !== saved.baseCodeRevision ||
        attempt.worker_subject !== saved.workerSubject ||
        attempt.qa_subject !== saved.qaSubject ||
        attempt.artifact_digest !== saved.artifactDigest ||
        attempt.artifact_ref !== saved.artifactRef
      )
        return yield* conflict("Approval attempt identity no longer matches.");
      yield* verifyPrior(attempt, saved);
    }).pipe(Effect.mapError((error) => (isApprovalError(error) ? error : unavailable())));
  return { capture, get, verifyApproval } satisfies OrganizationWorkApprovalReceiptStoreShape;
});

export const OrganizationWorkApprovalReceiptStoreLive = Layer.effect(
  OrganizationWorkApprovalReceiptStore,
  make.pipe(Effect.provide(OrganizationWorkApprovalCaptureDisabled)),
);
/** Explicitly mount only with a trusted authenticated human capture authority. */
export const OrganizationWorkApprovalReceiptStoreWithAuthority = Layer.effect(
  OrganizationWorkApprovalReceiptStore,
  make,
);
/** Compatible with WorkStore approval verifier; not mounted by default. */
export const OrganizationWorkApprovalVerifierFromReceipts = Layer.effect(
  OrganizationWorkApprovalVerifier,
  Effect.gen(function* () {
    const store = yield* OrganizationWorkApprovalReceiptStore;
    return {
      verifyApproval: (target: OrganizationWorkApprovalTarget) =>
        store
          .verifyApproval(target)
          .pipe(
            Effect.mapError(
              (error) => new OrganizationWorkError({ code: error.code, message: error.message }),
            ),
          ),
    };
  }),
);
/** Read-only verification is available; live capture remains denied. */
export const OrganizationWorkApprovalReceiptStoreWithQAReceiptsLive =
  OrganizationWorkApprovalReceiptStoreLive.pipe(
    Layer.provideMerge(OrganizationWorkQAReceiptStoreWithArtifactsLive),
    Layer.provide(OrganizationWorkArtifactStoreLive),
  );

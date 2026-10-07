// @effect-diagnostics nodeBuiltinImport:off - This Node-only server module uses synchronous host crypto for persistent IDs or hashes; replacing it would add Crypto service requirements through the persistence API.
import * as NodeCrypto from "node:crypto";
import { OrganizationCapability } from "../../../../packages/contracts/src/organizations.ts";
import { OrganizationWorkError } from "../../../../packages/contracts/src/organizationWork.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  OrganizationWorkApprovalReceiptStore,
  OrganizationWorkApprovalReceiptStoreWithQAReceiptsLive,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkIntegrationVerifier,
  type OrganizationWorkIntegrationTarget,
} from "./OrganizationWorkStore.ts";

const MAX_EVIDENCE_BYTES = 262_144;
const MAX_SUBJECT_BYTES = 256;
const MAX_REF_BYTES = 512;

export class OrganizationWorkIntegrationReceiptError extends Schema.TaggedError<OrganizationWorkIntegrationReceiptError>()(
  "OrganizationWorkIntegrationReceiptError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const integrationError = (code: OrganizationWorkIntegrationReceiptError["code"], message: string) =>
  new OrganizationWorkIntegrationReceiptError({ code, message });
const isIntegrationError = Schema.is(OrganizationWorkIntegrationReceiptError);
const conflict = (message: string) => integrationError("conflict", message);
const unavailable = () =>
  integrationError("unavailable", "Organization integration receipt storage is unavailable.");

export interface OrganizationWorkIntegrationReceiptCaptureInput extends OrganizationWorkIntegrationTarget {
  readonly evidenceBytes: Uint8Array;
}
export interface OrganizationWorkIntegrationReceiptRecord extends OrganizationWorkIntegrationReceiptCaptureInput {
  readonly qaReceiptDigest: string;
  readonly approvalReceiptDigest: string;
  readonly recordedAt: string;
  readonly receiptDigest: string;
}
export interface OrganizationWorkIntegrationCaptureContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly workId: string;
  readonly attemptId: string;
}
/** A trusted integration producer must prove the result revision and receipt reference. */
export class OrganizationWorkIntegrationCaptureAuthority extends Context.Service<
  OrganizationWorkIntegrationCaptureAuthority,
  {
    readonly permitsTrustedProducer: (
      input: OrganizationWorkIntegrationReceiptCaptureInput,
      context: OrganizationWorkIntegrationCaptureContext,
    ) => boolean;
  }
>()(
  "t3/organizations/OrganizationWorkIntegrationReceiptStore/OrganizationWorkIntegrationCaptureAuthority",
) {}
export const OrganizationWorkIntegrationCaptureDisabled = Layer.succeed(
  OrganizationWorkIntegrationCaptureAuthority,
  { permitsTrustedProducer: () => false },
);

type IntegrationRow = {
  attempt_id: string;
  work_id: string;
  project_id: string;
  base_code_revision: string;
  result_code_revision: string;
  artifact_ref: string;
  artifact_digest: string;
  qa_receipt_digest: string;
  approval_receipt_digest: string;
  worker_subject: string;
  qa_subject: string;
  approver_subject: string;
  integrator_subject: string;
  receipt_ref: string;
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
  approval_subject: string | null;
  approval_evidence_ref: string | null;
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

/** Versioned, length-prefixed digest binds all identities and exact evidence bytes. */
const receiptDigest = (value: Omit<OrganizationWorkIntegrationReceiptRecord, "receiptDigest">) => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update("t3-organization-work-integration-receipt-v1\0");
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
    value.resultCodeRevision,
    value.artifactRef,
    value.artifactDigest,
    value.qaReceiptDigest,
    value.approvalReceiptDigest,
    value.workerSubject,
    value.qaSubject,
    value.approvalSubject,
    value.integratorSubject,
    value.receiptRef,
    value.recordedAt,
  ])
    add(Buffer.from(field, "utf8"));
  add(value.evidenceBytes);
  return hash.digest("hex");
};
const decode = (row: IntegrationRow): OrganizationWorkIntegrationReceiptRecord => ({
  attemptId: row.attempt_id,
  workId: row.work_id,
  projectId: row.project_id,
  baseCodeRevision: row.base_code_revision,
  resultCodeRevision: row.result_code_revision,
  artifactRef: row.artifact_ref,
  artifactDigest: row.artifact_digest,
  qaReceiptDigest: row.qa_receipt_digest,
  approvalReceiptDigest: row.approval_receipt_digest,
  workerSubject: row.worker_subject,
  qaSubject: row.qa_subject,
  approvalSubject: row.approver_subject,
  integratorSubject: row.integrator_subject,
  receiptRef: row.receipt_ref,
  evidenceBytes: Uint8Array.from(row.evidence_bytes),
  recordedAt: row.recorded_at,
  receiptDigest: row.receipt_digest,
});
const matches = (
  saved: OrganizationWorkIntegrationReceiptRecord,
  target: OrganizationWorkIntegrationTarget,
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
  saved.integratorSubject === target.integratorSubject &&
  saved.resultCodeRevision === target.resultCodeRevision &&
  saved.receiptRef === target.receiptRef;
const decodeCapabilities = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(OrganizationCapability)),
);

export interface OrganizationWorkIntegrationReceiptStoreShape {
  readonly capture: (
    input: OrganizationWorkIntegrationReceiptCaptureInput,
  ) => Effect.Effect<
    OrganizationWorkIntegrationReceiptRecord,
    OrganizationWorkIntegrationReceiptError
  >;
  readonly get: (
    attemptId: string,
  ) => Effect.Effect<
    OrganizationWorkIntegrationReceiptRecord | null,
    OrganizationWorkIntegrationReceiptError
  >;
  readonly verifyIntegration: (
    target: OrganizationWorkIntegrationTarget,
  ) => Effect.Effect<void, OrganizationWorkIntegrationReceiptError>;
}
export class OrganizationWorkIntegrationReceiptStore extends Context.Service<
  OrganizationWorkIntegrationReceiptStore,
  OrganizationWorkIntegrationReceiptStoreShape
>()("t3/organizations/OrganizationWorkIntegrationReceiptStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* OrganizationWorkIntegrationCaptureAuthority;
  const approvals = yield* OrganizationWorkApprovalReceiptStore;
  const rowFor = (attemptId: string) =>
    sql<IntegrationRow>`SELECT * FROM organization_work_integration_receipts
      WHERE attempt_id = ${attemptId}`;
  const targetFor = (attemptId: string) =>
    sql<TargetRow>`SELECT a.attempt_id, a.status AS attempt_status,
      a.number AS attempt_number, a.worker_subject, a.qa_subject,
      a.artifact_digest, a.artifact_ref,
      w.work_id, w.status AS work_status, w.attempt_count, w.organization_id,
      w.project_id, w.binding_id, w.binding_version, w.scope, w.code_revision,
      w.approval_subject, w.approval_evidence_ref,
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
        Effect.mapError((error): OrganizationWorkIntegrationReceiptError =>
          isIntegrationError(error) ? error : unavailable(),
        ),
      );
  const get: OrganizationWorkIntegrationReceiptStoreShape["get"] = (attemptId) =>
    rowFor(attemptId).pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(() => unavailable()),
    );
  const verifyUpstream = (target: TargetRow, saved: OrganizationWorkIntegrationReceiptRecord) =>
    Effect.gen(function* () {
      const approval = yield* approvals
        .get(target.attempt_id)
        .pipe(Effect.mapError(() => unavailable()));
      if (
        !approval ||
        !approval.approved ||
        approval.workId !== saved.workId ||
        approval.projectId !== saved.projectId ||
        approval.baseCodeRevision !== saved.baseCodeRevision ||
        approval.artifactRef !== saved.artifactRef ||
        approval.artifactDigest !== saved.artifactDigest ||
        approval.workerSubject !== saved.workerSubject ||
        approval.qaSubject !== saved.qaSubject ||
        approval.approvalSubject !== saved.approvalSubject ||
        approval.evidenceRef !== target.approval_evidence_ref ||
        approval.receiptDigest !== saved.approvalReceiptDigest ||
        approval.qaReceiptDigest !== saved.qaReceiptDigest
      )
        return yield* conflict("Approved artifact receipt does not match this work attempt.");
      yield* approvals
        .verifyApproval(approval)
        .pipe(Effect.mapError(() => conflict("Approval, QA or artifact evidence is invalid.")));
    });
  const capture: OrganizationWorkIntegrationReceiptStoreShape["capture"] = (callerInput) => {
    const input: OrganizationWorkIntegrationReceiptCaptureInput = {
      attemptId: callerInput.attemptId,
      workId: callerInput.workId,
      projectId: callerInput.projectId,
      baseCodeRevision: callerInput.baseCodeRevision,
      artifactDigest: callerInput.artifactDigest,
      artifactRef: callerInput.artifactRef,
      workerSubject: callerInput.workerSubject,
      qaSubject: callerInput.qaSubject,
      approvalSubject: callerInput.approvalSubject,
      integratorSubject: callerInput.integratorSubject,
      resultCodeRevision: callerInput.resultCodeRevision,
      receiptRef: callerInput.receiptRef,
      evidenceBytes: Uint8Array.from(callerInput.evidenceBytes),
    };
    if (
      !input.attemptId ||
      !input.workId ||
      !input.projectId ||
      !input.baseCodeRevision ||
      !input.resultCodeRevision ||
      !input.artifactRef ||
      !/^[a-f0-9]{64}$/.test(input.artifactDigest) ||
      !input.workerSubject.trim() ||
      !input.qaSubject.trim() ||
      !input.approvalSubject.trim() ||
      !input.integratorSubject.trim() ||
      Buffer.byteLength(input.integratorSubject, "utf8") > MAX_SUBJECT_BYTES ||
      !input.receiptRef.trim() ||
      Buffer.byteLength(input.receiptRef, "utf8") > MAX_REF_BYTES ||
      input.evidenceBytes.byteLength === 0 ||
      input.evidenceBytes.byteLength > MAX_EVIDENCE_BYTES
    )
      return Effect.fail(
        integrationError("invalid", "Integration fields or evidence bytes are invalid."),
      );
    if (
      input.integratorSubject === input.workerSubject ||
      input.integratorSubject === input.qaSubject ||
      input.integratorSubject === input.approvalSubject
    )
      return Effect.fail(integrationError("forbidden", "Integrator identity must be independent."));
    return transaction(
      Effect.gen(function* () {
        const target = (yield* targetFor(input.attemptId))[0];
        if (!target) return yield* integrationError("not_found", "Attempt was not found.");
        if (
          target.work_id !== input.workId ||
          target.project_id !== input.projectId ||
          target.code_revision !== input.baseCodeRevision ||
          target.worker_subject !== input.workerSubject ||
          target.qa_subject !== input.qaSubject ||
          target.approval_subject !== input.approvalSubject ||
          target.artifact_digest !== input.artifactDigest ||
          target.artifact_ref !== input.artifactRef
        )
          return yield* conflict("Integration target does not match the approved attempt.");
        if (
          !authority.permitsTrustedProducer(input, {
            organizationId: target.organization_id,
            projectId: target.project_id,
            bindingId: target.binding_id,
            workId: target.work_id,
            attemptId: target.attempt_id,
          })
        )
          return yield* integrationError("forbidden", "Trusted integration producer is required.");
        const prior = (yield* rowFor(input.attemptId))[0];
        if (prior) {
          const saved = decode(prior);
          if (
            !matches(saved, input) ||
            !Buffer.from(saved.evidenceBytes).equals(Buffer.from(input.evidenceBytes)) ||
            receiptDigest(saved) !== saved.receiptDigest
          )
            return yield* conflict(
              "Attempt already has a different or corrupt integration receipt.",
            );
          yield* verifyUpstream(target, saved);
          return saved;
        }
        if (
          target.attempt_status !== "qa-accepted" ||
          target.work_status !== "blocked" ||
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
            "Current Project binding or work state does not authorize integration.",
          );
        const capabilities = yield* decodeCapabilities(target.binding_capabilities_json).pipe(
          Effect.mapError(() => conflict("Current Project capabilities are invalid.")),
        );
        if (
          !capabilities.includes("read-files") ||
          !capabilities.includes("write-files") ||
          !capabilities.includes("run-tests")
        )
          return yield* conflict("Current Project binding lacks integration capabilities.");
        const approval = yield* approvals
          .get(input.attemptId)
          .pipe(Effect.mapError(() => unavailable()));
        if (!approval) return yield* conflict("Approved artifact receipt is missing.");
        const candidate = {
          ...input,
          qaReceiptDigest: approval.qaReceiptDigest,
          approvalReceiptDigest: approval.receiptDigest,
          recordedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        };
        yield* verifyUpstream(target, { ...candidate, receiptDigest: "" });
        const computedDigest = receiptDigest(candidate);
        yield* sql`INSERT INTO organization_work_integration_receipts
          (attempt_id, work_id, project_id, base_code_revision, result_code_revision,
           artifact_ref, artifact_digest, qa_receipt_digest, approval_receipt_digest,
           worker_subject, qa_subject, approver_subject, integrator_subject,
           receipt_ref, evidence_bytes, recorded_at, receipt_digest)
          VALUES (${input.attemptId}, ${input.workId}, ${input.projectId},
            ${input.baseCodeRevision}, ${input.resultCodeRevision}, ${input.artifactRef},
            ${input.artifactDigest}, ${approval.qaReceiptDigest}, ${approval.receiptDigest},
            ${input.workerSubject}, ${input.qaSubject}, ${input.approvalSubject},
            ${input.integratorSubject}, ${input.receiptRef}, ${Buffer.from(input.evidenceBytes)},
            ${candidate.recordedAt}, ${computedDigest})`;
        const inserted = (yield* rowFor(input.attemptId))[0];
        if (!inserted) return yield* unavailable();
        return decode(inserted);
      }),
    );
  };
  const verifyIntegration: OrganizationWorkIntegrationReceiptStoreShape["verifyIntegration"] = (
    target,
  ) =>
    Effect.gen(function* () {
      const saved = yield* get(target.attemptId);
      if (!saved) return yield* integrationError("not_found", "Integration receipt was not found.");
      if (!matches(saved, target) || receiptDigest(saved) !== saved.receiptDigest)
        return yield* conflict("Integration receipt does not match persisted evidence or target.");
      const attempt = (yield* targetFor(target.attemptId))[0];
      if (
        !attempt ||
        attempt.work_id !== saved.workId ||
        attempt.project_id !== saved.projectId ||
        attempt.code_revision !== saved.baseCodeRevision ||
        attempt.worker_subject !== saved.workerSubject ||
        attempt.qa_subject !== saved.qaSubject ||
        attempt.approval_subject !== saved.approvalSubject ||
        attempt.artifact_digest !== saved.artifactDigest ||
        attempt.artifact_ref !== saved.artifactRef
      )
        return yield* conflict("Integration attempt identity no longer matches.");
      yield* verifyUpstream(attempt, saved);
    }).pipe(Effect.mapError((error) => (isIntegrationError(error) ? error : unavailable())));
  return { capture, get, verifyIntegration } satisfies OrganizationWorkIntegrationReceiptStoreShape;
});

export const OrganizationWorkIntegrationReceiptStoreLive = Layer.effect(
  OrganizationWorkIntegrationReceiptStore,
  make.pipe(Effect.provide(OrganizationWorkIntegrationCaptureDisabled)),
);
/** Mount only after a trusted, fenced integration producer supplies authority. */
export const OrganizationWorkIntegrationReceiptStoreWithAuthority = Layer.effect(
  OrganizationWorkIntegrationReceiptStore,
  make,
);
/** Compatible with WorkStore's integration verifier; not mounted by default. */
export const OrganizationWorkIntegrationVerifierFromReceipts = Layer.effect(
  OrganizationWorkIntegrationVerifier,
  Effect.gen(function* () {
    const store = yield* OrganizationWorkIntegrationReceiptStore;
    return {
      verifyIntegration: (target: OrganizationWorkIntegrationTarget) =>
        store
          .verifyIntegration(target)
          .pipe(
            Effect.mapError(
              (error) => new OrganizationWorkError({ code: error.code, message: error.message }),
            ),
          ),
    };
  }),
);
/** Read verification is available; production capture remains denied. */
export const OrganizationWorkIntegrationReceiptStoreWithApprovalsLive =
  OrganizationWorkIntegrationReceiptStoreLive.pipe(
    Layer.provide(OrganizationWorkApprovalReceiptStoreWithQAReceiptsLive),
  );

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
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreLive,
  OrganizationWorkArtifactVerifierFromStore,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkEvaluationVerifier,
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkExecutionDisabled,
  OrganizationWorkStoreLayer,
  type OrganizationWorkEvaluationTarget,
} from "./OrganizationWorkStore.ts";

const MAX_EVIDENCE_BYTES = 262_144;
const MAX_SUBJECT_BYTES = 256;
const MAX_REF_BYTES = 512;

export class OrganizationWorkQAReceiptError extends Schema.TaggedError<OrganizationWorkQAReceiptError>()(
  "OrganizationWorkQAReceiptError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const qaError = (code: OrganizationWorkQAReceiptError["code"], message: string) =>
  new OrganizationWorkQAReceiptError({ code, message });
const isQAError = Schema.is(OrganizationWorkQAReceiptError);
const conflict = (message: string) => qaError("conflict", message);
const unavailable = () => qaError("unavailable", "Organization QA receipt storage is unavailable.");

/** evidenceRef is an external label, not a globally unique receipt identifier. */
export interface OrganizationWorkQAReceiptCaptureInput extends OrganizationWorkEvaluationTarget {
  readonly evidenceBytes: Uint8Array;
}
export interface OrganizationWorkQAReceiptRecord extends OrganizationWorkQAReceiptCaptureInput {
  readonly recordedAt: string;
  readonly receiptDigest: string;
}
export interface OrganizationWorkQACaptureContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly workId: string;
  readonly attemptId: string;
}
/** A trusted server-owned QA producer must bind its actual reviewer identity. */
export class OrganizationWorkQAReceiptCaptureAuthority extends Context.Service<
  OrganizationWorkQAReceiptCaptureAuthority,
  {
    readonly permits: (
      input: OrganizationWorkQAReceiptCaptureInput,
      context: OrganizationWorkQACaptureContext,
    ) => boolean;
  }
>()("t3/organizations/OrganizationWorkQAReceiptStore/OrganizationWorkQAReceiptCaptureAuthority") {}
export const OrganizationWorkQAReceiptCaptureDisabled = Layer.succeed(
  OrganizationWorkQAReceiptCaptureAuthority,
  { permits: () => false },
);

type ReceiptRow = {
  attempt_id: string;
  work_id: string;
  project_id: string;
  artifact_ref: string;
  artifact_digest: string;
  worker_subject: string;
  reviewer_subject: string;
  accepted: number;
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
  artifact_digest: string | null;
  artifact_ref: string | null;
  work_id: string;
  work_status: string;
  attempt_count: number;
  code_revision: string;
  organization_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  scope: string | null;
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

/** Versioned, length-prefixed encoding of every identity and the exact evidence bytes. */
const receiptDigest = (value: Omit<OrganizationWorkQAReceiptRecord, "receiptDigest">): string => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update("t3-organization-work-qa-receipt-v1\0");
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
    value.artifactRef,
    value.artifactDigest,
    value.workerSubject,
    value.reviewerSubject,
    value.accepted ? "1" : "0",
    value.evidenceRef,
    value.recordedAt,
  ])
    add(Buffer.from(field, "utf8"));
  add(value.evidenceBytes);
  return hash.digest("hex");
};
const decode = (row: ReceiptRow): OrganizationWorkQAReceiptRecord => ({
  attemptId: row.attempt_id,
  workId: row.work_id,
  projectId: row.project_id,
  artifactRef: row.artifact_ref,
  artifactDigest: row.artifact_digest,
  workerSubject: row.worker_subject,
  reviewerSubject: row.reviewer_subject,
  accepted: row.accepted === 1,
  evidenceRef: row.evidence_ref,
  evidenceBytes: Uint8Array.from(row.evidence_bytes),
  recordedAt: row.recorded_at,
  receiptDigest: row.receipt_digest,
});
const matches = (
  saved: OrganizationWorkQAReceiptRecord,
  target: OrganizationWorkEvaluationTarget,
) =>
  saved.attemptId === target.attemptId &&
  saved.workId === target.workId &&
  saved.projectId === target.projectId &&
  saved.artifactRef === target.artifactRef &&
  saved.artifactDigest === target.artifactDigest &&
  saved.workerSubject === target.workerSubject &&
  saved.reviewerSubject === target.reviewerSubject &&
  saved.accepted === target.accepted &&
  saved.evidenceRef === target.evidenceRef;
const decodeCapabilities = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(OrganizationCapability)),
);

export interface OrganizationWorkQAReceiptStoreShape {
  readonly capture: (
    input: OrganizationWorkQAReceiptCaptureInput,
  ) => Effect.Effect<OrganizationWorkQAReceiptRecord, OrganizationWorkQAReceiptError>;
  readonly get: (
    attemptId: string,
  ) => Effect.Effect<OrganizationWorkQAReceiptRecord | null, OrganizationWorkQAReceiptError>;
  readonly verifyEvaluation: (
    target: OrganizationWorkEvaluationTarget,
  ) => Effect.Effect<void, OrganizationWorkQAReceiptError>;
}
export class OrganizationWorkQAReceiptStore extends Context.Service<
  OrganizationWorkQAReceiptStore,
  OrganizationWorkQAReceiptStoreShape
>()("t3/organizations/OrganizationWorkQAReceiptStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* OrganizationWorkQAReceiptCaptureAuthority;
  const artifacts = yield* OrganizationWorkArtifactStore;
  const rowFor = (attemptId: string) =>
    sql<ReceiptRow>`SELECT * FROM organization_work_qa_receipts WHERE attempt_id = ${attemptId}`;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error): OrganizationWorkQAReceiptError =>
          isQAError(error) ? error : unavailable(),
        ),
      );
  const get: OrganizationWorkQAReceiptStoreShape["get"] = (attemptId) =>
    rowFor(attemptId).pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(() => unavailable()),
    );
  const verifyArtifact = (target: TargetRow) =>
    Effect.gen(function* () {
      const saved = yield* artifacts
        .get(target.attempt_id)
        .pipe(Effect.mapError(() => unavailable()));
      if (
        !saved ||
        saved.workId !== target.work_id ||
        saved.projectId !== target.project_id ||
        saved.artifactDigest !== target.artifact_digest ||
        saved.artifactRef !== target.artifact_ref ||
        saved.baseCodeRevision !== target.code_revision
      )
        return yield* conflict("Submitted artifact receipt does not match the saved attempt.");
      yield* artifacts
        .verifySubmitted(saved)
        .pipe(Effect.mapError(() => conflict("Submitted artifact bytes or scope are invalid.")));
    });
  const capture: OrganizationWorkQAReceiptStoreShape["capture"] = (callerInput) => {
    const input: OrganizationWorkQAReceiptCaptureInput = {
      attemptId: callerInput.attemptId,
      workId: callerInput.workId,
      projectId: callerInput.projectId,
      artifactDigest: callerInput.artifactDigest,
      artifactRef: callerInput.artifactRef,
      workerSubject: callerInput.workerSubject,
      reviewerSubject: callerInput.reviewerSubject,
      accepted: callerInput.accepted,
      evidenceRef: callerInput.evidenceRef,
      evidenceBytes: Uint8Array.from(callerInput.evidenceBytes),
    };
    if (
      !input.attemptId ||
      !input.workId ||
      !input.projectId ||
      !input.artifactRef ||
      !/^[a-f0-9]{64}$/.test(input.artifactDigest) ||
      !input.workerSubject.trim() ||
      !input.reviewerSubject.trim() ||
      Buffer.byteLength(input.reviewerSubject, "utf8") > MAX_SUBJECT_BYTES ||
      Buffer.byteLength(input.evidenceRef, "utf8") > MAX_REF_BYTES ||
      !input.evidenceRef.trim() ||
      input.evidenceBytes.byteLength === 0 ||
      input.evidenceBytes.byteLength > MAX_EVIDENCE_BYTES ||
      typeof input.accepted !== "boolean"
    )
      return Effect.fail(qaError("invalid", "QA receipt fields or evidence bytes are invalid."));
    if (input.reviewerSubject === input.workerSubject)
      return Effect.fail(qaError("forbidden", "The worker cannot review its own attempt."));
    return transaction(
      Effect.gen(function* () {
        const target = (yield* sql<TargetRow>`SELECT a.attempt_id, a.status AS attempt_status,
          a.number AS attempt_number, a.worker_subject, a.artifact_digest, a.artifact_ref,
          w.work_id, w.status AS work_status, w.attempt_count, w.organization_id,
          w.project_id, w.binding_id, w.binding_version, w.scope, w.code_revision,
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
          WHERE a.attempt_id = ${input.attemptId}`)[0];
        if (!target) return yield* qaError("not_found", "Attempt was not found.");
        if (
          target.work_id !== input.workId ||
          target.project_id !== input.projectId ||
          target.worker_subject !== input.workerSubject ||
          target.artifact_digest !== input.artifactDigest ||
          target.artifact_ref !== input.artifactRef
        )
          return yield* conflict("QA target does not match the submitted attempt.");
        if (
          !authority.permits(input, {
            organizationId: target.organization_id,
            projectId: target.project_id,
            bindingId: target.binding_id,
            workId: target.work_id,
            attemptId: target.attempt_id,
          })
        )
          return yield* qaError("forbidden", "QA receipt capture is not authorized.");
        yield* verifyArtifact(target);
        const prior = (yield* rowFor(input.attemptId))[0];
        if (prior) {
          const saved = decode(prior);
          if (
            !matches(saved, input) ||
            !Buffer.from(saved.evidenceBytes).equals(Buffer.from(input.evidenceBytes)) ||
            receiptDigest(saved) !== saved.receiptDigest
          )
            return yield* conflict("Attempt already has a different or corrupt QA receipt.");
          return saved;
        }
        if (
          target.attempt_status !== "submitted" ||
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
          return yield* conflict("Current Project binding or work state does not authorize QA.");
        const capabilities = yield* decodeCapabilities(target.binding_capabilities_json).pipe(
          Effect.mapError(() => conflict("Current Project capabilities are invalid.")),
        );
        if (!capabilities.includes("read-files") || !capabilities.includes("run-tests"))
          return yield* conflict("Current Project binding lacks QA capabilities.");
        const recordedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const candidate = { ...input, recordedAt };
        const computedDigest = receiptDigest(candidate);
        yield* sql`INSERT INTO organization_work_qa_receipts
          (attempt_id, work_id, project_id, artifact_ref, artifact_digest,
           worker_subject, reviewer_subject, accepted, evidence_ref, evidence_bytes,
           recorded_at, receipt_digest)
          VALUES (${input.attemptId}, ${input.workId}, ${input.projectId},
            ${input.artifactRef}, ${input.artifactDigest}, ${input.workerSubject},
            ${input.reviewerSubject}, ${input.accepted ? 1 : 0}, ${input.evidenceRef},
            ${Buffer.from(input.evidenceBytes)}, ${recordedAt}, ${computedDigest})`;
        const inserted = (yield* rowFor(input.attemptId))[0];
        if (!inserted) return yield* unavailable();
        return decode(inserted);
      }),
    );
  };
  const verifyEvaluation: OrganizationWorkQAReceiptStoreShape["verifyEvaluation"] = (target) =>
    Effect.gen(function* () {
      const saved = yield* get(target.attemptId);
      if (!saved) return yield* qaError("not_found", "QA receipt was not found.");
      if (!matches(saved, target) || receiptDigest(saved) !== saved.receiptDigest)
        return yield* conflict("QA receipt does not match persisted evidence or target.");
      const artifact = yield* artifacts
        .get(target.attemptId)
        .pipe(Effect.mapError(() => unavailable()));
      if (
        !artifact ||
        artifact.workId !== saved.workId ||
        artifact.projectId !== saved.projectId ||
        artifact.artifactDigest !== saved.artifactDigest ||
        artifact.artifactRef !== saved.artifactRef
      )
        return yield* conflict("QA receipt no longer matches its submitted artifact.");
      yield* artifacts
        .verifySubmitted(artifact)
        .pipe(Effect.mapError(() => conflict("Submitted artifact bytes or scope are invalid.")));
    }).pipe(Effect.mapError((error) => (isQAError(error) ? error : unavailable())));
  return { capture, get, verifyEvaluation } satisfies OrganizationWorkQAReceiptStoreShape;
});

export const OrganizationWorkQAReceiptStoreLive = Layer.effect(
  OrganizationWorkQAReceiptStore,
  make.pipe(Effect.provide(OrganizationWorkQAReceiptCaptureDisabled)),
);
/** Mount only with an authenticated independent QA producer. */
export const OrganizationWorkQAReceiptStoreWithAuthority = Layer.effect(
  OrganizationWorkQAReceiptStore,
  make,
);
/** Compatible with WorkStore evaluation verifier; this remains disconnected. */
export const OrganizationWorkEvaluationVerifierFromQAReceipts = Layer.effect(
  OrganizationWorkEvaluationVerifier,
  Effect.gen(function* () {
    const store = yield* OrganizationWorkQAReceiptStore;
    return {
      verifyEvaluation: (target: OrganizationWorkEvaluationTarget) =>
        store
          .verifyEvaluation(target)
          .pipe(
            Effect.mapError(
              (error) => new OrganizationWorkError({ code: error.code, message: error.message }),
            ),
          ),
    };
  }),
);
/** Default read verifier can inspect persisted evidence, while capture remains denied. */
export const OrganizationWorkQAReceiptStoreWithArtifactsLive =
  OrganizationWorkQAReceiptStoreLive.pipe(Layer.provide(OrganizationWorkArtifactStoreLive));

/** Persisted read verifiers; work mutation and QA capture remain denied live. */
export const OrganizationWorkStoreWithQAReceiptsLive = OrganizationWorkStoreLayer.pipe(
  Layer.provide(OrganizationWorkExecutionDisabled),
  Layer.provide(OrganizationWorkApprovalVerifierDisabled),
  Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
  Layer.provide(
    Layer.mergeAll(
      OrganizationWorkArtifactVerifierFromStore,
      OrganizationWorkEvaluationVerifierFromQAReceipts,
    ).pipe(
      Layer.provide(
        OrganizationWorkQAReceiptStoreLive.pipe(
          Layer.provideMerge(OrganizationWorkArtifactStoreLive),
        ),
      ),
    ),
  ),
);

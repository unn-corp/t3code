import * as NodeCrypto from "node:crypto";
import { OrganizationWorkError } from "../../../../packages/contracts/src/organizationWork.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OrganizationWorkArtifactVerifier,
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionDisabled,
  OrganizationWorkStoreLayer,
  type OrganizationWorkArtifactTarget,
} from "./OrganizationWorkStore.ts";

const MAX_PATCH_BYTES = 1_048_576;
const MAX_EVIDENCE_BYTES = 262_144;

export class OrganizationWorkArtifactError extends Schema.TaggedError<OrganizationWorkArtifactError>()(
  "OrganizationWorkArtifactError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const artifactError = (code: OrganizationWorkArtifactError["code"], message: string) =>
  new OrganizationWorkArtifactError({ code, message });
const isArtifactError = Schema.is(OrganizationWorkArtifactError);
const conflict = (message: string) => artifactError("conflict", message);
const unavailable = () =>
  artifactError("unavailable", "Organization artifact storage is unavailable.");

export interface OrganizationWorkArtifactOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly resourceLimitExceeded: boolean;
}
export interface OrganizationWorkArtifactCaptureInput {
  readonly attemptId: string;
  readonly workId: string;
  readonly projectId: string;
  readonly baseCodeRevision: string;
  readonly scopeUnitName: string;
  readonly scopeInvocationId: string;
  readonly patchBytes: Uint8Array;
  readonly evidenceBytes: Uint8Array;
  readonly outcome: OrganizationWorkArtifactOutcome;
}
export interface OrganizationWorkArtifactRecord extends OrganizationWorkArtifactTarget {
  readonly scopeVerifiedStoppedAt: string;
  readonly outcome: OrganizationWorkArtifactOutcome;
  readonly patchBytes: Uint8Array;
  readonly evidenceBytes: Uint8Array;
  readonly capturedAt: string;
}

/** Only a reviewed server-owned producer may replace the disabled live authority. */
export class OrganizationWorkArtifactCaptureAuthority extends Context.Service<
  OrganizationWorkArtifactCaptureAuthority,
  { readonly permits: (input: OrganizationWorkArtifactCaptureInput) => boolean }
>()("t3/organizations/OrganizationWorkArtifactStore/OrganizationWorkArtifactCaptureAuthority") {}
export const OrganizationWorkArtifactCaptureDisabled = Layer.succeed(
  OrganizationWorkArtifactCaptureAuthority,
  { permits: () => false },
);

type ArtifactRow = {
  attempt_id: string;
  artifact_ref: string;
  work_id: string;
  project_id: string;
  base_code_revision: string;
  scope_unit_name: string;
  scope_invocation_id: string;
  scope_verified_stopped_at: string;
  exit_code: number;
  exit_signal: string | null;
  timed_out: number;
  output_limit_exceeded: number;
  resource_limit_exceeded: number;
  patch_bytes: Uint8Array;
  evidence_bytes: Uint8Array;
  artifact_digest: string;
  captured_at: string;
};
type TargetRow = {
  attempt_id: string;
  work_id: string;
  project_id: string;
  code_revision: string;
  attempt_status: string;
  work_status: string;
  attempt_number: number;
  attempt_count: number;
  lease_until: string;
  permit_state: string | null;
  scope_unit_name: string | null;
  scope_invocation_id: string | null;
  start_requested_at: string | null;
  token_released_at: string | null;
  started_at: string | null;
  stop_requested_at: string | null;
  verified_stopped_at: string | null;
  binding_version: string;
  organization_id: string;
  binding_organization_id: string | null;
  binding_project_id: string | null;
  binding_updated_at: string | null;
  binding_access: string | null;
  binding_detached_at: string | null;
  project_id_present: string | null;
  project_deleted_at: string | null;
  lifecycle: string | null;
};

const utf8 = (value: string): Buffer => Buffer.from(value, "utf8");
/** Versioned length-prefix format prevents concatenation ambiguity. */
const digest = (value: {
  attemptId: string;
  workId: string;
  projectId: string;
  baseCodeRevision: string;
  scopeUnitName: string;
  scopeInvocationId: string;
  scopeVerifiedStoppedAt: string;
  outcome: OrganizationWorkArtifactOutcome;
  patchBytes: Uint8Array;
  evidenceBytes: Uint8Array;
}): string => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update("t3-organization-work-artifact-v1\0");
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
    value.scopeUnitName,
    value.scopeInvocationId,
    value.scopeVerifiedStoppedAt,
    String(value.outcome.exitCode),
    value.outcome.signal ?? "",
    String(value.outcome.timedOut),
    String(value.outcome.outputLimitExceeded),
    String(value.outcome.resourceLimitExceeded),
  ])
    add(utf8(field));
  add(value.patchBytes);
  add(value.evidenceBytes);
  return hash.digest("hex");
};
const decode = (row: ArtifactRow): OrganizationWorkArtifactRecord => ({
  attemptId: row.attempt_id,
  artifactRef: row.artifact_ref,
  workId: row.work_id,
  projectId: row.project_id,
  baseCodeRevision: row.base_code_revision,
  scopeUnitName: row.scope_unit_name,
  scopeInvocationId: row.scope_invocation_id,
  scopeVerifiedStoppedAt: row.scope_verified_stopped_at,
  outcome: {
    exitCode: row.exit_code,
    signal: row.exit_signal,
    timedOut: row.timed_out === 1,
    outputLimitExceeded: row.output_limit_exceeded === 1,
    resourceLimitExceeded: row.resource_limit_exceeded === 1,
  },
  patchBytes: Uint8Array.from(row.patch_bytes),
  evidenceBytes: Uint8Array.from(row.evidence_bytes),
  artifactDigest: row.artifact_digest,
  capturedAt: row.captured_at,
});
const matchesTarget = (
  saved: OrganizationWorkArtifactRecord,
  target: OrganizationWorkArtifactTarget,
) =>
  saved.attemptId === target.attemptId &&
  saved.workId === target.workId &&
  saved.projectId === target.projectId &&
  saved.baseCodeRevision === target.baseCodeRevision &&
  saved.scopeUnitName === target.scopeUnitName &&
  saved.scopeInvocationId === target.scopeInvocationId &&
  saved.artifactDigest === target.artifactDigest &&
  saved.artifactRef === target.artifactRef;
const digestOf = (saved: OrganizationWorkArtifactRecord) => digest(saved);

export interface OrganizationWorkArtifactStoreShape {
  readonly capture: (
    input: OrganizationWorkArtifactCaptureInput,
  ) => Effect.Effect<OrganizationWorkArtifactRecord, OrganizationWorkArtifactError>;
  readonly get: (
    attemptId: string,
  ) => Effect.Effect<OrganizationWorkArtifactRecord | null, OrganizationWorkArtifactError>;
  readonly verifySubmitted: (
    target: OrganizationWorkArtifactTarget,
  ) => Effect.Effect<void, OrganizationWorkArtifactError>;
}
export class OrganizationWorkArtifactStore extends Context.Service<
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreShape
>()("t3/organizations/OrganizationWorkArtifactStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* OrganizationWorkArtifactCaptureAuthority;
  const rowFor = (attemptId: string) =>
    sql<ArtifactRow>`SELECT * FROM organization_work_artifacts WHERE attempt_id = ${attemptId}`;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error): OrganizationWorkArtifactError =>
          isArtifactError(error) ? error : unavailable(),
        ),
      );
  const get: OrganizationWorkArtifactStoreShape["get"] = (attemptId) =>
    rowFor(attemptId).pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(() => unavailable()),
    );
  const capture: OrganizationWorkArtifactStoreShape["capture"] = (callerInput) => {
    // Copy before Effect evaluation so a caller cannot mutate names or bytes across awaits.
    const input: OrganizationWorkArtifactCaptureInput = {
      attemptId: callerInput.attemptId,
      workId: callerInput.workId,
      projectId: callerInput.projectId,
      baseCodeRevision: callerInput.baseCodeRevision,
      scopeUnitName: callerInput.scopeUnitName,
      scopeInvocationId: callerInput.scopeInvocationId,
      patchBytes: Uint8Array.from(callerInput.patchBytes),
      evidenceBytes: Uint8Array.from(callerInput.evidenceBytes),
      outcome: { ...callerInput.outcome },
    };
    if (
      !input.attemptId ||
      !input.workId ||
      !input.projectId ||
      !input.baseCodeRevision ||
      !input.scopeUnitName ||
      !input.scopeInvocationId ||
      input.patchBytes.byteLength > MAX_PATCH_BYTES ||
      input.evidenceBytes.byteLength > MAX_EVIDENCE_BYTES ||
      input.outcome.exitCode !== 0 ||
      input.outcome.signal !== null ||
      input.outcome.timedOut !== false ||
      input.outcome.outputLimitExceeded !== false ||
      input.outcome.resourceLimitExceeded !== false
    )
      return Effect.fail(
        artifactError("invalid", "Artifact input or execution outcome is invalid."),
      );
    if (!authority.permits(input))
      return Effect.fail(artifactError("forbidden", "Artifact capture is not authorized."));
    return transaction(
      Effect.gen(function* () {
        const target = (yield* sql<TargetRow>`SELECT a.attempt_id, a.work_id,
        w.project_id, w.code_revision, a.status AS attempt_status,
        w.status AS work_status, a.number AS attempt_number,
        w.attempt_count, a.lease_until, p.state AS permit_state,
        s.unit_name AS scope_unit_name, s.invocation_id AS scope_invocation_id,
        s.start_requested_at, s.token_released_at, s.started_at,
        s.stop_requested_at, s.verified_stopped_at,
        w.binding_version, w.organization_id,
        b.organization_id AS binding_organization_id,
        b.project_id AS binding_project_id, b.updated_at AS binding_updated_at,
        b.access AS binding_access, b.detached_at AS binding_detached_at,
        pr.project_id AS project_id_present, pr.deleted_at AS project_deleted_at,
        o.lifecycle
        FROM organization_work_attempts a
        JOIN organization_work_items w ON w.work_id = a.work_id
        LEFT JOIN organization_work_resource_permits p ON p.attempt_id = a.attempt_id
        LEFT JOIN organization_work_scopes s ON s.attempt_id = a.attempt_id
        LEFT JOIN organization_project_bindings b ON b.binding_id = w.binding_id
        LEFT JOIN projection_projects pr ON pr.project_id = w.project_id
        LEFT JOIN organizations o ON o.organization_id = w.organization_id
        WHERE a.attempt_id = ${input.attemptId}`)[0];
        if (!target) return yield* artifactError("not_found", "Attempt was not found.");
        if (
          target.work_id !== input.workId ||
          target.project_id !== input.projectId ||
          target.code_revision !== input.baseCodeRevision ||
          target.scope_unit_name !== input.scopeUnitName ||
          target.scope_invocation_id !== input.scopeInvocationId
        )
          return yield* conflict("Artifact target does not match the saved attempt and scope.");
        const stoppedAt = target.verified_stopped_at;
        if (
          !stoppedAt ||
          !target.start_requested_at ||
          !target.token_released_at ||
          !target.started_at ||
          !target.stop_requested_at
        )
          return yield* conflict("Scope has not completed a verified stop.");
        const time = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        if (
          target.attempt_status !== "running" ||
          target.work_status !== "running" ||
          target.attempt_number !== target.attempt_count ||
          target.permit_state !== "active" ||
          target.lease_until <= time ||
          target.binding_access !== "write" ||
          target.binding_organization_id !== target.organization_id ||
          target.binding_project_id !== input.projectId ||
          target.binding_detached_at !== null ||
          target.binding_updated_at !== target.binding_version ||
          target.project_id_present !== input.projectId ||
          target.project_deleted_at !== null ||
          target.lifecycle !== "active"
        )
          return yield* conflict("Attempt is stale or its Project authority is no longer current.");
        const candidate = {
          ...input,
          scopeVerifiedStoppedAt: stoppedAt,
        };
        const computedDigest = digest(candidate);
        const prior = (yield* rowFor(input.attemptId))[0];
        if (prior) {
          const saved = decode(prior);
          if (saved.artifactDigest !== computedDigest || digestOf(saved) !== computedDigest)
            return yield* conflict("Attempt already has a different or corrupt artifact.");
          return saved;
        }
        const artifactRef = `org-artifact:${NodeCrypto.randomUUID()}`;
        yield* sql`INSERT INTO organization_work_artifacts
        (attempt_id, artifact_ref, work_id, project_id, base_code_revision,
         scope_unit_name, scope_invocation_id, scope_verified_stopped_at,
         exit_code, exit_signal, timed_out, output_limit_exceeded,
         resource_limit_exceeded, patch_bytes, evidence_bytes, artifact_digest, captured_at)
        VALUES (${input.attemptId}, ${artifactRef}, ${input.workId}, ${input.projectId},
          ${input.baseCodeRevision}, ${input.scopeUnitName}, ${input.scopeInvocationId},
          ${stoppedAt}, 0, NULL, 0, 0, 0,
          ${Buffer.from(input.patchBytes)}, ${Buffer.from(input.evidenceBytes)},
          ${computedDigest}, ${time})`;
        const inserted = (yield* rowFor(input.attemptId))[0];
        if (!inserted) return yield* unavailable();
        return decode(inserted);
      }),
    );
  };
  const verifySubmitted: OrganizationWorkArtifactStoreShape["verifySubmitted"] = (target) =>
    Effect.gen(function* () {
      const saved = yield* get(target.attemptId);
      if (!saved) return yield* artifactError("not_found", "Artifact receipt was not found.");
      if (
        !matchesTarget(saved, target) ||
        digestOf(saved) !== saved.artifactDigest ||
        saved.outcome.exitCode !== 0 ||
        saved.outcome.signal !== null ||
        saved.outcome.timedOut ||
        saved.outcome.outputLimitExceeded ||
        saved.outcome.resourceLimitExceeded
      )
        return yield* conflict("Artifact receipt does not match persisted bytes or target.");
      const scope = (yield* sql<{
        unit_name: string;
        invocation_id: string;
        verified_stopped_at: string | null;
      }>`SELECT unit_name, invocation_id, verified_stopped_at
        FROM organization_work_scopes WHERE attempt_id = ${target.attemptId}`)[0];
      if (
        !scope ||
        scope.unit_name !== saved.scopeUnitName ||
        scope.invocation_id !== saved.scopeInvocationId ||
        scope.verified_stopped_at !== saved.scopeVerifiedStoppedAt
      )
        return yield* conflict("Artifact scope verification has changed.");
    }).pipe(Effect.mapError((error) => (isArtifactError(error) ? error : unavailable())));
  return { capture, get, verifySubmitted } satisfies OrganizationWorkArtifactStoreShape;
});

export const OrganizationWorkArtifactStoreLive = Layer.effect(
  OrganizationWorkArtifactStore,
  make.pipe(Effect.provide(OrganizationWorkArtifactCaptureDisabled)),
);
/** Explicitly mount only after a trusted producer supplies capture authority. */
export const OrganizationWorkArtifactStoreWithAuthority = Layer.effect(
  OrganizationWorkArtifactStore,
  make,
);
/** Compatible with WorkStore's verifier seam; never mounted by default. */
export const OrganizationWorkArtifactVerifierFromStore = Layer.effect(
  OrganizationWorkArtifactVerifier,
  Effect.gen(function* () {
    const store = yield* OrganizationWorkArtifactStore;
    return {
      verifySubmitted: (target: OrganizationWorkArtifactTarget) =>
        store
          .verifySubmitted(target)
          .pipe(
            Effect.mapError(
              (error) => new OrganizationWorkError({ code: error.code, message: error.message }),
            ),
          ),
    };
  }),
);

/** Readable live work state with persisted artifact checks; mutation authority stays denied. */
export const OrganizationWorkStoreWithArtifactsLive = OrganizationWorkStoreLayer.pipe(
  Layer.provide(OrganizationWorkExecutionDisabled),
  Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
  Layer.provide(OrganizationWorkApprovalVerifierDisabled),
  Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
  Layer.provide(
    OrganizationWorkArtifactVerifierFromStore.pipe(
      Layer.provide(OrganizationWorkArtifactStoreLive),
    ),
  ),
);

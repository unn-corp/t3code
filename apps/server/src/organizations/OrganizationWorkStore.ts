import {
  OrganizationWorkAttempt,
  OrganizationWorkDetail,
  OrganizationWorkError,
  OrganizationWorkItem,
  type OrganizationWorkActionInput,
  type OrganizationWorkApprovalInput,
  type OrganizationWorkClaimInput,
  type OrganizationWorkCreateInput,
  type OrganizationWorkEvaluateInput,
  type OrganizationWorkHeartbeatInput,
  type OrganizationWorkIntegrationInput,
  type OrganizationWorkRecoveryInput,
  type OrganizationWorkSubmitInput,
  type OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import {
  OrganizationPublishedConfig,
  type OrganizationId,
} from "../../../../packages/contracts/src/organizations.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The transport supplies an authenticated subject. Input JSON cannot supply authority. */
export interface OrganizationWorkPrincipal {
  readonly subject: string;
}
export interface OrganizationWorkAuthorityTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly workId: string;
  readonly scope: string | null;
}
export type OrganizationWorkAuthorityAction =
  | "create"
  | "claim"
  | "heartbeat"
  | "submit"
  | "evaluate"
  | "approve"
  | "integrate"
  | "recover"
  | "cancel";
export interface OrganizationWorkExecutionAuthorityShape {
  readonly permits: (
    action: OrganizationWorkAuthorityAction,
    principal: OrganizationWorkPrincipal,
    target: OrganizationWorkAuthorityTarget,
  ) => boolean;
}
export class OrganizationWorkExecutionAuthority extends Context.Service<
  OrganizationWorkExecutionAuthority,
  OrganizationWorkExecutionAuthorityShape
>()("t3/organizations/OrganizationWorkStore/OrganizationWorkExecutionAuthority") {}
/** A reviewed executor policy must replace this layer before any work can be dispatched. */
export const OrganizationWorkExecutionDisabled = Layer.succeed(OrganizationWorkExecutionAuthority, {
  permits: () => false,
});

export interface OrganizationWorkArtifactTarget {
  readonly workId: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly baseCodeRevision: string;
  readonly scopeUnitName: string;
  readonly scopeInvocationId: string;
  readonly artifactDigest: string;
  readonly artifactRef: string;
}
/** A future executor must prove immutable artifact bytes and successful scoped exit. */
export class OrganizationWorkArtifactVerifier extends Context.Service<
  OrganizationWorkArtifactVerifier,
  {
    readonly verifySubmitted: (
      target: OrganizationWorkArtifactTarget,
    ) => Effect.Effect<void, OrganizationWorkError>;
  }
>()("t3/organizations/OrganizationWorkStore/OrganizationWorkArtifactVerifier") {}
export const OrganizationWorkArtifactVerifierDisabled = Layer.succeed(
  OrganizationWorkArtifactVerifier,
  {
    verifySubmitted: () =>
      Effect.fail(
        new OrganizationWorkError({
          code: "unavailable",
          message: "Artifact verification is not available.",
        }),
      ),
  },
);

export interface OrganizationWorkEvaluationTarget {
  readonly workId: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly artifactDigest: string;
  readonly artifactRef: string;
  readonly workerSubject: string;
  readonly reviewerSubject: string;
  readonly accepted: boolean;
  readonly evidenceRef: string;
}
/** A saved evaluation must bind independently produced evidence to the submitted bytes. */
export class OrganizationWorkEvaluationVerifier extends Context.Service<
  OrganizationWorkEvaluationVerifier,
  {
    readonly verifyEvaluation: (
      target: OrganizationWorkEvaluationTarget,
    ) => Effect.Effect<void, OrganizationWorkError>;
  }
>()("t3/organizations/OrganizationWorkStore/OrganizationWorkEvaluationVerifier") {}
export const OrganizationWorkEvaluationVerifierDisabled = Layer.succeed(
  OrganizationWorkEvaluationVerifier,
  {
    verifyEvaluation: () =>
      Effect.fail(
        new OrganizationWorkError({
          code: "unavailable",
          message: "Independent QA evidence verification is not available.",
        }),
      ),
  },
);

export interface OrganizationWorkApprovalTarget {
  readonly workId: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly baseCodeRevision: string;
  readonly artifactDigest: string;
  readonly artifactRef: string;
  readonly workerSubject: string;
  readonly qaSubject: string;
  readonly approvalSubject: string;
  readonly approved: boolean;
  readonly evidenceRef: string;
}
/** An approval must refer to the QA accepted bytes and a distinct human actor. */
export class OrganizationWorkApprovalVerifier extends Context.Service<
  OrganizationWorkApprovalVerifier,
  {
    readonly verifyApproval: (
      target: OrganizationWorkApprovalTarget,
    ) => Effect.Effect<void, OrganizationWorkError>;
  }
>()("t3/organizations/OrganizationWorkStore/OrganizationWorkApprovalVerifier") {}
export const OrganizationWorkApprovalVerifierDisabled = Layer.succeed(
  OrganizationWorkApprovalVerifier,
  {
    verifyApproval: () =>
      Effect.fail(
        new OrganizationWorkError({
          code: "unavailable",
          message: "Human approval evidence verification is not available.",
        }),
      ),
  },
);

export interface OrganizationWorkIntegrationTarget {
  readonly workId: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly baseCodeRevision: string;
  readonly artifactDigest: string;
  readonly artifactRef: string;
  readonly workerSubject: string;
  readonly qaSubject: string;
  readonly approvalSubject: string;
  readonly integratorSubject: string;
  readonly resultCodeRevision: string;
  readonly receiptRef: string;
}
/** Integration requires a persisted result bound to the exact approved artifact. */
export class OrganizationWorkIntegrationVerifier extends Context.Service<
  OrganizationWorkIntegrationVerifier,
  {
    readonly verifyIntegration: (
      target: OrganizationWorkIntegrationTarget,
    ) => Effect.Effect<void, OrganizationWorkError>;
  }
>()("t3/organizations/OrganizationWorkStore/OrganizationWorkIntegrationVerifier") {}
export const OrganizationWorkIntegrationVerifierDisabled = Layer.succeed(
  OrganizationWorkIntegrationVerifier,
  {
    verifyIntegration: () =>
      Effect.fail(
        new OrganizationWorkError({
          code: "unavailable",
          message: "Integration result verification is not available.",
        }),
      ),
  },
);

type WorkRow = {
  work_id: string;
  request_id: string;
  request_json: string;
  organization_id: string;
  finding_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  scope: string | null;
  published_revision: number;
  workflow_id: string;
  workflow_version: number;
  code_revision: string;
  status: string;
  attempt_limit: number;
  attempt_count: number;
  creator_subject: string;
  approval_subject: string | null;
  approval_evidence_ref: string | null;
  integration_subject: string | null;
  integration_receipt_ref: string | null;
  result_code_revision: string | null;
  created_at: string;
  updated_at: string;
};
type AttemptRow = {
  attempt_id: string;
  work_id: string;
  number: number;
  status: string;
  worker_subject: string;
  lease_until: string;
  artifact_digest: string | null;
  artifact_ref: string | null;
  qa_subject: string | null;
  qa_evidence_ref: string | null;
  started_at: string;
  updated_at: string;
};
type BindingRow = {
  binding_id: string;
  organization_id: string;
  project_id: string;
  access: string;
  capabilities_json: string;
  scope: string | null;
  detached_at: string | null;
  updated_at: string;
};
type FindingRow = {
  organization_id: string;
  source_id: string;
  project_id: string | null;
  observation_ids_json: string;
  evidence_json: string | null;
  state: string;
};
const EvidenceRefs = Schema.Array(
  Schema.Struct({
    observationId: Schema.String,
    sourceId: Schema.String,
    projectId: Schema.NullOr(Schema.String),
  }),
);
const error = (code: OrganizationWorkError["code"], message: string) =>
  new OrganizationWorkError({ code, message });
const invalid = (message: string) => error("invalid", message);
const forbidden = (message: string) => error("forbidden", message);
const conflict = (message: string) => error("conflict", message);
const unavailable = () => error("unavailable", "Organization work is temporarily unavailable.");
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeStoredJson = Schema.decodeUnknownEffect(JsonValue);
const encodeJson = Schema.encodeSync(JsonValue);
const decodeWorkRow = Schema.decodeUnknownEffect(OrganizationWorkItem);
const decodeAttemptRow = Schema.decodeUnknownEffect(OrganizationWorkAttempt);
const decodeWorkDetail = Schema.decodeUnknownEffect(OrganizationWorkDetail);
const decodePublishedConfig = Schema.decodeUnknownEffect(OrganizationPublishedConfig);
const decodeEvidenceRefs = Schema.decodeUnknownEffect(EvidenceRefs);
const isWorkError = Schema.is(OrganizationWorkError);
const parse = (value: string): Effect.Effect<unknown, OrganizationWorkError> =>
  decodeStoredJson(value).pipe(
    Effect.mapError(() => invalid("Stored Organization work data is invalid.")),
  );
const json = (value: unknown): string => encodeJson(value);
const decodeWork = (row: WorkRow) =>
  decodeWorkRow({
    id: row.work_id,
    organizationId: row.organization_id,
    findingId: row.finding_id,
    projectId: row.project_id,
    bindingId: row.binding_id,
    bindingVersion: row.binding_version,
    scope: row.scope,
    publishedRevision: row.published_revision,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    codeRevision: row.code_revision,
    status: row.status,
    attemptLimit: row.attempt_limit,
    attemptCount: row.attempt_count,
    creatorSubject: row.creator_subject,
    approvalSubject: row.approval_subject,
    approvalEvidenceRef: row.approval_evidence_ref,
    integrationSubject: row.integration_subject,
    integrationReceiptRef: row.integration_receipt_ref,
    resultCodeRevision: row.result_code_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
const decodeAttempt = (row: AttemptRow) =>
  decodeAttemptRow({
    id: row.attempt_id,
    workId: row.work_id,
    number: row.number,
    status: row.status,
    workerSubject: row.worker_subject,
    leaseUntil: row.lease_until,
    artifactDigest: row.artifact_digest,
    artifactRef: row.artifact_ref,
    qaSubject: row.qa_subject,
    qaEvidenceRef: row.qa_evidence_ref,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  });

export interface OrganizationWorkStoreShape {
  readonly createWork: (
    input: OrganizationWorkCreateInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly getWork: (
    workId: OrganizationWorkId,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly listWork: (
    organizationId: OrganizationId,
  ) => Effect.Effect<ReadonlyArray<OrganizationWorkDetail>, OrganizationWorkError>;
  readonly claimAttempt: (
    input: OrganizationWorkClaimInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly heartbeatAttempt: (
    input: OrganizationWorkHeartbeatInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly submitAttempt: (
    input: OrganizationWorkSubmitInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly evaluateAttempt: (
    input: OrganizationWorkEvaluateInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly recordApproval: (
    input: OrganizationWorkApprovalInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly recordIntegration: (
    input: OrganizationWorkIntegrationInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly recoverExpired: (
    input: OrganizationWorkActionInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly resolveRecovery: (
    input: OrganizationWorkRecoveryInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
  readonly cancelWork: (
    input: OrganizationWorkActionInput,
    principal: OrganizationWorkPrincipal,
  ) => Effect.Effect<OrganizationWorkDetail, OrganizationWorkError>;
}
export class OrganizationWorkStore extends Context.Service<
  OrganizationWorkStore,
  OrganizationWorkStoreShape
>()("t3/organizations/OrganizationWorkStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* OrganizationWorkExecutionAuthority;
  const artifactVerifier = yield* OrganizationWorkArtifactVerifier;
  const evaluationVerifier = yield* OrganizationWorkEvaluationVerifier;
  const approvalVerifier = yield* OrganizationWorkApprovalVerifier;
  const integrationVerifier = yield* OrganizationWorkIntegrationVerifier;
  const transaction = <A, E>(
    effect: Effect.Effect<A, E, never>,
  ): Effect.Effect<A, OrganizationWorkError> =>
    sql
      .withTransaction(effect)
      .pipe(Effect.mapError((cause) => (isWorkError(cause) ? cause : unavailable())));
  const requireAuthority = (
    action: OrganizationWorkAuthorityAction,
    principal: OrganizationWorkPrincipal,
    target: OrganizationWorkAuthorityTarget,
  ) =>
    principal.subject.trim() && authority.permits(action, principal, target)
      ? Effect.void
      : Effect.fail(forbidden(`Organization work ${action} is not authorized.`));
  const rows = (workId: OrganizationWorkId) =>
    sql<WorkRow>`SELECT * FROM organization_work_items WHERE work_id = ${workId}`;
  const attemptRows = (workId: OrganizationWorkId) =>
    sql<AttemptRow>`SELECT * FROM organization_work_attempts WHERE work_id = ${workId} ORDER BY number`;
  const detail = Effect.fnUntraced(function* (workId: OrganizationWorkId) {
    const row = (yield* rows(workId))[0];
    if (!row) return yield* error("not_found", "Organization work item not found.");
    const attempts: OrganizationWorkAttempt[] = [];
    for (const attempt of yield* attemptRows(workId)) attempts.push(yield* decodeAttempt(attempt));
    return yield* decodeWorkDetail({
      work: yield* decodeWork(row),
      attempts,
    });
  });
  const currentBinding = Effect.fnUntraced(function* (work: WorkRow) {
    const binding = (yield* sql<BindingRow>`SELECT * FROM organization_project_bindings
      WHERE binding_id = ${work.binding_id}`)[0];
    const project = (yield* sql<{
      deleted_at: string | null;
    }>`SELECT deleted_at FROM projection_projects
      WHERE project_id = ${work.project_id}`)[0];
    if (
      !binding ||
      !project ||
      project.deleted_at !== null ||
      binding.detached_at !== null ||
      binding.organization_id !== work.organization_id ||
      binding.project_id !== work.project_id ||
      binding.access !== "write" ||
      binding.updated_at !== work.binding_version ||
      binding.scope !== work.scope
    )
      return yield* forbidden("Current Project write binding no longer authorizes this work.");
    const capabilities = yield* parse(binding.capabilities_json);
    if (
      !Array.isArray(capabilities) ||
      !capabilities.includes("read-files") ||
      !capabilities.includes("write-files") ||
      !capabilities.includes("run-tests")
    )
      return yield* forbidden("Current binding lacks read, write, and QA capabilities.");
    return binding;
  });
  const currentWork = Effect.fnUntraced(function* (workId: OrganizationWorkId) {
    const row = (yield* rows(workId))[0];
    if (!row) return yield* error("not_found", "Organization work item not found.");
    return row;
  });
  const latestAttempt = Effect.fnUntraced(function* (work: WorkRow, attemptId: string) {
    const row = (yield* sql<AttemptRow>`SELECT * FROM organization_work_attempts
      WHERE work_id = ${work.work_id} AND attempt_id = ${attemptId}`)[0];
    if (!row || row.number !== work.attempt_count)
      return yield* conflict("Attempt is not current for this work item.");
    return row;
  });
  const acquireResourcePermit = Effect.fnUntraced(function* (
    work: WorkRow,
    attemptId: string,
    leaseUntil: string,
    time: string,
  ) {
    // One INSERT checks all three counters under SQLite's write transaction.
    // Even an expired lease occupies capacity until recovery fences the old
    // attempt. Lease time alone does not prove the worker has stopped.
    const acquired = yield* sql<{ attempt_id: string }>`
      INSERT INTO organization_work_resource_permits
        (attempt_id, work_id, organization_id, project_id, state, lease_until,
          granted_at, updated_at)
      SELECT ${attemptId}, ${work.work_id}, ${work.organization_id}, ${work.project_id},
        'active', ${leaseUntil}, ${time}, ${time}
      WHERE (SELECT count(*) FROM organization_work_resource_permits
        WHERE state = 'active') <
          COALESCE((SELECT max_active FROM organization_work_resource_limits
            WHERE scope_kind = 'global' AND scope_id = '*'), 4)
        AND (SELECT count(*) FROM organization_work_resource_permits
          WHERE state = 'active' AND organization_id = ${work.organization_id}) <
          COALESCE((SELECT max_active FROM organization_work_resource_limits
            WHERE scope_kind = 'organization' AND scope_id = ${work.organization_id}), 2)
        AND (SELECT count(*) FROM organization_work_resource_permits
          WHERE state = 'active' AND project_id = ${work.project_id}) <
          COALESCE((SELECT max_active FROM organization_work_resource_limits
            WHERE scope_kind = 'project' AND scope_id = ${work.project_id}), 1)
      RETURNING attempt_id`;
    if (acquired.length !== 1)
      return yield* conflict("Organization work resource concurrency limit reached.");
  });
  const releaseResourcePermit = (attemptId: string, state: "released" | "expired", time: string) =>
    Effect.gen(function* () {
      yield* requireScopeStopped(attemptId);
      yield* sql`UPDATE organization_work_resource_permits SET state = ${state}, updated_at = ${time}
        WHERE attempt_id = ${attemptId} AND state = 'active'`;
    });
  const requireScopeStopped = Effect.fnUntraced(function* (attemptId: string) {
    const scope = (yield* sql<{ verified_stopped_at: string | null }>`
      SELECT verified_stopped_at FROM organization_work_scopes
      WHERE attempt_id = ${attemptId}`)[0];
    const preparation = (yield* sql<{ attempt_id: string; recovery_certified: number }>`
      SELECT prep.attempt_id,
        EXISTS(SELECT 1 FROM organization_work_scope_recovery_receipts recovery
          WHERE recovery.attempt_id = prep.attempt_id
            AND recovery.operation_id = prep.attempt_id
            AND recovery.unit_name = prep.unit_name
            AND recovery.kind IN ('never-dispatched', 'verified-stopped-unattached')) AS recovery_certified
      FROM organization_work_scope_preparations prep
      WHERE prep.attempt_id = ${attemptId}`)[0];
    if (
      (scope && scope.verified_stopped_at === null) ||
      (preparation && !scope?.verified_stopped_at && preparation.recovery_certified !== 1)
    )
      return yield* conflict("Scoped worker must be verified stopped before releasing its permit.");
  });
  const transition = <I extends OrganizationWorkActionInput, E>(
    action: OrganizationWorkAuthorityAction,
    input: I,
    principal: OrganizationWorkPrincipal,
    run: (work: WorkRow, time: string) => Effect.Effect<unknown, E, never>,
  ) =>
    transaction(
      Effect.gen(function* () {
        const work = yield* currentWork(input.workId);
        yield* requireAuthority(action, principal, {
          organizationId: work.organization_id,
          projectId: work.project_id,
          bindingId: work.binding_id,
          workId: work.work_id,
          scope: work.scope,
        });
        const requestJson = json({ action, input, subject: principal.subject });
        const previous = (yield* sql<{ work_id: string; request_json: string }>`
      SELECT work_id, request_json FROM organization_work_transitions
      WHERE transition_id = ${input.transitionId}`)[0];
        if (previous) {
          if (previous.work_id !== input.workId || previous.request_json !== requestJson)
            return yield* conflict("Transition ID was reused for a different request.");
          return yield* detail(input.workId);
        }
        // A pause or archive stops every new forward transition, including an attempt
        // already holding a lease. Recovery and cancellation remain available.
        if (action !== "recover" && action !== "cancel") {
          const organization = (yield* sql<{
            lifecycle: string;
          }>`SELECT lifecycle FROM organizations
        WHERE organization_id = ${work.organization_id}`)[0];
          if (organization?.lifecycle !== "active")
            return yield* forbidden("Organization runtime is not active.");
        }
        const time = yield* now;
        yield* run(work, time);
        yield* sql`INSERT INTO organization_work_transitions
      (transition_id, work_id, action, actor_subject, request_json, created_at)
      VALUES (${input.transitionId}, ${input.workId}, ${action}, ${principal.subject},
        ${requestJson}, ${time})`;
        return yield* detail(input.workId);
      }),
    );
  const createWork: OrganizationWorkStoreShape["createWork"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        yield* requireAuthority("create", principal, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          bindingId: input.bindingId,
          workId: input.workId,
          scope: input.scope,
        });
        const requestJson = json({ input, subject: principal.subject });
        const previous = (yield* sql<WorkRow>`SELECT * FROM organization_work_items
        WHERE request_id = ${input.requestId}`)[0];
        if (previous) {
          if (previous.request_json !== requestJson)
            return yield* conflict("Work request ID was reused.");
          return yield* detail(input.workId);
        }
        if ((yield* rows(input.workId)).length) return yield* conflict("Work ID already exists.");
        const org = (yield* sql<{ lifecycle: string; published_revision: number | null }>`
        SELECT lifecycle, published_revision FROM organizations
        WHERE organization_id = ${input.organizationId}`)[0];
        if (!org || org.lifecycle !== "active" || org.published_revision === null)
          return yield* forbidden(
            "Organization work creation requires an active published runtime.",
          );
        const configRow = (yield* sql<{ config_json: string }>`SELECT config_json
        FROM organization_config_versions WHERE organization_id = ${input.organizationId}
        AND revision = ${org.published_revision}`)[0];
        if (!configRow) return yield* invalid("Published configuration snapshot is missing.");
        const config = yield* decodePublishedConfig(yield* parse(configRow.config_json));
        const workflow = config.workflows.find((candidate) => candidate.id === input.workflowId);
        if (
          !workflow ||
          !workflow.steps.some((step) => step.kind === "qa") ||
          !workflow.steps.some((step) => step.kind === "approval") ||
          !workflow.steps.some((step) => step.kind === "integrate")
        )
          return yield* forbidden(
            "Selected published workflow needs build, QA, approval, and integration.",
          );
        const publishedBinding = config.bindings.find(
          (candidate) =>
            candidate.id === input.bindingId &&
            candidate.projectId === input.projectId &&
            candidate.access === "write" &&
            candidate.scope === input.scope &&
            candidate.detachedAt === null &&
            candidate.capabilities.includes("read-files") &&
            candidate.capabilities.includes("write-files") &&
            candidate.capabilities.includes("run-tests"),
        );
        if (!publishedBinding)
          return yield* forbidden("Published Project scope lacks read, write, and QA authority.");
        const finding = (yield* sql<FindingRow>`SELECT * FROM organization_intake_findings
        WHERE finding_id = ${input.findingId} AND organization_id = ${input.organizationId}`)[0];
        if (!finding || finding.state !== "tentative")
          return yield* forbidden("Work requires a tentative finding from this Organization.");
        if (finding.project_id !== null && finding.project_id !== input.projectId)
          return yield* forbidden("Finding belongs to another Project.");
        const observationIds = yield* parse(finding.observation_ids_json);
        if (
          !Array.isArray(observationIds) ||
          observationIds.length === 0 ||
          observationIds.length > 32 ||
          new Set(observationIds).size !== observationIds.length ||
          observationIds.some((value) => typeof value !== "string")
        )
          return yield* invalid("Finding evidence is invalid or unbounded.");
        const refs =
          finding.evidence_json === null
            ? (observationIds as string[]).map((observationId) => ({
                observationId,
                sourceId: finding.source_id,
                projectId: null,
              }))
            : yield* decodeEvidenceRefs(yield* parse(finding.evidence_json)).pipe(
                Effect.mapError(() => invalid("Finding provenance is invalid.")),
              );
        if (
          refs.length !== observationIds.length ||
          new Set(refs.map((ref) => ref.observationId)).size !== refs.length ||
          refs.some((ref) => !(observationIds as string[]).includes(ref.observationId))
        )
          return yield* invalid("Finding provenance does not match its evidence IDs.");
        for (const ref of refs) {
          if (!ref.sourceId || (ref.projectId !== null && ref.projectId !== input.projectId))
            return yield* forbidden("Finding provenance is outside the selected Project.");
          const evidence = (yield* sql<{ project_id: string | null; source_id: string }>`
          SELECT project_id, source_id FROM organization_intake_observations
          WHERE observation_id = ${ref.observationId} AND organization_id = ${input.organizationId}`)[0];
          if (
            !evidence ||
            evidence.source_id !== ref.sourceId ||
            evidence.project_id !== input.projectId
          )
            return yield* forbidden("Finding evidence is outside the selected Project.");
        }
        const binding = (yield* sql<BindingRow>`SELECT * FROM organization_project_bindings
        WHERE binding_id = ${input.bindingId}`)[0];
        if (!binding) return yield* forbidden("Current Project binding is missing.");
        if (binding.updated_at !== publishedBinding.updatedAt)
          return yield* forbidden("Project binding changed since the selected publication.");
        const check = {
          ...binding,
          work_id: input.workId,
          request_id: input.requestId,
          request_json: requestJson,
          organization_id: input.organizationId,
          finding_id: input.findingId,
          project_id: input.projectId,
          binding_id: input.bindingId,
          binding_version: binding.updated_at,
          scope: input.scope,
          published_revision: org.published_revision,
          workflow_id: input.workflowId,
          workflow_version: workflow.version,
          code_revision: input.codeRevision,
          status: "pending",
          attempt_limit: input.attemptLimit,
          attempt_count: 0,
          creator_subject: principal.subject,
          approval_subject: null,
          approval_evidence_ref: null,
          integration_subject: null,
          integration_receipt_ref: null,
          result_code_revision: null,
          created_at: "",
          updated_at: "",
        } satisfies WorkRow;
        yield* currentBinding(check);
        const time = yield* now;
        yield* sql`INSERT INTO organization_work_items
        (work_id, request_id, request_json, organization_id, finding_id, project_id,
          binding_id, binding_version, scope, published_revision, workflow_id, workflow_version,
          code_revision, status, attempt_limit, attempt_count, creator_subject, created_at, updated_at)
        VALUES (${input.workId}, ${input.requestId}, ${requestJson}, ${input.organizationId},
          ${input.findingId}, ${input.projectId}, ${input.bindingId}, ${binding.updated_at},
          ${input.scope}, ${org.published_revision}, ${input.workflowId}, ${workflow.version},
          ${input.codeRevision}, 'pending', ${input.attemptLimit}, 0, ${principal.subject},
          ${time}, ${time})`;
        return yield* detail(input.workId);
      }),
    );
  const getWork: OrganizationWorkStoreShape["getWork"] = (workId) =>
    detail(workId).pipe(Effect.mapError((cause) => (isWorkError(cause) ? cause : unavailable())));
  const listWork: OrganizationWorkStoreShape["listWork"] = (organizationId) =>
    Effect.gen(function* () {
      const items: OrganizationWorkDetail[] = [];
      for (const row of yield* sql<{ work_id: OrganizationWorkId }>`SELECT work_id
        FROM organization_work_items WHERE organization_id = ${organizationId}
        ORDER BY created_at, work_id`)
        items.push(yield* detail(row.work_id));
      return items;
    }).pipe(Effect.mapError((cause) => (isWorkError(cause) ? cause : unavailable())));
  const claimAttempt: OrganizationWorkStoreShape["claimAttempt"] = (input, principal) =>
    transition("claim", input, principal, (work, time) =>
      Effect.gen(function* () {
        if (work.status !== "pending" && work.status !== "retrying")
          return yield* conflict("Work is not dispatchable.");
        if (work.attempt_count >= work.attempt_limit)
          return yield* conflict("Attempt limit reached.");
        yield* currentBinding(work);
        const leaseUntil = DateTime.formatIso(
          DateTime.add(yield* DateTime.now, { seconds: input.leaseSeconds }),
        );
        yield* sql`INSERT INTO organization_work_attempts
        (attempt_id, work_id, number, status, worker_subject, lease_until, started_at, updated_at)
        VALUES (${input.attemptId}, ${input.workId}, ${work.attempt_count + 1},
          'running', ${principal.subject}, ${leaseUntil}, ${time}, ${time})`;
        yield* acquireResourcePermit(work, input.attemptId, leaseUntil, time);
        yield* sql`UPDATE organization_work_items SET status = 'running',
        attempt_count = attempt_count + 1, updated_at = ${time} WHERE work_id = ${input.workId}`;
      }),
    );
  const heartbeatAttempt: OrganizationWorkStoreShape["heartbeatAttempt"] = (input, principal) =>
    transition("heartbeat", input, principal, (work, time) =>
      Effect.gen(function* () {
        const attempt = yield* latestAttempt(work, input.attemptId);
        if (
          work.status !== "running" ||
          attempt.status !== "running" ||
          attempt.worker_subject !== principal.subject ||
          attempt.lease_until <= time
        )
          return yield* conflict("Attempt lease is not held by this worker.");
        const stopping = (yield* sql<{ attempt_id: string }>`
        SELECT attempt_id FROM organization_work_scopes
        WHERE attempt_id = ${input.attemptId} AND stop_requested_at IS NOT NULL
        LIMIT 1`)[0];
        if (stopping) return yield* conflict("Scoped worker is stopping.");
        yield* currentBinding(work);
        const leaseUntil = DateTime.formatIso(
          DateTime.add(yield* DateTime.now, { seconds: input.leaseSeconds }),
        );
        const renewed = yield* sql<{ attempt_id: string }>`
        UPDATE organization_work_resource_permits
        SET lease_until = ${leaseUntil}, updated_at = ${time}
        WHERE attempt_id = ${input.attemptId} AND work_id = ${input.workId}
          AND state = 'active' AND lease_until > ${time}
        RETURNING attempt_id`;
        if (renewed.length !== 1) return yield* conflict("Resource permit is absent or expired.");
        yield* sql`UPDATE organization_work_attempts SET lease_until = ${leaseUntil},
        updated_at = ${time} WHERE attempt_id = ${input.attemptId}`;
        yield* sql`UPDATE organization_work_items SET updated_at = ${time} WHERE work_id = ${input.workId}`;
      }),
    );
  const submitAttempt: OrganizationWorkStoreShape["submitAttempt"] = (input, principal) =>
    transition("submit", input, principal, (work, time) =>
      Effect.gen(function* () {
        const attempt = yield* latestAttempt(work, input.attemptId);
        if (
          work.status !== "running" ||
          attempt.status !== "running" ||
          attempt.worker_subject !== principal.subject ||
          attempt.lease_until <= time
        )
          return yield* conflict("Attempt is not running under this worker's lease.");
        yield* currentBinding(work);
        yield* requireScopeStopped(input.attemptId);
        const scope = (yield* sql<{
          unit_name: string;
          invocation_id: string;
          start_requested_at: string | null;
          started_at: string | null;
          stop_requested_at: string | null;
          verified_stopped_at: string | null;
        }>`SELECT unit_name, invocation_id, start_requested_at, started_at,
            stop_requested_at, verified_stopped_at FROM organization_work_scopes
          WHERE attempt_id = ${input.attemptId}`)[0];
        if (
          !scope ||
          !scope.start_requested_at ||
          !scope.started_at ||
          !scope.stop_requested_at ||
          !scope.verified_stopped_at
        )
          return yield* conflict(
            "Submission requires a started and verified stopped scoped worker.",
          );
        yield* artifactVerifier.verifySubmitted({
          workId: work.work_id,
          attemptId: input.attemptId,
          projectId: work.project_id,
          baseCodeRevision: work.code_revision,
          scopeUnitName: scope.unit_name,
          scopeInvocationId: scope.invocation_id,
          artifactDigest: input.artifactDigest,
          artifactRef: input.artifactRef,
        });
        yield* sql`UPDATE organization_work_attempts SET status = 'submitted',
        artifact_digest = ${input.artifactDigest}, artifact_ref = ${input.artifactRef},
        updated_at = ${time} WHERE attempt_id = ${input.attemptId}`;
        const released = yield* sql<{ attempt_id: string }>`
        UPDATE organization_work_resource_permits
        SET state = 'released', updated_at = ${time}
        WHERE attempt_id = ${input.attemptId} AND work_id = ${input.workId}
          AND state = 'active' AND lease_until > ${time}
        RETURNING attempt_id`;
        if (released.length !== 1) return yield* conflict("Resource permit is absent or expired.");
        yield* sql`UPDATE organization_work_items SET status = 'blocked', updated_at = ${time}
        WHERE work_id = ${input.workId}`;
      }),
    );
  const evaluateAttempt: OrganizationWorkStoreShape["evaluateAttempt"] = (input, principal) =>
    transition("evaluate", input, principal, (work, time) =>
      Effect.gen(function* () {
        const attempt = yield* latestAttempt(work, input.attemptId);
        if (
          work.status !== "blocked" ||
          attempt.status !== "submitted" ||
          attempt.artifact_digest !== input.artifactDigest
        )
          return yield* conflict("Submitted artifact does not match this evaluation.");
        if (attempt.worker_subject === principal.subject)
          return yield* forbidden("A builder cannot evaluate its own attempt.");
        yield* currentBinding(work);
        if (!attempt.artifact_ref)
          return yield* conflict("Submitted attempt has no artifact reference.");
        yield* evaluationVerifier.verifyEvaluation({
          workId: work.work_id,
          attemptId: input.attemptId,
          projectId: work.project_id,
          artifactDigest: input.artifactDigest,
          artifactRef: attempt.artifact_ref,
          workerSubject: attempt.worker_subject,
          reviewerSubject: principal.subject,
          accepted: input.accepted,
          evidenceRef: input.evidenceRef,
        });
        const status = input.accepted ? "qa-accepted" : "qa-rejected";
        const next = input.accepted
          ? "waiting-approval"
          : work.attempt_count < work.attempt_limit
            ? "retrying"
            : "failed";
        yield* sql`UPDATE organization_work_attempts SET status = ${status},
        qa_subject = ${principal.subject}, qa_evidence_ref = ${input.evidenceRef},
        updated_at = ${time} WHERE attempt_id = ${input.attemptId}`;
        yield* sql`UPDATE organization_work_items SET status = ${next}, updated_at = ${time}
        WHERE work_id = ${input.workId}`;
      }),
    );
  const recordApproval: OrganizationWorkStoreShape["recordApproval"] = (input, principal) =>
    transition("approve", input, principal, (work, time) =>
      Effect.gen(function* () {
        const attempt = yield* latestAttempt(work, input.attemptId);
        if (
          work.status !== "waiting-approval" ||
          attempt.status !== "qa-accepted" ||
          attempt.artifact_digest !== input.artifactDigest
        )
          return yield* conflict("Only the QA accepted artifact can be approved.");
        if (
          principal.subject === attempt.worker_subject ||
          principal.subject === attempt.qa_subject
        )
          return yield* forbidden("Approval must be independent of build and QA.");
        yield* currentBinding(work);
        if (!attempt.artifact_ref || !attempt.qa_subject)
          return yield* conflict("QA accepted attempt lacks artifact or reviewer identity.");
        yield* approvalVerifier.verifyApproval({
          workId: work.work_id,
          attemptId: input.attemptId,
          projectId: work.project_id,
          baseCodeRevision: work.code_revision,
          artifactDigest: input.artifactDigest,
          artifactRef: attempt.artifact_ref,
          workerSubject: attempt.worker_subject,
          qaSubject: attempt.qa_subject,
          approvalSubject: principal.subject,
          approved: input.approved,
          evidenceRef: input.evidenceRef,
        });
        const next = input.approved ? "blocked" : "canceled";
        yield* sql`UPDATE organization_work_items SET status = ${next},
        approval_subject = ${principal.subject}, approval_evidence_ref = ${input.evidenceRef},
        updated_at = ${time} WHERE work_id = ${input.workId}`;
      }),
    );
  const recordIntegration: OrganizationWorkStoreShape["recordIntegration"] = (input, principal) =>
    transition("integrate", input, principal, (work, time) =>
      Effect.gen(function* () {
        const attempt = yield* latestAttempt(work, input.attemptId);
        if (
          work.status !== "blocked" ||
          attempt.status !== "qa-accepted" ||
          !work.approval_subject ||
          attempt.artifact_digest !== input.artifactDigest ||
          work.code_revision !== input.baseCodeRevision
        )
          return yield* conflict(
            "Integration needs an approved QA artifact and matching base revision.",
          );
        if (
          principal.subject === attempt.worker_subject ||
          principal.subject === attempt.qa_subject ||
          principal.subject === work.approval_subject
        )
          return yield* forbidden("Integration identity must be independent.");
        yield* currentBinding(work);
        if (!attempt.artifact_ref || !attempt.qa_subject)
          return yield* conflict("Approved attempt lacks artifact or reviewer identity.");
        yield* integrationVerifier.verifyIntegration({
          workId: work.work_id,
          attemptId: input.attemptId,
          projectId: work.project_id,
          baseCodeRevision: input.baseCodeRevision,
          artifactDigest: input.artifactDigest,
          artifactRef: attempt.artifact_ref,
          workerSubject: attempt.worker_subject,
          qaSubject: attempt.qa_subject,
          approvalSubject: work.approval_subject,
          integratorSubject: principal.subject,
          resultCodeRevision: input.resultCodeRevision,
          receiptRef: input.receiptRef,
        });
        yield* sql`UPDATE organization_work_items SET status = 'succeeded',
        integration_subject = ${principal.subject}, integration_receipt_ref = ${input.receiptRef},
        result_code_revision = ${input.resultCodeRevision}, updated_at = ${time}
        WHERE work_id = ${input.workId}`;
      }),
    );
  const recoverExpired: OrganizationWorkStoreShape["recoverExpired"] = (input, principal) =>
    transition("recover", input, principal, (work, time) =>
      Effect.gen(function* () {
        if (work.status !== "running") return yield* conflict("Work has no running attempt.");
        const attempt = (yield* attemptRows(input.workId)).at(-1);
        if (!attempt || attempt.status !== "running" || attempt.lease_until > time)
          return yield* conflict("Current attempt lease has not expired.");
        yield* sql`UPDATE organization_work_attempts SET status = 'expired', updated_at = ${time}
        WHERE attempt_id = ${attempt.attempt_id}`;
        yield* releaseResourcePermit(attempt.attempt_id, "expired", time);
        yield* sql`UPDATE organization_work_items SET status = 'recovering', updated_at = ${time}
        WHERE work_id = ${input.workId}`;
      }),
    );
  const resolveRecovery: OrganizationWorkStoreShape["resolveRecovery"] = (input, principal) =>
    transition("recover", input, principal, (work, time) =>
      Effect.gen(function* () {
        const attempt = yield* latestAttempt(work, input.attemptId);
        if (work.status !== "recovering" || attempt.status !== "expired")
          return yield* conflict("Attempt is not awaiting recovery.");
        const next =
          input.disposition === "safe-to-retry"
            ? work.attempt_count < work.attempt_limit
              ? "retrying"
              : "failed"
            : "blocked";
        yield* sql`UPDATE organization_work_items SET status = ${next}, updated_at = ${time}
        WHERE work_id = ${input.workId}`;
      }),
    );
  const cancelWork: OrganizationWorkStoreShape["cancelWork"] = (input, principal) =>
    transition("cancel", input, principal, (work, time) =>
      Effect.gen(function* () {
        if (work.status === "succeeded" || work.status === "failed" || work.status === "canceled")
          return yield* conflict("Terminal work cannot be canceled.");
        const openScopes = yield* sql<{ attempt_id: string }>`
        SELECT a.attempt_id FROM organization_work_attempts a
        LEFT JOIN organization_work_scopes s ON s.attempt_id = a.attempt_id
        LEFT JOIN organization_work_scope_preparations prep ON prep.attempt_id = a.attempt_id
        LEFT JOIN organization_work_scope_recovery_receipts recovery
          ON recovery.attempt_id = prep.attempt_id
          AND recovery.operation_id = prep.attempt_id
          AND recovery.unit_name = prep.unit_name
          AND recovery.kind IN ('never-dispatched', 'verified-stopped-unattached')
        WHERE a.work_id = ${input.workId}
          AND ((s.attempt_id IS NOT NULL AND s.verified_stopped_at IS NULL) OR
            (prep.attempt_id IS NOT NULL AND s.verified_stopped_at IS NULL
              AND recovery.attempt_id IS NULL))
        LIMIT 1`;
        if (openScopes.length > 0)
          return yield* conflict("Scoped worker must be verified stopped before canceling work.");
        yield* sql`UPDATE organization_work_attempts SET status = 'canceled', updated_at = ${time}
        WHERE work_id = ${input.workId} AND status IN ('running','submitted','qa-accepted')`;
        yield* sql`UPDATE organization_work_resource_permits SET state = 'released', updated_at = ${time}
        WHERE work_id = ${input.workId} AND state = 'active'`;
        yield* sql`UPDATE organization_work_items SET status = 'canceled', updated_at = ${time}
        WHERE work_id = ${input.workId}`;
      }),
    );
  return {
    createWork,
    getWork,
    listWork,
    claimAttempt,
    heartbeatAttempt,
    submitAttempt,
    evaluateAttempt,
    recordApproval,
    recordIntegration,
    recoverExpired,
    resolveRecovery,
    cancelWork,
  } satisfies OrganizationWorkStoreShape;
});

export const OrganizationWorkStoreLayer = Layer.effect(OrganizationWorkStore, make);
/** Read access is available; all writes remain denied until executor authority is reviewed. */
export const OrganizationWorkStoreLive = OrganizationWorkStoreLayer.pipe(
  Layer.provide(OrganizationWorkExecutionDisabled),
  Layer.provide(OrganizationWorkArtifactVerifierDisabled),
  Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
  Layer.provide(OrganizationWorkApprovalVerifierDisabled),
  Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
);

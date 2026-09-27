import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationBindingId, OrganizationId, OrganizationWorkflowId } from "./organizations.ts";
import { OrganizationTentativeFindingId } from "./organizationIntake.ts";

const ShortId = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const OrganizationWorkId = ShortId.pipe(Schema.brand("OrganizationWorkId"));
export type OrganizationWorkId = typeof OrganizationWorkId.Type;
export const OrganizationWorkAttemptId = ShortId.pipe(Schema.brand("OrganizationWorkAttemptId"));
export type OrganizationWorkAttemptId = typeof OrganizationWorkAttemptId.Type;
export const OrganizationWorkStatus = Schema.Literals([
  "pending",
  "running",
  "blocked",
  "waiting-approval",
  "retrying",
  "succeeded",
  "failed",
  "canceled",
  "recovering",
]);
export type OrganizationWorkStatus = typeof OrganizationWorkStatus.Type;
export const OrganizationWorkAttemptStatus = Schema.Literals([
  "running",
  "submitted",
  "qa-accepted",
  "qa-rejected",
  "expired",
  "canceled",
]);
export type OrganizationWorkAttemptStatus = typeof OrganizationWorkAttemptStatus.Type;

export const OrganizationWorkAttempt = Schema.Struct({
  id: OrganizationWorkAttemptId,
  workId: OrganizationWorkId,
  number: PositiveInt,
  status: OrganizationWorkAttemptStatus,
  workerSubject: ShortId,
  leaseUntil: IsoDateTime,
  artifactDigest: Schema.NullOr(ShortId),
  artifactRef: Schema.NullOr(ShortId),
  qaSubject: Schema.NullOr(ShortId),
  qaEvidenceRef: Schema.NullOr(ShortId),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrganizationWorkAttempt = typeof OrganizationWorkAttempt.Type;
export const OrganizationWorkItem = Schema.Struct({
  id: OrganizationWorkId,
  organizationId: OrganizationId,
  findingId: OrganizationTentativeFindingId,
  projectId: ProjectId,
  bindingId: OrganizationBindingId,
  bindingVersion: IsoDateTime,
  scope: Schema.NullOr(ShortId),
  publishedRevision: PositiveInt,
  workflowId: OrganizationWorkflowId,
  workflowVersion: PositiveInt,
  codeRevision: ShortId,
  status: OrganizationWorkStatus,
  attemptLimit: PositiveInt,
  attemptCount: Schema.Int,
  creatorSubject: ShortId,
  approvalSubject: Schema.NullOr(ShortId),
  approvalEvidenceRef: Schema.NullOr(ShortId),
  integrationSubject: Schema.NullOr(ShortId),
  integrationReceiptRef: Schema.NullOr(ShortId),
  resultCodeRevision: Schema.NullOr(ShortId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrganizationWorkItem = typeof OrganizationWorkItem.Type;
export const OrganizationWorkDetail = Schema.Struct({
  work: OrganizationWorkItem,
  attempts: Schema.Array(OrganizationWorkAttempt),
});
export type OrganizationWorkDetail = typeof OrganizationWorkDetail.Type;

export const OrganizationWorkCreateInput = Schema.Struct({
  workId: OrganizationWorkId,
  requestId: ShortId,
  organizationId: OrganizationId,
  findingId: OrganizationTentativeFindingId,
  projectId: ProjectId,
  bindingId: OrganizationBindingId,
  workflowId: OrganizationWorkflowId,
  scope: Schema.NullOr(ShortId),
  codeRevision: ShortId,
  attemptLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(3)),
});
export type OrganizationWorkCreateInput = typeof OrganizationWorkCreateInput.Type;
export const OrganizationWorkActionInput = Schema.Struct({
  workId: OrganizationWorkId,
  transitionId: ShortId,
});
export type OrganizationWorkActionInput = typeof OrganizationWorkActionInput.Type;
export const OrganizationWorkClaimInput = Schema.Struct({
  ...OrganizationWorkActionInput.fields,
  attemptId: OrganizationWorkAttemptId,
  leaseSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(300)),
});
export type OrganizationWorkClaimInput = typeof OrganizationWorkClaimInput.Type;
export const OrganizationWorkHeartbeatInput = Schema.Struct({
  ...OrganizationWorkActionInput.fields,
  attemptId: OrganizationWorkAttemptId,
  leaseSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(300)),
});
export type OrganizationWorkHeartbeatInput = typeof OrganizationWorkHeartbeatInput.Type;
export const OrganizationWorkSubmitInput = Schema.Struct({
  ...OrganizationWorkActionInput.fields,
  attemptId: OrganizationWorkAttemptId,
  artifactDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  artifactRef: ShortId,
});
export type OrganizationWorkSubmitInput = typeof OrganizationWorkSubmitInput.Type;
export const OrganizationWorkEvaluateInput = Schema.Struct({
  ...OrganizationWorkActionInput.fields,
  attemptId: OrganizationWorkAttemptId,
  accepted: Schema.Boolean,
  artifactDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  evidenceRef: ShortId,
});
export type OrganizationWorkEvaluateInput = typeof OrganizationWorkEvaluateInput.Type;
export const OrganizationWorkApprovalInput = Schema.Struct({
  ...OrganizationWorkActionInput.fields,
  attemptId: OrganizationWorkAttemptId,
  approved: Schema.Boolean,
  artifactDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  evidenceRef: ShortId,
});
export type OrganizationWorkApprovalInput = typeof OrganizationWorkApprovalInput.Type;
export const OrganizationWorkIntegrationInput = Schema.Struct({
  ...OrganizationWorkActionInput.fields,
  attemptId: OrganizationWorkAttemptId,
  artifactDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  baseCodeRevision: ShortId,
  resultCodeRevision: ShortId,
  receiptRef: ShortId,
});
export type OrganizationWorkIntegrationInput = typeof OrganizationWorkIntegrationInput.Type;
export const OrganizationWorkRecoveryInput = Schema.Struct({
  ...OrganizationWorkActionInput.fields,
  attemptId: OrganizationWorkAttemptId,
  disposition: Schema.Literals(["safe-to-retry", "effect-observed", "uncertain"]),
  evidenceRef: ShortId,
});
export type OrganizationWorkRecoveryInput = typeof OrganizationWorkRecoveryInput.Type;

export class OrganizationWorkError extends Schema.TaggedError<OrganizationWorkError>()(
  "OrganizationWorkError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}

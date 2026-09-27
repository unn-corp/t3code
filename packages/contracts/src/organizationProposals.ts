import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OrganizationTentativeFindingId,
  OrganizationObservationId,
  OrganizationIntakeSourceId,
} from "./organizationIntake.ts";
import { OrganizationBindingId, OrganizationId } from "./organizations.ts";

export const OrganizationProposalId = TrimmedNonEmptyString.check(Schema.isMaxLength(160)).pipe(
  Schema.brand("OrganizationProposalId"),
);
export type OrganizationProposalId = typeof OrganizationProposalId.Type;
export const OrganizationProposalMutationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
).pipe(Schema.brand("OrganizationProposalMutationId"));
export type OrganizationProposalMutationId = typeof OrganizationProposalMutationId.Type;
export const OrganizationProposalState = Schema.Literals([
  "proposed",
  "acknowledged",
  "rejected",
  "deferred",
]);
export const OrganizationProposalEvidence = Schema.Struct({
  observationId: OrganizationObservationId,
  sourceId: OrganizationIntakeSourceId,
  projectId: ProjectId,
});
export type OrganizationProposalEvidence = typeof OrganizationProposalEvidence.Type;
export const OrganizationWorkProposal = Schema.Struct({
  id: OrganizationProposalId,
  organizationId: OrganizationId,
  findingId: OrganizationTentativeFindingId,
  projectId: ProjectId,
  bindingId: OrganizationBindingId,
  bindingVersion: IsoDateTime,
  publishedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  evidence: Schema.Array(OrganizationProposalEvidence).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  state: OrganizationProposalState,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  currentlyEligible: Schema.Boolean,
  staleReason: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(TrimmedNonEmptyString),
  decisionReason: Schema.NullOr(Schema.String),
  reconsiderAfter: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrganizationWorkProposal = typeof OrganizationWorkProposal.Type;
export const OrganizationObservationMode = Schema.Struct({
  organizationId: OrganizationId,
  enabled: Schema.Boolean,
  effective: Schema.Boolean,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  enabledAt: Schema.NullOr(IsoDateTime),
  updatedBy: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type OrganizationObservationMode = typeof OrganizationObservationMode.Type;
export const OrganizationProposalListInput = Schema.Struct({
  organizationId: OrganizationId,
  afterProposalId: Schema.NullOr(OrganizationProposalId),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
});
export type OrganizationProposalListInput = typeof OrganizationProposalListInput.Type;
export const OrganizationProposalListResult = Schema.Struct({
  proposals: Schema.Array(OrganizationWorkProposal),
  nextCursor: Schema.NullOr(OrganizationProposalId),
});
export type OrganizationProposalListResult = typeof OrganizationProposalListResult.Type;
export const OrganizationObservationModeGetInput = Schema.Struct({
  organizationId: OrganizationId,
});
export const OrganizationObservationModeSetInput = Schema.Struct({
  organizationId: OrganizationId,
  mutationId: OrganizationProposalMutationId,
  expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  enabled: Schema.Boolean,
});
export type OrganizationObservationModeSetInput = typeof OrganizationObservationModeSetInput.Type;
export const OrganizationProposalDecisionInput = Schema.Struct({
  organizationId: OrganizationId,
  proposalId: OrganizationProposalId,
  mutationId: OrganizationProposalMutationId,
  expectedVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  decision: Schema.Literals(["acknowledge", "reject", "defer"]),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  reconsiderAt: Schema.NullOr(IsoDateTime),
});
export type OrganizationProposalDecisionInput = typeof OrganizationProposalDecisionInput.Type;
export class OrganizationProposalError extends Schema.TaggedError<OrganizationProposalError>()(
  "OrganizationProposalError",
  {
    code: Schema.Literals(["invalid", "forbidden", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}

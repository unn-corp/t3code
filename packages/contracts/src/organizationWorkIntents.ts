import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationProposalEvidence } from "./organizationProposals.ts";
import { OrganizationId } from "./organizations.ts";
import { OrganizationWorkflowId } from "./organizations.ts";
import { OrganizationWorkId } from "./organizationWork.ts";
import { ModelSelection } from "./orchestration.ts";

const WorkIntentId = TrimmedNonEmptyString.check(Schema.isMaxLength(160));

/** A saved proposal handoff. It does not grant approval or permission to run work. */
export const OrganizationWaitingWorkIntent = Schema.Struct({
  id: WorkIntentId,
  organizationId: OrganizationId,
  proposalId: WorkIntentId,
  proposalVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  findingId: WorkIntentId,
  projectId: WorkIntentId,
  bindingId: WorkIntentId,
  bindingVersion: IsoDateTime,
  publishedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  evidence: Schema.Array(OrganizationProposalEvidence).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  requestedBy: TrimmedNonEmptyString,
  status: Schema.Literal("awaiting-activation"),
  freshness: Schema.Literals(["current", "stale"]),
  staleReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type OrganizationWaitingWorkIntent = typeof OrganizationWaitingWorkIntent.Type;

export const OrganizationWorkIntentListInput = Schema.Struct({
  organizationId: OrganizationId,
  afterIntentId: Schema.NullOr(WorkIntentId),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
});
export type OrganizationWorkIntentListInput = typeof OrganizationWorkIntentListInput.Type;
export const OrganizationWorkIntentListResult = Schema.Struct({
  intents: Schema.Array(OrganizationWaitingWorkIntent).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(WorkIntentId),
});
export type OrganizationWorkIntentListResult = typeof OrganizationWorkIntentListResult.Type;
export class OrganizationWorkIntentReadError extends Schema.TaggedError<OrganizationWorkIntentReadError>()(
  "OrganizationWorkIntentReadError",
  {
    code: Schema.Literals(["invalid", "forbidden", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}

/** An interactive user's bounded choice for one Project file and independent QA oracle. */
export const OrganizationWorkIntentActivationSelection = Schema.Struct({
  workflowId: OrganizationWorkflowId,
  targetRef: Schema.String.check(
    Schema.isPattern(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  ),
  fileName: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/)),
  taskText: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  modelSelection: ModelSelection,
  qaPlan: Schema.Struct({
    version: Schema.Literal(1),
    exportName: Schema.String.check(Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/)),
    cases: Schema.Array(Schema.Struct({ input: Schema.Unknown, expected: Schema.Unknown })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
  }),
});
export type OrganizationWorkIntentActivationSelection =
  typeof OrganizationWorkIntentActivationSelection.Type;

export const OrganizationWorkIntentActivationInput = Schema.Struct({
  organizationId: OrganizationId,
  intentId: WorkIntentId,
  selection: OrganizationWorkIntentActivationSelection,
});
export type OrganizationWorkIntentActivationInput =
  typeof OrganizationWorkIntentActivationInput.Type;

export const OrganizationWorkIntentActivationResult = Schema.Struct({
  intentId: WorkIntentId,
  organizationId: OrganizationId,
  workId: OrganizationWorkId,
  selection: OrganizationWorkIntentActivationSelection,
  activatedBy: TrimmedNonEmptyString,
  activatedAt: IsoDateTime,
});
export type OrganizationWorkIntentActivationResult =
  typeof OrganizationWorkIntentActivationResult.Type;

export class OrganizationWorkIntentActivationError extends Schema.TaggedError<OrganizationWorkIntentActivationError>()(
  "OrganizationWorkIntentActivationError",
  {
    code: Schema.Literals(["invalid", "forbidden", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}

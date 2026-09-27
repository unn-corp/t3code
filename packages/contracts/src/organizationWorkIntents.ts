import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationProposalEvidence } from "./organizationProposals.ts";
import { OrganizationId } from "./organizations.ts";

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

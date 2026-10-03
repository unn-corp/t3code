import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";
import { OrganizationObservationId, OrganizationTentativeFindingId } from "./organizationIntake.ts";
import { OrganizationProposalId } from "./organizationProposals.ts";
import { OrganizationWorkId } from "./organizationWork.ts";

const ShortId = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const OrganizationDirectorRequestId = ShortId.pipe(
  Schema.brand("OrganizationDirectorRequestId"),
);
export type OrganizationDirectorRequestId = typeof OrganizationDirectorRequestId.Type;
export const OrganizationDirectorMessageId = ShortId.pipe(
  Schema.brand("OrganizationDirectorMessageId"),
);
export type OrganizationDirectorMessageId = typeof OrganizationDirectorMessageId.Type;
export const OrganizationDirectorEvidence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("observation"),
    label: Schema.Literal("observed"),
    id: OrganizationObservationId,
    projectId: Schema.NullOr(ProjectId),
  }),
  Schema.Struct({
    kind: Schema.Literal("finding"),
    label: Schema.Literal("tentative"),
    id: OrganizationTentativeFindingId,
    projectId: Schema.NullOr(ProjectId),
  }),
  Schema.Struct({
    kind: Schema.Literal("proposal"),
    label: Schema.Literal("proposed"),
    id: OrganizationProposalId,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("work"),
    label: Schema.Literal("verified-work"),
    id: OrganizationWorkId,
    projectId: ProjectId,
  }),
]);
export type OrganizationDirectorEvidence = typeof OrganizationDirectorEvidence.Type;
export const OrganizationDirectorMessage = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  id: OrganizationDirectorMessageId,
  organizationId: OrganizationId,
  projectId: Schema.NullOr(ProjectId),
  requestId: OrganizationDirectorRequestId,
  role: Schema.Literals(["user", "director"]),
  text: Schema.String,
  evidence: Schema.Array(OrganizationDirectorEvidence).check(Schema.isMaxLength(32)),
  createdAt: IsoDateTime,
});
export type OrganizationDirectorMessage = typeof OrganizationDirectorMessage.Type;
export const OrganizationDirectorAskInput = Schema.Struct({
  organizationId: OrganizationId,
  projectId: Schema.NullOr(ProjectId),
  requestId: OrganizationDirectorRequestId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
});
export type OrganizationDirectorAskInput = typeof OrganizationDirectorAskInput.Type;
export const OrganizationDirectorAskResult = Schema.Struct({
  userMessage: OrganizationDirectorMessage,
  directorMessage: OrganizationDirectorMessage,
});
export type OrganizationDirectorAskResult = typeof OrganizationDirectorAskResult.Type;
/** Null projectId selects only Organization-wide messages, not every Project. */
export const OrganizationDirectorListInput = Schema.Struct({
  organizationId: OrganizationId,
  projectId: Schema.NullOr(ProjectId),
  afterSequence: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50)),
});
export type OrganizationDirectorListInput = typeof OrganizationDirectorListInput.Type;
export const OrganizationDirectorListResult = Schema.Struct({
  messages: Schema.Array(OrganizationDirectorMessage),
  nextCursor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type OrganizationDirectorListResult = typeof OrganizationDirectorListResult.Type;
export class OrganizationDirectorError extends Schema.TaggedError<OrganizationDirectorError>()(
  "OrganizationDirectorError",
  {
    code: Schema.Literals(["invalid", "forbidden", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}

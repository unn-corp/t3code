import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import {
  OrganizationEdge,
  OrganizationId,
  OrganizationRoleId,
  OrganizationWorkflowDefinition,
} from "./organizations.ts";

/** Proposals are draft suggestions. They do not mutate configuration or grant authority. */
const ArchitectWorkerRole = Schema.Struct({
  id: OrganizationRoleId,
  kind: Schema.Literals(["engineering", "qa", "security", "research", "custom"]),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  mandate: Schema.String.check(Schema.isMaxLength(2_000)),
  poolSize: PositiveInt.check(Schema.isLessThanOrEqualTo(4)),
});

export const OrganizationArchitectAllowedChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("add-role"), role: ArchitectWorkerRole }),
  Schema.Struct({
    type: Schema.Literal("update-role"),
    roleId: OrganizationRoleId,
    title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
    mandate: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
    poolSize: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(4))),
  }),
  Schema.Struct({ type: Schema.Literal("add-edge"), edge: OrganizationEdge }),
  Schema.Struct({
    type: Schema.Literal("upsert-workflow"),
    workflow: OrganizationWorkflowDefinition,
  }),
  Schema.Struct({
    type: Schema.Literal("set-title"),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  }),
  Schema.Struct({
    type: Schema.Literal("set-mission"),
    mission: Schema.String.check(Schema.isMaxLength(2_000)),
  }),
]);
export type OrganizationArchitectAllowedChange = typeof OrganizationArchitectAllowedChange.Type;

export const OrganizationArchitectTurnOutput = Schema.Struct({
  reply: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  proposals: Schema.Array(
    Schema.Struct({
      baseRevision: PositiveInt,
      change: OrganizationArchitectAllowedChange,
    }),
  ).check(Schema.isMaxLength(8)),
});
export type OrganizationArchitectTurnOutput = typeof OrganizationArchitectTurnOutput.Type;

const ArchitectMessageId = TrimmedNonEmptyString.check(Schema.isMaxLength(160)).pipe(
  Schema.brand("OrganizationArchitectMessageId"),
);
export const OrganizationArchitectMessageId = ArchitectMessageId;
export type OrganizationArchitectMessageId = typeof ArchitectMessageId.Type;
export const OrganizationArchitectProposalId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
).pipe(Schema.brand("OrganizationArchitectProposalId"));
export type OrganizationArchitectProposalId = typeof OrganizationArchitectProposalId.Type;

export const OrganizationArchitectMessage = Schema.Struct({
  id: OrganizationArchitectMessageId,
  organizationId: OrganizationId,
  requestId: OrganizationArchitectMessageId,
  role: Schema.Literals(["user", "architect"]),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  baseRevision: PositiveInt,
  modelSelection: Schema.NullOr(ModelSelection),
  createdAt: IsoDateTime,
});
export type OrganizationArchitectMessage = typeof OrganizationArchitectMessage.Type;
export const OrganizationArchitectProposal = Schema.Struct({
  id: OrganizationArchitectProposalId,
  organizationId: OrganizationId,
  responseMessageId: OrganizationArchitectMessageId,
  baseRevision: PositiveInt,
  change: OrganizationArchitectAllowedChange,
  createdAt: IsoDateTime,
});
export type OrganizationArchitectProposal = typeof OrganizationArchitectProposal.Type;
export const OrganizationArchitectRequestStatus = Schema.Struct({
  requestId: OrganizationArchitectMessageId,
  organizationId: OrganizationId,
  baseRevision: PositiveInt,
  status: Schema.Literals(["pending", "completed", "failed"]),
  failureMessage: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrganizationArchitectRequestStatus = typeof OrganizationArchitectRequestStatus.Type;
export const OrganizationArchitectListInput = Schema.Struct({ organizationId: OrganizationId });
export type OrganizationArchitectListInput = typeof OrganizationArchitectListInput.Type;
export const OrganizationArchitectListResult = Schema.Struct({
  messages: Schema.Array(OrganizationArchitectMessage),
  proposals: Schema.Array(OrganizationArchitectProposal),
  requests: Schema.Array(OrganizationArchitectRequestStatus),
  appliedProposalIds: Schema.Array(OrganizationArchitectProposalId),
});
export type OrganizationArchitectListResult = typeof OrganizationArchitectListResult.Type;
export const OrganizationArchitectSendInput = Schema.Struct({
  organizationId: OrganizationId,
  messageId: OrganizationArchitectMessageId,
  baseRevision: PositiveInt,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  modelSelection: ModelSelection,
});
export type OrganizationArchitectSendInput = typeof OrganizationArchitectSendInput.Type;
export const OrganizationArchitectSendResult = Schema.Struct({
  userMessage: OrganizationArchitectMessage,
  responseMessage: OrganizationArchitectMessage,
  proposals: Schema.Array(OrganizationArchitectProposal),
});
export type OrganizationArchitectSendResult = typeof OrganizationArchitectSendResult.Type;
/** Apply one saved Architect turn as one validated draft revision. */
export const OrganizationArchitectApplyBatchInput = Schema.Struct({
  organizationId: OrganizationId,
  mutationId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  baseRevision: PositiveInt,
  proposalIds: Schema.Array(OrganizationArchitectProposalId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
});
export type OrganizationArchitectApplyBatchInput = typeof OrganizationArchitectApplyBatchInput.Type;
export const OrganizationArchitectBeginResult = Schema.Struct({
  shouldGenerate: Schema.Boolean,
  status: OrganizationArchitectRequestStatus.fields.status,
  result: Schema.NullOr(OrganizationArchitectSendResult),
});
export type OrganizationArchitectBeginResult = typeof OrganizationArchitectBeginResult.Type;
export class OrganizationArchitectError extends Schema.TaggedError<OrganizationArchitectError>()(
  "OrganizationArchitectError",
  {
    code: Schema.Literals(["invalid", "conflict", "not_found", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}

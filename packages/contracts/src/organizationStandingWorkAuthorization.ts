import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationIntakeSourceId } from "./organizationIntake.ts";
import { OrganizationWorkIntentActivationSelection } from "./organizationWorkIntents.ts";
import { OrganizationBindingId, OrganizationId } from "./organizations.ts";

export const OrganizationStandingWorkAuthorizationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
).pipe(Schema.brand("OrganizationStandingWorkAuthorizationId"));
export type OrganizationStandingWorkAuthorizationId =
  typeof OrganizationStandingWorkAuthorizationId.Type;

/** A bounded human grant for future intents from one generic HTTP source. */
export const OrganizationStandingWorkAuthorizationCreateInput = Schema.Struct({
  organizationId: OrganizationId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  projectId: ProjectId,
  sourceId: OrganizationIntakeSourceId,
  bindingId: OrganizationBindingId,
  selection: OrganizationWorkIntentActivationSelection,
  maxActivations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  expiresAt: IsoDateTime,
});
export type OrganizationStandingWorkAuthorizationCreateInput =
  typeof OrganizationStandingWorkAuthorizationCreateInput.Type;

export const OrganizationStandingWorkAuthorizationRevokeInput = Schema.Struct({
  organizationId: OrganizationId,
  authorizationId: OrganizationStandingWorkAuthorizationId,
});
export type OrganizationStandingWorkAuthorizationRevokeInput =
  typeof OrganizationStandingWorkAuthorizationRevokeInput.Type;

export const OrganizationStandingWorkAuthorizationListInput = Schema.Struct({
  organizationId: OrganizationId,
});
export type OrganizationStandingWorkAuthorizationListInput =
  typeof OrganizationStandingWorkAuthorizationListInput.Type;

export const OrganizationStandingWorkAuthorization = Schema.Struct({
  id: OrganizationStandingWorkAuthorizationId,
  organizationId: OrganizationId,
  projectId: ProjectId,
  sourceId: OrganizationIntakeSourceId,
  bindingId: OrganizationBindingId,
  bindingVersion: IsoDateTime,
  publishedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  selection: OrganizationWorkIntentActivationSelection,
  maxActivations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  usedActivations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
  revocationReason: Schema.NullOr(Schema.Literals(["manual", "expired", "exhausted"])),
  createdBy: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type OrganizationStandingWorkAuthorization =
  typeof OrganizationStandingWorkAuthorization.Type;

export const OrganizationStandingWorkAuthorizationListResult = Schema.Struct({
  authorizations: Schema.Array(OrganizationStandingWorkAuthorization).check(
    Schema.isMaxLength(100),
  ),
});
export type OrganizationStandingWorkAuthorizationListResult =
  typeof OrganizationStandingWorkAuthorizationListResult.Type;

export class OrganizationStandingWorkAuthorizationError extends Schema.TaggedError<OrganizationStandingWorkAuthorizationError>()(
  "OrganizationStandingWorkAuthorizationError",
  {
    code: Schema.Literals(["invalid", "forbidden", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}

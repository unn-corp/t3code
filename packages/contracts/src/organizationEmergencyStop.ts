import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";

export const OrganizationEmergencyStopRequestInput = Schema.Struct({
  organizationId: OrganizationId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
});
export type OrganizationEmergencyStopRequestInput =
  typeof OrganizationEmergencyStopRequestInput.Type;

export const OrganizationEmergencyStopStatusInput = Schema.Struct({
  organizationId: OrganizationId,
});
export type OrganizationEmergencyStopStatusInput = typeof OrganizationEmergencyStopStatusInput.Type;

export const OrganizationEmergencyStopStatus = Schema.Struct({
  organizationId: OrganizationId,
  state: Schema.Literals(["none", "requested"]),
  requestedAt: Schema.NullOr(IsoDateTime),
  admittedPhases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  verifiedProviderExits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unverifiedProviderLaunches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  verifiedScopes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OrganizationEmergencyStopStatus = typeof OrganizationEmergencyStopStatus.Type;

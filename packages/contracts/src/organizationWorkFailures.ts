import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";
import { OrganizationWorkId } from "./organizationWork.ts";

export const OrganizationLiveWorkFailure = Schema.Struct({
  workId: OrganizationWorkId,
  phase: Schema.Literals(["attempt", "qa", "integration"]),
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  occurredAt: IsoDateTime,
});
export type OrganizationLiveWorkFailure = typeof OrganizationLiveWorkFailure.Type;

export const OrganizationLiveWorkFailuresInput = Schema.Struct({ organizationId: OrganizationId });
export const OrganizationLiveWorkFailuresResult = Schema.Struct({
  failures: Schema.Array(OrganizationLiveWorkFailure).check(Schema.isMaxLength(100)),
});
export const OrganizationLiveWorkRuntimeStatusInput = Schema.Struct({
  organizationId: OrganizationId,
});
export const OrganizationLiveWorkRuntimeStatusResult = Schema.Struct({
  ready: Schema.Boolean,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
});
export class OrganizationLiveWorkFailuresError extends Schema.TaggedError<OrganizationLiveWorkFailuresError>()(
  "OrganizationLiveWorkFailuresError",
  {
    code: Schema.Literals(["forbidden", "not_found", "unavailable"]),
    message: Schema.String,
  },
) {}

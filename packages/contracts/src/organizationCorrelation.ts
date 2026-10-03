import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";
import { OrganizationTentativeFinding } from "./organizationIntake.ts";

export const OrganizationCorrelationInput = Schema.Struct({
  organizationId: OrganizationId,
  projectId: ProjectId,
  /** Exact, source-supplied key. No title/body similarity is inferred. */
  correlationKey: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
});
export type OrganizationCorrelationInput = typeof OrganizationCorrelationInput.Type;
export const OrganizationCorrelationResult = Schema.Struct({
  outcome: Schema.Literals(["created", "duplicate", "insufficient", "ambiguous"]),
  finding: Schema.NullOr(OrganizationTentativeFinding),
  evidenceCount: Schema.Int,
});
export type OrganizationCorrelationResult = typeof OrganizationCorrelationResult.Type;

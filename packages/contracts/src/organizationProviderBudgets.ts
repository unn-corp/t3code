import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";

export const OrganizationProviderBudgetReadInput = Schema.Struct({
  organizationId: OrganizationId,
  afterProjectId: Schema.NullOr(ProjectId),
});
export type OrganizationProviderBudgetReadInput = typeof OrganizationProviderBudgetReadInput.Type;

/** Configured ceilings only. These fields are not usage or provider spend. */
export const OrganizationProviderBudgetCeiling = Schema.Struct({
  maxConcurrent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(64)),
  maxDailyCalls: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(10_000),
  ),
  maxDailyEstimatedTokens: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1_000_000_000),
  ),
});
export type OrganizationProviderBudgetCeiling = typeof OrganizationProviderBudgetCeiling.Type;

export const OrganizationProviderBudgetReadResult = Schema.Struct({
  global: OrganizationProviderBudgetCeiling,
  organization: Schema.NullOr(OrganizationProviderBudgetCeiling),
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      ceiling: Schema.NullOr(OrganizationProviderBudgetCeiling),
    }),
  ).check(Schema.isMaxLength(100)),
  hasMoreProjects: Schema.Boolean,
  nextProjectCursor: Schema.NullOr(ProjectId),
});
export type OrganizationProviderBudgetReadResult = typeof OrganizationProviderBudgetReadResult.Type;

export class OrganizationProviderBudgetReadError extends Schema.TaggedError<OrganizationProviderBudgetReadError>()(
  "OrganizationProviderBudgetReadError",
  {
    code: Schema.Literals(["forbidden", "not_found", "unavailable"]),
    message: Schema.String,
  },
) {}

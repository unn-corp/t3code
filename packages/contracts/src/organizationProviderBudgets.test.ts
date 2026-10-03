import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  OrganizationProviderBudgetReadInput,
  OrganizationProviderBudgetReadResult,
} from "./organizationProviderBudgets.ts";

const decodeInput = Schema.decodeUnknownSync(OrganizationProviderBudgetReadInput);
const decodeResult = Schema.decodeUnknownSync(OrganizationProviderBudgetReadResult);

describe("provider budget read contract", () => {
  it("accepts exact zero ceilings and absent scoped configuration", () => {
    const result = decodeResult({
      global: { maxConcurrent: 0, maxDailyCalls: 0, maxDailyEstimatedTokens: 0 },
      organization: null,
      projects: [{ projectId: "project-a", ceiling: null }],
      hasMoreProjects: false,
      nextProjectCursor: null,
    });
    expect(result.global.maxConcurrent).toBe(0);
    expect(result.organization).toBeNull();
    expect(result.projects[0]?.ceiling).toBeNull();
  });

  it("requires an Organization ID and rejects budget values beyond configured bounds", () => {
    expect(() => decodeInput({})).toThrow();
    expect(
      decodeInput({ organizationId: "org-a", afterProjectId: "project-099" }).afterProjectId,
    ).toBe("project-099");
    expect(() =>
      decodeResult({
        global: { maxConcurrent: 65, maxDailyCalls: 0, maxDailyEstimatedTokens: 0 },
        organization: null,
        projects: [],
        hasMoreProjects: false,
        nextProjectCursor: null,
      }),
    ).toThrow();
    expect(() =>
      decodeResult({
        global: { maxConcurrent: 0, maxDailyCalls: 0, maxDailyEstimatedTokens: 0 },
        organization: null,
        projects: Array.from({ length: 101 }, (_, index) => ({
          projectId: `project-${index}`,
          ceiling: null,
        })),
        hasMoreProjects: true,
        nextProjectCursor: "project-099",
      }),
    ).toThrow();
  });
});

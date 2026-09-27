import type { OrganizationId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrganizationProviderBudgetConfigurationAuthority } from "./OrganizationProviderBudgetConfiguration.ts";

const PROJECT_PAGE_SIZE = 100;

type LinkedBudgetRow = {
  project_id: ProjectId;
  max_concurrent: number | null;
  max_daily_calls: number | null;
  max_daily_estimated_tokens: number | null;
};

/** Binding and ceiling are read in one SQLite statement, so a committed detach cannot race between them. */
export const readLinkedBudgetProjectPage = (
  organizationId: OrganizationId,
  afterProjectId: ProjectId | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<LinkedBudgetRow>`SELECT b.project_id,
        l.max_concurrent, l.max_daily_calls, l.max_daily_estimated_tokens
      FROM organization_project_bindings AS b
      LEFT JOIN organization_provider_budget_limits AS l
        ON l.scope_kind = 'project' AND l.scope_id = b.project_id
      WHERE b.organization_id = ${organizationId}
        AND b.detached_at IS NULL
        AND b.project_id > ${afterProjectId ?? ""}
      ORDER BY b.project_id COLLATE BINARY
      LIMIT ${PROJECT_PAGE_SIZE + 1}`;
    const page = rows.slice(0, PROJECT_PAGE_SIZE);
    const hasMoreProjects = rows.length > PROJECT_PAGE_SIZE;
    return {
      projects: page.map((row) => ({
        projectId: row.project_id,
        ceiling:
          row.max_concurrent === null ||
          row.max_daily_calls === null ||
          row.max_daily_estimated_tokens === null
            ? null
            : {
                maxConcurrent: row.max_concurrent,
                maxDailyCalls: row.max_daily_calls,
                maxDailyEstimatedTokens: row.max_daily_estimated_tokens,
              },
      })),
      hasMoreProjects,
      nextProjectCursor: hasMoreProjects ? (page.at(-1)?.project_id ?? null) : null,
    };
  });

/** Caller must obtain humanId from the authenticated server session. */
export const providerBudgetReadAuthority = (
  humanId: string,
  organizationId: string,
): OrganizationProviderBudgetConfigurationAuthority["Service"] => {
  return {
    authenticatedHumanId: humanId,
    permitsRead: (scope) =>
      scope.kind === "global" ||
      (scope.kind === "organization" && scope.organizationId === organizationId),
    permitsGlobalUpdate: () => false,
    permitsScopedUpdate: () => false,
  };
};

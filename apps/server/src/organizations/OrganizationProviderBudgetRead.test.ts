import { assert, it } from "@effect/vitest";
import type { OrganizationId, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  providerBudgetReadAuthority,
  readLinkedBudgetProjectPage,
} from "./OrganizationProviderBudgetRead.ts";

const organizationId = "org-a" as OrganizationId;
const project = (id: string) => id as ProjectId;

it("grants read authority to only the selected Organization and never grants updates", () => {
  const authority = providerBudgetReadAuthority("human-1", "org-a");
  assert.equal(authority.authenticatedHumanId, "human-1");
  assert.equal(authority.permitsRead({ kind: "global" }), true);
  assert.equal(authority.permitsRead({ kind: "organization", organizationId: "org-a" }), true);
  assert.equal(authority.permitsRead({ kind: "organization", organizationId: "org-b" }), false);
  assert.equal(authority.permitsRead({ kind: "project", projectId: "project-1" }), false);
  assert.equal(
    authority.permitsGlobalUpdate({
      scope: { kind: "global" },
      expectedRevision: null,
      limits: { maxConcurrent: 1, maxDailyCalls: 1, maxDailyEstimatedTokens: 1 },
    }),
    false,
  );
  assert.equal(
    authority.permitsScopedUpdate({
      scope: { kind: "organization", organizationId: "org-a" },
      expectedRevision: null,
      limits: { maxConcurrent: 1, maxDailyCalls: 1, maxDailyEstimatedTokens: 1 },
    }),
    false,
  );
});

it.effect(
  "pages beyond 100 linked Projects and rechecks detach against the same ceiling read",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE organization_project_bindings (
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, detached_at TEXT)`;
      yield* sql`CREATE TABLE organization_provider_budget_limits (
      scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
      max_concurrent INTEGER NOT NULL, max_daily_calls INTEGER NOT NULL,
      max_daily_estimated_tokens INTEGER NOT NULL)`;
      for (let index = 0; index < 101; index++) {
        const id = `project-${String(index).padStart(3, "0")}`;
        yield* sql`INSERT INTO organization_project_bindings VALUES ('org-a', ${id}, NULL)`;
      }
      yield* sql`INSERT INTO organization_project_bindings VALUES
      ('org-b', 'foreign-project', NULL),
      ('org-a', 'old-project', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO organization_provider_budget_limits VALUES
      ('project', 'project-000', 0, 0, 0),
      ('project', 'project-100', 3, 50, 5000),
      ('project', 'old-project', 9, 9, 9),
      ('project', 'foreign-project', 9, 9, 9)`;

      const first = yield* readLinkedBudgetProjectPage(organizationId, null);
      assert.equal(first.projects.length, 100);
      assert.equal(first.projects[0]?.projectId, "project-000");
      assert.equal(first.projects[0]?.ceiling?.maxConcurrent, 0);
      assert.equal(first.projects.at(-1)?.projectId, "project-099");
      assert.equal(first.hasMoreProjects, true);
      assert.equal(first.nextProjectCursor, "project-099");
      assert.equal(
        first.projects.some((item) => item.projectId === project("foreign-project")),
        false,
      );

      // A stale Organization snapshot may still name this Project. The next SQL read uses current bindings.
      const staleBinding = (yield* sql<{ project_id: string }>`SELECT project_id
      FROM organization_project_bindings WHERE project_id = 'project-100'
        AND detached_at IS NULL`)[0];
      assert.equal(staleBinding?.project_id, "project-100");
      yield* sql`UPDATE organization_project_bindings
      SET detached_at = '2026-09-27T00:00:00.000Z' WHERE project_id = 'project-100'`;
      const afterDetach = yield* readLinkedBudgetProjectPage(
        organizationId,
        first.nextProjectCursor,
      );
      assert.deepEqual(afterDetach.projects, []);
      assert.equal(afterDetach.nextProjectCursor, null);

      yield* sql`UPDATE organization_project_bindings
      SET detached_at = NULL WHERE project_id = 'project-100'`;
      // A detached cursor remains a safe lexical position.
      yield* sql`UPDATE organization_project_bindings
      SET detached_at = '2026-09-27T00:00:00.000Z' WHERE project_id = 'project-099'`;
      const second = yield* readLinkedBudgetProjectPage(organizationId, first.nextProjectCursor);
      assert.deepEqual(
        second.projects.map((item) => item.projectId),
        ["project-100"],
      );
      assert.equal(second.projects[0]?.ceiling?.maxConcurrent, 3);
      assert.equal(second.hasMoreProjects, false);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

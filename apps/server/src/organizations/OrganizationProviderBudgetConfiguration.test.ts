// @effect-diagnostics nodeBuiltinImport:off - Disposable SQLite files exercise independent concurrent writers.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import Migration081 from "../persistence/Migrations/081_OrganizationProviderBudgets.ts";
import Migration083 from "../persistence/Migrations/083_OrganizationProviderBudgetAudit.ts";
import {
  OrganizationProviderBudgetConfiguration,
  OrganizationProviderBudgetConfigurationAuthority,
  OrganizationProviderBudgetConfigurationLive,
  OrganizationProviderBudgetConfigurationWithAuthority,
} from "./OrganizationProviderBudgetConfiguration.ts";

const globalScope = { kind: "global" } as const;
const orgScope = { kind: "organization", organizationId: "org-a" } as const;
const projectScope = { kind: "project", projectId: "project-a" } as const;
const limits = { maxConcurrent: 2, maxDailyCalls: 10, maxDailyEstimatedTokens: 1000 };
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organizations (organization_id TEXT PRIMARY KEY)`;
  yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
  yield* sql`CREATE TABLE organization_project_bindings (
    organization_id TEXT NOT NULL, project_id TEXT NOT NULL, detached_at TEXT)`;
  yield* sql`INSERT INTO organizations VALUES ('org-a')`;
  yield* sql`INSERT INTO projection_projects VALUES ('project-a', NULL), ('deleted-project', '2026-01-01')`;
  yield* sql`INSERT INTO organization_project_bindings VALUES ('org-a', 'project-a', NULL)`;
  yield* Migration081;
  yield* Migration083;
});
const authorizedLayer = (
  sqlite = NodeSqliteClient.layerMemory(),
  humanId: string | null = "human-a",
  canManageGlobal = true,
  canManageScoped = true,
) =>
  OrganizationProviderBudgetConfigurationWithAuthority.pipe(
    Layer.provide(
      Layer.succeed(OrganizationProviderBudgetConfigurationAuthority, {
        authenticatedHumanId: humanId,
        projectOrganizationId: "org-a",
        permitsRead: () => true,
        permitsGlobalUpdate: () => canManageGlobal,
        permitsScopedUpdate: () => canManageScoped,
      }),
    ),
    Layer.provideMerge(sqlite),
  );
const use = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: ReturnType<typeof authorizedLayer>) =>
  effect.pipe(Effect.provide(layer));

it.effect("denies reads and updates by default, and rejects a missing human identity", () =>
  Effect.gen(function* () {
    yield* setup;
    const denied = yield* Effect.gen(function* () {
      const service = yield* OrganizationProviderBudgetConfiguration;
      const current = yield* service.get(globalScope).pipe(Effect.flip);
      const write = yield* service
        .update({
          scope: globalScope,
          expectedRevision: "1970-01-01T00:00:00.000Z",
          limits,
        })
        .pipe(Effect.flip);
      return { current, write };
    }).pipe(Effect.provide(OrganizationProviderBudgetConfigurationLive));
    assert.equal(denied.current.code, "forbidden");
    assert.equal(denied.write.code, "forbidden");
    const noHuman = yield* Effect.gen(function* () {
      const service = yield* OrganizationProviderBudgetConfiguration;
      return yield* service
        .update({
          scope: globalScope,
          expectedRevision: "1970-01-01T00:00:00.000Z",
          limits,
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(authorizedLayer(NodeSqliteClient.layerMemory(), null)));
    assert.equal(noHuman.code, "forbidden");
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql<{ max_concurrent: number }>`SELECT max_concurrent
      FROM organization_provider_budget_limits WHERE scope_kind = 'global'`)[0];
    assert.equal(row?.max_concurrent, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rechecks the Project binding inside the ceiling write transaction", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* OrganizationProviderBudgetConfiguration;
    const original = yield* service.update({ scope: projectScope, expectedRevision: null, limits });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_project_bindings
      SET detached_at = '2026-01-03T00:00:00.000Z'
      WHERE organization_id = 'org-a' AND project_id = 'project-a'`;
    const denied = yield* service
      .update({
        scope: projectScope,
        expectedRevision: original.revision,
        limits: { ...limits, maxConcurrent: 3 },
      })
      .pipe(Effect.flip);
    assert.equal(denied.code, "forbidden");
    assert.equal((yield* service.get(projectScope))?.maxConcurrent, 2);
  }).pipe(Effect.provide(authorizedLayer())),
);

it.effect("updates exact scopes, preserves zero, and rejects stale revisions", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* OrganizationProviderBudgetConfiguration;
    const initial = yield* service.get(globalScope);
    assert.equal(initial?.maxConcurrent, 0);
    const global = yield* service.update({
      scope: globalScope,
      expectedRevision: initial!.revision,
      limits,
    });
    assert.equal(global.maxConcurrent, 2);
    assert.notEqual(global.revision, initial?.revision);
    assert.equal(
      (yield* service
        .update({
          scope: globalScope,
          expectedRevision: initial!.revision,
          limits,
        })
        .pipe(Effect.flip)).code,
      "conflict",
    );
    const org = yield* service.update({ scope: orgScope, expectedRevision: null, limits });
    assert.equal(org.scope.kind, "organization");
    const zero = yield* service.update({
      scope: orgScope,
      expectedRevision: org.revision,
      limits: { maxConcurrent: 0, maxDailyCalls: 0, maxDailyEstimatedTokens: 0 },
    });
    assert.equal(zero.maxConcurrent, 0);
    assert.equal(zero.maxDailyCalls, 0);
    assert.equal(zero.maxDailyEstimatedTokens, 0);
    const project = yield* service.update({ scope: projectScope, expectedRevision: null, limits });
    assert.equal(project.scope.kind, "project");
    assert.equal((yield* service.get(globalScope))?.maxConcurrent, 2);
    assert.equal((yield* service.get(orgScope))?.maxConcurrent, 0);
    assert.equal((yield* service.get(projectScope))?.maxConcurrent, 2);
    const sql = yield* SqlClient.SqlClient;
    const audit = yield* sql<{
      scope_kind: string;
      scope_id: string;
      actor_id: string;
      previous_revision: string | null;
      applied_revision: string;
      previous_max_concurrent: number | null;
      previous_max_daily_calls: number | null;
      previous_max_daily_estimated_tokens: number | null;
      max_concurrent: number;
      max_daily_calls: number;
      max_daily_estimated_tokens: number;
    }>`SELECT * FROM organization_provider_budget_audit ORDER BY audit_id`;
    assert.equal(audit.length, 4);
    assert.deepEqual(
      audit.map((row) => [row.scope_kind, row.scope_id, row.actor_id]),
      [
        ["global", "*", "human-a"],
        ["organization", "org-a", "human-a"],
        ["organization", "org-a", "human-a"],
        ["project", "project-a", "human-a"],
      ],
    );
    assert.equal(audit[0]?.previous_revision, initial?.revision);
    assert.equal(audit[0]?.applied_revision, global.revision);
    assert.equal(audit[0]?.previous_max_concurrent, 0);
    assert.equal(audit[0]?.max_concurrent, 2);
    assert.equal(audit[2]?.previous_revision, org.revision);
    assert.equal(audit[2]?.previous_max_concurrent, 2);
    assert.equal(audit[2]?.previous_max_daily_calls, 10);
    assert.equal(audit[2]?.previous_max_daily_estimated_tokens, 1000);
    assert.equal(audit[2]?.max_concurrent, 0);
    assert.equal(audit[2]?.max_daily_calls, 0);
    assert.equal(audit[2]?.max_daily_estimated_tokens, 0);
    assert.equal(audit[3]?.previous_revision, null);
    assert.equal(
      (yield* service
        .update({
          scope: projectScope,
          expectedRevision: null,
          limits,
        })
        .pipe(Effect.flip)).code,
      "conflict",
    );
  }).pipe(Effect.provide(authorizedLayer())),
);

it.effect("requires host authority for global changes even with Organization authority", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* OrganizationProviderBudgetConfiguration;
    assert.equal(
      (yield* service
        .update({
          scope: globalScope,
          expectedRevision: "1970-01-01T00:00:00.000Z",
          limits,
        })
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    assert.equal(
      (yield* service.update({
        scope: orgScope,
        expectedRevision: null,
        limits,
      })).maxConcurrent,
      2,
    );
    assert.equal((yield* service.get(globalScope))?.maxConcurrent, 0);
  }).pipe(Effect.provide(authorizedLayer(NodeSqliteClient.layerMemory(), "human-a", false))),
);

it.effect("global administration alone does not grant Organization changes", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* OrganizationProviderBudgetConfiguration;
    assert.equal(
      (yield* service
        .update({
          scope: orgScope,
          expectedRevision: null,
          limits,
        })
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    assert.equal(
      (yield* service.update({
        scope: globalScope,
        expectedRevision: "1970-01-01T00:00:00.000Z",
        limits,
      })).maxConcurrent,
      2,
    );
  }).pipe(Effect.provide(authorizedLayer(NodeSqliteClient.layerMemory(), "human-a", true, false))),
);

it.effect("requires real scopes and validates bounds before any mutation", () =>
  Effect.gen(function* () {
    yield* setup;
    const service = yield* OrganizationProviderBudgetConfiguration;
    for (const scope of [
      { kind: "organization", organizationId: "missing" } as const,
      { kind: "project", projectId: "missing" } as const,
      { kind: "project", projectId: "deleted-project" } as const,
    ])
      assert.equal(
        (yield* service
          .update({
            scope,
            expectedRevision: null,
            limits,
          })
          .pipe(Effect.flip)).code,
        "not_found",
      );
    for (const bad of [
      { ...limits, maxConcurrent: -1 },
      { ...limits, maxConcurrent: 65 },
      { ...limits, maxDailyCalls: 10_001 },
      { ...limits, maxDailyEstimatedTokens: 1_000_000_001 },
      { ...limits, maxConcurrent: 1.5 },
      { ...limits, maxDailyCalls: Number.NaN },
    ])
      assert.equal(
        (yield* service
          .update({
            scope: orgScope,
            expectedRevision: null,
            limits: bad,
          })
          .pipe(Effect.flip)).code,
        "invalid",
      );
    assert.equal(
      (yield* service
        .update({
          scope: { kind: "global", organizationId: "org-a" } as typeof globalScope,
          expectedRevision: null,
          limits,
        })
        .pipe(Effect.flip)).code,
      "invalid",
    );
    assert.equal(yield* service.get(orgScope), null);
  }).pipe(Effect.provide(authorizedLayer())),
);

it.effect("allows only one of two independent writers using the same revision", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-budget-config-"));
    const filename = NodePath.join(directory, "state.sqlite");
    const sqlite = () => NodeSqliteClient.layer({ filename });
    try {
      yield* setup.pipe(Effect.provide(sqlite()));
      const update = (maxConcurrent: number) =>
        use(
          Effect.gen(function* () {
            const service = yield* OrganizationProviderBudgetConfiguration;
            return yield* service.update({
              scope: globalScope,
              expectedRevision: "1970-01-01T00:00:00.000Z",
              limits: { ...limits, maxConcurrent },
            });
          }),
          authorizedLayer(sqlite()),
        ).pipe(
          Effect.match({
            onFailure: (error) => ({
              ok: false as const,
              code: "code" in error ? error.code : "sql-error",
            }),
            onSuccess: () => ({ ok: true as const, code: null }),
          }),
        );
      const results = yield* Effect.all([update(3), update(4)], { concurrency: 2 });
      assert.equal(results.filter((result) => result.ok).length, 1);
      const denied = results.filter((result) => !result.ok);
      assert.equal(denied.length, 1);
      assert.equal(denied[0]?.code, "conflict");
      const read = yield* use(
        Effect.gen(function* () {
          const service = yield* OrganizationProviderBudgetConfiguration;
          return yield* service.get(globalScope);
        }),
        authorizedLayer(sqlite()),
      );
      assert.ok(read?.maxConcurrent === 3 || read?.maxConcurrent === 4);
      const auditCount = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{ total: number }>`SELECT count(*) AS total
          FROM organization_provider_budget_audit`)[0]?.total;
      }).pipe(Effect.provide(sqlite()));
      assert.equal(auditCount, 1);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);

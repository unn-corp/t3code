// @effect-diagnostics nodeBuiltinImport:off - Disposable SQLite files exercise independent concurrent claimers and restart.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import Migration081 from "../persistence/Migrations/081_OrganizationProviderBudgets.ts";
import {
  OrganizationProviderBudget,
  OrganizationProviderBudgetAuthority,
  OrganizationProviderBudgetLive,
  OrganizationProviderBudgetWithAuthority,
} from "./OrganizationProviderBudget.ts";

const input = (
  requestId: string,
  projectId = "project-a",
  organizationId = "org-a",
  estimatedTokens = 40,
) => ({
  requestId,
  organizationId,
  projectId,
  providerInstanceId: "claude",
  modelId: "fixture-model",
  estimatedTokens,
});
const budgetLayer = (sqlite = NodeSqliteClient.layerMemory(), permitted = true) =>
  OrganizationProviderBudgetWithAuthority.pipe(
    Layer.provide(
      Layer.succeed(OrganizationProviderBudgetAuthority, {
        permitsReserve: () => permitted,
        permitsTransition: () => permitted,
        permitsReconcile: () => permitted,
      }),
    ),
    Layer.provideMerge(sqlite),
  );
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organizations (organization_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)`;
  yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
  yield* sql`CREATE TABLE organization_project_bindings (
    binding_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL, detached_at TEXT)`;
  for (const org of ["org-a", "org-b"])
    yield* sql`INSERT INTO organizations VALUES (${org}, 'active')`;
  for (const [project, org] of [
    ["project-a", "org-a"],
    ["project-b", "org-a"],
    ["project-c", "org-b"],
  ]) {
    yield* sql`INSERT INTO projection_projects VALUES (${project}, NULL)`;
    yield* sql`INSERT INTO organization_project_bindings VALUES
      (${`binding-${project}`}, ${org}, ${project}, NULL)`;
  }
  yield* Migration081;
  const stamp = "2026-01-01T00:00:00.000Z";
  yield* sql`UPDATE organization_provider_budget_limits
    SET max_concurrent = 2, max_daily_calls = 4,
      max_daily_estimated_tokens = 500, updated_at = ${stamp}
    WHERE scope_kind = 'global' AND scope_id = '*'`;
  for (const org of ["org-a", "org-b"])
    yield* sql`INSERT INTO organization_provider_budget_limits VALUES
      ('organization', ${org}, 2, 4, 500, ${stamp})`;
  for (const project of ["project-a", "project-b", "project-c"])
    yield* sql`INSERT INTO organization_provider_budget_limits VALUES
      ('project', ${project}, 1, 4, 500, ${stamp})`;
});

it.effect("denies allocation by default even when capacity rows exist", () =>
  Effect.gen(function* () {
    yield* seed;
    const denied = yield* Effect.gen(function* () {
      const store = yield* OrganizationProviderBudget;
      return yield* store.reserve(input("default-denied"));
    }).pipe(Effect.provide(OrganizationProviderBudgetLive), Effect.flip);
    assert.equal(denied.code, "forbidden");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("reserves all three scopes atomically and replays request IDs exactly", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* OrganizationProviderBudget;
    const a = yield* store.reserve(input("scope-a"));
    assert.equal(a.state, "reserved");
    assert.deepEqual(yield* store.reserve(input("scope-a")), a);
    assert.equal(
      (yield* store.reserve(input("scope-a", "project-a", "org-a", 41)).pipe(Effect.flip)).code,
      "conflict",
    );
    assert.equal((yield* store.reserve(input("scope-a2")).pipe(Effect.flip)).code, "exhausted");
    const b = yield* store.reserve(input("scope-b", "project-b"));
    assert.equal(b.state, "reserved");
    assert.equal(
      (yield* store.reserve(input("scope-c", "project-c", "org-b")).pipe(Effect.flip)).code,
      "exhausted",
    );
    yield* store.release("scope-a");
    const c = yield* store.reserve(input("scope-a2"));
    assert.equal(c.state, "reserved");
    const dayUtc = c.dayUtc;
    const global = yield* store.getTotals({ scopeKind: "global", scopeId: "*", dayUtc });
    assert.equal(global.activeRequests, 2);
    assert.equal(global.dailyAllocatedCalls, 2);
    assert.equal(global.allocatedEstimatedTokens, 80);
    const project = yield* store.getTotals({ scopeKind: "project", scopeId: "project-b", dayUtc });
    assert.equal(project.activeRequests, 1);
  }).pipe(Effect.provide(budgetLayer())),
);

it.effect("retains unknown use across lease expiry and requires explicit reconciliation", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationProviderBudget;
    const reserved = yield* store.reserve(input("lease-a"));
    yield* sql`UPDATE organization_provider_budget_admissions
      SET lease_until = '2000-01-01T00:00:00.000Z' WHERE request_id = 'lease-a'`;
    const uncertain = yield* store.markUncertain("lease-a");
    assert.equal(uncertain.state, "uncertain");
    assert.equal((yield* store.markDispatched("lease-a").pipe(Effect.flip)).code, "conflict");
    assert.equal((yield* store.reserve(input("lease-b")).pipe(Effect.flip)).code, "exhausted");
    const totals = yield* store.getTotals({
      scopeKind: "project",
      scopeId: "project-a",
      dayUtc: reserved.dayUtc,
    });
    assert.equal(totals.activeRequests, 1);
    assert.equal(totals.unknownUsageCalls, 1);
    const released = yield* store.reconcile({
      requestId: "lease-a",
      disposition: "not-dispatched",
    });
    assert.equal(released.state, "released");
    assert.equal((yield* store.reserve(input("lease-b"))).state, "reserved");
  }).pipe(Effect.provide(budgetLayer())),
);

it.effect("never authorizes a second dispatch and checks proposed reconciliation usage", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* OrganizationProviderBudget;
    yield* store.reserve(input("single-dispatch"));
    assert.equal((yield* store.markDispatched("single-dispatch")).state, "dispatched");
    assert.equal(
      (yield* store.markDispatched("single-dispatch").pipe(Effect.flip)).code,
      "conflict",
    );
    assert.equal(
      (yield* store
        .reconcile({
          requestId: "single-dispatch",
          disposition: "completed",
          measuredUsage: { inputTokens: 5, outputTokens: 11 },
        })
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    assert.equal((yield* store.get("single-dispatch"))?.state, "dispatched");
    assert.equal(
      (yield* store.reconcile({
        requestId: "single-dispatch",
        disposition: "completed",
        measuredUsage: { inputTokens: 5, outputTokens: 10 },
      })).state,
      "reconciled",
    );
  }).pipe(
    Effect.provide(
      OrganizationProviderBudgetWithAuthority.pipe(
        Layer.provide(
          Layer.succeed(OrganizationProviderBudgetAuthority, {
            permitsReserve: () => true,
            permitsTransition: () => true,
            permitsReconcile: (request) =>
              request.measuredUsage === undefined || request.measuredUsage.outputTokens <= 10,
          }),
        ),
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
      ),
    ),
  ),
);

it.effect(
  "records supplied measured overrun without pricing and halts further daily admission",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* OrganizationProviderBudget;
      const reserved = yield* store.reserve(input("overrun-a", "project-a", "org-a", 40));
      yield* store.markDispatched("overrun-a");
      assert.equal((yield* store.markDispatched("overrun-a").pipe(Effect.flip)).code, "conflict");
      const done = yield* store.reconcile({
        requestId: "overrun-a",
        disposition: "completed",
        measuredUsage: { inputTokens: 50, outputTokens: 60 },
      });
      assert.equal(done.measuredUsage?.inputTokens, 50);
      assert.equal(done.measuredUsage?.outputTokens, 60);
      assert.equal(done.usageOverrun, true);
      assert.equal("estimatedCost" in done, false);
      const totals = yield* store.getTotals({
        scopeKind: "global",
        scopeId: "*",
        dayUtc: reserved.dayUtc,
      });
      assert.equal(totals.activeRequests, 0);
      assert.equal(totals.allocatedEstimatedTokens, 40);
      assert.equal(totals.measuredInputTokens, 50);
      assert.equal(totals.measuredOutputTokens, 60);
      assert.equal(totals.usageOverrunCalls, 1);
      assert.equal(
        (yield* store.reserve(input("overrun-b", "project-b")).pipe(Effect.flip)).code,
        "exhausted",
      );
      assert.deepEqual(
        yield* store.reconcile({
          requestId: "overrun-a",
          disposition: "completed",
          measuredUsage: { inputTokens: 50, outputTokens: 60 },
        }),
        done,
      );
    }).pipe(Effect.provide(budgetLayer())),
);

it.effect("two independent SQLite claimers cannot exceed a one-slot global limit", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-provider-budget-test-"));
    const filename = NodePath.join(directory, "state.sqlite");
    const sqlite = () => NodeSqliteClient.layer({ filename });
    try {
      yield* seed.pipe(Effect.provide(sqlite()));
      const setup = sqlLimit(1);
      yield* setup.pipe(Effect.provide(sqlite()));
      const claim = (id: string) =>
        Effect.gen(function* () {
          const store = yield* OrganizationProviderBudget;
          return yield* store.reserve(input(id, id === "parallel-a" ? "project-a" : "project-b"));
        }).pipe(Effect.provide(budgetLayer(sqlite())), Effect.exit);
      const results = yield* Effect.all([claim("parallel-a"), claim("parallel-b")], {
        concurrency: 2,
      });
      assert.equal(results.filter(Exit.isSuccess).length, 1);
      const count = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{ total: number }>`SELECT count(*) AS total
          FROM organization_provider_budget_admissions WHERE state = 'reserved'`)[0]?.total;
      }).pipe(Effect.provide(sqlite()));
      assert.equal(count, 1);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);

const sqlLimit = (limit: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_provider_budget_limits SET max_concurrent = ${limit}
    WHERE scope_kind = 'global' AND scope_id = '*'`;
  });

it.effect("restart preserves the uncertain reservation and its capacity", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp("/tmp/t3-provider-restart-test-"),
    );
    const filename = NodePath.join(directory, "state.sqlite");
    const sqlite = () => NodeSqliteClient.layer({ filename });
    try {
      yield* seed.pipe(Effect.provide(sqlite()));
      yield* Effect.gen(function* () {
        const store = yield* OrganizationProviderBudget;
        yield* store.reserve(input("restart-a"));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE organization_provider_budget_admissions
          SET lease_until = '2000-01-01T00:00:00.000Z' WHERE request_id = 'restart-a'`;
        yield* store.markUncertain("restart-a");
      }).pipe(Effect.provide(budgetLayer(sqlite())));
      yield* Effect.gen(function* () {
        const store = yield* OrganizationProviderBudget;
        assert.equal((yield* store.get("restart-a"))?.state, "uncertain");
        assert.equal(
          (yield* store.reserve(input("restart-b")).pipe(Effect.flip)).code,
          "exhausted",
        );
        yield* store.reconcile({ requestId: "restart-a", disposition: "not-dispatched" });
        assert.equal((yield* store.reserve(input("restart-b"))).state, "reserved");
      }).pipe(Effect.provide(budgetLayer(sqlite())));
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);

// @effect-diagnostics nodeBuiltinImport:off - Tests use disposable SQLite files only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import Migration081 from "../persistence/Migrations/081_OrganizationProviderBudgets.ts";
import Migration083 from "../persistence/Migrations/083_OrganizationProviderBudgetAudit.ts";
import {
  organizationBudgetCommand,
  readGlobalOrganizationBudget,
  updateGlobalOrganizationBudget,
} from "./organizationBudget.ts";

const makeFixture = () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-organization-budget-cli-"));
  const stateDir = NodePath.join(baseDir, "userdata");
  NodeFS.mkdirSync(stateDir);
  const dbPath = NodePath.join(stateDir, "state.sqlite");
  return {
    baseDir,
    dbPath,
    remove: () => NodeFS.rmSync(baseDir, { recursive: true, force: true }),
  };
};

const initialize = (dbPath: string) =>
  Effect.gen(function* () {
    yield* Migration081;
    yield* Migration083;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(organizationBudgetCommand, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)),
  );

it.effect("requires an explicit absolute base directory with existing state", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    const missing = yield* readGlobalOrganizationBudget(fixture.baseDir).pipe(Effect.flip);
    assert.equal(missing._tag, "OrganizationBudgetStateError");
    assert.match(missing.message, /No initialized Arcwright Code database/);

    const relative = yield* readGlobalOrganizationBudget("relative-directory").pipe(Effect.flip);
    assert.equal(relative._tag, "OrganizationBudgetStateError");
    assert.match(relative.message, /absolute path/);
    assert.isFalse(NodeFS.existsSync(fixture.dbPath));
  }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(fixture.remove)));
});

it.effect("shows and updates only the global ceiling with a revision and audit row", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    yield* initialize(fixture.dbPath);
    const initial = yield* readGlobalOrganizationBudget(fixture.baseDir);
    assert.equal(initial.maxConcurrent, 0);

    const updated = yield* updateGlobalOrganizationBudget({
      baseDir: fixture.baseDir,
      expectedRevision: initial.revision,
      limits: { maxConcurrent: 2, maxDailyCalls: 20, maxDailyEstimatedTokens: 10000 },
    });
    assert.equal(updated.maxConcurrent, 2);
    assert.notEqual(updated.revision, initial.revision);

    const stale = yield* updateGlobalOrganizationBudget({
      baseDir: fixture.baseDir,
      expectedRevision: initial.revision,
      limits: { maxConcurrent: 3, maxDailyCalls: 30, maxDailyEstimatedTokens: 20000 },
    }).pipe(Effect.flip);
    assert.equal(stale._tag, "OrganizationProviderBudgetConfigurationError");
    if (stale._tag === "OrganizationProviderBudgetConfigurationError") {
      assert.equal(stale.code, "conflict");
    }

    const evidence = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ scope_kind: string; actor_id: string; max_concurrent: number }>`
        SELECT scope_kind, actor_id, max_concurrent FROM organization_provider_budget_audit`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: fixture.dbPath, readonly: true })));
    assert.lengthOf(evidence, 1);
    assert.equal(evidence[0]?.scope_kind, "global");
    assert.equal(evidence[0]?.actor_id, `host-admin-cli:${NodeOS.userInfo().username}`);
    assert.equal(evidence[0]?.max_concurrent, 2);
  }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(Effect.sync(fixture.remove)));
});

it.effect("CLI show supplies a revision and set applies explicit limits", () => {
  const fixture = makeFixture();
  return Effect.gen(function* () {
    yield* initialize(fixture.dbPath);
    yield* runCli(["show", "--base-dir", fixture.baseDir]);
    const lines = yield* TestConsole.logLines;
    const output = lines.findLast((line): line is string => typeof line === "string");
    assert.equal(
      output,
      '{"maxConcurrent":0,"maxDailyCalls":0,"maxDailyEstimatedTokens":0,"revision":"1970-01-01T00:00:00.000Z"}',
    );
    yield* runCli([
      "set",
      "--base-dir",
      fixture.baseDir,
      "--expected-revision",
      "1970-01-01T00:00:00.000Z",
      "--max-concurrent",
      "2",
      "--max-daily-calls",
      "20",
      "--max-daily-estimated-tokens",
      "10000",
    ]);
    const updated = yield* readGlobalOrganizationBudget(fixture.baseDir);
    assert.equal(updated.maxConcurrent, 2);
    assert.equal(updated.maxDailyCalls, 20);
    assert.equal(updated.maxDailyEstimatedTokens, 10000);
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)),
    Effect.ensuring(Effect.sync(fixture.remove)),
  );
});

import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";

// The V2 schema is unchanged from the published September 15–16 previews.
const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

describe("V2 preview upgrade", () => {
  it.effect("keeps a valid installed fork ledger and timestamps unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-02 00:00:00' WHERE migration_id = 95`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id = 95`,
        [{ migration_id: 95, name: "OrchestrationV2", created_at: "2026-10-02 00:00:00" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects unknown non-preview history without changing ledger or schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-03 00:00:00' WHERE migration_id = 53`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownForkMigration')`;
      const history =
        yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
      const columns = yield* sql`PRAGMA table_info(projection_threads)`;

      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(yield* sql`PRAGMA table_info(projection_threads)`, columns);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => (id >= 53 && id <= 94) || id >= 96),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 95`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("remaps pinned upstream history and applies every fork-only migration once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      const migrationByName = new Map(
        migrationEntries.map(([, name, migration]) => [name, migration]),
      );
      const upstreamHistory = [
        [36, "ProjectionThreadsPinned"],
        [37, "ProjectionTurnsKeysetIndex"],
        [38, "ProjectionThreadsPinOrderKey"],
        [39, "ProjectionProjectsDefaultThreadEnvMode"],
        [40, "ProjectionProjectFaviconPath"],
        [41, "AuthSessionClientConnection"],
        [42, "ProjectionThreadLinkedPullRequest"],
        [43, "ProjectionThreadsUnsettledAt"],
        [44, "ClearAutomaticProjectModelDefaults"],
        [45, "ProjectionProjectsAutoPull"],
        [46, "RepairAutomaticSettlementTimestamps"],
        [47, "ProjectionProjectIcon"],
        [48, "ProjectionThreadBranchPullRequest"],
        [49, "ProjectionThreadsActiveOrderKey"],
        [50, "ProjectionThreadPullRequests"],
        [51, "ProjectionThreadMessageContext"],
        [52, "ProjectionThreadTitleState"],
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
      ] as const;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            upstreamHistory.map(([id, name]) => [`${id}_${name}`, migrationByName.get(name)!]),
          ),
        ),
      });
      yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-01 00:00:00' WHERE migration_id = 55`;

      const executed = yield* runMigrations();
      const alreadyApplied = new Set([
        38, 40, 41, 42, 43, 44, 45, 46, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 94,
      ]);
      assert.deepStrictEqual(
        executed,
        migrationManifest.filter(([id]) => id >= 36 && id <= 94 && !alreadyApplied.has(id)),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 95`,
        [{ created_at: "2026-10-01 00:00:00" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'`,
        [{ name: "scheduled_tasks" }],
      );
      assert.ok(
        (yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`).some(
          (column) => column.name === "active_order_key",
        ),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([36, 52, 54])(
    "upgrades a pre-V2 upstream ledger ending at %s without replaying applied columns",
    (latestId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 35 });
        const names = [
          "ProjectionThreadsPinned",
          "ProjectionTurnsKeysetIndex",
          "ProjectionThreadsPinOrderKey",
          "ProjectionProjectsDefaultThreadEnvMode",
          "ProjectionProjectFaviconPath",
          "AuthSessionClientConnection",
          "ProjectionThreadLinkedPullRequest",
          "ProjectionThreadsUnsettledAt",
          "ClearAutomaticProjectModelDefaults",
          "ProjectionProjectsAutoPull",
          "RepairAutomaticSettlementTimestamps",
          "ProjectionProjectIcon",
          "ProjectionThreadBranchPullRequest",
          "ProjectionThreadsActiveOrderKey",
          "ProjectionThreadPullRequests",
          "ProjectionThreadMessageContext",
          "ProjectionThreadTitleState",
          "PullRequestFilesViewed",
          "ProjectionThreadsAutoSettleDisabledAt",
        ] as const;
        const byName = new Map(migrationEntries.map(([, name, migration]) => [name, migration]));
        yield* Migrator.make({})({
          loader: Migrator.fromRecord(
            Object.fromEntries(
              names
                .slice(0, latestId - 35)
                .map((name, index) => [`${index + 36}_${name}`, byName.get(name)!]),
            ),
          ),
        });
        yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-09-18 00:00:00' WHERE migration_id = 36`;
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('upstream-project', 'Existing repository', '/workspace/existing', '[]', '2026-09-18', '2026-09-18')`;
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(
          (yield* sql<{ readonly migration_id: number; readonly name: string }>`
            SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
          `).map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 38`,
          [{ created_at: "2026-09-18 00:00:00" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT title FROM projection_projects WHERE project_id = 'upstream-project'`,
          [{ title: "Existing repository" }],
        );
        assert.strictEqual(
          (yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'`)
            .length,
          1,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects an unknown pre-V2 upstream suffix without changing its ledger or schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({
          "36_ProjectionThreadsPinned": migrationEntries.find(
            ([, name]) => name === "ProjectionThreadsPinned",
          )![2],
        }),
      });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (37, 'UnknownUpstreamMigration')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const columns = yield* sql`PRAGMA table_info(projection_threads)`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(yield* sql`PRAGMA table_info(projection_threads)`, columns);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.migration_id = 53 AND NEW.name = 'ProjectionThreadsActiveOrderKey'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.ok(
        !(yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`).some(
          (column) => column.name === "active_order_key",
        ),
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => (id >= 53 && id <= 94) || id >= 96),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

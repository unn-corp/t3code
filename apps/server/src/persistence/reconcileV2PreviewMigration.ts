import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Schema from "effect/Schema";

type MigrationRow = {
  readonly migration_id: number;
  readonly name: string;
};

// Upstream 1.4.x and the fork assigned different meanings to migration ids
// after 35. Move upstream ledger entries by migration identity before running
// the fork's retained 1–96 sequence. The schema changes themselves are already
// present, so this prevents both rerunning V2 and skipping fork migrations.
const upstreamMigrationTargets = new Map<string, number>([
  ["ProjectionThreadsPinned", 38],
  ["ProjectionTurnsKeysetIndex", 40],
  ["ProjectionThreadsPinOrderKey", 41],
  ["ProjectionProjectsDefaultThreadEnvMode", 42],
  ["ProjectionProjectFaviconPath", 43],
  ["AuthSessionClientConnection", 44],
  ["ProjectionThreadLinkedPullRequest", 45],
  ["ProjectionThreadsUnsettledAt", 46],
  ["ClearAutomaticProjectModelDefaults", 48],
  ["ProjectionProjectsAutoPull", 49],
  ["RepairAutomaticSettlementTimestamps", 50],
  ["ProjectionProjectIcon", 51],
  ["ProjectionThreadBranchPullRequest", 52],
  ["ProjectionThreadsActiveOrderKey", 53],
  ["ProjectionThreadPullRequests", 54],
  ["ProjectionThreadMessageContext", 55],
  ["ProjectionThreadTitleState", 56],
  ["PullRequestFilesViewed", 57],
  ["ProjectionThreadsAutoSettleDisabledAt", 94],
  ["OrchestrationV2", 95],
  ["RemoveRedundantProjectionIndexes", 96],
  ["ScheduledTaskWebhooks", 97],
  ["WebhookRelayDeliveries", 98],
]);

const previewMigrationTargets = new Map<string, number>([
  ["PullRequestFilesViewed", 57],
  ["ProjectionThreadsAutoSettleDisabledAt", 94],
  ["OrchestrationV2", 95],
  ["RemoveRedundantProjectionIndexes", 96],
]);

export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* (
  migrations: ReadonlyArray<
    readonly [
      number,
      string,
      Effect.Effect<void, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient>,
    ]
  >,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
      if (tables.length === 0) return [];
      const history = yield* sql<MigrationRow>`
          SELECT migration_id, name FROM effect_sql_migrations
        `;
      const currentNames = new Map(migrations.map(([id, name]) => [id, name]));

      // Current upstream releases have V2 at 55 and its follow-up migrations
      // at 56–58. Validate every post-35 entry before moving anything.
      if (history.some((row) => row.migration_id === 55 && row.name === "OrchestrationV2")) {
        const baseMismatch = history.find(
          (row) => row.migration_id < 36 && currentNames.get(row.migration_id) !== row.name,
        );
        if (baseMismatch) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot upgrade upstream history with mismatched base migration ${baseMismatch.migration_id}_${baseMismatch.name}.`,
          });
        }
        const upstreamRows = history.filter((row) => row.migration_id >= 36);
        const valid = upstreamRows.every((row) => {
          if (row.migration_id <= 58) {
            const expectedName = upstreamMigrationNames.get(row.migration_id);
            return expectedName === row.name;
          }
          return false;
        });
        if (!valid) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade upstream migration history with unexpected later migrations.",
          });
        }
        return yield* migrateForkGap(sql, upstreamRows, upstreamRows, migrations);
      }

      // Older fork previews published V2 at 53 or 54 before the fork's
      // migration sequence was extended. Translate those known identities,
      // then let the regular loader apply every missing fork migration.
      const previewRows = history.filter((row) => row.migration_id >= 53);
      const legacy = previewRows.find(
        (row) =>
          row.name === "OrchestrationV2" && (row.migration_id === 53 || row.migration_id === 54),
      );
      if (!legacy) {
        const mismatch = history.find((row) => currentNames.get(row.migration_id) !== row.name);
        if (mismatch) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot upgrade unrecognized migration history ${mismatch.migration_id}_${mismatch.name}.`,
          });
        }
        return [];
      }
      const baseMismatch = history.find(
        (row) => row.migration_id < 53 && currentNames.get(row.migration_id) !== row.name,
      );
      if (baseMismatch) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Cannot upgrade V2 preview with mismatched base migration ${baseMismatch.migration_id}_${baseMismatch.name}.`,
        });
      }
      const valid = previewRows.every((row) => {
        if (row === legacy) return true;
        if (legacy.migration_id === 53) return false;
        if (row.migration_id === 53) return row.name === "PullRequestFilesViewed";
        if (row.migration_id === 55) return row.name === "RemoveRedundantProjectionIndexes";
        return false;
      });
      if (!valid) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      return yield* migrateForkGap(sql, previewRows, history, migrations);
    }),
  );
});

const migrateForkGap = (
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<MigrationRow>,
  alreadyAppliedRows: ReadonlyArray<MigrationRow>,
  migrations: ReadonlyArray<
    readonly [
      number,
      string,
      Effect.Effect<void, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient>,
    ]
  >,
) =>
  Effect.gen(function* () {
    // Hold all legacy rows outside the active id range while applying fork-only
    // migrations. Effect's Migrator intentionally skips every id at or below
    // the latest ledger row, so these missing fork migrations must run directly
    // before restoring identity-matched rows.
    for (const row of rows) {
      yield* sql`UPDATE effect_sql_migrations SET migration_id = ${1000 + row.migration_id} WHERE migration_id = ${row.migration_id}`;
    }

    const executed: Array<readonly [number, string]> = [];
    for (const [id, name, migration] of migrations) {
      if (id < 36 || id > 94) continue;
      const existing = alreadyAppliedRows.find((row) => {
        const target =
          upstreamMigrationTargets.get(row.name) ?? previewMigrationTargets.get(row.name);
        return (target === id || row.migration_id === id) && row.name === name;
      });
      if (existing) {
        if (rows.some((row) => row.migration_id === existing.migration_id)) {
          yield* sql`UPDATE effect_sql_migrations SET migration_id = ${id} WHERE migration_id = ${1000 + existing.migration_id}`;
        }
        continue;
      }
      yield* migration.pipe(
        Effect.catchCause((cause) =>
          Effect.die(
            new Migrator.MigrationError({
              cause,
              kind: "Failed",
              message: `Migration "${id}_${name}" failed during upstream history reconciliation.`,
            }),
          ),
        ),
      );
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      executed.push([id, name]);
    }

    for (const row of rows) {
      const target =
        upstreamMigrationTargets.get(row.name) ?? previewMigrationTargets.get(row.name);
      if (target === undefined) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Cannot reconcile unknown V2 migration ${row.migration_id}_${row.name}.`,
        });
      }
      const stagedId = 1000 + row.migration_id;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = ${target} WHERE migration_id = ${stagedId}`;
    }
    return executed;
  });

const upstreamMigrationNames = new Map<number, string>([
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
]);

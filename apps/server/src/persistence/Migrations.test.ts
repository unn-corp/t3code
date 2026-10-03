import legacy55 from "./Migrations/055_TeamSpaces.ts";
import legacy56 from "./Migrations/056_ThreadCollaboration.ts";
import legacy57 from "./Migrations/057_TeamPublication.ts";
import legacy58 from "./Migrations/058_TeamPublicationMessageOrder.ts";
import legacy59 from "./Migrations/059_TeamFiles.ts";
import legacy60 from "./Migrations/060_TeamPublicationIntents.ts";
import legacy61 from "./Migrations/061_TeamCreationIntentReceipts.ts";
import legacy62 from "./Migrations/062_RepairForkMigrationCollisions.ts";
import legacy63 from "./Migrations/063_TeamRoster.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import activeOrderKey from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import threadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";

const legacyTeamMigrations = [
  [55, "TeamSpaces", legacy55],
  [56, "ThreadCollaboration", legacy56],
  [57, "TeamPublication", legacy57],
  [58, "TeamPublicationMessageOrder", legacy58],
  [59, "TeamFiles", legacy59],
  [60, "TeamPublicationIntents", legacy60],
  [61, "TeamCreationIntentReceipts", legacy61],
  [62, "RepairForkMigrationCollisions", legacy62],
  [63, "TeamRoster", legacy63],
] as const;

const seedLegacyTeams = Effect.fn("seedLegacyTeams")(function* (throughId = 63) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  for (const [id, name, migration] of legacyTeamMigrations) {
    if (id > throughId) break;
    yield* migration;
    yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES(${id},${name})`;
  }
});

const previousDesktopHistory = [
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
] as const;

const seedPreviousDesktop = Effect.fn("seedPreviousDesktop")(function* (throughId: 52 | 61) {
  const sql = yield* SqlClient.SqlClient;
  if (throughId === 61) yield* seedLegacyTeams(61);
  else yield* runMigrations({ toMigrationInclusive: throughId });
  yield* activeOrderKey;
  yield* threadPullRequests;
  for (const [id, name] of previousDesktopHistory) {
    yield* sql`UPDATE effect_sql_migrations SET name=${name} WHERE migration_id=${id}`;
  }
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id>${throughId}`;
  yield* sql`ALTER TABLE projection_projects DROP COLUMN github_account_id`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN context_json TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES('old-project','Existing project','/existing','[]','2026-09-26','2026-09-26')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at,runtime_mode,interaction_mode,title_state_json)
    VALUES('old-thread','old-project','Existing thread','2026-09-26','2026-09-26','full-access','default','{"manual":true}')`;
  yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at,context_json)
    VALUES('old-message','old-thread','user','Keep this message',0,'2026-09-26','2026-09-26','{"references":[]}')`;
});

for (const throughId of [52, 61] as const) {
  it.effect(
    `repairs the previous desktop history through ${throughId} without changing its ledger or content`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedPreviousDesktop(throughId);
        yield* sql`DROP INDEX idx_projection_turns_thread_keyset`;
        const oldLedger =
          yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;

        const applied = yield* runMigrations();
        assert.ok(applied.some(([id]) => id === 102));
        assert.deepEqual(
          yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id<=${throughId} ORDER BY migration_id`,
          oldLedger,
        );
        assert.deepEqual(
          yield* sql`SELECT title,github_account_id FROM projection_projects WHERE project_id='old-project'`,
          [{ title: "Existing project", github_account_id: null }],
        );
        assert.deepEqual(
          yield* sql`SELECT title,title_state_json FROM projection_threads WHERE thread_id='old-thread'`,
          [{ title: "Existing thread", title_state_json: '{"manual":true}' }],
        );
        assert.deepEqual(
          yield* sql`SELECT text,context_json FROM projection_thread_messages WHERE message_id='old-message'`,
          [{ text: "Keep this message", context_json: '{"references":[]}' }],
        );
        assert.equal(
          (yield* sql`SELECT name FROM sqlite_master WHERE name='idx_projection_turns_thread_keyset'`)
            .length,
          1,
        );
        assert.deepEqual(yield* runMigrations(), []);
        assert.deepEqual(yield* sql`PRAGMA quick_check`, [{ quick_check: "ok" }]);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect("preserves a GitHub account reference after the manual column repair", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedPreviousDesktop(61);
    yield* sql`ALTER TABLE projection_projects ADD COLUMN github_account_id TEXT`;
    yield* sql`UPDATE projection_projects SET github_account_id='existing-account'`;
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT github_account_id FROM projection_projects`, [
      { github_account_id: "existing-account" },
    ]);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("repairs the exact previous AppImage history at IDs 36 and 37", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedPreviousDesktop(61);
    yield* sql`UPDATE effect_sql_migrations SET name='ProjectionThreadsPinned' WHERE migration_id=36`;
    yield* sql`UPDATE effect_sql_migrations SET name='ProjectionTurnsKeysetIndex' WHERE migration_id=37`;
    yield* sql`DROP TABLE discord_bridge_messages`;
    yield* sql`DROP TABLE discord_bridge_threads`;
    yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,checkpoint_files_json)
      VALUES('old-thread','last-real-turn','completed','2026-09-26','[]')`;
    yield* runMigrations();
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE name IN ('discord_bridge_threads','discord_bridge_messages')`)
        .length,
      2,
    );
    assert.deepEqual(
      yield* sql`SELECT latest_turn_id FROM projection_threads WHERE thread_id='old-thread'`,
      [{ latest_turn_id: "last-real-turn" }],
    );
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("repairs missing pinning and retired review modes at the appended ID", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedPreviousDesktop(61);
    yield* sql`ALTER TABLE projection_threads DROP COLUMN pinned_at`;
    yield* sql`UPDATE projection_threads SET runtime_mode='automated-review',pending_approval_count=1 WHERE thread_id='old-thread'`;
    yield* sql`INSERT INTO projection_pending_approvals(request_id,thread_id,status,created_at)
      VALUES('old-request','old-thread','pending','2026-09-26')`;
    yield* runMigrations();
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.ok(columns.some(({ name }) => name === "pinned_at"));
    assert.deepEqual(
      yield* sql`SELECT runtime_mode,pending_approval_count FROM projection_threads WHERE thread_id='old-thread'`,
      [{ runtime_mode: "full-access", pending_approval_count: 0 }],
    );
    assert.deepEqual(yield* sql`SELECT request_id FROM projection_pending_approvals`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects an unknown reused migration ID before applying pending migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 37 });
    yield* sql`UPDATE effect_sql_migrations SET name='UnexpectedMigration' WHERE migration_id=37`;
    const result = yield* Effect.result(runMigrations());
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(
        String(result.failure),
        /37.*UnexpectedMigration.*BackfillProjectionThreadsLatestTurn/,
      );
    }
    assert.equal(
      (yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id>37`).length,
      0,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects a database from a newer build before skipping its migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const nextId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
    yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES(${nextId},'FutureMigration')`;
    const result = yield* Effect.result(runMigrations());
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.match(String(result.failure), /newer build/);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "rejects a hole below the latest recorded migration before applying pending migrations",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id=36`;
      const result = yield* Effect.result(runMigrations());
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.match(String(result.failure), /missing migration 36_DiscordBridge/);
      assert.equal(
        (yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id>37`).length,
        0,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("upgrades a fresh database and repeats without additional migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* runMigrations(), migrationManifest);
    assert.deepEqual(yield* runMigrations(), []);
    assert.deepEqual(yield* sql`PRAGMA quick_check`, [{ quick_check: "ok" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("upgrades the shipped Teams ledger without losing memberships", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyTeams();
    yield* sql`INSERT INTO team_spaces(id,name) VALUES('shared','Shared')`;
    yield* sql`INSERT INTO team_members(space_id,user_id,role) VALUES('shared','owner','owner')`;
    const before =
      yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
    yield* runMigrations();
    assert.deepEqual(
      yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id <= 63 ORDER BY migration_id`,
      before,
    );
    assert.deepEqual(yield* sql`SELECT user_id,role FROM team_members`, [
      { user_id: "owner", role: "owner" },
    ]);
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE name = 'organizations'`).length,
      1,
    );
    assert.deepEqual(yield* runMigrations(), []);
    assert.deepEqual(yield* sql`PRAGMA quick_check`, [{ quick_check: "ok" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
it.effect("upgrades UNN through 94 by appending Teams migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 94 });
    const before =
      yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
    const applied = yield* runMigrations();
    assert.deepEqual(
      applied.map(([id]) => id),
      [95, 96, 97, 98, 99, 100, 101, 102, 103],
    );
    assert.deepEqual(
      yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id <= 94 ORDER BY migration_id`,
      before,
    );
    assert.equal((yield* sql`SELECT name FROM sqlite_master WHERE name = 'team_spaces'`).length, 1);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects a mixed Teams and UNN collision ledger before schema changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyTeams();
    yield* sql`UPDATE effect_sql_migrations SET name='ProjectionThreadTitleState' WHERE migration_id=56`;
    const result = yield* Effect.result(runMigrations());
    assert.equal(result._tag, "Failure");
    assert.equal(
      (yield* sql`SELECT name FROM sqlite_master WHERE name = 'organizations'`).length,
      0,
    );
    assert.equal(
      (yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id > 63`).length,
      0,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

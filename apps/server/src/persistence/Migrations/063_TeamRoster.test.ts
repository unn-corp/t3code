import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./063_TeamRoster.ts";

it.layer(NodeSqliteClient.layerMemory())("063_TeamRoster", (it) => {
  it.effect(
    "backfills existing project members without promoting creators and preserves memberships",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 62 });
        yield* sql`INSERT INTO team_spaces(id,name) VALUES('existing','Existing')`;
        yield* sql`INSERT INTO team_members(space_id,user_id,role) VALUES('existing','creator','owner'),('existing','viewer','viewer')`;
        yield* sql`INSERT INTO team_events(space_id,actor,kind,text,created_at) VALUES('existing','creator','project.created','Existing',0)`;
        yield* runMigrations();
        assert.deepEqual(yield* sql`SELECT * FROM team_roster ORDER BY user_id`, [
          { user_id: "creator", role: "member" },
          { user_id: "viewer", role: "member" },
        ]);
        assert.deepEqual(yield* sql`SELECT user_id,role FROM team_members ORDER BY user_id`, [
          { user_id: "creator", role: "owner" },
          { user_id: "viewer", role: "viewer" },
        ]);
        yield* sql`DELETE FROM team_roster WHERE user_id='viewer'`;
        yield* migration;
        assert.deepEqual(yield* sql`SELECT * FROM team_roster ORDER BY user_id`, [
          { user_id: "creator", role: "member" },
        ]);
        assert.deepEqual(yield* runMigrations(), []);
      }),
  );
});

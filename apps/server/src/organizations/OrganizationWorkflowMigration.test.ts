import { assert, it } from "@effect/vitest";
import { OrganizationId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";

const layer = it.layer(
  OrganizationStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

layer("Organization workflow migration", (it) => {
  it.effect(
    "upgrades a migration-59 Organization and reads a pre-workflow published snapshot",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 59 });
        const graph =
          '{"roles":[{"id":"legacy:architect","kind":"architect","title":"Architect","mandate":"Design","poolSize":1},{"id":"legacy:director","kind":"director","title":"Director","mandate":"Represent","poolSize":1}],"edges":[]}';
        yield* sql`
        INSERT INTO organizations (organization_id, title, mission, lifecycle, draft_revision,
          published_revision, architect_role_id, director_role_id, graph_json, layout_json,
          created_at, updated_at)
        VALUES ('legacy', 'Legacy', 'Maintain', 'draft', 1, 1,
          'legacy:architect', 'legacy:director', ${graph}, '{"positions":[]}',
          '2026-01-01', '2026-01-01')
      `;
        const priorSnapshot = `{"organizationId":"legacy","revision":1,"title":"Legacy","mission":"Maintain","graph":${graph},"bindings":[],"publishedAt":"2026-01-01"}`;
        yield* sql`
        INSERT INTO organization_config_versions (organization_id, revision, config_json, published_at)
        VALUES ('legacy', 1, ${priorSnapshot}, '2026-01-01')
      `;
        yield* runMigrations();
        const store = yield* OrganizationStore;
        assert.deepStrictEqual(
          (yield* store.get({ organizationId: OrganizationId.make("legacy") })).workflows,
          [],
        );
        assert.deepStrictEqual(
          (yield* store.getPublishedConfig({
            organizationId: OrganizationId.make("legacy"),
            revision: 1,
          })).workflows,
          [],
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
  );
});

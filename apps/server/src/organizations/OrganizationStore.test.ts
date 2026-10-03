import { assert, it } from "@effect/vitest";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationRoleId,
  OrganizationEdgeId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";

const layer = it.layer(
  OrganizationStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
const id = OrganizationId.make;
const projectId = ProjectId.make;
const create = (organizationId: OrganizationId, mutationId: string) =>
  Effect.gen(function* () {
    const store = yield* OrganizationStore;
    return yield* store.create({
      organizationId,
      mutationId,
      title: "Example",
      mission: "Maintain software",
      actor: "user",
    });
  });
const seedProject = (project: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${project}, ${project}, ${`/tmp/${project}`}, '[]', '2026-01-01', '2026-01-01')
  `;
  });

layer("OrganizationStore", (it) => {
  it.effect("creates and reloads an Organization with no Project", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* OrganizationStore;
      const created = yield* create(id("org-zero"), "m-create-zero");
      assert.equal(created.bindings.length, 0);
      assert.notEqual(created.architectRoleId, created.directorRoleId);
      assert.deepStrictEqual(
        (yield* store.get({ organizationId: created.id })).graph,
        created.graph,
      );
      assert.equal((yield* store.list()).organizations.length, 1);
      assert.equal(
        (yield* store.listAudit({ organizationId: created.id })).entries[0]?.action,
        "create",
      );
    }),
  );

  it.effect("rejects stale edits and malformed supervision graphs without changing revision", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* OrganizationStore;
      const created = yield* create(id("org-graph"), "m-create-graph");
      const roleId = OrganizationRoleId.make("engineer");
      const added = yield* store.mutate({
        organizationId: created.id,
        mutationId: "m-add-role",
        baseRevision: 1,
        actor: "user",
        change: {
          type: "add-role",
          role: {
            id: roleId,
            kind: "engineering",
            title: "Engineer",
            mandate: "Fix bugs",
            poolSize: 1,
          },
        },
      });
      assert.equal(added.draftRevision, 2);
      const stale = yield* Effect.flip(
        store.mutate({
          organizationId: created.id,
          mutationId: "m-stale",
          baseRevision: 1,
          actor: "user",
          change: { type: "set-title", title: "Lost edit" },
        }),
      );
      assert.equal(stale.code, "conflict");
      const dangling = yield* Effect.flip(
        store.mutate({
          organizationId: created.id,
          mutationId: "m-dangling",
          baseRevision: 2,
          actor: "user",
          change: {
            type: "add-edge",
            edge: {
              id: OrganizationEdgeId.make("edge-dangling"),
              kind: "reports-to",
              fromRoleId: roleId,
              toRoleId: OrganizationRoleId.make("missing"),
            },
          },
        }),
      );
      assert.equal(dangling.code, "invalid");
      assert.equal((yield* store.get({ organizationId: created.id })).draftRevision, 2);
    }),
  );

  it.effect("allows two Projects and one write steward across Organizations", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-a");
      yield* seedProject("project-b");
      const store = yield* OrganizationStore;
      const first = yield* create(id("org-first"), "m-create-first");
      const second = yield* create(id("org-second"), "m-create-second");
      const write = yield* store.bindProject({
        organizationId: first.id,
        mutationId: "m-bind-a",
        baseRevision: 1,
        actor: "user",
        bindingId: OrganizationBindingId.make("bind-a"),
        projectId: projectId("project-a"),
        access: "write",
        capabilities: ["read-files", "write-files"],
        scope: null,
      });
      const twoProjects = yield* store.bindProject({
        organizationId: first.id,
        mutationId: "m-bind-b",
        baseRevision: write.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("bind-b"),
        projectId: projectId("project-b"),
        access: "read",
        capabilities: ["read-files"],
        scope: null,
      });
      assert.equal(twoProjects.bindings.filter((binding) => binding.detachedAt === null).length, 2);
      const denied = yield* Effect.flip(
        store.bindProject({
          organizationId: second.id,
          mutationId: "m-second-write",
          baseRevision: 1,
          actor: "user",
          bindingId: OrganizationBindingId.make("bind-second-write"),
          projectId: projectId("project-a"),
          access: "write",
          capabilities: ["write-files"],
          scope: null,
        }),
      );
      assert.equal(denied.code, "conflict");
      const read = yield* store.bindProject({
        organizationId: second.id,
        mutationId: "m-second-read",
        baseRevision: 1,
        actor: "user",
        bindingId: OrganizationBindingId.make("bind-second-read"),
        projectId: projectId("project-a"),
        access: "proposal",
        capabilities: ["read-files", "propose-work"],
        scope: null,
      });
      assert.equal(read.bindings[0]?.access, "proposal");
      // The database must protect the steward invariant even if a caller bypasses the store.
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.flip(sql`
      UPDATE organization_project_bindings SET access = 'write'
      WHERE binding_id = 'bind-second-read'
    `);
      assert.equal(
        (yield* store.get({ organizationId: second.id })).bindings[0]?.access,
        "proposal",
      );
      const detached = yield* store.detachProject({
        organizationId: first.id,
        mutationId: "m-detach-a",
        baseRevision: twoProjects.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("bind-a"),
      });
      assert.equal(
        detached.bindings.find((binding) => binding.id === "bind-a")?.detachedAt !== null,
        true,
      );
      assert.equal((yield* store.get({ organizationId: first.id })).bindings.length, 2);
      const listed = (yield* store.list()).organizations;
      assert.ok(listed.some((organization) => organization.id === first.id));
      assert.ok(listed.some((organization) => organization.id === second.id));
    }),
  );

  it.effect("refuses a soft-deleted Project binding", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-deleted");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-02' WHERE project_id = 'project-deleted'`;
      const store = yield* OrganizationStore;
      const created = yield* create(id("org-deleted-target"), "m-create-deleted-target");
      const error = yield* Effect.flip(
        store.bindProject({
          organizationId: created.id,
          mutationId: "m-bind-deleted",
          baseRevision: 1,
          actor: "user",
          bindingId: OrganizationBindingId.make("bind-deleted"),
          projectId: projectId("project-deleted"),
          access: "read",
          capabilities: ["read-files"],
          scope: null,
        }),
      );
      assert.equal(error.code, "invalid");
    }),
  );

  it.effect("publishes an immutable configuration, then keeps later draft changes separate", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* OrganizationStore;
      const created = yield* create(id("org-publish"), "m-create-publish");
      const denied = yield* Effect.flip(
        store.publish({
          organizationId: created.id,
          mutationId: "m-architect-publish",
          baseRevision: 1,
          actor: "architect",
        }),
      );
      assert.equal(denied.code, "forbidden");
      const published = yield* store.publish({
        organizationId: created.id,
        mutationId: "m-publish",
        baseRevision: 1,
        actor: "user",
      });
      assert.equal(published.publishedRevision, 2);
      const edited = yield* store.mutate({
        organizationId: created.id,
        mutationId: "m-edit-after-publish",
        baseRevision: 2,
        actor: "user",
        change: { type: "set-mission", mission: "A new mission" },
      });
      assert.equal(edited.mission, "A new mission");
      assert.equal(edited.publishedRevision, 2);
      const snapshot = yield* store.getPublishedConfig({ organizationId: created.id, revision: 2 });
      assert.equal(snapshot.mission, "Maintain software");
      const inactive = yield* Effect.flip(
        store.setLifecycle({
          organizationId: created.id,
          mutationId: "m-activate",
          baseRevision: 3,
          actor: "user",
          lifecycle: "active",
        }),
      );
      assert.equal(inactive.code, "unavailable");
    }),
  );

  it.effect(
    "rejects pause before activation and preserves bindings while work is open on archive",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-archive");
        const store = yield* OrganizationStore;
        const sql = yield* SqlClient.SqlClient;
        const created = yield* create(id("org-archive-guard"), "m-create-archive-guard");
        const pause = yield* Effect.flip(
          store.setLifecycle({
            organizationId: created.id,
            mutationId: "m-pause-draft",
            baseRevision: 1,
            actor: "user",
            lifecycle: "paused",
          }),
        );
        assert.equal(pause.code, "invalid");
        const bound = yield* store.bindProject({
          organizationId: created.id,
          mutationId: "m-bind-archive",
          baseRevision: 1,
          actor: "user",
          bindingId: OrganizationBindingId.make("bind-archive"),
          projectId: projectId("project-archive"),
          access: "read",
          capabilities: ["read-history"],
          scope: null,
        });
        const time = "2026-09-26T12:00:00.000Z";
        yield* sql`INSERT INTO organization_intake_sources
        (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
          secret_hash, credential_version, created_at, updated_at)
        VALUES ('source-archive', ${created.id}, 'project-archive', 'manual', 'Report',
          'user', 1, NULL, 1, ${time}, ${time})`;
        yield* sql`INSERT INTO organization_intake_findings
        (finding_id, organization_id, source_id, dedup_key, title, summary,
          observation_ids_json, state, created_at)
        VALUES ('finding-archive', ${created.id}, 'source-archive', 'archive', 'Report',
          'Open report', '[]', 'tentative', ${time})`;
        yield* sql`INSERT INTO organization_work_items
        (work_id, request_id, request_json, organization_id, finding_id, project_id,
          binding_id, binding_version, scope, published_revision, workflow_id,
          workflow_version, code_revision, status, attempt_limit, attempt_count,
          creator_subject, created_at, updated_at)
        VALUES ('work-archive', 'request-archive', '{}', ${created.id}, 'finding-archive',
          'project-archive', 'bind-archive', ${time}, NULL, 1, 'workflow-archive',
          1, 'revision', 'pending', 1, 0, 'user', ${time}, ${time})`;
        const detach = yield* Effect.flip(
          store.detachProject({
            organizationId: created.id,
            mutationId: "m-detach-open",
            baseRevision: bound.draftRevision,
            actor: "user",
            bindingId: OrganizationBindingId.make("bind-archive"),
          }),
        );
        assert.equal(detach.code, "conflict");
        const archive = yield* Effect.flip(
          store.setLifecycle({
            organizationId: created.id,
            mutationId: "m-archive-open",
            baseRevision: bound.draftRevision,
            actor: "user",
            lifecycle: "archived",
          }),
        );
        assert.equal(archive.code, "conflict");
        assert.equal(
          (yield* store.get({ organizationId: created.id })).draftRevision,
          bound.draftRevision,
        );
        assert.equal(
          (yield* store.get({ organizationId: created.id })).bindings[0]?.detachedAt,
          null,
        );
        yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${created.id}`;
        yield* sql`UPDATE organization_work_items SET status = 'running', attempt_count = 1
          WHERE work_id = 'work-archive'`;
        yield* sql`INSERT INTO organization_work_attempts
          (attempt_id, work_id, number, status, worker_subject, lease_until,
            started_at, updated_at)
          VALUES ('attempt-archive', 'work-archive', 1, 'running', 'worker',
            '2026-09-27T12:00:00.000Z', ${time}, ${time})`;
        const activeWithWorker = yield* Effect.flip(
          store.setLifecycle({
            organizationId: created.id,
            mutationId: "m-pause-running",
            baseRevision: bound.draftRevision,
            actor: "user",
            lifecycle: "paused",
          }),
        );
        assert.equal(activeWithWorker.code, "conflict");
        yield* sql`UPDATE organization_work_attempts SET status = 'canceled'
          WHERE attempt_id = 'attempt-archive'`;
        yield* sql`UPDATE organizations SET lifecycle = 'draft' WHERE organization_id = ${created.id}`;
        yield* sql`UPDATE organization_work_items SET status = 'canceled' WHERE work_id = 'work-archive'`;
        const archived = yield* store.setLifecycle({
          organizationId: created.id,
          mutationId: "m-archive-closed",
          baseRevision: bound.draftRevision,
          actor: "user",
          lifecycle: "archived",
        });
        assert.equal(archived.lifecycle, "archived");
        assert.notEqual(archived.bindings[0]?.detachedAt, null);
      }),
  );
});

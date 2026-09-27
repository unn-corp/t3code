import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OrganizationMemoryMutationId,
  OrganizationMemoryRecordId,
  type OrganizationMemoryContent,
} from "../../../../packages/contracts/src/organizationMemory.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import { OrganizationMemoryStore, OrganizationMemoryStoreLive } from "./OrganizationMemoryStore.ts";

const layer = it.layer(
  Layer.mergeAll(OrganizationStoreLive, OrganizationMemoryStoreLive).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);
const org = OrganizationId.make;
const project = ProjectId.make;
const record = OrganizationMemoryRecordId.make;
const mutation = OrganizationMemoryMutationId.make;
const user = { subject: "interactive-user", interactive: true } as const;
const content = (body = "The user approved this decision."): OrganizationMemoryContent => ({
  kind: "decision",
  title: "Scoped decision",
  body,
  provenance: { kind: "explicit-reference", reference: "issue:42", note: "Reviewed by user" },
  reviewedAt: null,
  staleAt: null,
  retainUntil: null,
});
const createInput = (
  id: string,
  organizationId = "memory-org-a",
  projectId: string | null = null,
) => ({
  mutationId: mutation(`create:${id}`),
  recordId: record(id),
  organizationId: org(organizationId),
  projectId: projectId === null ? null : project(projectId),
  content: content(),
});
const initialize = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM organization_memory_revisions`;
  yield* sql`DELETE FROM organization_memory_records`;
  yield* sql`DELETE FROM organization_project_bindings`;
  yield* sql`DELETE FROM organization_config_versions`;
  yield* sql`DELETE FROM organization_audit`;
  yield* sql`DELETE FROM organizations`;
  const organizations = yield* OrganizationStore;
  yield* organizations.create({
    organizationId: org("memory-org-a"),
    mutationId: "memory-org-a-create",
    title: "A",
    mission: "Study",
    actor: "user",
  });
  yield* organizations.create({
    organizationId: org("memory-org-b"),
    mutationId: "memory-org-b-create",
    title: "B",
    mission: "Study",
    actor: "user",
  });
});

layer("Organization memory", (it) => {
  it.effect("preserves corrections and supersession with idempotent immutable revisions", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationMemoryStore;
      const organizations = yield* OrganizationStore;
      const graphBefore = yield* organizations.get({ organizationId: org("memory-org-a") });
      const firstInput = createInput("decision-1");
      const first = yield* store.create(firstInput, user);
      assert.equal(first.version, 1);
      assert.deepStrictEqual(yield* store.create(firstInput, user), first);
      assert.equal(
        (yield* Effect.flip(store.create({ ...firstInput, content: content("Changed") }, user)))
          .code,
        "conflict",
      );
      const corrected = yield* store.correct(
        {
          mutationId: mutation("correct-1"),
          organizationId: first.organizationId,
          recordId: first.id,
          expectedVersion: 1,
          content: content("Corrected after review"),
        },
        user,
      );
      assert.equal(corrected.version, 2);
      assert.equal(corrected.content.body, "Corrected after review");
      const replacement = yield* store.create(createInput("decision-2"), user);
      const superseded = yield* store.supersede(
        {
          mutationId: mutation("supersede-1"),
          organizationId: first.organizationId,
          recordId: first.id,
          expectedVersion: 2,
          replacementRecordId: replacement.id,
        },
        user,
      );
      assert.equal(superseded.status, "superseded");
      assert.equal(superseded.supersededById, replacement.id);
      assert.equal(
        (yield* Effect.flip(
          store.correct(
            {
              mutationId: mutation("late-correction"),
              organizationId: first.organizationId,
              recordId: first.id,
              expectedVersion: 3,
              content: content("Too late"),
            },
            user,
          ),
        )).code,
        "conflict",
      );
      const history = yield* store.history({
        organizationId: first.organizationId,
        recordId: first.id,
        projectId: null,
      });
      assert.deepStrictEqual(
        history.map((entry) => entry.action),
        ["supersede", "correct", "create"],
      );
      assert.equal(history[2]?.snapshot.content.body, first.content.body);
      assert.equal(history[1]?.snapshot.content.body, "Corrected after review");
      assert.deepStrictEqual(
        (yield* store.history({
          organizationId: first.organizationId,
          recordId: first.id,
          projectId: null,
          offset: 1,
        })).map((entry) => entry.action),
        ["correct", "create"],
      );
      assert.equal(
        (yield* store.list({ organizationId: first.organizationId, projectId: null })).length,
        2,
      );
      assert.equal(
        (yield* store.list({ organizationId: first.organizationId, projectId: null, offset: 1 }))
          .length,
        1,
      );
      assert.equal(
        (yield* store.list({ organizationId: org("memory-org-b"), projectId: null })).length,
        0,
      );
      const graphAfter = yield* organizations.get({ organizationId: org("memory-org-a") });
      assert.equal(graphAfter.draftRevision, graphBefore.draftRevision);
      assert.deepStrictEqual(graphAfter.graph, graphBefore.graph);
      const archived = yield* store.archive(
        {
          mutationId: mutation("archive-replacement"),
          organizationId: replacement.organizationId,
          recordId: replacement.id,
          expectedVersion: 1,
        },
        user,
      );
      assert.equal(archived.status, "archived");
      assert.equal(
        (yield* store.history({
          organizationId: replacement.organizationId,
          recordId: replacement.id,
          projectId: null,
        })).length,
        2,
      );
    }),
  );

  it.effect("requires an interactive user, rejects cross-Organization IDs and archives", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationMemoryStore;
      const input = createInput("protected");
      assert.equal(
        (yield* Effect.flip(store.create(input, { subject: "agent", interactive: false }))).code,
        "forbidden",
      );
      const created = yield* store.create(input, user);
      assert.equal(
        (yield* Effect.flip(
          store.history({
            organizationId: org("memory-org-b"),
            recordId: created.id,
            projectId: null,
          }),
        )).code,
        "not_found",
      );
      assert.equal(
        (yield* Effect.flip(
          store.correct(
            {
              mutationId: mutation("cross-org"),
              organizationId: org("memory-org-b"),
              recordId: created.id,
              expectedVersion: 1,
              content: content("Take over"),
            },
            user,
          ),
        )).code,
        "not_found",
      );
      const organizations = yield* OrganizationStore;
      yield* organizations.setLifecycle({
        organizationId: org("memory-org-a"),
        mutationId: "archive-memory-org",
        baseRevision: 1,
        actor: "user",
        lifecycle: "archived",
      });
      assert.equal(
        (yield* Effect.flip(store.create(createInput("after-archive"), user))).code,
        "forbidden",
      );
      assert.deepStrictEqual(yield* store.create(input, user), created);
      assert.equal(
        (yield* store.list({ organizationId: org("memory-org-a"), projectId: null })).length,
        1,
      );
    }),
  );

  it.effect("requires a live Project binding for writes while preserving historical reads", () =>
    Effect.gen(function* () {
      yield* initialize;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('memory-project', 'Project', '/tmp/memory-project', '[]', '2026-01-01', '2026-01-01')`;
      const store = yield* OrganizationMemoryStore;
      const scopedInput = createInput("scoped", "memory-org-a", "memory-project");
      assert.equal((yield* Effect.flip(store.create(scopedInput, user))).code, "forbidden");
      const organizations = yield* OrganizationStore;
      yield* organizations.bindProject({
        organizationId: org("memory-org-a"),
        mutationId: "bind-memory-project",
        baseRevision: 1,
        actor: "user",
        bindingId: OrganizationBindingId.make("memory-binding"),
        projectId: project("memory-project"),
        access: "read",
        capabilities: ["read-history"],
        scope: null,
      });
      const created = yield* store.create(scopedInput, user);
      assert.equal(
        (yield* store.list({ organizationId: org("memory-org-a"), projectId: null })).length,
        0,
      );
      assert.equal(
        (yield* store.list({
          organizationId: org("memory-org-a"),
          projectId: project("memory-project"),
        })).length,
        1,
      );
      assert.equal(
        (yield* Effect.flip(
          store.history({
            organizationId: org("memory-org-a"),
            recordId: created.id,
            projectId: null,
          }),
        )).code,
        "not_found",
      );
      yield* organizations.detachProject({
        organizationId: org("memory-org-a"),
        mutationId: "detach-memory-project",
        baseRevision: 2,
        actor: "user",
        bindingId: OrganizationBindingId.make("memory-binding"),
      });
      assert.equal(
        (yield* store.list({
          organizationId: org("memory-org-a"),
          projectId: project("memory-project"),
        })).length,
        1,
      );
      assert.equal(
        (yield* store.history({
          organizationId: org("memory-org-a"),
          recordId: created.id,
          projectId: project("memory-project"),
        })).length,
        1,
      );
      assert.deepStrictEqual(yield* store.create(scopedInput, user), created);
      assert.equal(
        (yield* Effect.flip(
          store.correct(
            {
              mutationId: mutation("detached-correction"),
              organizationId: org("memory-org-a"),
              recordId: created.id,
              expectedVersion: 1,
              content: content("Cannot edit"),
            },
            user,
          ),
        )).code,
        "forbidden",
      );
    }),
  );

  it.effect("redacts inline secrets and rejects overlarge Unicode and malformed provenance", () =>
    Effect.gen(function* () {
      yield* initialize;
      const store = yield* OrganizationMemoryStore;
      const input = {
        ...createInput("redacted"),
        content: {
          ...content("Bearer abc123 token=very-secret OPENAI_API_KEY=env-secret"),
          provenance: {
            kind: "explicit-reference" as const,
            reference: "password=hunter2",
            note: "api_key=raw-secret",
          },
        },
      };
      const saved = yield* store.create(input, user);
      assert.equal(saved.content.provenance.reference?.includes("hunter2"), false);
      assert.equal(saved.content.body.includes("very-secret"), false);
      assert.equal(saved.content.body.includes("env-secret"), false);
      const sql = yield* SqlClient.SqlClient;
      const raw = yield* sql<{ content_json: string; snapshot_json: string }>`
        SELECT r.content_json, h.snapshot_json FROM organization_memory_records r
        JOIN organization_memory_revisions h ON h.record_id = r.record_id
        WHERE r.record_id = ${saved.id}`;
      assert.equal(
        raw.some(
          (row) => row.content_json.includes("hunter2") || row.snapshot_json.includes("hunter2"),
        ),
        false,
      );
      assert.equal(
        raw.some(
          (row) =>
            row.content_json.includes("very-secret") || row.snapshot_json.includes("very-secret"),
        ),
        false,
      );
      assert.equal(
        raw.some(
          (row) =>
            row.content_json.includes("env-secret") || row.snapshot_json.includes("env-secret"),
        ),
        false,
      );
      assert.equal(
        (yield* Effect.flip(
          store.create({ ...createInput("oversized"), content: content("💥".repeat(4_000)) }, user),
        )).code,
        "invalid",
      );
      assert.equal(
        (yield* Effect.flip(
          store.create(
            {
              ...createInput("bad-reference"),
              content: {
                ...content(),
                provenance: { kind: "explicit-reference", reference: null, note: null },
              },
            },
            user,
          ),
        )).code,
        "invalid",
      );
    }),
  );
});

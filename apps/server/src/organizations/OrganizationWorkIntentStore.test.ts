// @effect-diagnostics nodeBuiltinImport:off - File-backed SQLite concurrency fixtures need temporary filesystem paths.
import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import { OrganizationIntakeSourceId } from "../../../../packages/contracts/src/organizationIntake.ts";
import {
  OrganizationProposalMutationId,
  type OrganizationProposalId,
} from "../../../../packages/contracts/src/organizationProposals.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration082 from "../persistence/Migrations/082_OrganizationWorkIntents.ts";
import { OrganizationIntakeStore, OrganizationIntakeStoreLive } from "./OrganizationIntakeStore.ts";
import {
  OrganizationProposalStore,
  OrganizationProposalStoreLive,
} from "./OrganizationProposalStore.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import {
  OrganizationWorkIntentStore,
  OrganizationWorkIntentStoreLive,
} from "./OrganizationWorkIntentStore.ts";

const layer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationIntakeStoreLive,
    OrganizationProposalStoreLive,
    OrganizationWorkIntentStoreLive,
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
const principal = { subject: "intent-user", interactive: true } as const;
const manager = { subject: principal.subject, canManageSources: true } as const;
let sequence = 0;
const setup = () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    // The migration is registered by the composition owner. This also lets the
    // isolated test execute before that registration is merged.
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'organization_work_intents'`;
    if (tables.length === 0) yield* Migration082;
    const tag = `intent-${++sequence}`;
    const organizationId = OrganizationId.make(`${tag}-org`);
    const projectId = ProjectId.make(`${tag}-project`);
    const bindingId = OrganizationBindingId.make(`${tag}-binding`);
    const sourceId = OrganizationIntakeSourceId.make(`${tag}-source`);
    yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, ${tag}, ${`/tmp/${tag}`}, '[]', '2026-01-01', '2026-01-01')`;
    const organizations = yield* OrganizationStore;
    const created = yield* organizations.create({
      organizationId,
      mutationId: `${tag}-create`,
      title: tag,
      mission: "Observe",
      actor: "user",
    });
    const bound = yield* organizations.bindProject({
      organizationId,
      mutationId: `${tag}-bind`,
      baseRevision: created.draftRevision,
      actor: "user",
      bindingId,
      projectId,
      access: "proposal",
      capabilities: ["read-history", "propose-work"],
      scope: null,
    });
    yield* organizations.publish({
      organizationId,
      mutationId: `${tag}-publish`,
      baseRevision: bound.draftRevision,
      actor: "user",
    });
    const intake = yield* OrganizationIntakeStore;
    yield* intake.registerSource(
      {
        organizationId,
        sourceId,
        projectId,
        kind: "manual",
        name: tag,
        ingestSubject: principal.subject,
      },
      manager,
    );
    const proposals = yield* OrganizationProposalStore;
    yield* proposals.setObservationMode(
      {
        organizationId,
        mutationId: OrganizationProposalMutationId.make(`${tag}-mode`),
        expectedVersion: 0,
        enabled: true,
      },
      principal,
    );
    yield* TestClock.adjust(Duration.seconds(1));
    const observed = yield* intake.ingest(
      {
        organizationId,
        sourceId,
        projectId,
        externalEventId: `${tag}-event`,
        dedupKey: `${tag}-observation`,
        occurredAt: "2026-01-01T00:00:00.000Z",
        title: "Signal",
        body: "Evidence",
        attributes: {},
      },
      { kind: "interactive-user", subject: principal.subject },
    );
    yield* intake.proposeFinding(
      {
        organizationId,
        sourceId,
        dedupKey: `${tag}-finding`,
        title: "Signal",
        summary: "Evidence",
        observationIds: [observed.observation.id],
      },
      manager,
    );
    assert.equal((yield* proposals.reconcileOnce()).proposed, 1);
    const proposal = (yield* proposals.list({
      organizationId,
      afterProposalId: null,
      limit: 10,
    })).proposals[0]!;
    return { organizationId, projectId, bindingId, sourceId, proposal };
  });
const create = (fixture: {
  organizationId: OrganizationId;
  proposal: { id: OrganizationProposalId; version: number };
}) =>
  Effect.gen(function* () {
    const store = yield* OrganizationWorkIntentStore;
    return yield* store.createFromProposal(
      {
        organizationId: fixture.organizationId,
        proposalId: fixture.proposal.id,
        expectedVersion: fixture.proposal.version,
      },
      principal,
    );
  });
const assertForbidden = <A, E extends { code: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit);
      assert.equal(error._tag, "Some");
      if (error._tag === "Some") assert.equal(error.value.code, "forbidden");
    }
  });

layer("Organization work intent", (it) => {
  it.effect("reconciles once, remains inert, and is idempotent across direct requests", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const store = yield* OrganizationWorkIntentStore;
      const report = yield* store.reconcileOnce();
      assert.equal(report.created, 1);
      const first = (yield* store.list(fixture.organizationId))[0]!;
      assert.equal(first.status, "awaiting-activation");
      assert.equal(first.freshness, "current");
      assert.equal(first.requestedBy, "system:organization-proposal-reconciler");
      assert.equal((yield* create(fixture)).id, first.id);
      assert.equal((yield* store.list(fixture.organizationId)).length, 1);
      const work = yield* (yield* SqlClient.SqlClient)<{ count: number }>`SELECT count(*) AS count
        FROM organization_work_items`;
      assert.equal(work[0]?.count, 0);
    }),
  );

  it.effect("admits a fresh proposal beyond more than 32 older stale IDs in one pass", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 40; index++) {
        const findingId = `a-stale-finding-${index}`;
        const proposalId = `a-stale-proposal-${String(index).padStart(2, "0")}`;
        yield* sql`INSERT INTO organization_intake_findings
          (finding_id, organization_id, source_id, dedup_key, title, summary,
            observation_ids_json, project_id, evidence_json, state, created_at)
          SELECT ${findingId}, organization_id, source_id, ${findingId}, title, summary,
            observation_ids_json, project_id, evidence_json, state, '1970-01-01T00:00:00.000Z'
          FROM organization_intake_findings WHERE finding_id = ${fixture.proposal.findingId}`;
        yield* sql`INSERT INTO organization_work_proposals
          (proposal_id, organization_id, finding_id, project_id, binding_id,
            binding_version, published_revision, evidence_json, title, summary,
            state, version, created_at, updated_at)
          SELECT ${proposalId}, organization_id, ${findingId}, project_id, binding_id,
            binding_version, published_revision, evidence_json, title, summary,
            state, version, '1970-01-01T00:00:00.000Z', updated_at
          FROM organization_work_proposals WHERE proposal_id = ${fixture.proposal.id}`;
      }
      const report = yield* (yield* OrganizationWorkIntentStore).reconcileOnce();
      assert.ok(report.examined <= 32);
      assert.equal(report.created, 1);
      const intents = yield* (yield* OrganizationWorkIntentStore).list(fixture.organizationId);
      assert.equal(intents.length, 1);
      assert.equal(intents[0]?.proposalId, fixture.proposal.id);
    }),
  );

  it.effect("survives store layer recreation and rejects a stale proposal version", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const first = yield* create(fixture);
      const sql = yield* SqlClient.SqlClient;
      const restartedStore = OrganizationWorkIntentStoreLive.pipe(
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      );
      const persisted = yield* OrganizationWorkIntentStore.pipe(
        Effect.flatMap((store) => store.get(fixture.organizationId, first.id)),
        Effect.provide(restartedStore),
      );
      assert.equal(persisted.id, first.id);
      assert.equal(persisted.freshness, "current");
      yield* sql`UPDATE organization_work_proposals SET version = version + 1
        WHERE proposal_id = ${fixture.proposal.id}`;
      const reloaded = yield* (yield* OrganizationWorkIntentStore).get(
        fixture.organizationId,
        first.id,
      );
      assert.equal(reloaded.freshness, "stale");
      assert.equal(reloaded.staleReason, "proposal-changed");
      const result = yield* Effect.exit(create(fixture));
      assert.equal(Exit.isFailure(result), true);
    }),
  );

  it.effect("rejects revoked source, binding, publication, and deleted project", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_intake_sources SET enabled = 0
        WHERE source_id = ${fixture.sourceId}`;
      yield* assertForbidden(create(fixture));
      yield* sql`UPDATE organization_intake_sources SET enabled = 1
        WHERE source_id = ${fixture.sourceId}`;
      yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-02'
        WHERE binding_id = ${fixture.bindingId}`;
      yield* assertForbidden(create(fixture));
      yield* sql`UPDATE organization_project_bindings SET detached_at = NULL
        WHERE binding_id = ${fixture.bindingId}`;
      yield* sql`UPDATE organizations SET published_revision = published_revision + 1
        WHERE organization_id = ${fixture.organizationId}`;
      yield* assertForbidden(create(fixture));
      yield* sql`UPDATE organizations SET published_revision = published_revision - 1
        WHERE organization_id = ${fixture.organizationId}`;
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-02'
        WHERE project_id = ${fixture.projectId}`;
      yield* assertForbidden(create(fixture));
      assert.equal(
        (yield* (yield* OrganizationWorkIntentStore).list(fixture.organizationId)).length,
        0,
      );
    }),
  );

  it.effect("marks an existing waiting intent stale after its source is revoked", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const intent = yield* create(fixture);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organization_intake_sources SET enabled = 0
        WHERE source_id = ${fixture.sourceId}`;
      const reloaded = yield* (yield* OrganizationWorkIntentStore).get(
        fixture.organizationId,
        intent.id,
      );
      assert.equal(reloaded.status, "awaiting-activation");
      assert.equal(reloaded.freshness, "stale");
      assert.equal(reloaded.staleReason, "source-or-evidence-revoked");
    }),
  );

  it.effect("rejects paused and archived Organizations", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organizations SET lifecycle = 'paused'
        WHERE organization_id = ${fixture.organizationId}`;
      yield* assertForbidden(create(fixture));
      yield* sql`UPDATE organizations SET lifecycle = 'archived'
        WHERE organization_id = ${fixture.organizationId}`;
      yield* assertForbidden(create(fixture));
    }),
  );
});

it.effect("two SQLite clients converge on one intent for the same proposal", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-work-intent-"));
    const filename = NodePath.join(directory, "state.sqlite");
    const fileLayer = () =>
      Layer.fresh(
        Layer.mergeAll(
          OrganizationStoreLive,
          OrganizationIntakeStoreLive,
          OrganizationProposalStoreLive,
          OrganizationWorkIntentStoreLive,
        ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))),
      );
    try {
      const selectedDatabase = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
      }).pipe(Effect.provide(fileLayer()));
      assert.equal(selectedDatabase.find((row) => row.name === "main")?.file, filename);
      const fixture = yield* setup().pipe(Effect.provide(fileLayer()));
      const write = () => create(fixture).pipe(Effect.provide(fileLayer()));
      const intents = yield* Effect.all([write(), write()], { concurrency: 2 });
      assert.equal(intents[0]?.id, intents[1]?.id);
      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ total: number }>`SELECT count(*) AS total
          FROM organization_work_intents`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      assert.equal(rows[0]?.total, 1);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);

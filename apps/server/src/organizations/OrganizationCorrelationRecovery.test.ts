import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  OrganizationIntakeError,
  OrganizationIntakeSourceId,
  type OrganizationIntakeEventInput,
} from "../../../../packages/contracts/src/organizationIntake.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import { OrganizationIntakeStore, OrganizationIntakeStoreLive } from "./OrganizationIntakeStore.ts";
import { OrganizationCorrelationCoordinator } from "./OrganizationCorrelationCoordinator.ts";
import { correlateRecordedIntake } from "./OrganizationIntakeCorrelation.ts";
import {
  OrganizationCorrelationRecovery,
  OrganizationCorrelationRecoveryLayer,
  OrganizationCorrelationRecoveryLive,
} from "./OrganizationCorrelationRecovery.ts";

const organizationId = OrganizationId.make("recovery-org");
const projectId = ProjectId.make("recovery-project");
const sourceId = OrganizationIntakeSourceId.make;
const manager = { subject: "recovery-user", canManageSources: true } as const;
const authentication = { kind: "interactive-user", subject: manager.subject } as const;
const event = (source: string, id: string): OrganizationIntakeEventInput => ({
  organizationId,
  sourceId: sourceId(source),
  projectId,
  externalEventId: id,
  dedupKey: id,
  occurredAt: "2026-01-01T00:00:00.000Z",
  title: "Signal",
  body: "Persisted signal",
  attributes: { correlationKey: "incident-42" },
});
const prepare = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM organization_intake_correlation_jobs`;
  yield* sql`DELETE FROM organization_intake_findings`;
  yield* sql`DELETE FROM organization_intake_observations`;
  yield* sql`DELETE FROM organization_intake_audit`;
  yield* sql`DELETE FROM organization_intake_sources`;
  yield* sql`DELETE FROM organization_project_bindings`;
  yield* sql`DELETE FROM organization_config_versions`;
  yield* sql`DELETE FROM organization_audit`;
  yield* sql`DELETE FROM organizations`;
  yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Recovery Project', '/tmp/recovery-project', '[]',
      '2026-01-01', '2026-01-01')`;
  const organizations = yield* OrganizationStore;
  const created = yield* organizations.create({
    organizationId,
    mutationId: "create-recovery",
    title: "Recovery Org",
    mission: "Observe",
    actor: "user",
  });
  yield* organizations.bindProject({
    organizationId,
    mutationId: "bind-recovery",
    baseRevision: created.draftRevision,
    actor: "user",
    bindingId: OrganizationBindingId.make("recovery-binding"),
    projectId,
    access: "proposal",
    capabilities: ["read-history", "propose-work"],
    scope: null,
  });
  const intake = yield* OrganizationIntakeStore;
  for (const name of ["source-a", "source-b"]) {
    yield* intake.registerSource(
      {
        organizationId,
        sourceId: sourceId(name),
        projectId,
        kind: "manual",
        name,
        ingestSubject: manager.subject,
      },
      manager,
    );
  }
});

const realLayer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationIntakeStoreLive,
    OrganizationCorrelationRecoveryLive,
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

realLayer("Organization correlation recovery", (it) => {
  it.effect("settles a synchronous correlation without consuming a recovery attempt", () =>
    Effect.gen(function* () {
      yield* prepare;
      const intake = yield* OrganizationIntakeStore;
      const recorded = yield* intake.ingest(event("source-a", "immediate"), authentication);
      const recovery = yield* OrganizationCorrelationRecovery;
      const result = yield* correlateRecordedIntake(
        {
          onObservation: () =>
            Effect.succeed({
              outcome: "insufficient" as const,
              finding: null,
              evidenceCount: 1,
              reason: null,
            }),
        },
        recorded,
        recovery,
      );
      assert.equal(result.correlation?.outcome, "insufficient");
      assert.equal((yield* recovery.runOnce()).claimed, 0);
      const sql = yield* SqlClient.SqlClient;
      const job = yield* sql<{ state: string; attempts: number }>`SELECT state, attempts
        FROM organization_intake_correlation_jobs
        WHERE observation_id = ${recorded.observation.id}`;
      assert.deepStrictEqual(job, [{ state: "complete", attempts: 0 }]);
    }),
  );

  it.effect("recovers a missed pair once and preserves tentative evidence", () =>
    Effect.gen(function* () {
      yield* prepare;
      const intake = yield* OrganizationIntakeStore;
      yield* intake.ingest(event("source-a", "a"), authentication);
      yield* intake.ingest(event("source-b", "b"), authentication);
      const recovery = yield* OrganizationCorrelationRecovery;
      assert.deepStrictEqual(yield* recovery.runOnce(), {
        claimed: 2,
        completed: 2,
        retried: 0,
        terminal: 0,
      });
      assert.equal((yield* intake.listTentativeFindings(organizationId)).length, 1);
      assert.equal((yield* recovery.runOnce()).claimed, 0);
      const sql = yield* SqlClient.SqlClient;
      const jobs = yield* sql<{ state: string; attempts: number }>`SELECT state, attempts
        FROM organization_intake_correlation_jobs ORDER BY observation_id`;
      assert.deepStrictEqual(jobs, [
        { state: "complete", attempts: 1 },
        { state: "complete", attempts: 1 },
      ]);
    }),
  );

  it.effect("terminates revoked Project work and reclaims an expired lease", () =>
    Effect.gen(function* () {
      yield* prepare;
      const intake = yield* OrganizationIntakeStore;
      const first = yield* intake.ingest(event("source-a", "a"), authentication);
      const sql = yield* SqlClient.SqlClient;
      const expiredAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: -1 }));
      yield* sql`UPDATE organization_intake_correlation_jobs SET state = 'leased', attempts = 1,
        lease_token = 'crashed-worker', lease_expires_at = ${expiredAt}
        WHERE observation_id = ${first.observation.id}`;
      const organizations = yield* OrganizationStore;
      const current = yield* organizations.get({ organizationId });
      yield* organizations.detachProject({
        organizationId,
        mutationId: "detach-recovery",
        baseRevision: current.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("recovery-binding"),
      });
      const recovery = yield* OrganizationCorrelationRecovery;
      assert.deepStrictEqual(yield* recovery.runOnce(), {
        claimed: 1,
        completed: 0,
        retried: 0,
        terminal: 1,
      });
      const jobs = yield* sql<{ state: string; attempts: number; last_error_code: string }>`
        SELECT state, attempts, last_error_code FROM organization_intake_correlation_jobs
        WHERE observation_id = ${first.observation.id}`;
      assert.deepStrictEqual(jobs, [
        { state: "terminal", attempts: 2, last_error_code: "forbidden" },
      ]);
      const detached = yield* organizations.get({ organizationId });
      yield* organizations.bindProject({
        organizationId,
        mutationId: "rebind-recovery",
        baseRevision: detached.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("recovery-rebinding"),
        projectId,
        access: "proposal",
        capabilities: ["read-history", "propose-work"],
        scope: null,
      });
      yield* recovery.markFromResult(first.observation.id, {
        outcome: "insufficient",
        finding: null,
        evidenceCount: 1,
        reason: null,
      });
      const settled = yield* sql<{
        state: string;
        outcome: string;
        last_error_code: string | null;
      }>`
        SELECT state, outcome, last_error_code FROM organization_intake_correlation_jobs
        WHERE observation_id = ${first.observation.id}`;
      assert.deepStrictEqual(settled, [
        { state: "complete", outcome: "insufficient", last_error_code: null },
      ]);
    }),
  );
});

let transientFailures = 0;
const transientCoordinator = Layer.succeed(OrganizationCorrelationCoordinator, {
  onObservation: () =>
    transientFailures-- > 0
      ? Effect.fail(new OrganizationIntakeError({ code: "unavailable", message: "Transient" }))
      : Effect.succeed({
          outcome: "insufficient" as const,
          finding: null,
          evidenceCount: 1,
          reason: null,
        }),
});
const transientLayer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationIntakeStoreLive,
    OrganizationCorrelationRecoveryLayer.pipe(Layer.provideMerge(transientCoordinator)),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

transientLayer("Organization correlation retry", (it) => {
  it.effect("backs off transient failure, then settles an idempotent retry", () =>
    Effect.gen(function* () {
      transientFailures = 1;
      yield* prepare;
      const intake = yield* OrganizationIntakeStore;
      const first = yield* intake.ingest(event("source-a", "a"), authentication);
      const recovery = yield* OrganizationCorrelationRecovery;
      assert.deepStrictEqual(yield* recovery.runOnce(), {
        claimed: 1,
        completed: 0,
        retried: 1,
        terminal: 0,
      });
      assert.equal((yield* recovery.runOnce()).claimed, 0);
      const sql = yield* SqlClient.SqlClient;
      const dueAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: -1 }));
      yield* sql`UPDATE organization_intake_correlation_jobs
        SET next_attempt_at = ${dueAt}
        WHERE observation_id = ${first.observation.id}`;
      const due = yield* sql<{ state: string; next_attempt_at: string }>`
        SELECT state, next_attempt_at FROM organization_intake_correlation_jobs
        WHERE observation_id = ${first.observation.id}`;
      assert.deepStrictEqual(due, [{ state: "pending", next_attempt_at: dueAt }]);
      assert.deepStrictEqual(yield* recovery.runOnce(), {
        claimed: 1,
        completed: 1,
        retried: 0,
        terminal: 0,
      });
      const jobs = yield* sql<{ state: string; attempts: number; outcome: string }>`
        SELECT state, attempts, outcome FROM organization_intake_correlation_jobs
        WHERE observation_id = ${first.observation.id}`;
      assert.deepStrictEqual(jobs, [{ state: "complete", attempts: 2, outcome: "insufficient" }]);
      assert.equal((yield* recovery.runOnce()).claimed, 0);
    }),
  );

  it.effect("stops after eight unavailable attempts", () =>
    Effect.gen(function* () {
      transientFailures = 20;
      yield* prepare;
      const intake = yield* OrganizationIntakeStore;
      const recorded = yield* intake.ingest(event("source-a", "repeated"), authentication);
      const recovery = yield* OrganizationCorrelationRecovery;
      const sql = yield* SqlClient.SqlClient;
      for (let attempt = 1; attempt <= 8; attempt++) {
        const result = yield* recovery.runOnce();
        assert.equal(result.claimed, 1);
        assert.equal(result.terminal, attempt === 8 ? 1 : 0);
        if (attempt < 8) {
          const dueAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: -1 }));
          yield* sql`UPDATE organization_intake_correlation_jobs
            SET next_attempt_at = ${dueAt}
            WHERE observation_id = ${recorded.observation.id}`;
        }
      }
      assert.equal((yield* recovery.runOnce()).claimed, 0);
      const job = yield* sql<{ state: string; attempts: number }>`SELECT state, attempts
        FROM organization_intake_correlation_jobs
        WHERE observation_id = ${recorded.observation.id}`;
      assert.deepStrictEqual(job, [{ state: "terminal", attempts: 8 }]);
    }),
  );
});

const migrationLayer = it.layer(
  OrganizationStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
migrationLayer("Organization correlation migration", (it) => {
  it.effect("backfills previously saved observations as pending once", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 66 });
      const organizations = yield* OrganizationStore;
      yield* organizations.create({
        organizationId,
        mutationId: "legacy-create",
        title: "Legacy Org",
        mission: "Observe",
        actor: "user",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO organization_intake_sources
        (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
          secret_hash, credential_version, created_at, updated_at)
        VALUES ('legacy-source', ${organizationId}, NULL, 'manual', 'Legacy', 'legacy', 1,
          NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO organization_intake_observations
        (observation_id, organization_id, source_id, project_id, external_event_id,
          dedup_key, occurred_at, received_at, title, body, attributes_json)
        VALUES ('legacy-observation', ${organizationId}, 'legacy-source', NULL, 'legacy',
          'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          'Legacy', 'Before migration', '{}')`;
      yield* runMigrations();
      yield* runMigrations();
      const jobs = yield* sql<{ observation_id: string; state: string; attempts: number }>`
        SELECT observation_id, state, attempts FROM organization_intake_correlation_jobs`;
      assert.deepStrictEqual(jobs, [
        { observation_id: "legacy-observation", state: "pending", attempts: 0 },
      ]);
    }),
  );
});

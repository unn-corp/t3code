import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import {
  OrganizationIntakeSourceId,
  type OrganizationIntakeEventInput,
} from "../../../../packages/contracts/src/organizationIntake.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import { OrganizationIntakeStore, OrganizationIntakeStoreLive } from "./OrganizationIntakeStore.ts";
import {
  OrganizationFindingCorrelationAuthority,
  OrganizationFindingCorrelatorLayer,
} from "./OrganizationFindingCorrelator.ts";
import {
  OrganizationCorrelationCoordinator,
  OrganizationCorrelationCoordinatorLayer,
} from "./OrganizationCorrelationCoordinator.ts";

const org = OrganizationId.make("coordinator-org");
const project = ProjectId.make("coordinator-project");
const source = OrganizationIntakeSourceId.make;
const manager = { subject: "intake-user", canManageSources: true } as const;
const authentication = { kind: "interactive-user", subject: manager.subject } as const;
const principal = { subject: "correlation-server" } as const;
const correlatorLayer = OrganizationFindingCorrelatorLayer.pipe(
  Layer.provideMerge(
    Layer.succeed(OrganizationFindingCorrelationAuthority, {
      permits: (actor, target) =>
        actor.subject === principal.subject &&
        target.organizationId === org &&
        target.projectId === project,
    }),
  ),
);
const layer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationIntakeStoreLive,
    OrganizationCorrelationCoordinatorLayer.pipe(Layer.provideMerge(correlatorLayer)),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
const event = (
  sourceId: string,
  externalEventId: string,
  projectId: ProjectId | null,
  attributes: Record<string, string>,
): OrganizationIntakeEventInput => ({
  organizationId: org,
  sourceId: source(sourceId),
  projectId,
  externalEventId,
  dedupKey: externalEventId,
  occurredAt: "2026-01-01T00:00:00.000Z",
  title: "Observed signal",
  body: "incident-42 appears in body but is not a key",
  attributes,
});

layer("Organization correlation coordinator", (it) => {
  it.effect("correlates persisted scoped observations and handles retries and ambiguity", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${project}, 'Coordinator Project', '/tmp/coordinator-project', '[]',
          '2026-01-01', '2026-01-01')`;
      const organizations = yield* OrganizationStore;
      const created = yield* organizations.create({
        organizationId: org,
        mutationId: "coordinator-create",
        title: "Coordinator Org",
        mission: "Observe",
        actor: "user",
      });
      yield* organizations.bindProject({
        organizationId: org,
        mutationId: "coordinator-bind",
        baseRevision: created.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("coordinator-binding"),
        projectId: project,
        access: "proposal",
        capabilities: ["read-history", "propose-work"],
        scope: null,
      });
      const intake = yield* OrganizationIntakeStore;
      for (const [sourceId, scope] of [
        ["source-a", project],
        ["source-b", project],
        ["source-unscoped", null],
      ] as const) {
        yield* intake.registerSource(
          {
            organizationId: org,
            sourceId: source(sourceId),
            projectId: scope,
            kind: "manual",
            name: sourceId,
            ingestSubject: manager.subject,
          },
          manager,
        );
      }
      const coordinator = yield* OrganizationCorrelationCoordinator;
      const first = (yield* intake.ingest(
        event("source-a", "event-a", project, { correlationKey: "incident-42" }),
        authentication,
      )).observation;
      assert.deepStrictEqual(yield* coordinator.onObservation(first, principal), {
        outcome: "insufficient",
        finding: null,
        evidenceCount: 1,
        reason: null,
      });
      const second = (yield* intake.ingest(
        event("source-b", "event-b", project, { correlationKey: "incident-42" }),
        authentication,
      )).observation;
      const correlated = yield* coordinator.onObservation(second, principal);
      assert.equal(correlated.outcome, "created");
      assert.deepStrictEqual(
        correlated.finding?.evidence.map((ref) => String(ref.sourceId)).sort(),
        ["source-a", "source-b"],
      );
      assert.equal((yield* coordinator.onObservation(second, principal)).outcome, "duplicate");
      const duplicateIngest = yield* intake.ingest(
        event("source-b", "event-b", project, { correlationKey: "incident-42" }),
        authentication,
      );
      assert.equal(duplicateIngest.outcome, "duplicate");
      assert.equal(
        (yield* coordinator.onObservation(duplicateIngest.observation, principal)).outcome,
        "duplicate",
      );
      yield* intake.setSourceEnabled(org, source("source-b"), false, manager);
      assert.equal((yield* coordinator.onObservation(second, principal)).outcome, "ambiguous");
      yield* intake.setSourceEnabled(org, source("source-b"), true, manager);
      // The caller's body and attributes cannot substitute for persisted attributes.
      assert.equal(
        (yield* coordinator.onObservation(
          { ...second, body: "arbitrary", attributes: { correlationKey: "forged" } },
          principal,
        )).outcome,
        "duplicate",
      );
      assert.equal(
        (yield* Effect.flip(coordinator.onObservation({ ...second, projectId: null }, principal)))
          .code,
        "conflict",
      );
      const noKey = (yield* intake.ingest(
        event("source-a", "event-no-key", project, {}),
        authentication,
      )).observation;
      assert.deepStrictEqual(yield* coordinator.onObservation(noKey, principal), {
        outcome: "skipped",
        finding: null,
        evidenceCount: 0,
        reason: "missing-correlation-key",
      });
      const invalidKey = (yield* intake.ingest(
        event("source-a", "event-invalid-key", project, { correlationKey: " incident-42 " }),
        authentication,
      )).observation;
      assert.deepStrictEqual(yield* coordinator.onObservation(invalidKey, principal), {
        outcome: "skipped",
        finding: null,
        evidenceCount: 0,
        reason: "invalid-correlation-key",
      });
      const projectless = (yield* intake.ingest(
        event("source-unscoped", "event-unscoped", null, { correlationKey: "incident-42" }),
        authentication,
      )).observation;
      assert.deepStrictEqual(yield* coordinator.onObservation(projectless, principal), {
        outcome: "skipped",
        finding: null,
        evidenceCount: 0,
        reason: "missing-project",
      });
      assert.equal((yield* coordinator.onObservation(second, principal)).outcome, "ambiguous");
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM organization_intake_findings`)[0]?.count,
        1,
      );
      const current = yield* organizations.get({ organizationId: org });
      yield* organizations.detachProject({
        organizationId: org,
        mutationId: "coordinator-detach",
        baseRevision: current.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("coordinator-binding"),
      });
      assert.equal(
        (yield* Effect.flip(coordinator.onObservation(second, principal))).code,
        "forbidden",
      );
    }),
  );
});

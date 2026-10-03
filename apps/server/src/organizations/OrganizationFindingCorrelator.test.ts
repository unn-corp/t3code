import { assert, it } from "@effect/vitest";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration063 from "../persistence/Migrations/063_OrganizationFindingEvidence.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import { OrganizationIntakeStore, OrganizationIntakeStoreLive } from "./OrganizationIntakeStore.ts";
import {
  OrganizationFindingCorrelationAuthority,
  OrganizationFindingCorrelator,
  OrganizationFindingCorrelatorLayer,
} from "./OrganizationFindingCorrelator.ts";

const org = OrganizationId.make("correlation-org");
const project = ProjectId.make("correlation-project");
const layer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    OrganizationIntakeStoreLive,
    OrganizationFindingCorrelatorLayer,
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(OrganizationFindingCorrelationAuthority, {
        permits: (principal, target) =>
          principal.subject === "correlator" &&
          target.organizationId === org &&
          target.projectId === project,
      }),
    ),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);
const input = { organizationId: org, projectId: project, correlationKey: "incident-42" };
const observation = (id: string, sourceId: string, projectId: string | null, key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attributes = `{"correlationKey":"${key}"}`;
    yield* sql`INSERT INTO organization_intake_observations
      (observation_id, organization_id, source_id, project_id, external_event_id,
        dedup_key, occurred_at, received_at, title, body, attributes_json)
      VALUES (${id}, ${org}, ${sourceId}, ${projectId}, ${id}, ${id},
        '2026-01-01', '2026-01-01', 'Observed event', 'Evidence only', ${attributes})`;
  });

layer("Organization finding correlation", (it) => {
  it.effect("records exact cross-source provenance without creating work", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(organization_intake_findings)`;
      if (!columns.some((column) => column.name === "evidence_json")) yield* Migration063;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${project}, 'Correlation Project', '/tmp/correlation-project', '[]',
          '2026-01-01', '2026-01-01')`;
      const organizations = yield* OrganizationStore;
      const created = yield* organizations.create({
        organizationId: org,
        mutationId: "create-correlation-org",
        title: "Correlation Org",
        mission: "Investigate",
        actor: "user",
      });
      yield* organizations.bindProject({
        organizationId: org,
        mutationId: "bind-correlation-project",
        baseRevision: created.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("correlation-binding"),
        projectId: project,
        access: "proposal",
        capabilities: ["read-history", "propose-work"],
        scope: null,
      });
      for (const sourceId of ["source-a", "source-b"]) {
        yield* sql`INSERT INTO organization_intake_sources
          (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
            credential_version, created_at, updated_at)
          VALUES (${sourceId}, ${org}, ${project}, 'manual', ${sourceId}, 'human',
            1, 1, '2026-01-01', '2026-01-01')`;
      }
      yield* observation("obs-a", "source-a", project, "incident-42");
      yield* observation("obs-b", "source-b", project, "incident-42");
      const correlator = yield* OrganizationFindingCorrelator;
      assert.equal(
        (yield* Effect.flip(correlator.correlate(input, { subject: "untrusted" }))).code,
        "forbidden",
      );
      const createdFinding = yield* correlator.correlate(input, { subject: "correlator" });
      assert.equal(createdFinding.outcome, "created");
      assert.equal(createdFinding.finding?.state, "tentative");
      assert.equal(createdFinding.finding?.projectId, project);
      assert.deepStrictEqual(
        createdFinding.finding?.evidence.map((ref) => [
          String(ref.observationId),
          String(ref.sourceId),
          String(ref.projectId),
        ]),
        [
          ["obs-a", "source-a", String(project)],
          ["obs-b", "source-b", String(project)],
        ],
      );
      const replay = yield* correlator.correlate(input, { subject: "correlator" });
      assert.equal(replay.outcome, "duplicate");
      assert.equal(replay.finding?.id, createdFinding.finding?.id);
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM organization_work_items`)[0]?.count,
        0,
      );
      // A key on another explicit Project does not contaminate this group.
      yield* observation("obs-other-project", "source-a", "other-project", "incident-42");
      assert.equal(
        (yield* correlator.correlate(input, { subject: "correlator" })).outcome,
        "duplicate",
      );
      // A projectless event cannot be assigned to the requested Project.
      yield* observation("obs-unscoped", "source-a", null, "incident-42");
      assert.equal(
        (yield* correlator.correlate(input, { subject: "correlator" })).outcome,
        "ambiguous",
      );
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM organization_intake_findings`)[0]?.count,
        1,
      );
      // Existing single-source rows have no evidence_json and still decode.
      yield* sql`INSERT INTO organization_intake_findings
        (finding_id, organization_id, source_id, dedup_key, title, summary,
          observation_ids_json, state, created_at)
        VALUES ('legacy-finding', ${org}, 'source-a', 'legacy-key', 'Legacy',
          'Manual finding', '["obs-a"]', 'tentative', '2026-01-01')`;
      const legacy = (yield* (yield* OrganizationIntakeStore).listTentativeFindings(org)).find(
        (finding) => finding.id === "legacy-finding",
      );
      assert.equal(legacy?.projectId, null);
      assert.deepStrictEqual(
        legacy?.evidence.map((ref) => [ref.observationId, ref.sourceId]),
        [["obs-a", "source-a"]],
      );
    }),
  );
});

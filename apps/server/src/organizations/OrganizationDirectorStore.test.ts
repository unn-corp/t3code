import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { OrganizationBindingId, OrganizationId, ProjectId } from "@t3tools/contracts";
import { OrganizationDirectorRequestId } from "../../../../packages/contracts/src/organizationDirector.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import {
  OrganizationDirectorStore,
  OrganizationDirectorStoreLive,
} from "./OrganizationDirectorStore.ts";

const principal = { subject: "director-user", interactive: true } as const;
const layer = it.layer(
  Layer.mergeAll(OrganizationStoreLive, OrganizationDirectorStoreLive).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);
const prepare = (name: string) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const organizationId = OrganizationId.make(`director-org-${name}`);
    const projectId = ProjectId.make(`director-project-${name}`);
    const bindingId = OrganizationBindingId.make(`director-binding-${name}`);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, ${name}, ${`/tmp/${name}`}, '[]', '2026-01-01', '2026-01-01')`;
    const organizations = yield* OrganizationStore;
    const org = yield* organizations.create({
      organizationId,
      mutationId: `create-${name}`,
      title: name,
      mission: "Observe",
      actor: "user",
    });
    const bound = yield* organizations.bindProject({
      organizationId,
      mutationId: `bind-${name}`,
      baseRevision: org.draftRevision,
      actor: "user",
      bindingId,
      projectId,
      access: "read",
      capabilities: ["read-history"],
      scope: null,
    });
    return { organizationId, projectId, bindingId, revision: bound.draftRevision };
  });
const askInput = (
  organizationId: OrganizationId,
  projectId: ProjectId | null,
  requestId: string,
  prompt = "What is recorded?",
) => ({
  organizationId,
  projectId,
  requestId: OrganizationDirectorRequestId.make(requestId),
  prompt,
});

layer("Organization Director conversation", (it) => {
  it.effect("uses only persisted evidence and never invents investigation or completed work", () =>
    Effect.gen(function* () {
      const fixture = yield* prepare("evidence");
      const sql = yield* SqlClient.SqlClient;
      const sourceId = "director-source-evidence";
      yield* sql`INSERT INTO organization_intake_sources
        (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
          credential_version, created_at, updated_at)
        VALUES (${sourceId}, ${fixture.organizationId}, ${fixture.projectId}, 'manual',
          'source', 'director-user', 1, 1, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO organization_intake_observations
        (observation_id, organization_id, source_id, project_id, external_event_id,
          dedup_key, occurred_at, received_at, title, body, attributes_json)
        VALUES ('director-observation', ${fixture.organizationId}, ${sourceId},
          ${fixture.projectId}, 'event', 'key', '2026-01-01', '2026-01-01',
          'SECRET_SOURCE_TITLE', 'SECRET_SOURCE_BODY', '{}')`;
      yield* sql`INSERT INTO organization_intake_findings
        (finding_id, organization_id, source_id, dedup_key, title, summary,
          observation_ids_json, state, created_at, project_id, evidence_json)
        VALUES ('director-finding', ${fixture.organizationId}, ${sourceId},
          'finding-key', 'SECRET_FINDING_TITLE', 'SECRET_FINDING_SUMMARY',
          '["director-observation"]', 'tentative', '2026-01-01', ${fixture.projectId},
          '[{"observationId":"director-observation","sourceId":"director-source-evidence","projectId":"director-project-evidence"}]')`;
      const director = yield* OrganizationDirectorStore;
      const answer = yield* director.ask(
        askInput(
          fixture.organizationId,
          fixture.projectId,
          "evidence-request",
          "Please investigate and fix this.",
        ),
        principal,
      );
      assert.deepEqual(
        answer.directorMessage.evidence.map((entry) => entry.label),
        ["observed", "tentative"],
      );
      assert.match(answer.directorMessage.text, /Execution is unavailable/);
      assert.match(answer.directorMessage.text, /cost: unknown/);
      assert.equal(/SECRET_SOURCE|SECRET_FINDING/.test(answer.directorMessage.text), false);
      assert.equal(/verified work records: [1-9]/.test(answer.directorMessage.text), false);
      const retry = yield* director.ask(
        askInput(
          fixture.organizationId,
          fixture.projectId,
          "evidence-request",
          "Please investigate and fix this.",
        ),
        principal,
      );
      assert.deepEqual(retry, answer);
      const rows = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM organization_director_messages WHERE request_id = 'evidence-request'`;
      assert.equal(rows[0]?.count, 2);
      const conflict = yield* director
        .ask(
          askInput(
            fixture.organizationId,
            fixture.projectId,
            "evidence-request",
            "Changed question",
          ),
          principal,
        )
        .pipe(Effect.flip);
      assert.equal(conflict.code, "conflict");
    }),
  );

  it.effect("keeps exact Project scope, paginates, and retains history after detach", () =>
    Effect.gen(function* () {
      const first = yield* prepare("scope-one");
      const second = yield* prepare("scope-two");
      const sql = yield* SqlClient.SqlClient;
      const director = yield* OrganizationDirectorStore;
      const organizations = yield* OrganizationStore;
      yield* director.ask(
        askInput(first.organizationId, first.projectId, "scope-one-a"),
        principal,
      );
      yield* director.ask(askInput(first.organizationId, null, "scope-one-wide"), principal);
      yield* director.ask(
        askInput(second.organizationId, second.projectId, "scope-two-a"),
        principal,
      );
      const firstPage = yield* director.list({
        organizationId: first.organizationId,
        projectId: first.projectId,
        afterSequence: null,
        limit: 1,
      });
      assert.equal(firstPage.messages.length, 1);
      assert.ok(firstPage.nextCursor);
      const nextPage = yield* director.list({
        organizationId: first.organizationId,
        projectId: first.projectId,
        afterSequence: firstPage.nextCursor,
        limit: 1,
      });
      assert.equal(nextPage.messages.length, 1);
      assert.equal(nextPage.nextCursor, null);
      const wide = yield* director.list({
        organizationId: first.organizationId,
        projectId: null,
        afterSequence: null,
        limit: 50,
      });
      assert.equal(wide.messages.length, 2);
      assert.ok(wide.messages.every((message) => message.projectId === null));
      yield* sql`INSERT INTO organization_intake_sources
        (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
          credential_version, created_at, updated_at)
        VALUES ('director-old-source', ${first.organizationId}, ${first.projectId},
          'manual', 'old', 'director-user', 1, 1, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO organization_intake_observations
        (observation_id, organization_id, source_id, project_id, external_event_id,
          dedup_key, occurred_at, received_at, title, body, attributes_json)
        VALUES ('director-old-observation', ${first.organizationId}, 'director-old-source',
          ${first.projectId}, 'old-event', 'old-key', '2026-01-01', '2026-01-01',
          'old', 'old', '{}')`;
      const detached = yield* organizations.detachProject({
        organizationId: first.organizationId,
        mutationId: "detach-scope-one",
        baseRevision: first.revision,
        actor: "user",
        bindingId: first.bindingId,
      });
      const currentProjectId = ProjectId.make("director-current-project");
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${currentProjectId}, 'current', '/tmp/current', '[]', '2026-01-01', '2026-01-01')`;
      yield* organizations.bindProject({
        organizationId: first.organizationId,
        mutationId: "bind-current",
        baseRevision: detached.draftRevision,
        actor: "user",
        bindingId: OrganizationBindingId.make("director-current-binding"),
        projectId: currentProjectId,
        access: "read",
        capabilities: ["read-history"],
        scope: null,
      });
      yield* sql`INSERT INTO organization_intake_sources
        (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
          credential_version, created_at, updated_at)
        VALUES ('director-current-source', ${first.organizationId}, ${currentProjectId},
          'manual', 'current', 'director-user', 1, 1, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO organization_intake_observations
        (observation_id, organization_id, source_id, project_id, external_event_id,
          dedup_key, occurred_at, received_at, title, body, attributes_json)
        VALUES ('director-current-observation', ${first.organizationId},
          'director-current-source', ${currentProjectId}, 'current-event', 'current-key',
          '2026-01-01', '2026-01-01', 'current', 'current', '{}')`;
      const aggregate = yield* director.ask(
        askInput(
          first.organizationId,
          null,
          "scope-aggregate",
          "What needs attention across Projects?",
        ),
        principal,
      );
      assert.deepEqual(
        aggregate.directorMessage.evidence.map((entry) => entry.id),
        ["director-current-observation"],
      );
      const history = yield* director.list({
        organizationId: first.organizationId,
        projectId: first.projectId,
        afterSequence: null,
        limit: 50,
      });
      assert.equal(history.messages.length, 2);
      const denied = yield* director
        .ask(askInput(first.organizationId, first.projectId, "scope-after-detach"), principal)
        .pipe(Effect.flip);
      assert.equal(denied.code, "forbidden");
      const crossing = yield* director
        .ask(askInput(first.organizationId, second.projectId, "scope-cross-org"), principal)
        .pipe(Effect.flip);
      assert.equal(crossing.code, "forbidden");
    }),
  );
});

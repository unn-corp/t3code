import { assert, it } from "@effect/vitest";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationWorkflowId,
  ProjectId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrganizationTentativeFindingId } from "../../../../packages/contracts/src/organizationIntake.ts";
import {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";
import { OrganizationWorkStoreReadOnlyLive } from "./OrganizationWorkRuntimeLayers.ts";
import { runMigrations } from "../persistence/Migrations.ts";

const layer = it.layer(
  OrganizationWorkStoreReadOnlyLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

layer("Organization work production authorization", (it) => {
  it.effect("denies create and claim with the production execution policy", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrganizationWorkStore;
      const workId = OrganizationWorkId.make("production-denied-work");
      const organizationId = OrganizationId.make("production-denied-org");
      const findingId = OrganizationTentativeFindingId.make("production-denied-finding");
      const projectId = ProjectId.make("production-denied-project");
      const bindingId = OrganizationBindingId.make("production-denied-binding");
      const workflowId = OrganizationWorkflowId.make("production-denied-workflow");
      const principal = { subject: "authenticated-user" };
      const create = yield* Effect.flip(
        store.createWork(
          {
            workId,
            requestId: "production-denied-create",
            organizationId,
            findingId,
            projectId,
            bindingId,
            workflowId,
            scope: null,
            codeRevision: "base-revision",
            attemptLimit: 1,
          },
          principal,
        ),
      );
      assert.equal(create.code, "forbidden");
      // Claim authorization needs an existing work target, so seed a minimal valid row.
      yield* sql`INSERT INTO organizations
        (organization_id, title, mission, lifecycle, draft_revision, architect_role_id,
          director_role_id, graph_json, layout_json, created_at, updated_at)
        VALUES (${organizationId}, 'Denied Org', 'Test', 'active', 1, 'architect',
          'director', '{}', '{}', '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO organization_project_bindings
        (binding_id, organization_id, project_id, access, capabilities_json,
          created_at, updated_at)
        VALUES (${bindingId}, ${organizationId}, ${projectId}, 'write',
          '["write-files","run-tests"]', '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO organization_intake_sources
        (source_id, organization_id, kind, name, ingest_subject, enabled,
          credential_version, created_at, updated_at)
        VALUES ('denied-source', ${organizationId}, 'manual', 'Denied source', 'human',
          1, 1, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO organization_intake_findings
        (finding_id, organization_id, source_id, dedup_key, title, summary,
          observation_ids_json, state, created_at)
        VALUES (${findingId}, ${organizationId}, 'denied-source', 'denied-key',
          'Denied finding', '', '[]', 'tentative', '2026-01-01')`;
      yield* sql`INSERT INTO organization_work_items
        (work_id, request_id, request_json, organization_id, finding_id, project_id,
          binding_id, binding_version, published_revision, workflow_id, workflow_version,
          code_revision, status, attempt_limit, attempt_count, creator_subject,
          created_at, updated_at)
        VALUES (${workId}, 'seed-request', '{}', ${organizationId}, ${findingId},
          ${projectId}, ${bindingId}, '2026-01-01', 1, ${workflowId}, 1,
          'base-revision', 'pending', 1, 0, 'seed', '2026-01-01', '2026-01-01')`;
      const claim = yield* Effect.flip(
        store.claimAttempt(
          {
            workId,
            transitionId: "production-denied-claim",
            attemptId: OrganizationWorkAttemptId.make("production-denied-attempt"),
            leaseSeconds: 60,
          },
          principal,
        ),
      );
      assert.equal(claim.code, "forbidden");
    }),
  );
});

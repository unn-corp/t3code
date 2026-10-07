import { assert, it } from "@effect/vitest";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationRoleId,
  OrganizationWorkflowId,
  OrganizationWorkflowStepId,
  OrganizationWorkflowTransitionId,
  ProjectId,
} from "@t3tools/contracts";
import { OrganizationTentativeFindingId } from "../../../../packages/contracts/src/organizationIntake.ts";
import {
  OrganizationWorkId,
  OrganizationWorkAttemptId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration0070 from "../persistence/Migrations/070_OrganizationResourcePermits.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import {
  OrganizationWorkLaunchPlanner,
  OrganizationWorkLaunchPlannerLive,
} from "./OrganizationWorkLaunchPlanner.ts";
import {
  OrganizationWorkArtifactVerifier,
  OrganizationWorkApprovalVerifier,
  OrganizationWorkEvaluationVerifier,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifier,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

const coreLayer = Layer.mergeAll(OrganizationStoreLive, OrganizationWorkStoreLayer).pipe(
  Layer.provideMerge(
    Layer.succeed(GitVcsDriver.GitVcsDriver, {
      resolveCommit: (input: { readonly revision: string }) =>
        Effect.succeed({ commitSha: input.revision }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
  ),
  Layer.provideMerge(
    Layer.succeed(OrganizationWorkExecutionAuthority, {
      permits: (_action, _principal, target) =>
        target.organizationId === organizationId &&
        target.projectId === projectId &&
        target.bindingId === bindingId &&
        (target.workId === workId || target.workId === "work-2") &&
        target.scope === null,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(OrganizationWorkArtifactVerifier, {
      verifySubmitted: () => Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(OrganizationWorkEvaluationVerifier, {
      verifyEvaluation: () => Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(OrganizationWorkApprovalVerifier, {
      verifyApproval: () => Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(OrganizationWorkIntegrationVerifier, {
      verifyIntegration: () => Effect.void,
    }),
  ),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
const layer = it.layer(OrganizationWorkLaunchPlannerLive.pipe(Layer.provideMerge(coreLayer)));
const principal = (subject: string) => ({ subject });
const ConfigJson = Schema.fromJsonString(Schema.Unknown);
const decodeConfigJson = Schema.decodeUnknownSync(ConfigJson);
const encodeConfigJson = Schema.encodeSync(ConfigJson);
const organizationId = OrganizationId.make("work-org");
const projectId = ProjectId.make("work-project");
const bindingId = OrganizationBindingId.make("work-binding");
const findingId = OrganizationTentativeFindingId.make("work-finding");
const workId = OrganizationWorkId.make("work-1");
const stepId = OrganizationWorkflowStepId.make;
const transition = (id: string, from: string, to: string) => ({
  id: OrganizationWorkflowTransitionId.make(id),
  fromStepId: stepId(from),
  toStepId: stepId(to),
  maxTraversals: null,
});
const createInput = {
  workId,
  requestId: "create-work-1",
  organizationId,
  findingId,
  projectId,
  bindingId,
  workflowId: OrganizationWorkflowId.make("work-flow"),
  scope: null,
  codeRevision: "base-commit-1",
  attemptLimit: 2,
} as const;

const seed = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM organization_work_transitions`;
  yield* sql`DELETE FROM organization_work_resource_permits`;
  yield* sql`DELETE FROM organization_work_scope_preparations`;
  yield* sql`DELETE FROM organization_work_scopes`;
  yield* sql`DELETE FROM organization_work_resource_limits WHERE scope_kind != 'global'`;
  yield* sql`UPDATE organization_work_resource_limits SET max_active = 4
    WHERE scope_kind = 'global' AND scope_id = '*'`;
  yield* sql`DELETE FROM organization_work_attempts`;
  yield* sql`DELETE FROM organization_work_items`;
  yield* sql`DELETE FROM organization_intake_findings`;
  yield* sql`DELETE FROM organization_intake_correlation_jobs`;
  yield* sql`DELETE FROM organization_intake_observations`;
  yield* sql`DELETE FROM organization_intake_sources`;
  yield* sql`DELETE FROM organization_project_bindings`;
  yield* sql`DELETE FROM organization_config_versions`;
  yield* sql`DELETE FROM organization_audit`;
  yield* sql`DELETE FROM organizations`;
  yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Work Project', '/tmp/work-project', '[]', '2026-01-01', '2026-01-01')`;
  const orgs = yield* OrganizationStore;
  let state = yield* orgs.create({
    organizationId,
    mutationId: "work-create-org",
    title: "Work Org",
    mission: "Fix software",
    actor: "user",
  });
  state = yield* orgs.bindProject({
    organizationId,
    mutationId: "work-bind",
    baseRevision: state.draftRevision,
    actor: "user",
    bindingId,
    projectId,
    access: "write",
    capabilities: ["read-files", "write-files", "run-tests"],
    scope: null,
  });
  const worker = OrganizationRoleId.make("work-engineer");
  const qa = OrganizationRoleId.make("work-qa");
  for (const [roleId, kind] of [
    [worker, "engineering"],
    [qa, "qa"],
  ] as const) {
    state = yield* orgs.mutate({
      organizationId,
      mutationId: `add-${roleId}`,
      baseRevision: state.draftRevision,
      actor: "user",
      change: {
        type: "add-role",
        role: { id: roleId, kind, title: kind, mandate: kind, poolSize: 1 },
      },
    });
  }
  state = yield* orgs.mutate({
    organizationId,
    mutationId: "work-flow-add",
    baseRevision: state.draftRevision,
    actor: "user",
    change: {
      type: "upsert-workflow",
      workflow: {
        id: createInput.workflowId,
        title: "QA workflow",
        version: 1,
        steps: [
          {
            id: stepId("trigger"),
            kind: "trigger",
            title: "Start",
            roleId: null,
            reviewsStepId: null,
          },
          { id: stepId("work"), kind: "work", title: "Build", roleId: worker, reviewsStepId: null },
          {
            id: stepId("qa"),
            kind: "qa",
            title: "Check",
            roleId: qa,
            reviewsStepId: stepId("work"),
          },
          {
            id: stepId("approval"),
            kind: "approval",
            title: "Approve",
            roleId: state.directorRoleId,
            reviewsStepId: stepId("work"),
          },
          {
            id: stepId("integrate"),
            kind: "integrate",
            title: "Land",
            roleId: worker,
            reviewsStepId: null,
          },
          {
            id: stepId("finish"),
            kind: "finish",
            title: "Done",
            roleId: null,
            reviewsStepId: null,
          },
        ],
        transitions: [
          transition("t1", "trigger", "work"),
          transition("t2", "work", "qa"),
          transition("t3", "qa", "approval"),
          transition("t4", "approval", "integrate"),
          transition("t5", "integrate", "finish"),
        ],
      },
    },
  });
  yield* orgs.publish({
    organizationId,
    mutationId: "work-publish",
    baseRevision: state.draftRevision,
    actor: "user",
  });
  // Production activation remains unavailable; only this persistence fixture has a
  // reviewed permissive execution authority.
  yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${organizationId}`;
  yield* sql`INSERT INTO organization_intake_sources
    (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
      credential_version, created_at, updated_at)
    VALUES ('work-source', ${organizationId}, ${projectId}, 'manual', 'Work source',
      'human', 1, 1, '2026-01-01', '2026-01-01')`;
  yield* sql`INSERT INTO organization_intake_observations
    (observation_id, organization_id, source_id, project_id, external_event_id,
      dedup_key, occurred_at, received_at, title, body, attributes_json)
    VALUES ('work-observation', ${organizationId}, 'work-source', ${projectId},
      'event-1', 'issue-1', '2026-01-01', '2026-01-01', 'Bug', 'Reproduce', '{}')`;
  yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
      observation_ids_json, state, created_at)
    VALUES (${findingId}, ${organizationId}, 'work-source', 'issue-1', 'Bug',
      'Investigate', '["work-observation"]', 'tentative', '2026-01-01')`;
});

const markFixtureScopeStopped = (attemptId: OrganizationWorkAttemptId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO organization_work_scopes
      (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
       pid_namespace, prepared_at, start_requested_at, token_released_at, started_at,
       stop_requested_at, verified_stopped_at)
      VALUES (${attemptId}, ${`unit-${attemptId}`}, ${`inv-${attemptId}`},
       ${`/unit-${attemptId}`}, 12345, 67890,
       '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`;
  });

const createSecondWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secondFindingId = OrganizationTentativeFindingId.make("work-finding-2");
  const secondWorkId = OrganizationWorkId.make("work-2");
  yield* sql`INSERT INTO organization_intake_findings
    (finding_id, organization_id, source_id, dedup_key, title, summary,
      observation_ids_json, state, created_at)
    VALUES (${secondFindingId}, ${organizationId}, 'work-source', 'issue-2', 'Bug 2',
      'Investigate', '["work-observation"]', 'tentative', '2026-01-01')`;
  const work = yield* OrganizationWorkStore;
  yield* work.createWork(
    {
      ...createInput,
      workId: secondWorkId,
      findingId: secondFindingId,
      requestId: "create-work-2",
    },
    principal("creator"),
  );
  return secondWorkId;
});

layer("Organization work state", (it) => {
  it.effect(
    "holds a scoped permit until a verified stop and blocks renewal after stop request",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const work = yield* OrganizationWorkStore;
        yield* work.createWork(createInput, principal("creator"));
        const attemptId = OrganizationWorkAttemptId.make("scoped-attempt");
        yield* work.claimAttempt(
          { workId, transitionId: "scoped-claim", attemptId, leaseSeconds: 120 },
          principal("builder"),
        );
        yield* sql`INSERT INTO organization_work_scopes
        (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
          pid_namespace, prepared_at)
        VALUES (${attemptId}, 'scoped-unit', 'scoped-invocation',
          '/scoped-unit', 12345, 67890, '2026-01-01')`;
        assert.equal(
          (yield* Effect.flip(
            work.submitAttempt(
              {
                workId,
                transitionId: "scoped-submit",
                attemptId,
                artifactDigest: "a".repeat(64),
                artifactRef: "scoped-artifact",
              },
              principal("builder"),
            ),
          )).code,
          "conflict",
        );
        assert.equal(
          (yield* Effect.flip(
            work.cancelWork({ workId, transitionId: "scoped-cancel" }, principal("director")),
          )).code,
          "conflict",
        );
        yield* sql`UPDATE organization_work_scopes SET stop_requested_at = '2026-01-02'
        WHERE attempt_id = ${attemptId}`;
        assert.equal(
          (yield* Effect.flip(
            work.heartbeatAttempt(
              { workId, transitionId: "scoped-heartbeat", attemptId, leaseSeconds: 120 },
              principal("builder"),
            ),
          )).code,
          "conflict",
        );
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]?.state,
          "active",
        );
        // The scope store independently verifies the exact OS identity before
        // recording this timestamp. This fixture exercises the WorkStore fence.
        yield* sql`UPDATE organization_work_scopes SET verified_stopped_at = '2026-01-03'
        WHERE attempt_id = ${attemptId}`;
        yield* work.cancelWork({ workId, transitionId: "scoped-cancel" }, principal("director"));
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]?.state,
          "released",
        );
      }),
  );

  it.effect("does not reclaim an expired scoped permit before verified stop", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* work.createWork(createInput, principal("creator"));
      const attemptId = OrganizationWorkAttemptId.make("expired-scoped-attempt");
      yield* work.claimAttempt(
        { workId, transitionId: "expired-scoped-claim", attemptId, leaseSeconds: 120 },
        principal("builder"),
      );
      yield* sql`INSERT INTO organization_work_scopes
        (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
          pid_namespace, prepared_at, stop_requested_at)
        VALUES (${attemptId}, 'expired-scoped-unit', 'expired-scoped-invocation',
          '/expired-scoped-unit', 12346, 67891, '2026-01-01', '2026-01-02')`;
      yield* TestClock.adjust(Duration.seconds(121));
      assert.equal(
        (yield* Effect.flip(
          work.recoverExpired(
            { workId, transitionId: "expired-scoped-recover" },
            principal("recovery"),
          ),
        )).code,
        "conflict",
      );
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]?.state,
        "active",
      );
      yield* sql`UPDATE organization_work_scopes SET verified_stopped_at = '2026-01-03'
        WHERE attempt_id = ${attemptId}`;
      yield* work.recoverExpired(
        { workId, transitionId: "expired-scoped-recover" },
        principal("recovery"),
      );
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]?.state,
        "expired",
      );
    }),
  );

  it.effect("does not release a prepared but unidentified scope on expiry or cancellation", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* work.createWork(createInput, principal("creator"));
      const attemptId = OrganizationWorkAttemptId.make("ambiguous-preparation-attempt");
      yield* work.claimAttempt(
        { workId, transitionId: "ambiguous-preparation-claim", attemptId, leaseSeconds: 120 },
        principal("builder"),
      );
      yield* sql`INSERT INTO organization_work_scope_preparations
        (attempt_id, preparation_started_at) VALUES (${attemptId}, '2026-01-01')`;
      yield* TestClock.adjust(Duration.seconds(121));
      assert.equal(
        (yield* Effect.flip(
          work.recoverExpired(
            { workId, transitionId: "ambiguous-preparation-recover" },
            principal("recovery"),
          ),
        )).code,
        "conflict",
      );
      assert.equal(
        (yield* Effect.flip(
          work.cancelWork(
            { workId, transitionId: "ambiguous-preparation-cancel" },
            principal("director"),
          ),
        )).code,
        "conflict",
      );
      assert.equal((yield* work.getWork(workId)).work.status, "running");
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
          WHERE attempt_id = ${attemptId}`)[0]?.state,
        "active",
      );
      // A legacy marker cannot acquire an identity after an ambiguous launch.
      const attached = yield* Effect.exit(sql`INSERT INTO organization_work_scopes
        (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
          pid_namespace, prepared_at, stop_requested_at, verified_stopped_at)
        VALUES (${attemptId}, 'resolved-unit', 'resolved-invocation',
          '/resolved-unit', 12347, 67892, '2026-01-01', '2026-01-02', '2026-01-03')`);
      assert.equal(Exit.isFailure(attached), true);
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
          WHERE attempt_id = ${attemptId}`)[0]?.state,
        "active",
      );
    }),
  );

  it.effect("releases a reserved preparation only after its matching scope has verified stop", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* work.createWork(createInput, principal("creator"));
      const attemptId = OrganizationWorkAttemptId.make("reserved-preparation-attempt");
      const unitName = "t3-org-sandbox-00000000000000000000000000000001.scope";
      yield* work.claimAttempt(
        { workId, transitionId: "reserved-preparation-claim", attemptId, leaseSeconds: 120 },
        principal("builder"),
      );
      yield* sql`INSERT INTO organization_work_scope_preparations
        (attempt_id, preparation_started_at, unit_name)
        VALUES (${attemptId}, '2026-01-01', ${unitName})`;
      yield* sql`INSERT INTO organization_work_scopes
        (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
          pid_namespace, prepared_at, stop_requested_at, verified_stopped_at)
        VALUES (${attemptId}, ${unitName}, 'resolved-invocation',
          ${`/user.slice/${unitName}`}, 12347, 67892,
          '2026-01-01', '2026-01-02', '2026-01-03')`;
      yield* TestClock.adjust(Duration.seconds(121));
      yield* work.recoverExpired(
        { workId, transitionId: "reserved-preparation-recover" },
        principal("recovery"),
      );
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
          WHERE attempt_id = ${attemptId}`)[0]?.state,
        "expired",
      );
    }),
  );

  it.effect("plans only pinned work with a current write binding and full Git commit", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      const planner = yield* OrganizationWorkLaunchPlanner;
      yield* work.createWork(createInput, principal("creator"));
      assert.equal((yield* Effect.flip(planner.plan(workId))).code, "conflict");
      const commit = "a".repeat(40);
      yield* sql`UPDATE organization_work_items SET code_revision = ${commit}
        WHERE work_id = ${workId}`;
      const plan = yield* planner.plan(workId);
      assert.equal(plan.baseCommit, commit);
      assert.equal(plan.nextAttemptNumber, 1);
      assert.equal(plan.projectRoot, "/tmp/work-project");
      assert.match(plan.worktreeName, /^organization-[0-9a-f]{24}$/);
      yield* sql`UPDATE organization_project_bindings SET access = 'read'
        WHERE binding_id = ${bindingId}`;
      assert.equal((yield* Effect.flip(planner.plan(workId))).code, "forbidden");
      yield* sql`UPDATE organization_project_bindings SET access = 'write'
        WHERE binding_id = ${bindingId}`;
      yield* sql`UPDATE organization_work_items SET workflow_version = 2
        WHERE work_id = ${workId}`;
      assert.equal((yield* Effect.flip(planner.plan(workId))).code, "conflict");
      yield* sql`UPDATE organization_work_items SET workflow_version = 1
        WHERE work_id = ${workId}`;
      yield* sql`UPDATE organizations SET lifecycle = 'paused'
        WHERE organization_id = ${organizationId}`;
      assert.equal((yield* Effect.flip(planner.plan(workId))).code, "forbidden");
    }),
  );

  it.effect("requires read capability before creating or claiming QA-gated work", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      const configRow = (yield* sql<{ config_json: string }>`SELECT config_json
        FROM organization_config_versions WHERE organization_id = ${organizationId}`)[0];
      assert.ok(configRow);
      const config = decodeConfigJson(configRow.config_json) as {
        bindings: Array<{ capabilities: string[] }>;
      };
      const publishedJson = configRow.config_json;
      config.bindings[0]!.capabilities = ["write-files", "run-tests"];
      yield* sql`UPDATE organization_config_versions SET config_json = ${encodeConfigJson(config)}
        WHERE organization_id = ${organizationId}`;
      assert.equal(
        (yield* work.createWork(createInput, principal("creator")).pipe(Effect.flip)).code,
        "forbidden",
      );
      yield* sql`UPDATE organization_config_versions SET config_json = ${publishedJson}
        WHERE organization_id = ${organizationId}`;
      yield* work.createWork(createInput, principal("creator"));
      yield* sql`UPDATE organization_project_bindings
        SET capabilities_json = '["write-files","run-tests"]'
        WHERE binding_id = ${bindingId}`;
      assert.equal(
        (yield* work
          .claimAttempt(
            {
              workId,
              attemptId: OrganizationWorkAttemptId.make("readless-attempt"),
              transitionId: "readless-claim",
              leaseSeconds: 30,
            },
            principal("worker"),
          )
          .pipe(Effect.flip)).code,
        "forbidden",
      );
    }),
  );

  for (const scope of ["global", "organization", "project"] as const) {
    it.effect(`enforces the persisted ${scope} attempt ceiling and releases on submit`, () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const work = yield* OrganizationWorkStore;
        yield* work.createWork(createInput, principal("creator"));
        const secondWorkId = yield* createSecondWork;
        yield* sql`UPDATE organization_work_resource_limits SET max_active = ${scope === "global" ? 1 : 4}
          WHERE scope_kind = 'global' AND scope_id = '*'`;
        yield* sql`INSERT INTO organization_work_resource_limits (scope_kind, scope_id, max_active)
          VALUES ('organization', ${organizationId}, ${scope === "organization" ? 1 : 4})`;
        yield* sql`INSERT INTO organization_work_resource_limits (scope_kind, scope_id, max_active)
          VALUES ('project', ${projectId}, ${scope === "project" ? 1 : 4})`;
        const firstClaim = {
          workId,
          transitionId: `claim-${scope}-1`,
          attemptId: OrganizationWorkAttemptId.make(`attempt-${scope}-1`),
          leaseSeconds: 120,
        };
        const secondClaim = {
          workId: secondWorkId,
          transitionId: `claim-${scope}-2`,
          attemptId: OrganizationWorkAttemptId.make(`attempt-${scope}-2`),
          leaseSeconds: 120,
        };
        yield* work.claimAttempt(firstClaim, principal("builder"));
        assert.equal(
          (yield* Effect.flip(work.claimAttempt(secondClaim, principal("builder")))).code,
          "conflict",
        );
        assert.equal(
          (yield* sql<{ count: number }>`SELECT count(*) AS count
          FROM organization_work_attempts WHERE work_id = ${secondWorkId}`)[0]?.count,
          0,
        );
        if (scope === "global") {
          const withoutScope = yield* Effect.flip(
            work.submitAttempt(
              {
                workId,
                transitionId: "submit-without-scope",
                attemptId: firstClaim.attemptId,
                artifactDigest: "a".repeat(64),
                artifactRef: "artifact-without-scope",
              },
              principal("builder"),
            ),
          );
          assert.equal(withoutScope.code, "conflict");
        }
        yield* markFixtureScopeStopped(firstClaim.attemptId);
        yield* work.submitAttempt(
          {
            workId,
            transitionId: `submit-${scope}`,
            attemptId: firstClaim.attemptId,
            artifactDigest: "a".repeat(64),
            artifactRef: `artifact-${scope}`,
          },
          principal("builder"),
        );
        yield* work.claimAttempt(secondClaim, principal("builder"));
        const permits = yield* sql<{ state: string }>`SELECT state
          FROM organization_work_resource_permits ORDER BY attempt_id`;
        assert.deepEqual(
          permits.map((row) => row.state),
          ["released", "active"],
        );
      }),
    );
  }

  it.effect("expired lease still holds capacity until recovery records permit expiry", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* work.createWork(createInput, principal("creator"));
      const secondWorkId = yield* createSecondWork;
      const firstAttemptId = OrganizationWorkAttemptId.make("lease-attempt-1");
      yield* work.claimAttempt(
        { workId, transitionId: "lease-claim-1", attemptId: firstAttemptId, leaseSeconds: 120 },
        principal("builder"),
      );
      yield* TestClock.adjust(Duration.seconds(121));
      const secondClaim = {
        workId: secondWorkId,
        transitionId: "lease-claim-2",
        attemptId: OrganizationWorkAttemptId.make("lease-attempt-2"),
        leaseSeconds: 120,
      };
      assert.equal(
        (yield* Effect.flip(work.claimAttempt(secondClaim, principal("builder")))).code,
        "conflict",
      );
      assert.equal(
        (yield* Effect.flip(
          work.heartbeatAttempt(
            {
              workId,
              transitionId: "lease-heartbeat-late",
              attemptId: firstAttemptId,
              leaseSeconds: 120,
            },
            principal("builder"),
          ),
        )).code,
        "conflict",
      );
      yield* work.recoverExpired({ workId, transitionId: "lease-recover" }, principal("recovery"));
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${firstAttemptId}`)[0]?.state,
        "expired",
      );
      yield* work.claimAttempt(secondClaim, principal("builder"));
      assert.equal((yield* work.getWork(workId)).work.status, "recovering");
    }),
  );

  it.effect("cancel releases a running permit without authorizing execution", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* work.createWork(createInput, principal("creator"));
      const secondWorkId = yield* createSecondWork;
      const attemptId = OrganizationWorkAttemptId.make("cancel-permit-attempt");
      yield* work.claimAttempt(
        { workId, transitionId: "cancel-permit-claim", attemptId, leaseSeconds: 120 },
        principal("builder"),
      );
      yield* work.cancelWork({ workId, transitionId: "cancel-permit" }, principal("director"));
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]?.state,
        "released",
      );
      assert.equal(
        (yield* work.claimAttempt(
          {
            workId: secondWorkId,
            transitionId: "cancel-permit-next",
            attemptId: OrganizationWorkAttemptId.make("next"),
            leaseSeconds: 120,
          },
          principal("builder"),
        )).work.status,
        "running",
      );
    }),
  );

  it.effect("migration backfills a running attempt and fences even an expired lease", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* work.createWork(createInput, principal("creator"));
      const secondWorkId = yield* createSecondWork;
      const attemptId = OrganizationWorkAttemptId.make("legacy-attempt");
      yield* work.claimAttempt(
        { workId, transitionId: "legacy-claim", attemptId, leaseSeconds: 120 },
        principal("builder"),
      );
      yield* TestClock.adjust(Duration.seconds(121));
      // Recreate the migration against a database with a pre-070 running attempt.
      yield* sql`DROP TABLE organization_work_resource_permits`;
      yield* sql`DROP TABLE organization_work_resource_limits`;
      yield* Migration0070;
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state
        FROM organization_work_resource_permits WHERE attempt_id = ${attemptId}`)[0]?.state,
        "active",
      );
      const nextClaim = {
        workId: secondWorkId,
        transitionId: "legacy-next",
        attemptId: OrganizationWorkAttemptId.make("legacy-next-attempt"),
        leaseSeconds: 120,
      };
      assert.equal(
        (yield* Effect.flip(work.claimAttempt(nextClaim, principal("builder")))).code,
        "conflict",
      );
      assert.equal(
        (yield* work.recoverExpired(
          { workId, transitionId: "legacy-recover" },
          principal("recovery"),
        )).work.status,
        "recovering",
      );
      yield* work.claimAttempt(nextClaim, principal("builder"));
    }),
  );
  it.effect("never creates work while the runtime is draft or paused", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      for (const lifecycle of ["paused", "draft"] as const) {
        yield* sql`UPDATE organizations SET lifecycle = ${lifecycle}
          WHERE organization_id = ${organizationId}`;
        assert.equal(
          (yield* Effect.flip(work.createWork(createInput, principal("creator")))).code,
          "forbidden",
        );
      }
      assert.equal((yield* work.listWork(organizationId)).length, 0);
    }),
  );

  it.effect("pins authorized findings, rejects revoked writes, and preserves retry identity", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* sql`UPDATE organization_project_bindings SET access = 'proposal'
        WHERE binding_id = ${bindingId}`;
      assert.equal(
        (yield* Effect.flip(work.createWork(createInput, principal("creator")))).code,
        "forbidden",
      );
      yield* sql`UPDATE organization_project_bindings SET access = 'write'
        WHERE binding_id = ${bindingId}`;
      yield* sql`UPDATE organization_intake_observations SET project_id = NULL
        WHERE observation_id = 'work-observation'`;
      assert.equal(
        (yield* Effect.flip(work.createWork(createInput, principal("creator")))).code,
        "forbidden",
      );
      yield* sql`UPDATE organization_intake_observations SET project_id = ${projectId}
        WHERE observation_id = 'work-observation'`;
      const created = yield* work.createWork(createInput, principal("creator"));
      assert.equal(created.work.status, "pending");
      assert.equal(created.work.workflowVersion, 1);
      assert.equal(created.work.bindingId, bindingId);
      assert.deepStrictEqual(yield* work.createWork(createInput, principal("creator")), created);
      assert.equal((yield* work.listWork(organizationId)).length, 1);
      assert.equal(
        (yield* Effect.flip(
          work.createWork({ ...createInput, codeRevision: "changed" }, principal("creator")),
        )).code,
        "conflict",
      );
      const claim = {
        workId,
        transitionId: "claim-1",
        attemptId: OrganizationWorkAttemptId.make("attempt-1"),
        leaseSeconds: 120,
      };
      yield* sql`UPDATE organizations SET lifecycle = 'paused' WHERE organization_id = ${organizationId}`;
      assert.equal(
        (yield* Effect.flip(work.claimAttempt(claim, principal("builder")))).code,
        "forbidden",
      );
      // Runtime activation is unavailable in production. Simulate a reviewed executor only here.
      yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${organizationId}`;
      yield* sql`UPDATE organization_project_bindings SET access = 'proposal'
        WHERE binding_id = ${bindingId}`;
      assert.equal(
        (yield* Effect.flip(work.claimAttempt(claim, principal("builder")))).code,
        "forbidden",
      );
      yield* sql`UPDATE organization_project_bindings SET access = 'write'
        WHERE binding_id = ${bindingId}`;
      const running = yield* work.claimAttempt(claim, principal("builder"));
      assert.equal(running.work.status, "running");
      assert.equal(running.attempts[0]?.workerSubject, "builder");
      assert.equal((yield* work.claimAttempt(claim, principal("builder"))).work.attemptCount, 1);
      assert.equal(
        (yield* Effect.flip(
          work.claimAttempt({ ...claim, leaseSeconds: 100 }, principal("builder")),
        )).code,
        "conflict",
      );
      yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-02'
        WHERE binding_id = ${bindingId}`;
      const digest = "a".repeat(64);
      assert.equal(
        (yield* Effect.flip(
          work.submitAttempt(
            {
              workId,
              transitionId: "submit-denied",
              attemptId: claim.attemptId,
              artifactDigest: digest,
              artifactRef: "artifact-1",
            },
            principal("builder"),
          ),
        )).code,
        "forbidden",
      );
      assert.equal((yield* work.getWork(workId)).work.status, "running");
      yield* sql`UPDATE organizations SET lifecycle = 'paused' WHERE organization_id = ${organizationId}`;
      assert.equal(
        (yield* work.cancelWork({ workId, transitionId: "cancel-paused" }, principal("director")))
          .work.status,
        "canceled",
      );
    }),
  );

  it.effect("requires independent QA and approval; expired attempts enter explicit recovery", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* work.createWork(createInput, principal("creator"));
      yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${organizationId}`;
      const attemptId = OrganizationWorkAttemptId.make("attempt-1");
      yield* work.claimAttempt(
        { workId, transitionId: "claim-1", attemptId, leaseSeconds: 120 },
        principal("builder"),
      );
      yield* sql`UPDATE organization_work_attempts SET lease_until = '1900-01-01'
        WHERE attempt_id = ${attemptId}`;
      yield* sql`UPDATE organizations SET lifecycle = 'paused' WHERE organization_id = ${organizationId}`;
      assert.equal(
        (yield* sql<{ lease_until: string }>`SELECT lease_until FROM organization_work_attempts
        WHERE attempt_id = ${attemptId}`)[0]?.lease_until,
        "1900-01-01",
      );
      assert.equal(
        (yield* work.recoverExpired({ workId, transitionId: "recover-1" }, principal("recovery")))
          .work.status,
        "recovering",
      );
      assert.equal(
        (yield* work.resolveRecovery(
          {
            workId,
            transitionId: "resolve-1",
            attemptId,
            disposition: "safe-to-retry",
            evidenceRef: "reconciled-1",
          },
          principal("recovery"),
        )).work.status,
        "retrying",
      );
      yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${organizationId}`;
      const secondId = OrganizationWorkAttemptId.make("attempt-2");
      yield* work.claimAttempt(
        { workId, transitionId: "claim-2", attemptId: secondId, leaseSeconds: 120 },
        principal("builder"),
      );
      const digest = "b".repeat(64);
      yield* markFixtureScopeStopped(secondId);
      yield* work.submitAttempt(
        {
          workId,
          transitionId: "submit-2",
          attemptId: secondId,
          artifactDigest: digest,
          artifactRef: "artifact-2",
        },
        principal("builder"),
      );
      const evaluation = {
        workId,
        transitionId: "qa-2",
        attemptId: secondId,
        accepted: true,
        artifactDigest: digest,
        evidenceRef: "qa-proof-2",
      };
      assert.equal(
        (yield* Effect.flip(work.evaluateAttempt(evaluation, principal("builder")))).code,
        "forbidden",
      );
      assert.equal(
        (yield* work.evaluateAttempt(evaluation, principal("qa"))).work.status,
        "waiting-approval",
      );
      const approval = {
        workId,
        transitionId: "approve-2",
        attemptId: secondId,
        approved: true,
        artifactDigest: digest,
        evidenceRef: "approval-2",
      };
      assert.equal(
        (yield* Effect.flip(work.recordApproval(approval, principal("qa")))).code,
        "forbidden",
      );
      assert.equal(
        (yield* work.recordApproval(approval, principal("director"))).work.status,
        "blocked",
      );
      const integration = {
        workId,
        transitionId: "integrate-2",
        attemptId: secondId,
        artifactDigest: digest,
        baseCodeRevision: "base-commit-1",
        resultCodeRevision: "result-commit-1",
        receiptRef: "integration-receipt",
      };
      assert.equal(
        (yield* Effect.flip(
          work.recordIntegration(
            { ...integration, baseCodeRevision: "wrong" },
            principal("integrator"),
          ),
        )).code,
        "conflict",
      );
      const succeeded = yield* work.recordIntegration(integration, principal("integrator"));
      assert.equal(succeeded.work.status, "succeeded");
      assert.equal(succeeded.work.resultCodeRevision, "result-commit-1");
      assert.equal(succeeded.attempts[1]?.qaSubject, "qa");
    }),
  );

  it.effect("pausing blocks each forward transition until active authority is restored", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const work = yield* OrganizationWorkStore;
      yield* work.createWork(createInput, principal("creator"));
      yield* sql`UPDATE organizations SET lifecycle = 'active' WHERE organization_id = ${organizationId}`;
      const attemptId = OrganizationWorkAttemptId.make("pause-attempt");
      yield* work.claimAttempt(
        { workId, transitionId: "pause-claim", attemptId, leaseSeconds: 120 },
        principal("builder"),
      );
      const paused = sql`UPDATE organizations SET lifecycle = 'paused'
        WHERE organization_id = ${organizationId}`;
      const active = sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${organizationId}`;
      yield* paused;
      const heartbeat = { workId, transitionId: "pause-heartbeat", attemptId, leaseSeconds: 120 };
      assert.equal(
        (yield* Effect.flip(work.heartbeatAttempt(heartbeat, principal("builder")))).code,
        "forbidden",
      );
      const digest = "c".repeat(64);
      const submit = {
        workId,
        transitionId: "pause-submit",
        attemptId,
        artifactDigest: digest,
        artifactRef: "artifact-paused",
      };
      assert.equal(
        (yield* Effect.flip(work.submitAttempt(submit, principal("builder")))).code,
        "forbidden",
      );
      yield* sql`UPDATE organizations SET lifecycle = 'archived'
        WHERE organization_id = ${organizationId}`;
      assert.equal(
        (yield* Effect.flip(work.heartbeatAttempt(heartbeat, principal("builder")))).code,
        "forbidden",
      );
      assert.equal(
        (yield* Effect.flip(work.submitAttempt(submit, principal("builder")))).code,
        "forbidden",
      );
      yield* active;
      yield* sql`UPDATE organization_project_bindings SET access = 'proposal'
        WHERE binding_id = ${bindingId}`;
      assert.equal(
        (yield* Effect.flip(work.heartbeatAttempt(heartbeat, principal("builder")))).code,
        "forbidden",
      );
      yield* sql`UPDATE organization_project_bindings SET access = 'write'
        WHERE binding_id = ${bindingId}`;
      yield* work.heartbeatAttempt(heartbeat, principal("builder"));
      yield* markFixtureScopeStopped(attemptId);
      yield* work.submitAttempt(submit, principal("builder"));
      const evaluate = {
        workId,
        transitionId: "pause-evaluate",
        attemptId,
        accepted: true,
        artifactDigest: digest,
        evidenceRef: "qa-paused",
      };
      yield* paused;
      assert.equal(
        (yield* Effect.flip(work.evaluateAttempt(evaluate, principal("qa")))).code,
        "forbidden",
      );
      yield* active;
      yield* work.evaluateAttempt(evaluate, principal("qa"));
      const approval = {
        workId,
        transitionId: "pause-approval",
        attemptId,
        approved: true,
        artifactDigest: digest,
        evidenceRef: "approved-paused",
      };
      yield* paused;
      assert.equal(
        (yield* Effect.flip(work.recordApproval(approval, principal("director")))).code,
        "forbidden",
      );
      yield* active;
      yield* work.recordApproval(approval, principal("director"));
      const integration = {
        workId,
        transitionId: "pause-integration",
        attemptId,
        artifactDigest: digest,
        baseCodeRevision: "base-commit-1",
        resultCodeRevision: "result-paused",
        receiptRef: "integration-paused",
      };
      yield* paused;
      assert.equal(
        (yield* Effect.flip(work.recordIntegration(integration, principal("integrator")))).code,
        "forbidden",
      );
      assert.equal((yield* work.getWork(workId)).work.status, "blocked");
      yield* active;
      assert.equal(
        (yield* work.recordIntegration(integration, principal("integrator"))).work.status,
        "succeeded",
      );
    }),
  );

  it.effect("accepts cross-source evidence only when each source and Project match reality", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO organization_intake_sources
        (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
          credential_version, created_at, updated_at)
        VALUES ('work-source-b', ${organizationId}, ${projectId}, 'manual', 'Second source',
          'human', 1, 1, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO organization_intake_observations
        (observation_id, organization_id, source_id, project_id, external_event_id,
          dedup_key, occurred_at, received_at, title, body, attributes_json)
        VALUES ('work-observation-b', ${organizationId}, 'work-source-b', ${projectId},
          'event-b', 'issue-b', '2026-01-01', '2026-01-01', 'Bug', 'Independent evidence', '{}')`;
      const wrongProvenance =
        '[{"observationId":"work-observation","sourceId":"work-source","projectId":"work-project"},{"observationId":"work-observation-b","sourceId":"work-source","projectId":"work-project"}]';
      yield* sql`UPDATE organization_intake_findings
        SET project_id = ${projectId},
          observation_ids_json = '["work-observation","work-observation-b"]',
          evidence_json = ${wrongProvenance}
        WHERE finding_id = ${findingId}`;
      const work = yield* OrganizationWorkStore;
      assert.equal(
        (yield* Effect.flip(work.createWork(createInput, principal("creator")))).code,
        "forbidden",
      );
      const correctProvenance =
        '[{"observationId":"work-observation","sourceId":"work-source","projectId":"work-project"},{"observationId":"work-observation-b","sourceId":"work-source-b","projectId":"work-project"}]';
      yield* sql`UPDATE organization_intake_findings SET evidence_json = ${correctProvenance}
        WHERE finding_id = ${findingId}`;
      assert.equal(
        (yield* work.createWork(createInput, principal("creator"))).work.status,
        "pending",
      );
    }),
  );
});

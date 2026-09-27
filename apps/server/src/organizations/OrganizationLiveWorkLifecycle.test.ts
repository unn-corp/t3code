// @effect-diagnostics nodeBuiltinImport:off - Disposable child verifies Linux pidfd recovery.
import * as NodeChildProcess from "node:child_process";
import { assert, it } from "@effect/vitest";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationWorkId,
  ProjectId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationLiveWorkRuntimeReadiness } from "./OrganizationLiveWorkExecutor.ts";
import {
  OrganizationLiveWorkDrainDeferred,
  readOrganizationWorkDrain,
  reconcileOrganizationWorkDrainsAfterRecovery,
  requestOrganizationWorkDrain,
  withOrganizationLiveWorkPhaseClaim,
} from "./OrganizationLiveWorkDrain.ts";
import {
  OrganizationLiveWorkEmergencyDeferred,
  makeOrganizationEmergencyProviderObserver,
  readOrganizationEmergencyStop,
  reconcileOrganizationEmergencyStopsAfterRecovery,
  requestOrganizationEmergencyStop,
  stopAndVerifyOrganizationEmergencyScopes,
} from "./OrganizationLiveWorkEmergencyStop.ts";
import { organizationQABrokerOperationPrefix } from "./OrganizationScopedBrokerHosts.ts";
import { recoverOrganizationProviderProcessesAtStartup } from "./OrganizationProviderProcessRecovery.ts";
import {
  cancelActivatedOrganizationWork,
  resumePausedOrganization,
} from "./OrganizationLiveWorkLifecycle.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";

let ready = true;
const testLayer = it.layer(
  Layer.mergeAll(
    OrganizationStoreLive,
    Layer.succeed(OrganizationLiveWorkRuntimeReadiness, {
      status: () => ({ ready, reason: ready ? "ready" : "not_ready" }),
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
let serial = 0;
const stamp = "2026-01-01T00:00:00.000Z";
const interactive = { subject: "human-a", interactive: true } as const;

const seed = Effect.gen(function* () {
  yield* runMigrations();
  const tag = `lifecycle-${++serial}`;
  const organizationId = OrganizationId.make(`${tag}-org`);
  const projectId = ProjectId.make(`${tag}-project`);
  const bindingId = OrganizationBindingId.make(`${tag}-binding`);
  const workId = OrganizationWorkId.make(`${tag}-work`);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, ${tag}, ${`/tmp/${tag}`}, '[]', ${stamp}, ${stamp})`;
  const store = yield* OrganizationStore;
  let org = yield* store.create({
    organizationId,
    mutationId: `${tag}-create`,
    title: tag,
    mission: "Maintain a Project",
    actor: "user",
  });
  org = yield* store.bindProject({
    organizationId,
    mutationId: `${tag}-bind`,
    baseRevision: org.draftRevision,
    actor: "user",
    bindingId,
    projectId,
    access: "write",
    capabilities: ["propose-work", "read-files", "write-files", "run-tests"],
    scope: null,
  });
  org = yield* store.publish({
    organizationId,
    mutationId: `${tag}-publish`,
    baseRevision: org.draftRevision,
    actor: "user",
  });
  return {
    tag,
    org,
    organizationId,
    projectId,
    bindingId,
    bindingVersion: org.bindings[0]!.updatedAt,
    workId,
  };
});

const seedActivatedWork = (fixture: {
  readonly tag: string;
  readonly org: { readonly publishedRevision: number | null };
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly bindingId: OrganizationBindingId;
  readonly bindingVersion: string;
  readonly workId: OrganizationWorkId;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { tag, organizationId, projectId, bindingId, bindingVersion, workId } = fixture;
    const sourceId = `${tag}-source`;
    const findingId = `${tag}-finding`;
    const proposalId = `${tag}-proposal`;
    const intentId = `${tag}-intent`;
    yield* sql`INSERT INTO organization_intake_sources
      (source_id, organization_id, project_id, kind, name, ingest_subject,
        enabled, credential_version, created_at, updated_at)
      VALUES (${sourceId}, ${organizationId}, ${projectId}, 'manual', 'Source',
        'human-a', 1, 1, ${stamp}, ${stamp})`;
    yield* sql`INSERT INTO organization_intake_findings
      (finding_id, organization_id, source_id, dedup_key, title, summary,
        observation_ids_json, state, created_at)
      VALUES (${findingId}, ${organizationId}, ${sourceId}, ${findingId},
        'Fix', 'Fix a bug', '[]', 'tentative', ${stamp})`;
    yield* sql`INSERT INTO organization_work_proposals
      (proposal_id, organization_id, finding_id, project_id, binding_id,
        binding_version, published_revision, evidence_json, title, summary,
        state, version, created_at, updated_at)
      VALUES (${proposalId}, ${organizationId}, ${findingId}, ${projectId}, ${bindingId},
        ${bindingVersion}, ${fixture.org.publishedRevision}, '{}', 'Fix', 'Fix a bug',
        'proposed', 1, ${stamp}, ${stamp})`;
    yield* sql`INSERT INTO organization_work_intents
      (intent_id, organization_id, proposal_id, proposal_version, finding_id,
        project_id, binding_id, binding_version, published_revision, evidence_json,
        requested_by, created_at)
      VALUES (${intentId}, ${organizationId}, ${proposalId}, 1, ${findingId},
        ${projectId}, ${bindingId}, ${bindingVersion}, ${fixture.org.publishedRevision},
        '{}', 'human-a', ${stamp})`;
    yield* sql`INSERT INTO organization_work_items
      (work_id, request_id, request_json, organization_id, finding_id,
        project_id, binding_id, binding_version, scope, published_revision,
        workflow_id, workflow_version, code_revision, status, attempt_limit,
        creator_subject, created_at, updated_at)
      VALUES (${workId}, ${`${tag}-request`}, '{}', ${organizationId}, ${findingId},
        ${projectId}, ${bindingId}, ${bindingVersion}, NULL, ${fixture.org.publishedRevision},
        ${`${tag}-workflow`}, 1, ${"a".repeat(40)}, 'pending', 2,
        'human-a', ${stamp}, ${stamp})`;
    yield* sql`INSERT INTO organization_work_intent_activations
      (intent_id, organization_id, work_id, selection_json, activated_by, activated_at)
      VALUES (${intentId}, ${organizationId}, ${workId}, '{}', 'human-a', ${stamp})`;
  });

testLayer("Organization live work lifecycle", (it) => {
  it.effect("clears an uncertain provider launch only after a different Linux boot", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return;
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const sql = yield* SqlClient.SqlClient;
      const observer = makeOrganizationEmergencyProviderObserver(
        fixture.organizationId,
        fixture.workId,
        sql,
      );
      yield* observer.preparing();
      const row = (yield* sql<{ launch_marker: string }>`SELECT launch_marker
        FROM organization_provider_processes WHERE work_id = ${fixture.workId}`)[0]!;
      const parts = row.launch_marker.split("|");
      const previousBoot = `${parts[0]}|${parts[1]}|00000000-0000-0000-0000-000000000000`;
      yield* sql`UPDATE organization_provider_processes SET launch_marker = ${previousBoot}
        WHERE work_id = ${fixture.workId}`;
      assert.deepEqual((yield* recoverOrganizationProviderProcessesAtStartup).held, []);
      assert.equal(
        (yield* readOrganizationEmergencyStop(fixture.organizationId)).unverifiedProviderLaunches,
        0,
      );
    }),
  );
  it.effect("recovers a crash-gap provider by its durable marker and exact pidfd", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return;
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const sql = yield* SqlClient.SqlClient;
      const observer = makeOrganizationEmergencyProviderObserver(
        fixture.organizationId,
        fixture.workId,
        sql,
      );
      yield* observer.preparing();
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          env: { ...process.env, ...observer.environment },
          detached: true,
          stdio: "ignore",
        },
      );
      try {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              child.once("spawn", () => resolve());
              child.once("error", reject);
            }),
        );
        const recovered = yield* recoverOrganizationProviderProcessesAtStartup;
        assert.deepEqual(recovered.held, []);
        assert.equal(
          (yield* readOrganizationEmergencyStop(fixture.organizationId)).unverifiedProviderLaunches,
          0,
        );
      } finally {
        child.kill("SIGKILL");
      }
    }),
  );
  it.effect("holds startup readiness for a durable provider launch until exact exit is saved", () =>
    Effect.gen(function* () {
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const sql = yield* SqlClient.SqlClient;
      const observer = makeOrganizationEmergencyProviderObserver(
        fixture.organizationId,
        fixture.workId,
        sql,
      );
      const broker = {
        checkOwner: async () => true,
        status: async () => [],
        stopAndVerifyOperation: async (operationId: string) => ({
          operationId,
          disposition: "never-dispatched" as const,
          identity: null,
        }),
      };
      yield* observer.preparing();
      assert.equal(
        (yield* recoverOrganizationProviderProcessesAtStartup).held[0]?.reason,
        "provider_exit_unverified",
      );
      yield* sql`UPDATE organization_provider_processes SET launch_marker = NULL
        WHERE work_id = ${fixture.workId}`;
      assert.equal(
        (yield* readOrganizationEmergencyStop(fixture.organizationId)).unverifiedProviderLaunches,
        1,
      );
      const held = yield* reconcileOrganizationEmergencyStopsAfterRecovery(broker);
      assert.equal(held.held[0]?.reason, "provider_identity_unavailable");
      yield* sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${fixture.organizationId}`;
      yield* requestOrganizationEmergencyStop(
        { organizationId: fixture.organizationId, requestId: `${fixture.tag}-emergency` },
        interactive,
      );
      const handle = { pid: 54321 } as ChildProcessSpawner.ChildProcessHandle;
      yield* observer.spawned(handle);
      yield* observer.exited(handle);
      const status = yield* readOrganizationEmergencyStop(fixture.organizationId);
      assert.equal(status.unverifiedProviderLaunches, 0);
      assert.equal(status.verifiedProviderExits, 1);
      assert.deepEqual((yield* reconcileOrganizationEmergencyStopsAfterRecovery(broker)).held, []);
    }),
  );
  it.effect(
    "stops only exact worker and QA journal operations linked to an emergency Organization",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seed;
        yield* seedActivatedWork(fixture);
        const sql = yield* SqlClient.SqlClient;
        const attemptId = `${fixture.tag}-attempt`;
        yield* sql`INSERT INTO organization_work_attempts
        (attempt_id, work_id, number, status, worker_subject, lease_until,
          started_at, updated_at)
        VALUES (${attemptId}, ${fixture.workId}, 1, 'running', 'worker-a',
          '2099-01-01T00:00:00.000Z', ${stamp}, ${stamp})`;
        yield* sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${fixture.organizationId}`;
        yield* requestOrganizationEmergencyStop(
          { organizationId: fixture.organizationId, requestId: `${fixture.tag}-emergency` },
          interactive,
        );
        const qaId = `${organizationQABrokerOperationPrefix(attemptId)}qa-1`;
        const entries = [attemptId, qaId, "unrelated-attempt"];
        const called: string[] = [];
        let holdQA = true;
        const broker = {
          checkOwner: async () => true,
          status: async () =>
            entries.map((operationId) => ({
              operationId,
              unitName: "unit",
              phase: "prepared",
              identity: null,
            })),
          stopAndVerifyOperation: async (operationId: string) => {
            called.push(operationId);
            return {
              operationId,
              disposition:
                operationId === qaId && holdQA ? ("held" as const) : ("never-dispatched" as const),
              identity: null,
            };
          },
        };
        const first = yield* stopAndVerifyOrganizationEmergencyScopes(
          fixture.organizationId,
          broker,
        );
        assert.deepEqual(first.verified, [attemptId]);
        assert.deepEqual(first.held, [qaId]);
        const lostOwner = yield* stopAndVerifyOrganizationEmergencyScopes(fixture.organizationId, {
          ...broker,
          checkOwner: async () => false,
        }).pipe(Effect.flip);
        assert.match(lostOwner.message, /owner is unavailable/);
        assert.equal(
          (yield* readOrganizationEmergencyStop(fixture.organizationId)).verifiedScopes,
          1,
        );
        assert.equal(
          (yield* reconcileOrganizationEmergencyStopsAfterRecovery(broker)).held.length,
          1,
        );
        holdQA = false;
        const retry = yield* stopAndVerifyOrganizationEmergencyScopes(
          fixture.organizationId,
          broker,
        );
        assert.deepEqual(retry.held, []);
        assert.deepEqual(
          (yield* reconcileOrganizationEmergencyStopsAfterRecovery(broker)).held,
          [],
        );
        assert.equal(
          (yield* readOrganizationEmergencyStop(fixture.organizationId)).verifiedScopes,
          2,
        );
        assert.equal(called.includes("unrelated-attempt"), false);
      }),
  );
  it.effect("commits an emergency fence before interrupting an admitted phase", () =>
    Effect.gen(function* () {
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${fixture.organizationId}`;
      const entered = yield* Deferred.make<void>();
      const phase = yield* withOrganizationLiveWorkPhaseClaim(
        fixture.workId,
        "attempt",
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const input = {
        organizationId: fixture.organizationId,
        requestId: `${fixture.tag}-emergency`,
      };
      const requested = yield* requestOrganizationEmergencyStop(input, interactive);
      assert.equal(requested.state, "requested");
      assert.equal(Exit.isFailure(yield* Effect.exit(Fiber.join(phase))), true);
      const settled = yield* readOrganizationEmergencyStop(fixture.organizationId);
      assert.equal(settled.admittedPhases, 0);
      assert.equal(
        (yield* requestOrganizationEmergencyStop(input, interactive)).state,
        "requested",
      );
      const denied = yield* withOrganizationLiveWorkPhaseClaim(
        fixture.workId,
        "qa",
        Effect.void,
      ).pipe(Effect.flip);
      assert.equal(denied instanceof OrganizationLiveWorkEmergencyDeferred, true);
      const second = yield* requestOrganizationEmergencyStop(
        { ...input, requestId: `${fixture.tag}-different` },
        interactive,
      ).pipe(Effect.flip);
      assert.match(second.message, /already has an emergency stop/);
    }),
  );
  it.effect("resumes only a paused Organization while runtime and scope recovery are ready", () =>
    Effect.gen(function* () {
      ready = true;
      const fixture = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organizations SET lifecycle = 'paused'
        WHERE organization_id = ${fixture.organizationId}`;
      const resumed = yield* resumePausedOrganization(
        {
          organizationId: fixture.organizationId,
          mutationId: `${fixture.tag}-resume`,
          baseRevision: fixture.org.draftRevision,
          actor: "user",
          lifecycle: "active",
        },
        interactive,
      );
      assert.equal(resumed.lifecycle, "active");
      assert.equal(resumed.draftRevision, fixture.org.draftRevision + 1);
      const store = yield* OrganizationStore;
      const paused = yield* store.setLifecycle({
        organizationId: fixture.organizationId,
        mutationId: `${fixture.tag}-pause`,
        baseRevision: resumed.draftRevision,
        actor: "user",
        lifecycle: "paused",
      });
      assert.equal(paused.lifecycle, "paused");
      ready = false;
      const denied = yield* resumePausedOrganization(
        {
          organizationId: fixture.organizationId,
          mutationId: `${fixture.tag}-resume-again`,
          baseRevision: paused.draftRevision,
          actor: "user",
          lifecycle: "active",
        },
        interactive,
      ).pipe(Effect.flip);
      assert.equal(denied.code, "unavailable");
    }),
  );

  it.effect("cancels only linked work and keeps exact transition retries idempotent", () =>
    Effect.gen(function* () {
      ready = true;
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const input = {
        organizationId: fixture.organizationId,
        workId: fixture.workId,
        transitionId: `${fixture.tag}-cancel`,
      };
      const denied = yield* cancelActivatedOrganizationWork(input, {
        subject: "human-a",
        interactive: false,
      }).pipe(Effect.flip);
      assert.equal(denied.code, "forbidden");
      const canceled = yield* cancelActivatedOrganizationWork(input, interactive);
      assert.equal(canceled.work.status, "canceled");
      assert.equal(
        (yield* cancelActivatedOrganizationWork(input, interactive)).work.status,
        "canceled",
      );
      const wrongOrg = yield* cancelActivatedOrganizationWork(
        {
          ...input,
          organizationId: OrganizationId.make("other-org"),
          transitionId: `${fixture.tag}-wrong`,
        },
        interactive,
      ).pipe(Effect.flip);
      assert.equal(wrongOrg.code, "not_found");
    }),
  );

  it.effect("refuses idle pause and resume when an attempt is still running", () =>
    Effect.gen(function* () {
      ready = true;
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const sql = yield* SqlClient.SqlClient;
      const attemptId = `${fixture.tag}-attempt`;
      yield* sql`INSERT INTO organization_work_attempts
        (attempt_id, work_id, number, status, worker_subject, lease_until,
          started_at, updated_at)
        VALUES (${attemptId}, ${fixture.workId}, 1, 'running', 'worker-a',
          '2099-01-01T00:00:00.000Z', ${stamp}, ${stamp})`;
      yield* sql`UPDATE organization_work_items SET status = 'running', attempt_count = 1
        WHERE work_id = ${fixture.workId}`;
      yield* sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${fixture.organizationId}`;
      const store = yield* OrganizationStore;
      const pause = yield* store
        .setLifecycle({
          organizationId: fixture.organizationId,
          mutationId: `${fixture.tag}-pause`,
          baseRevision: fixture.org.draftRevision,
          actor: "user",
          lifecycle: "paused",
        })
        .pipe(Effect.flip);
      assert.equal(pause.code, "conflict");
      yield* sql`UPDATE organizations SET lifecycle = 'paused'
        WHERE organization_id = ${fixture.organizationId}`;
      const resume = yield* resumePausedOrganization(
        {
          organizationId: fixture.organizationId,
          mutationId: `${fixture.tag}-resume`,
          baseRevision: fixture.org.draftRevision,
          actor: "user",
          lifecycle: "active",
        },
        interactive,
      ).pipe(Effect.flip);
      assert.equal(resume.code, "conflict");
      assert.match(resume.message, /Verify or recover/);
    }),
  );

  it.effect("durably drains admitted work and resumes only after it settles", () =>
    Effect.gen(function* () {
      ready = true;
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${fixture.organizationId}`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const phase = yield* withOrganizationLiveWorkPhaseClaim(
        fixture.workId,
        "attempt",
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const request = { organizationId: fixture.organizationId, requestId: `${fixture.tag}-drain` };
      assert.equal((yield* requestOrganizationWorkDrain(request, interactive)).state, "draining");
      const denied = yield* withOrganizationLiveWorkPhaseClaim(
        fixture.workId,
        "qa",
        Effect.void,
      ).pipe(Effect.flip);
      assert.equal(denied instanceof OrganizationLiveWorkDrainDeferred, true);
      const store = yield* OrganizationStore;
      const pause = yield* store
        .setLifecycle({
          organizationId: fixture.organizationId,
          mutationId: `${fixture.tag}-direct-pause`,
          baseRevision: fixture.org.draftRevision,
          actor: "user",
          lifecycle: "paused",
        })
        .pipe(Effect.flip);
      assert.equal(pause.code, "conflict");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(phase);
      assert.equal((yield* readOrganizationWorkDrain(fixture.organizationId)).state, "paused");
      assert.equal((yield* requestOrganizationWorkDrain(request, interactive)).state, "paused");
      assert.equal(
        (yield* store.get({ organizationId: fixture.organizationId })).lifecycle,
        "paused",
      );
      const resumed = yield* resumePausedOrganization(
        {
          organizationId: fixture.organizationId,
          mutationId: `${fixture.tag}-resume`,
          baseRevision: fixture.org.draftRevision + 1,
          actor: "user",
          lifecycle: "active",
        },
        interactive,
      );
      assert.equal(resumed.lifecycle, "active");
      assert.equal((yield* readOrganizationWorkDrain(fixture.organizationId)).state, "none");
    }),
  );

  it.effect("holds stale claims until exclusive startup recovery clears them", () =>
    Effect.gen(function* () {
      ready = true;
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${fixture.organizationId}`;
      yield* sql`INSERT INTO organization_live_work_phase_claims
        (work_id, organization_id, phase, owner_epoch, started_at)
        VALUES (${fixture.workId}, ${fixture.organizationId}, 'attempt', 'former-process', ${stamp})`;
      assert.equal(
        (yield* requestOrganizationWorkDrain(
          { organizationId: fixture.organizationId, requestId: `${fixture.tag}-drain` },
          interactive,
        )).state,
        "draining",
      );
      assert.deepEqual((yield* reconcileOrganizationWorkDrainsAfterRecovery).held, []);
      assert.equal((yield* readOrganizationWorkDrain(fixture.organizationId)).state, "paused");
    }),
  );

  it.effect("keeps a drain pending until an existing attempt is settled", () =>
    Effect.gen(function* () {
      ready = true;
      const fixture = yield* seed;
      yield* seedActivatedWork(fixture);
      const sql = yield* SqlClient.SqlClient;
      const attemptId = `${fixture.tag}-attempt`;
      yield* sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${fixture.organizationId}`;
      yield* sql`INSERT INTO organization_work_attempts
        (attempt_id, work_id, number, status, worker_subject, lease_until,
          started_at, updated_at)
        VALUES (${attemptId}, ${fixture.workId}, 1, 'running', 'worker-a',
          '2099-01-01T00:00:00.000Z', ${stamp}, ${stamp})`;
      yield* sql`UPDATE organization_work_items SET status = 'running', attempt_count = 1
        WHERE work_id = ${fixture.workId}`;
      assert.equal(
        (yield* requestOrganizationWorkDrain(
          { organizationId: fixture.organizationId, requestId: `${fixture.tag}-drain` },
          interactive,
        )).state,
        "draining",
      );
      assert.equal((yield* readOrganizationWorkDrain(fixture.organizationId)).state, "draining");
      yield* sql`UPDATE organization_work_attempts SET status = 'canceled'
        WHERE attempt_id = ${attemptId}`;
      yield* sql`UPDATE organization_work_items SET status = 'canceled'
        WHERE work_id = ${fixture.workId}`;
      assert.equal(
        (yield* requestOrganizationWorkDrain(
          { organizationId: fixture.organizationId, requestId: `${fixture.tag}-recheck` },
          interactive,
        )).state,
        "paused",
      );
    }),
  );

  it.effect("clears a completed drain when its Organization is archived", () =>
    Effect.gen(function* () {
      ready = true;
      const fixture = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE organizations SET lifecycle = 'active'
        WHERE organization_id = ${fixture.organizationId}`;
      const drained = yield* requestOrganizationWorkDrain(
        { organizationId: fixture.organizationId, requestId: `${fixture.tag}-drain` },
        interactive,
      );
      assert.equal(drained.state, "paused");
      const store = yield* OrganizationStore;
      const archived = yield* store.setLifecycle({
        organizationId: fixture.organizationId,
        mutationId: `${fixture.tag}-archive`,
        baseRevision: fixture.org.draftRevision + 1,
        actor: "user",
        lifecycle: "archived",
      });
      assert.equal(archived.lifecycle, "archived");
      assert.equal((yield* readOrganizationWorkDrain(fixture.organizationId)).state, "none");
      const rows = yield* sql<{ request_id: string }>`SELECT request_id
        FROM organization_live_work_drains WHERE organization_id = ${fixture.organizationId}`;
      assert.equal(rows.length, 0);
    }),
  );
});

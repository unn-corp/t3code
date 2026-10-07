import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration071 from "../persistence/Migrations/071_OrganizationWorkScopes.ts";
import Migration077 from "../persistence/Migrations/077_OrganizationScopePreparation.ts";
import Migration078 from "../persistence/Migrations/078_OrganizationReservedScopeUnits.ts";
import Migration084 from "../persistence/Migrations/084_OrganizationScopeLaunchRequested.ts";
import {
  OrganizationWorkScopeError,
  OrganizationWorkScopeStopVerifier,
  OrganizationWorkScopeStore,
  OrganizationWorkScopeStoreLayer,
  OrganizationScopeTokenReleased,
  type OrganizationWorkScopeIdentity,
} from "./OrganizationWorkScopeStore.ts";

const identity = (suffix: string): OrganizationWorkScopeIdentity => {
  const hex = suffix.padStart(32, "0");
  const unitName = `t3-org-sandbox-${hex}.scope`;
  return {
    unitName,
    invocationId: hex,
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unitName}`,
    sandboxPid: 1000 + Number(suffix),
    pidNamespace: 2000 + Number(suffix),
  };
};

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organizations (
    organization_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)`;
  yield* sql`CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
  yield* sql`CREATE TABLE organization_project_bindings (
    binding_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
    detached_at TEXT, access TEXT NOT NULL, capabilities_json TEXT NOT NULL,
    updated_at TEXT NOT NULL, scope TEXT)`;
  yield* sql`CREATE TABLE organization_work_items (
    work_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL, binding_version TEXT NOT NULL, scope TEXT,
    status TEXT NOT NULL, attempt_count INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_attempts (
    attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, number INTEGER NOT NULL,
    status TEXT NOT NULL, lease_until TEXT NOT NULL, started_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_resource_permits (
    attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL,
    organization_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL,
    lease_until TEXT NOT NULL, granted_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  yield* Migration071;
  yield* Migration077;
  yield* Migration078;
  yield* Migration084;
  yield* sql`INSERT INTO organizations VALUES ('org', 'active')`;
  yield* sql`INSERT INTO projection_projects VALUES ('project', NULL)`;
  yield* sql`INSERT INTO organization_project_bindings VALUES
    ('binding', 'org', 'project', NULL, 'write', '["read-files","write-files","run-tests"]',
      'version-1', NULL)`;
  yield* sql`INSERT INTO organization_work_items VALUES
    ('work', 'org', 'project', 'binding', 'version-1', NULL, 'running', 1)`;
  yield* sql`INSERT INTO organization_work_attempts VALUES
    ('attempt-1', 'work', 1, 'running', '2099-01-01T00:00:00.000Z', '2026-01-01')`;
  yield* sql`INSERT INTO organization_work_resource_permits VALUES
    ('attempt-1', 'work', 'org', 'project', 'active',
      '2099-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01')`;
});

const testLayer = (
  verify: (saved: OrganizationWorkScopeIdentity) => Effect.Effect<void, OrganizationWorkScopeError>,
) =>
  OrganizationWorkScopeStoreLayer.pipe(
    Layer.provideMerge(Layer.succeed(OrganizationWorkScopeStopVerifier, { verifyStopped: verify })),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );

it.effect("migration 71 applies after the real Organization work schema", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 71 });
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(organization_work_scopes)`;
    assert.ok(columns.some((column) => column.name === "verified_stopped_at"));
    assert.ok(columns.some((column) => column.name === "invocation_id"));
    assert.ok(columns.some((column) => column.name === "token_released_at"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("migration 78 reserves unit names without inventing legacy attempt identities", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 78 });
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{
      name: string;
    }>`PRAGMA table_info(organization_work_scope_preparations)`;
    assert.ok(columns.some((column) => column.name === "preparation_started_at"));
    assert.ok(columns.some((column) => column.name === "unit_name"));
    assert.equal(
      (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM organization_work_scope_preparations`)[0]
        ?.n,
      0,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("migration 84 adds a nullable, one-time launch marker", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 84 });
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{
      name: string;
    }>`PRAGMA table_info(organization_work_scope_preparations)`;
    assert.ok(columns.some((column) => column.name === "launch_requested_at"));
    assert.ok(columns.some((column) => column.name === "launch_state"));
    assert.equal(
      (yield* sql<{ n: number }>`SELECT COUNT(*) AS n
      FROM organization_work_scope_preparations WHERE launch_requested_at IS NOT NULL`)[0]?.n,
      0,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("migration 84 preserves pre-existing preparations as unknown launch provenance", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE organization_work_scope_preparations (
      attempt_id TEXT PRIMARY KEY, preparation_started_at TEXT NOT NULL, unit_name TEXT)`;
    yield* sql`INSERT INTO organization_work_scope_preparations
      (attempt_id, preparation_started_at, unit_name)
      VALUES ('legacy-attempt', '2026-01-01', ${identity("1").unitName})`;
    yield* Migration084;
    const legacy = (yield* sql<{
      launch_state: string;
      launch_requested_at: string | null;
    }>`SELECT launch_state, launch_requested_at FROM organization_work_scope_preparations
      WHERE attempt_id = 'legacy-attempt'`)[0];
    assert.equal(legacy?.launch_state, "legacy-unknown");
    assert.equal(legacy?.launch_requested_at, null);
    assert.ok(
      yield* sql`UPDATE organization_work_scope_preparations
      SET launch_state = 'reserved' WHERE attempt_id = 'legacy-attempt'`.pipe(Effect.flip),
    );
    assert.ok(
      yield* sql`UPDATE organization_work_scope_preparations
      SET launch_state = 'requested', launch_requested_at = '2026-01-02'
      WHERE attempt_id = 'legacy-attempt'`.pipe(Effect.flip),
    );
    assert.equal(
      (yield* sql<{ launch_state: string }>`SELECT launch_state
      FROM organization_work_scope_preparations WHERE attempt_id = 'legacy-attempt'`)[0]
        ?.launch_state,
      "legacy-unknown",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("never promotes an unknown legacy reservation into a fresh launch", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const unitName = identity("1").unitName;
    yield* sql`INSERT INTO organization_work_scope_preparations
      (attempt_id, preparation_started_at, unit_name)
      VALUES ('attempt-1', '2026-01-01', ${unitName})`;
    const store = yield* OrganizationWorkScopeStore;
    assert.equal((yield* store.getPreparation("attempt-1"))?.launchState, "legacy-unknown");
    assert.equal(
      (yield* store
        .markLaunchRequested("attempt-1", unitName, { requireFresh: true })
        .pipe(Effect.flip)).code,
      "conflict",
    );
    assert.equal((yield* store.getPreparation("attempt-1"))?.launchRequestedAt, null);
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect(
  "records one exact launch request and rejects a missing reservation or changed unit",
  () =>
    Effect.gen(function* () {
      yield* fixture;
      const store = yield* OrganizationWorkScopeStore;
      const unitName = identity("1").unitName;
      assert.equal(
        (yield* store.markLaunchRequested("attempt-1", unitName).pipe(Effect.flip)).code,
        "conflict",
      );
      assert.equal(yield* store.getPreparation("attempt-1"), null);
      const reserved = yield* store.markPreparing("attempt-1", unitName);
      assert.equal(reserved.launchRequestedAt, null);
      assert.equal(reserved.launchState, "reserved");
      const marked = yield* store.markLaunchRequested("attempt-1", unitName);
      assert.ok(marked.launchRequestedAt);
      assert.equal(marked.launchState, "requested");
      assert.equal(marked.unitName, unitName);
      assert.deepEqual(yield* store.markLaunchRequested("attempt-1", unitName), marked);
      assert.equal(
        (yield* store
          .markLaunchRequested("attempt-1", unitName, { requireFresh: true })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      assert.deepEqual(yield* store.getPreparation("attempt-1"), marked);
      assert.equal(
        (yield* store.markLaunchRequested("attempt-1", identity("2").unitName).pipe(Effect.flip))
          .code,
        "conflict",
      );
      const sql = yield* SqlClient.SqlClient;
      assert.ok(
        yield* sql`UPDATE organization_work_scope_preparations
      SET launch_requested_at = '2099-01-01' WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip),
      );
      assert.ok(
        yield* sql`UPDATE organization_work_scope_preparations
      SET launch_requested_at = NULL WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip),
      );
      assert.deepEqual(yield* store.getPreparation("attempt-1"), marked);
      const savedIdentity = identity("1");
      yield* sql`INSERT INTO organization_work_scopes
      (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
        pid_namespace, prepared_at, stop_requested_at, verified_stopped_at)
      VALUES ('attempt-1', ${savedIdentity.unitName}, ${savedIdentity.invocationId},
        ${savedIdentity.controlGroup}, ${savedIdentity.sandboxPid}, ${savedIdentity.pidNamespace},
        '2026-01-01', '2026-01-01', '2026-01-01')`;
      yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
      WHERE attempt_id = 'attempt-1'`;
      assert.ok(
        yield* sql`DELETE FROM organization_work_scope_preparations
      WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip),
      );
      assert.deepEqual(yield* store.getPreparation("attempt-1"), marked);
    }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect("refuses a launch marker after binding, attempt, or permit authority becomes stale", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkScopeStore;
    const unitName = identity("1").unitName;
    yield* store.markPreparing("attempt-1", unitName);
    yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-01'
      WHERE binding_id = 'binding'`;
    assert.equal(
      (yield* store.markLaunchRequested("attempt-1", unitName).pipe(Effect.flip)).code,
      "conflict",
    );
    yield* sql`UPDATE organization_project_bindings SET detached_at = NULL
      WHERE binding_id = 'binding'`;
    yield* sql`UPDATE organization_work_attempts SET status = 'expired'
      WHERE attempt_id = 'attempt-1'`;
    assert.equal(
      (yield* store.markLaunchRequested("attempt-1", unitName).pipe(Effect.flip)).code,
      "conflict",
    );
    yield* sql`UPDATE organization_work_attempts SET status = 'running'
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_resource_permits SET lease_until = '1900-01-01'
      WHERE attempt_id = 'attempt-1'`;
    assert.equal(
      (yield* store.markLaunchRequested("attempt-1", unitName).pipe(Effect.flip)).code,
      "conflict",
    );
    assert.equal((yield* store.getPreparation("attempt-1"))?.launchRequestedAt, null);
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect(
  "marks only an authorized running attempt and fences permit release until verified stop",
  () =>
    Effect.gen(function* () {
      yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrganizationWorkScopeStore;
      yield* sql`UPDATE organization_project_bindings SET access = 'read' WHERE binding_id = 'binding'`;
      assert.equal(
        (yield* Effect.flip(store.markPreparing("attempt-1", identity("1").unitName))).code,
        "conflict",
      );
      yield* sql`UPDATE organization_project_bindings SET access = 'write' WHERE binding_id = 'binding'`;
      const marked = yield* store.markPreparing("attempt-1", identity("1").unitName);
      assert.equal(marked.attemptId, "attempt-1");
      assert.equal(marked.unitName, identity("1").unitName);
      assert.deepEqual(yield* store.getPreparation("attempt-1"), marked);
      assert.deepEqual(yield* store.markPreparing("attempt-1", identity("1").unitName), marked);
      assert.equal(
        (yield* Effect.flip(store.markPreparing("attempt-1", identity("2").unitName))).code,
        "conflict",
      );
      assert.equal(
        (yield* Effect.flip(
          store.attachPrepared({ attemptId: "attempt-1", identity: identity("2") }),
        )).code,
        "conflict",
      );
      const forgedScope = yield* sql`INSERT INTO organization_work_scopes
        (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
          pid_namespace, prepared_at)
        VALUES ('attempt-1', ${identity("2").unitName}, ${identity("2").invocationId},
          ${identity("2").controlGroup}, 1002, 2002, '2026-01-01')`.pipe(Effect.flip);
      assert.ok(forgedScope);
      const changedReservation = yield* sql`UPDATE organization_work_scope_preparations
        SET unit_name = ${identity("2").unitName} WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip);
      assert.ok(changedReservation);
      const erased = yield* sql`DELETE FROM organization_work_scope_preparations
      WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip);
      assert.ok(erased);
      const premature = yield* sql`UPDATE organization_work_resource_permits
      SET state = 'released' WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip);
      assert.ok(premature);
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
      WHERE attempt_id = 'attempt-1'`)[0]?.state,
        "active",
      );
      const prepared = yield* store.attachPrepared({
        attemptId: "attempt-1",
        identity: identity("1"),
      });
      assert.equal(prepared.state, "prepared");
      yield* store.requestStop("attempt-1");
      yield* store.recordStopped("attempt-1");
      yield* sql`UPDATE organization_work_resource_permits
      SET state = 'released' WHERE attempt_id = 'attempt-1'`;
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
      WHERE attempt_id = 'attempt-1'`)[0]?.state,
        "released",
      );
    }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect("legacy unmarked attempts retain unscoped release compatibility", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE organization_work_resource_permits
      SET state = 'expired' WHERE attempt_id = 'attempt-1'`;
    assert.equal(
      (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
      WHERE attempt_id = 'attempt-1'`)[0]?.state,
      "expired",
    );
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect("an identity-less legacy preparation remains ambiguous and held", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO organization_work_scope_preparations
      (attempt_id, preparation_started_at) VALUES ('attempt-1', '2026-01-01')`;
    const store = yield* OrganizationWorkScopeStore;
    assert.equal((yield* store.getPreparation("attempt-1"))?.unitName, null);
    assert.equal(
      (yield* Effect.flip(
        store.attachPrepared({ attemptId: "attempt-1", identity: identity("1") }),
      )).code,
      "conflict",
    );
    const release = yield* sql`UPDATE organization_work_resource_permits SET state = 'expired'
      WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip);
    assert.ok(release);
    assert.equal(
      (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
        WHERE attempt_id = 'attempt-1'`)[0]?.state,
      "active",
    );
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect(
  "attaches one immutable scope only to a current running attempt with an active permit",
  () =>
    Effect.gen(function* () {
      yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrganizationWorkScopeStore;
      const saved = yield* store.attachPrepared({
        attemptId: "attempt-1",
        identity: identity("1"),
      });
      assert.equal(saved.state, "prepared");
      assert.deepEqual(
        yield* store.attachPrepared({ attemptId: "attempt-1", identity: identity("1") }),
        saved,
      );
      assert.equal((yield* store.listOpenScopes(10)).length, 1);
      assert.equal((yield* store.listUnscopedRunning(10)).length, 0);
      const duplicate = yield* store
        .attachPrepared({ attemptId: "attempt-1", identity: identity("2") })
        .pipe(Effect.flip);
      assert.equal(duplicate.code, "conflict");
      yield* sql`INSERT INTO organization_work_items VALUES
      ('work-2', 'org', 'project', 'binding', 'version-1', NULL, 'running', 1)`;
      yield* sql`INSERT INTO organization_work_attempts VALUES
      ('attempt-2', 'work-2', 1, 'running', '2099-01-01T00:00:00.000Z', '2026-01-01')`;
      yield* sql`INSERT INTO organization_work_resource_permits VALUES
      ('attempt-2', 'work-2', 'org', 'project', 'active',
        '2099-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01')`;
      const reused = yield* store
        .attachPrepared({ attemptId: "attempt-2", identity: identity("1") })
        .pipe(Effect.flip);
      assert.equal(reused.code, "conflict");
      // The database also guards immutable identity against direct UPDATE.
      const changed = yield* sql`UPDATE organization_work_scopes SET invocation_id = 'tampered'
      WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip);
      assert.ok(changed);
    }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect("shows the claim-before-prepare gap and rejects stale or revoked attempts", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkScopeStore;
    assert.deepEqual(
      (yield* store.listUnscopedRunning(10)).map((row) => row.attemptId),
      ["attempt-1"],
    );
    yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.listUnscopedRunning(10))[0]?.permitState, "released");
    const stale = yield* store
      .attachPrepared({ attemptId: "attempt-1", identity: identity("1") })
      .pipe(Effect.flip);
    assert.equal(stale.code, "conflict");
    yield* sql`UPDATE organization_work_resource_permits SET state = 'active'
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_attempts SET status = 'expired'
      WHERE attempt_id = 'attempt-1'`;
    const expired = yield* store
      .attachPrepared({ attemptId: "attempt-1", identity: identity("1") })
      .pipe(Effect.flip);
    assert.equal(expired.code, "conflict");
    yield* sql`UPDATE organization_work_attempts SET status = 'running'
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_items SET attempt_count = 2 WHERE work_id = 'work'`;
    const superseded = yield* store
      .attachPrepared({ attemptId: "attempt-1", identity: identity("1") })
      .pipe(Effect.flip);
    assert.equal(superseded.code, "conflict");
    yield* sql`UPDATE organization_work_items SET attempt_count = 1 WHERE work_id = 'work'`;
    yield* sql`UPDATE organization_project_bindings SET detached_at = '2026-01-01'
      WHERE binding_id = 'binding'`;
    const detached = yield* store
      .attachPrepared({ attemptId: "attempt-1", identity: identity("1") })
      .pipe(Effect.flip);
    assert.equal(detached.code, "conflict");
    yield* sql`UPDATE organization_project_bindings SET detached_at = NULL,
      capabilities_json = '["read-files","write-files"]' WHERE binding_id = 'binding'`;
    const missingQa = yield* store
      .attachPrepared({ attemptId: "attempt-1", identity: identity("1") })
      .pipe(Effect.flip);
    assert.equal(missingQa.code, "conflict");
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect(
  "fences start on stop request and verifies persisted identity before recording stop",
  () => {
    let currentInvocation = "wrong";
    let verifiedUnit = "";
    const verifier = (saved: OrganizationWorkScopeIdentity) => {
      verifiedUnit = saved.unitName;
      return saved.invocationId === currentInvocation
        ? Effect.void
        : Effect.fail(
            new OrganizationWorkScopeError({ code: "conflict", message: "OS identity differs." }),
          );
    };
    return Effect.gen(function* () {
      yield* fixture;
      const store = yield* OrganizationWorkScopeStore;
      const attached = yield* store.attachPrepared({
        attemptId: "attempt-1",
        identity: identity("1"),
      });
      assert.equal(attached.state, "prepared");
      assert.equal((yield* store.requestStart("attempt-1")).state, "start-requested");
      assert.equal((yield* store.requestStart("attempt-1")).state, "start-requested");
      let releases = 0;
      assert.equal(
        (yield* store.startWithFence("attempt-1", () => {
          releases++;
          return OrganizationScopeTokenReleased;
        })).state,
        "token-released",
      );
      assert.equal(
        (yield* store.startWithFence("attempt-1", () => {
          releases++;
          return OrganizationScopeTokenReleased;
        })).state,
        "token-released",
      );
      assert.equal(releases, 1);
      assert.equal((yield* store.recordStarted("attempt-1")).state, "started");
      assert.equal((yield* store.requestStop("attempt-1")).state, "stop-requested");
      assert.equal((yield* store.requestStop("attempt-1")).state, "stop-requested");
      assert.equal((yield* store.requestStart("attempt-1").pipe(Effect.flip)).code, "conflict");
      assert.equal((yield* store.recordStopped("attempt-1").pipe(Effect.flip)).code, "conflict");
      assert.equal((yield* store.get("attempt-1"))?.state, "stop-requested");
      currentInvocation = identity("1").invocationId;
      const stopped = yield* store.recordStopped("attempt-1");
      assert.equal(verifiedUnit, identity("1").unitName);
      assert.equal(stopped.state, "verified-stopped");
      assert.equal((yield* store.listOpenScopes(10)).length, 0);
      assert.deepEqual(yield* store.recordStopped("attempt-1"), stopped);
    }).pipe(Effect.provide(testLayer(verifier)));
  },
);

it.effect("a prepared scope can be stopped without ever starting; live verifier denies", () =>
  Effect.gen(function* () {
    yield* fixture;
    const store = yield* OrganizationWorkScopeStore;
    yield* store.attachPrepared({ attemptId: "attempt-1", identity: identity("1") });
    assert.equal((yield* store.recordStopped("attempt-1").pipe(Effect.flip)).code, "conflict");
    yield* store.requestStop("attempt-1");
    assert.equal((yield* store.requestStart("attempt-1").pipe(Effect.flip)).code, "conflict");
    assert.equal((yield* store.recordStopped("attempt-1").pipe(Effect.flip)).code, "unavailable");
    assert.equal((yield* store.get("attempt-1"))?.state, "stop-requested");
  }).pipe(
    Effect.provide(
      testLayer(() =>
        Effect.fail(
          new OrganizationWorkScopeError({
            code: "unavailable",
            message: "Verifier disabled.",
          }),
        ),
      ),
    ),
  ),
);

it.effect(
  "revoked permit fences a prepared scope from start but still permits emergency stop",
  () =>
    Effect.gen(function* () {
      yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrganizationWorkScopeStore;
      yield* store.attachPrepared({ attemptId: "attempt-1", identity: identity("1") });
      yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
      WHERE attempt_id = 'attempt-1'`;
      assert.equal((yield* store.requestStart("attempt-1").pipe(Effect.flip)).code, "conflict");
      assert.equal((yield* store.requestStop("attempt-1")).state, "stop-requested");
      assert.equal((yield* store.listOpenScopes(10)).length, 1);
      assert.equal((yield* store.recordStopped("attempt-1")).state, "verified-stopped");
    }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect("a delayed token release loses to requestStop and never calls the gate", () =>
  Effect.gen(function* () {
    yield* fixture;
    const store = yield* OrganizationWorkScopeStore;
    yield* store.attachPrepared({ attemptId: "attempt-1", identity: identity("1") });
    yield* store.requestStart("attempt-1");
    const proceed = yield* Deferred.make<void>();
    let released = false;
    const delayed = yield* Deferred.await(proceed).pipe(
      Effect.flatMap(() =>
        store.startWithFence("attempt-1", () => {
          released = true;
          return OrganizationScopeTokenReleased;
        }),
      ),
      Effect.forkChild,
    );
    yield* store.requestStop("attempt-1");
    yield* Deferred.succeed(proceed, undefined);
    const blocked = yield* Fiber.join(delayed).pipe(Effect.flip);
    assert.equal(blocked.code, "conflict");
    assert.equal(released, false);
    assert.equal((yield* store.recordStarted("attempt-1").pipe(Effect.flip)).code, "conflict");
    assert.equal((yield* store.get("attempt-1"))?.tokenReleasedAt, null);
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect("holds the start fence until an asynchronous gate write completes", () =>
  Effect.gen(function* () {
    yield* fixture;
    const store = yield* OrganizationWorkScopeStore;
    yield* store.attachPrepared({ attemptId: "attempt-1", identity: identity("1") });
    yield* store.requestStart("attempt-1");
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let complete!: (value: typeof OrganizationScopeTokenReleased) => void;
    const write = new Promise<typeof OrganizationScopeTokenReleased>((resolve) => {
      complete = resolve;
    });
    let startDone = false;
    const start = yield* store
      .startWithFence("attempt-1", () => {
        enter();
        return write;
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            startDone = true;
          }),
        ),
        Effect.forkChild,
      );
    yield* Effect.promise(() => entered);
    let stopDone = false;
    const stop = yield* store.requestStop("attempt-1").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          stopDone = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    assert.equal(startDone, false);
    assert.equal(stopDone, false);
    complete(OrganizationScopeTokenReleased);
    assert.equal((yield* Fiber.join(start)).tokenReleasedAt !== null, true);
    assert.equal((yield* Fiber.join(stop)).state, "stop-requested");
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect("interruption cannot roll back the fence while a gate write is pending", () =>
  Effect.gen(function* () {
    yield* fixture;
    const store = yield* OrganizationWorkScopeStore;
    yield* store.attachPrepared({ attemptId: "attempt-1", identity: identity("1") });
    yield* store.requestStart("attempt-1");
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let complete!: (value: typeof OrganizationScopeTokenReleased) => void;
    const write = new Promise<typeof OrganizationScopeTokenReleased>((resolve) => {
      complete = resolve;
    });
    const start = yield* store
      .startWithFence("attempt-1", () => {
        enter();
        return write;
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => entered);
    const interrupt = yield* Fiber.interrupt(start).pipe(Effect.forkChild);
    let stopDone = false;
    const stop = yield* store.requestStop("attempt-1").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          stopDone = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    assert.equal(stopDone, false);
    complete(OrganizationScopeTokenReleased);
    yield* Fiber.join(interrupt);
    assert.equal((yield* Fiber.join(stop)).state, "stop-requested");
    assert.equal((yield* store.get("attempt-1"))?.tokenReleasedAt !== null, true);
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

it.effect("recordStarted cannot first appear after stop is requested", () =>
  Effect.gen(function* () {
    yield* fixture;
    const store = yield* OrganizationWorkScopeStore;
    yield* store.attachPrepared({ attemptId: "attempt-1", identity: identity("1") });
    yield* store.requestStart("attempt-1");
    yield* store.startWithFence("attempt-1", () => OrganizationScopeTokenReleased);
    yield* store.requestStop("attempt-1");
    assert.equal((yield* store.recordStarted("attempt-1").pipe(Effect.flip)).code, "conflict");
    assert.equal((yield* store.get("attempt-1"))?.startedAt, null);
  }).pipe(Effect.provide(testLayer(() => Effect.void))),
);

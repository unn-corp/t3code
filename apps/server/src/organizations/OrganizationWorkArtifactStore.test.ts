import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration071 from "../persistence/Migrations/071_OrganizationWorkScopes.ts";
import Migration072 from "../persistence/Migrations/072_OrganizationWorkArtifacts.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStore,
  OrganizationWorkArtifactStoreWithAuthority,
  OrganizationWorkArtifactStoreLive,
  OrganizationWorkArtifactVerifierFromStore,
  type OrganizationWorkArtifactCaptureInput,
} from "./OrganizationWorkArtifactStore.ts";
import { OrganizationWorkArtifactVerifier } from "./OrganizationWorkStore.ts";

const input = (): OrganizationWorkArtifactCaptureInput => ({
  attemptId: "attempt-1",
  workId: "work",
  projectId: "project",
  baseCodeRevision: "revision-1",
  scopeUnitName: "t3-org-sandbox-00000000000000000000000000000001.scope",
  scopeInvocationId: "00000000000000000000000000000001",
  patchBytes: new TextEncoder().encode("diff --git a/a b/a\n+safe\n"),
  evidenceBytes: new TextEncoder().encode("tests: passed"),
  outcome: {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    resourceLimitExceeded: false,
  },
});
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organizations (organization_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)`;
  yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
  yield* sql`CREATE TABLE organization_project_bindings (
    binding_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL, access TEXT NOT NULL, detached_at TEXT,
    updated_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_items (
    work_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL, binding_version TEXT NOT NULL, code_revision TEXT NOT NULL,
    status TEXT NOT NULL, attempt_count INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_attempts (
    attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, number INTEGER NOT NULL,
    status TEXT NOT NULL, lease_until TEXT NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_resource_permits (
    attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
  yield* Migration071;
  yield* Migration072;
  yield* sql`INSERT INTO organizations VALUES ('org', 'active')`;
  yield* sql`INSERT INTO projection_projects VALUES ('project', NULL)`;
  yield* sql`INSERT INTO organization_project_bindings VALUES
    ('binding', 'org', 'project', 'write', NULL, 'version-1')`;
  yield* sql`INSERT INTO organization_work_items VALUES
    ('work', 'org', 'project', 'binding', 'version-1', 'revision-1', 'running', 1)`;
  yield* sql`INSERT INTO organization_work_attempts VALUES
    ('attempt-1', 'work', 1, 'running', '2099-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO organization_work_resource_permits VALUES ('attempt-1', 'active')`;
  const attempt = input();
  yield* sql`INSERT INTO organization_work_scopes
    (attempt_id, unit_name, invocation_id, control_group, sandbox_pid, pid_namespace,
     prepared_at, start_requested_at, token_released_at, started_at,
     stop_requested_at, verified_stopped_at)
    VALUES ('attempt-1', ${attempt.scopeUnitName}, ${attempt.scopeInvocationId},
      '/user.slice/user-1000.slice/app.slice/t3-org-sandbox-00000000000000000000000000000001.scope',
      1000, 2000, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01',
      '2026-01-01', '2026-01-01')`;
});
const database = NodeSqliteClient.layerMemory();
const permitted = OrganizationWorkArtifactStoreWithAuthority.pipe(
  Layer.provideMerge(
    Layer.succeed(OrganizationWorkArtifactCaptureAuthority, {
      permits: () => true,
    }),
  ),
  Layer.provideMerge(database),
);
const denied = OrganizationWorkArtifactStoreLive.pipe(Layer.provideMerge(database));

it.effect("migration 72 applies after the full Organization schema", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 72 });
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(organization_work_artifacts)`;
    assert.ok(columns.some((column) => column.name === "patch_bytes"));
    assert.ok(columns.some((column) => column.name === "artifact_digest"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("captures an immutable byte receipt and verifies exact WorkStore target", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkArtifactStore;
    const saved = yield* store.capture(input());
    assert.match(saved.artifactDigest, /^[a-f0-9]{64}$/);
    assert.equal(saved.patchBytes.byteLength, input().patchBytes.byteLength);
    const verifier = yield* OrganizationWorkArtifactVerifier;
    yield* verifier.verifySubmitted(saved);
    const again = yield* store.capture(input());
    assert.equal(again.artifactRef, saved.artifactRef);
    const changed = yield* store
      .capture({ ...input(), patchBytes: new Uint8Array([1]) })
      .pipe(Effect.flip);
    assert.equal(changed.code, "conflict");
    yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.capture(input()).pipe(Effect.flip)).code, "conflict");
    const update = yield* sql`UPDATE organization_work_artifacts SET artifact_digest = 'bad'
      WHERE attempt_id = 'attempt-1'`.pipe(Effect.flip);
    assert.ok(update);
  }).pipe(
    Effect.provide(OrganizationWorkArtifactVerifierFromStore.pipe(Layer.provideMerge(permitted))),
  ),
);

it.effect(
  "denies capture by default and rejects unverified, stale, mismatched or failed attempts",
  () =>
    Effect.gen(function* () {
      yield* fixture;
      const store = yield* OrganizationWorkArtifactStore;
      assert.equal((yield* store.capture(input()).pipe(Effect.flip)).code, "forbidden");
    }).pipe(Effect.provide(denied)),
);

it.effect("rejects changed scope identity, missing stop and stale permits", () =>
  Effect.gen(function* () {
    yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrganizationWorkArtifactStore;
    assert.equal(
      (yield* store.capture({ ...input(), scopeInvocationId: "wrong" }).pipe(Effect.flip)).code,
      "conflict",
    );
    yield* sql`UPDATE organization_work_scopes SET verified_stopped_at = NULL
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.capture(input()).pipe(Effect.flip)).code, "conflict");
    yield* sql`UPDATE organization_work_scopes SET verified_stopped_at = '2026-01-01'
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`UPDATE organization_work_resource_permits SET state = 'released'
      WHERE attempt_id = 'attempt-1'`;
    assert.equal((yield* store.capture(input()).pipe(Effect.flip)).code, "conflict");
    yield* sql`UPDATE organization_work_resource_permits SET state = 'active'
      WHERE attempt_id = 'attempt-1'`;
    yield* sql`DELETE FROM projection_projects WHERE project_id = 'project'`;
    assert.equal((yield* store.capture(input()).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.provide(permitted)),
);

it.effect(
  "rejects unsuccessful outcomes, oversized bytes, target replay and stored-byte tamper",
  () =>
    Effect.gen(function* () {
      yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrganizationWorkArtifactStore;
      const failed = yield* store
        .capture({ ...input(), outcome: { ...input().outcome, exitCode: 1 } })
        .pipe(Effect.flip);
      assert.equal(failed.code, "invalid");
      const timeout = yield* store
        .capture({ ...input(), outcome: { ...input().outcome, timedOut: true } })
        .pipe(Effect.flip);
      assert.equal(timeout.code, "invalid");
      const malformed = yield* store
        .capture({
          ...input(),
          outcome: { ...input().outcome, timedOut: undefined as unknown as boolean },
        })
        .pipe(Effect.flip);
      assert.equal(malformed.code, "invalid");
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM organization_work_artifacts`)[0]?.count,
        0,
      );
      const huge = yield* store
        .capture({ ...input(), patchBytes: new Uint8Array(1_048_577) })
        .pipe(Effect.flip);
      assert.equal(huge.code, "invalid");
      const saved = yield* store.capture(input());
      assert.equal(
        (yield* store.verifySubmitted({ ...saved, projectId: "other" }).pipe(Effect.flip)).code,
        "conflict",
      );
      assert.equal(
        (yield* store.verifySubmitted({ ...saved, artifactRef: "replay" }).pipe(Effect.flip)).code,
        "conflict",
      );
      yield* sql`DROP TRIGGER organization_work_artifact_immutable`;
      yield* sql`UPDATE organization_work_artifacts SET patch_bytes = ${Buffer.from("tampered")}
      WHERE attempt_id = 'attempt-1'`;
      assert.equal((yield* store.verifySubmitted(saved).pipe(Effect.flip)).code, "conflict");
    }).pipe(Effect.provide(permitted)),
);

it.effect("snapshots caller-owned byte arrays before deferred capture runs", () =>
  Effect.gen(function* () {
    yield* fixture;
    const store = yield* OrganizationWorkArtifactStore;
    const mutable = input();
    const original = Uint8Array.from(mutable.patchBytes);
    const deferred = store.capture(mutable);
    mutable.patchBytes.fill(0);
    const saved = yield* deferred;
    assert.deepEqual(saved.patchBytes, original);
    yield* store.verifySubmitted(saved);
  }).pipe(Effect.provide(permitted)),
);

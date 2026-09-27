import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  classifyOrganizationLiveWorkRecovery,
  reconcileOrganizationWorkAtStartup,
} from "./OrganizationLiveWorkRecovery.ts";

const expired = "2026-01-01T00:00:00.000Z";
const now = "2026-01-02T00:00:00.000Z";
const running = {
  work_status: "running" as const,
  attempt_status: "running" as const,
  lease_until: expired,
  scope_attempt_id: null,
  prep_attempt_id: null,
  verified_stopped_at: null,
  receipt_kind: null,
};

it("recovers an expired claim that never reached broker preparation", () => {
  assert.equal(classifyOrganizationLiveWorkRecovery(running, now), "recover");
});

it("holds live leases and any prepared or attached scope without exact stop proof", () => {
  assert.equal(
    classifyOrganizationLiveWorkRecovery(
      { ...running, lease_until: "2026-01-03T00:00:00.000Z" },
      now,
    ),
    "lease_active",
  );
  assert.equal(
    classifyOrganizationLiveWorkRecovery({ ...running, prep_attempt_id: "attempt" }, now),
    "scope_unverified",
  );
  assert.equal(
    classifyOrganizationLiveWorkRecovery({ ...running, scope_attempt_id: "attempt" }, now),
    "scope_unverified",
  );
});

it("accepts persisted exact stop evidence and keeps recovered attempts blocked", () => {
  assert.equal(
    classifyOrganizationLiveWorkRecovery(
      { ...running, scope_attempt_id: "attempt", verified_stopped_at: now },
      now,
    ),
    "recover",
  );
  assert.equal(
    classifyOrganizationLiveWorkRecovery(
      { ...running, prep_attempt_id: "attempt", receipt_kind: "never-dispatched" },
      now,
    ),
    "recover",
  );
  assert.equal(
    classifyOrganizationLiveWorkRecovery(
      { ...running, work_status: "recovering", attempt_status: "expired" },
      now,
    ),
    "recover",
  );
});

it.effect(
  "expires a never-prepared claim, blocks its work, and holds an unverified prepared scope",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE organization_work_intent_activations (work_id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE organization_work_items (
      work_id TEXT PRIMARY KEY, request_id TEXT, request_json TEXT,
      organization_id TEXT, finding_id TEXT, project_id TEXT, binding_id TEXT,
      binding_version TEXT, scope TEXT, published_revision INTEGER, workflow_id TEXT,
      workflow_version INTEGER, code_revision TEXT, status TEXT, attempt_limit INTEGER,
      attempt_count INTEGER, creator_subject TEXT, approval_subject TEXT,
      approval_evidence_ref TEXT, integration_subject TEXT, integration_receipt_ref TEXT,
      result_code_revision TEXT, created_at TEXT, updated_at TEXT)`;
      yield* sql`CREATE TABLE organization_work_attempts (
      attempt_id TEXT PRIMARY KEY, work_id TEXT, number INTEGER, status TEXT,
      worker_subject TEXT, lease_until TEXT, artifact_digest TEXT, artifact_ref TEXT,
      qa_subject TEXT, qa_evidence_ref TEXT, started_at TEXT, updated_at TEXT)`;
      yield* sql`CREATE TABLE organization_work_transitions (
      transition_id TEXT PRIMARY KEY, work_id TEXT, action TEXT,
      actor_subject TEXT, request_json TEXT, created_at TEXT)`;
      yield* sql`CREATE TABLE organization_work_resource_permits (
      attempt_id TEXT PRIMARY KEY, state TEXT, updated_at TEXT)`;
      yield* sql`CREATE TABLE organization_work_scopes (
      attempt_id TEXT PRIMARY KEY, verified_stopped_at TEXT)`;
      yield* sql`CREATE TABLE organization_work_scope_preparations (
      attempt_id TEXT PRIMARY KEY, unit_name TEXT)`;
      yield* sql`CREATE TABLE organization_work_scope_recovery_receipts (
      attempt_id TEXT PRIMARY KEY, operation_id TEXT, unit_name TEXT, kind TEXT)`;
      yield* sql`CREATE TABLE organization_live_work_failures (
      work_id TEXT PRIMARY KEY, phase TEXT, error_code TEXT, terminal INTEGER, recorded_at TEXT)`;
      for (const workId of ["no-prep", "unverified", "unactivated"]) {
        const attemptId = `attempt-${workId}`;
        yield* sql`INSERT INTO organization_work_items VALUES
        (${workId}, ${`request-${workId}`}, '{}', 'org', 'finding', 'project', 'binding',
        '2026-01-01T00:00:00.000Z', NULL, 1, 'workflow', 1, 'basecommit',
        'running', 1, 1, 'human', NULL, NULL, NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO organization_work_attempts VALUES
        (${attemptId}, ${workId}, 1, 'running', 'worker',
        '2026-01-02T00:00:00.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO organization_work_resource_permits VALUES
        (${attemptId}, 'active', '2026-01-01T00:00:00.000Z')`;
        if (workId !== "unactivated")
          yield* sql`INSERT INTO organization_work_intent_activations VALUES (${workId})`;
        if (workId === "unverified")
          yield* sql`INSERT INTO organization_work_scope_preparations VALUES (${attemptId}, 'unit')`;
      }
      yield* TestClock.adjust("22000 days");
      const report = yield* reconcileOrganizationWorkAtStartup;
      assert.deepEqual(report, {
        recovered: ["no-prep"],
        held: [{ workId: "unverified", reason: "scope_unverified" }],
      });
      const work = yield* sql<{
        status: string;
      }>`SELECT status FROM organization_work_items WHERE work_id = 'no-prep'`;
      const attempt = yield* sql<{
        status: string;
      }>`SELECT status FROM organization_work_attempts WHERE work_id = 'no-prep'`;
      const permit = yield* sql<{
        state: string;
      }>`SELECT state FROM organization_work_resource_permits WHERE attempt_id = 'attempt-no-prep'`;
      const failure = yield* sql<{
        error_code: string;
      }>`SELECT error_code FROM organization_live_work_failures WHERE work_id = 'no-prep'`;
      assert.equal(work[0]?.status, "blocked");
      assert.equal(attempt[0]?.status, "expired");
      assert.equal(permit[0]?.state, "expired");
      assert.equal(failure[0]?.error_code, "attempt_unavailable");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

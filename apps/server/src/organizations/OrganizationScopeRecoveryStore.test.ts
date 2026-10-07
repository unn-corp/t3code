// @effect-diagnostics nodeBuiltinImport:off - Recovery tests use disposable broker and in-memory SQLite state.
import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration071 from "../persistence/Migrations/071_OrganizationWorkScopes.ts";
import Migration077 from "../persistence/Migrations/077_OrganizationScopePreparation.ts";
import Migration078 from "../persistence/Migrations/078_OrganizationReservedScopeUnits.ts";
import Migration084 from "../persistence/Migrations/084_OrganizationScopeLaunchRequested.ts";
import Migration086 from "../persistence/Migrations/086_OrganizationScopeRecoveryReceipts.ts";
import {
  serveOrganizationScopeLaunchBroker,
  organizationScopeLaunchBrokerClient,
} from "./OrganizationScopeLaunchBroker.ts";
import {
  recordOrganizationNeverDispatchedScopeRecovery,
  recordOrganizationUnattachedScopeRecovery,
} from "./OrganizationScopeRecoveryStore.ts";
import { reconcileOrganizationScopesAtStartup } from "./OrganizationScopeStartupRecovery.ts";
import {
  allocateOrganizationScopedUnitName,
  isOrganizationScopedSandboxAvailable,
} from "./OrganizationScopedSandboxHost.ts";

const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_attempts (
    attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL)`;
  yield* sql`CREATE TABLE organization_work_resource_permits (
    attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
  yield* Migration071;
  yield* Migration077;
  yield* Migration078;
  yield* Migration084;
  yield* Migration086;
  yield* sql`INSERT INTO organization_work_attempts VALUES ('attempt-a', 'work-a')`;
  yield* sql`INSERT INTO organization_work_resource_permits VALUES ('attempt-a', 'active')`;
});

it.effect("releases a permit only after the broker durably certifies no OS dispatch", () =>
  Effect.gen(function* () {
    const baseDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-recovery-test-")),
    );
    const broker = yield* Effect.promise(() => serveOrganizationScopeLaunchBroker(baseDir));
    try {
      yield* schema;
      const sql = yield* SqlClient.SqlClient;
      const unit = allocateOrganizationScopedUnitName();
      yield* sql`INSERT INTO organization_work_scope_preparations
        (attempt_id, preparation_started_at, unit_name, launch_state)
        VALUES ('attempt-a', '2026-01-01', ${unit}, 'reserved')`;
      assert.equal(
        yield* sql`UPDATE organization_work_resource_permits SET state = 'expired'
        WHERE attempt_id = 'attempt-a'`.pipe(Effect.flip, Effect.as(true)),
        true,
      );

      const client = organizationScopeLaunchBrokerClient(baseDir);
      yield* Effect.promise(() => client.activate());
      yield* Effect.promise(() => client.reserve("attempt-a", unit));
      const recovery = yield* Effect.promise(() => client.reconcile());
      assert.deepEqual(recovery, { stopped: [], neverDispatched: ["attempt-a"], held: [] });
      assert.deepEqual(yield* reconcileOrganizationScopesAtStartup(baseDir), {
        verifiedStopped: [],
        neverDispatched: ["attempt-a"],
        verifiedStoppedUnattached: [],
        held: [],
      });
      const receipt = yield* recordOrganizationNeverDispatchedScopeRecovery(baseDir, "attempt-a");
      assert.equal(receipt.unitName, unit);
      assert.deepEqual(
        yield* recordOrganizationNeverDispatchedScopeRecovery(baseDir, "attempt-a"),
        receipt,
      );
      yield* sql`UPDATE organization_work_resource_permits SET state = 'expired'
        WHERE attempt_id = 'attempt-a'`;
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
        WHERE attempt_id = 'attempt-a'`)[0]?.state,
        "expired",
      );
      assert.equal(
        yield* sql`INSERT INTO organization_work_scopes
        (attempt_id, unit_name, invocation_id, control_group, sandbox_pid,
          pid_namespace, prepared_at)
        VALUES ('attempt-a', ${unit}, ${"a".repeat(32)}, '/x', 1, 2, '2026-01-01')`.pipe(
          Effect.flip,
          Effect.as(true),
        ),
        true,
      );
    } finally {
      yield* Effect.promise(() => broker.close());
      yield* Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("keeps a dispatched identity-less attempt and legacy marker held", () =>
  Effect.gen(function* () {
    const baseDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-recovery-held-test-")),
    );
    const broker = yield* Effect.promise(() => serveOrganizationScopeLaunchBroker(baseDir));
    try {
      yield* schema;
      const sql = yield* SqlClient.SqlClient;
      const unit = allocateOrganizationScopedUnitName();
      yield* sql`INSERT INTO organization_work_scope_preparations
        (attempt_id, preparation_started_at, unit_name, launch_state)
        VALUES ('attempt-a', '2026-01-01', ${unit}, 'reserved')`;
      yield* sql`UPDATE organization_work_scope_preparations
        SET launch_state = 'requested', launch_requested_at = '2026-01-01'
        WHERE attempt_id = 'attempt-a'`;
      const client = organizationScopeLaunchBrokerClient(baseDir);
      yield* Effect.promise(() => client.activate());
      yield* Effect.promise(() => client.reserve("attempt-a", unit));
      // Invalid input rejects before systemd-run here, but the durable
      // dispatching marker cannot assume where another host failed.
      yield* Effect.promise(() =>
        client.prepare("attempt-a", { reservedUnitName: unit, argv: ["relative-command"] }).then(
          () => false,
          () => true,
        ),
      );
      assert.deepEqual((yield* Effect.promise(() => client.reconcile())).held, ["attempt-a"]);
      yield* recordOrganizationNeverDispatchedScopeRecovery(baseDir, "attempt-a").pipe(Effect.flip);
      yield* sql`UPDATE organization_work_resource_permits SET state = 'expired'
        WHERE attempt_id = 'attempt-a'`.pipe(Effect.flip);
      assert.equal(
        (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
        WHERE attempt_id = 'attempt-a'`)[0]?.state,
        "active",
      );
    } finally {
      yield* Effect.promise(() => broker.close());
      yield* Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect.skipIf(!isOrganizationScopedSandboxAvailable())(
  "releases an unattached prepared scope only after its exact broker stop",
  () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-recovery-stopped-test-")),
      );
      const broker = yield* Effect.promise(() => serveOrganizationScopeLaunchBroker(baseDir));
      try {
        yield* schema;
        const sql = yield* SqlClient.SqlClient;
        const unit = allocateOrganizationScopedUnitName();
        yield* sql`INSERT INTO organization_work_scope_preparations
          (attempt_id, preparation_started_at, unit_name, launch_state)
          VALUES ('attempt-a', '2026-01-01', ${unit}, 'reserved')`;
        yield* sql`UPDATE organization_work_scope_preparations
          SET launch_state = 'requested', launch_requested_at = '2026-01-01'
          WHERE attempt_id = 'attempt-a'`;
        const client = organizationScopeLaunchBrokerClient(baseDir);
        yield* Effect.promise(() => client.activate());
        yield* Effect.promise(() => client.reserve("attempt-a", unit));
        const handle = yield* Effect.promise(() =>
          client.prepare("attempt-a", {
            reservedUnitName: unit,
            argv: ["/usr/bin/node", "-e", "process.exit(0)"],
            runtimeMs: 2_000,
          }),
        );
        yield* Effect.promise(() => handle.discard());
        assert.deepEqual(yield* reconcileOrganizationScopesAtStartup(baseDir), {
          verifiedStopped: [],
          neverDispatched: [],
          verifiedStoppedUnattached: ["attempt-a"],
          held: [],
        });
        const receipt = yield* recordOrganizationUnattachedScopeRecovery(baseDir, "attempt-a");
        assert.equal(receipt.kind, "verified-stopped-unattached");
        yield* sql`UPDATE organization_work_resource_permits SET state = 'expired'
          WHERE attempt_id = 'attempt-a'`;
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state FROM organization_work_resource_permits
            WHERE attempt_id = 'attempt-a'`)[0]?.state,
          "expired",
        );
      } finally {
        yield* Effect.promise(() => broker.close());
        yield* Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

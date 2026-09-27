// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off - Host-local process markers, UTC receipts and broker identity receipts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import {
  OrganizationWorkError,
  type OrganizationId,
  type OrganizationWorkId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { OrganizationPatchProcessObserverShape } from "../textGeneration/OrganizationPatchProcessObserver.ts";
import { organizationScopeLaunchBrokerClient } from "./OrganizationScopeLaunchBroker.ts";
import { organizationQABrokerOperationPrefix } from "./OrganizationScopedBrokerHosts.ts";
import { recoverOrganizationProviderProcessesAtStartup } from "./OrganizationProviderProcessRecovery.ts";

type StopRow = {
  organization_id: string;
  request_id: string;
  requested_by: string;
  requested_at: string;
};
export interface OrganizationEmergencyStopStatus {
  readonly organizationId: OrganizationId;
  readonly state: "none" | "requested";
  readonly requestedAt: string | null;
  readonly admittedPhases: number;
  readonly verifiedProviderExits: number;
  readonly unverifiedProviderLaunches: number;
  readonly verifiedScopes: number;
}
export interface OrganizationEmergencyStopPrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}

const fail = (code: OrganizationWorkError["code"], message: string) =>
  new OrganizationWorkError({ code, message });

/** Only the process that owns these admitted phase fibers can interrupt them. */
const livePhases = new Map<
  OrganizationWorkId,
  { readonly organizationId: OrganizationId; readonly interrupt: () => Effect.Effect<void> }
>();
const liveProviders = new Map<OrganizationWorkId, ChildProcessSpawner.ChildProcessHandle>();

export class OrganizationLiveWorkEmergencyDeferred extends Error {
  readonly _tag = "OrganizationLiveWorkEmergencyDeferred";
  constructor() {
    super("Organization emergency stop holds Project work.");
  }
}

export const registerOrganizationLivePhase = (
  organizationId: OrganizationId,
  workId: OrganizationWorkId,
  interrupt: () => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    if (livePhases.has(workId))
      return yield* Effect.fail(new OrganizationLiveWorkEmergencyDeferred());
    const entry = { organizationId, interrupt };
    livePhases.set(workId, entry);
    return () => {
      if (livePhases.get(workId) === entry) livePhases.delete(workId);
    };
  });

export const hasUnverifiedOrganizationProvider = (workId: OrganizationWorkId) =>
  liveProviders.has(workId);

/** The adapter calls exited only after the exact child handle reports no process. */
export const makeOrganizationEmergencyProviderObserver = (
  organizationId: OrganizationId,
  workId: OrganizationWorkId,
  sql: SqlClient.SqlClient,
): OrganizationPatchProcessObserverShape => {
  const launchMarker = NodeCrypto.randomBytes(32).toString("hex");
  let markerRecord = launchMarker;
  if (process.platform === "linux") {
    try {
      const uptime = Number(NodeFS.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
      const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (Number.isFinite(uptime) && uptime > 0 && /^[a-f0-9-]{36}$/.test(bootId))
        markerRecord = `${launchMarker}|${uptime}|${bootId}`;
    } catch {
      // Recovery holds launches whose monotonic preparation time is unavailable.
    }
  }
  return {
    environment: { T3_ORG_PROVIDER_LAUNCH_ID: launchMarker },
    preparing: () =>
      Effect.gen(function* () {
        const preparedAt = new Date().toISOString();
        const inserted = yield* sql<{ work_id: string }>`INSERT INTO organization_provider_processes
        (work_id, organization_id, state, process_id, prepared_at, spawned_at, exited_at, launch_marker)
        SELECT ${workId}, ${organizationId}, 'launching', NULL, ${preparedAt}, NULL, NULL, ${markerRecord}
        WHERE EXISTS (SELECT 1 FROM organization_work_items w
          WHERE w.work_id = ${workId} AND w.organization_id = ${organizationId})
          AND NOT EXISTS (SELECT 1 FROM organization_emergency_stops stop
            WHERE stop.organization_id = ${organizationId})
        ON CONFLICT(work_id) DO UPDATE SET
          state = 'launching', process_id = NULL, prepared_at = excluded.prepared_at,
          spawned_at = NULL, exited_at = NULL, launch_marker = excluded.launch_marker
        WHERE organization_provider_processes.state = 'exited'
        RETURNING work_id`;
        if (inserted.length !== 1)
          return yield* Effect.die(new Error("Provider launch intent is held or unauthorized."));
      }).pipe(Effect.orDie),
    spawned: (handle) =>
      Effect.gen(function* () {
        liveProviders.set(workId, handle);
        const spawnedAt = new Date().toISOString();
        const updated = yield* sql<{ work_id: string }>`UPDATE organization_provider_processes
        SET state = 'running', process_id = ${handle.pid}, spawned_at = ${spawnedAt}
        WHERE work_id = ${workId} AND organization_id = ${organizationId}
          AND state = 'launching' RETURNING work_id`;
        if (updated.length !== 1)
          return yield* Effect.die(new Error("Provider process identity could not be saved."));
      }).pipe(Effect.orDie),
    exited: (handle) =>
      Effect.gen(function* () {
        if (liveProviders.get(workId) !== handle) return;
        const exitedAt = new Date().toISOString();
        const updated = yield* sql<{ work_id: string }>`UPDATE organization_provider_processes
        SET state = 'exited', exited_at = ${exitedAt}
        WHERE work_id = ${workId} AND organization_id = ${organizationId}
          AND state = 'running' AND process_id = ${handle.pid}
        RETURNING work_id`;
        if (updated.length !== 1)
          return yield* Effect.die(new Error("Provider process exit could not be saved."));
        yield* recordOrganizationProviderExit({
          organizationId,
          workId,
          processId: handle.pid,
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        liveProviders.delete(workId);
      }).pipe(Effect.orDie),
  };
};

const interruptOrganizationLivePhases = (organizationId: OrganizationId) =>
  Effect.forEach(
    [...livePhases.values()].filter((entry) => entry.organizationId === organizationId),
    (entry) => entry.interrupt().pipe(Effect.exit),
    { discard: true },
  );

/** Neither requested nor a provider exit receipt claims that scoped/Git work stopped. */
export const readOrganizationEmergencyStop = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const exists = yield* sql<{ organization_id: string }>`SELECT organization_id FROM organizations
      WHERE organization_id = ${organizationId}`;
    if (exists.length === 0) return yield* fail("not_found", "Organization is unavailable.");
    const row = (yield* sql<StopRow>`SELECT * FROM organization_emergency_stops
      WHERE organization_id = ${organizationId}`)[0];
    const claims = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM organization_live_work_phase_claims WHERE organization_id = ${organizationId}`;
    const exits = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM organization_emergency_provider_exits WHERE organization_id = ${organizationId}`;
    const unverified = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM organization_provider_processes
      WHERE organization_id = ${organizationId} AND state <> 'exited'`;
    const scopes = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM organization_emergency_scope_stops WHERE organization_id = ${organizationId}`;
    return {
      organizationId,
      state: row ? ("requested" as const) : ("none" as const),
      requestedAt: row?.requested_at ?? null,
      admittedPhases: claims[0]?.count ?? 0,
      verifiedProviderExits: exits[0]?.count ?? 0,
      unverifiedProviderLaunches: unverified[0]?.count ?? 0,
      verifiedScopes: scopes[0]?.count ?? 0,
    };
  });

type Broker = Pick<
  ReturnType<typeof organizationScopeLaunchBrokerClient>,
  "checkOwner" | "status" | "stopAndVerifyOperation"
>;
export interface OrganizationEmergencyScopeStopReport {
  readonly verified: readonly string[];
  readonly held: readonly string[];
}

/** Replays safely after crashes. Only journal entries bound to this Organization's
 * persisted attempts are eligible for an exact broker stop.
 */
export const stopAndVerifyOrganizationEmergencyScopes = (
  organizationId: OrganizationId,
  broker: Broker,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stop = yield* sql<StopRow>`SELECT * FROM organization_emergency_stops
      WHERE organization_id = ${organizationId}`;
    if (stop.length === 0)
      return yield* fail("conflict", "Emergency stop must be durable before scoped recovery.");
    const attempts = yield* sql<{ attempt_id: string; work_id: string }>`SELECT
      a.attempt_id, a.work_id FROM organization_work_attempts a
      JOIN organization_work_items w ON w.work_id = a.work_id
      WHERE w.organization_id = ${organizationId} ORDER BY a.attempt_id LIMIT 1025`;
    if (attempts.length > 1024)
      return yield* fail("unavailable", "Scoped recovery batch limit was exceeded.");
    const journal = yield* Effect.tryPromise({
      try: async () => {
        if ((await broker.checkOwner()) !== true)
          throw new Error("Organization broker owner is unavailable.");
        return broker.status();
      },
      catch: () => fail("unavailable", "Organization broker owner is unavailable."),
    });
    const selected = journal.flatMap((entry) => {
      const attempt = attempts.find(
        (candidate) =>
          entry.operationId === candidate.attempt_id ||
          entry.operationId.startsWith(organizationQABrokerOperationPrefix(candidate.attempt_id)),
      );
      return attempt ? [{ entry, attempt }] : [];
    });
    const verified: string[] = [];
    const held: string[] = [];
    for (const { entry, attempt } of selected) {
      const outcome = yield* Effect.tryPromise({
        try: () => broker.stopAndVerifyOperation(entry.operationId),
        catch: () => fail("unavailable", "Exact broker stop could not be verified."),
      }).pipe(Effect.result);
      if (Result.isFailure(outcome) || outcome.success.disposition === "held") {
        held.push(entry.operationId);
        continue;
      }
      const evidence = outcome.success;
      const verifiedAt = new Date().toISOString();
      const identityJson = evidence.identity ? JSON.stringify(evidence.identity) : null;
      yield* sql`INSERT INTO organization_emergency_scope_stops
        (operation_id, organization_id, work_id, attempt_id, disposition, identity_json, verified_at)
        VALUES (${entry.operationId}, ${organizationId}, ${attempt.work_id},
          ${attempt.attempt_id}, ${evidence.disposition}, ${identityJson}, ${verifiedAt})
        ON CONFLICT(operation_id) DO NOTHING`;
      verified.push(entry.operationId);
    }
    return { verified, held } satisfies OrganizationEmergencyScopeStopReport;
  });

/** Run after exclusive broker ownership and global scope recovery, before
 * readiness is granted. A held operation or lost owner keeps the gate closed.
 */
export const reconcileOrganizationEmergencyStopsAfterRecovery = (
  broker: Broker,
  options: { readonly recoverOrphanProviders?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ organization_id: string }>`SELECT organization_id
      FROM organization_emergency_stops ORDER BY requested_at LIMIT 129`;
    const held: { workId: string; reason: string }[] = [];
    if (rows.length > 128)
      held.push({ workId: rows[128]!.organization_id, reason: "emergency_recovery_batch_limit" });
    for (const row of rows.slice(0, 128)) {
      const result = yield* Effect.result(
        stopAndVerifyOrganizationEmergencyScopes(row.organization_id as OrganizationId, broker),
      );
      if (Result.isFailure(result)) {
        held.push({ workId: row.organization_id, reason: "emergency_scope_recovery_failed" });
        continue;
      }
      held.push(
        ...result.success.held.map((operationId) => ({
          workId: row.organization_id,
          reason: `emergency_scope_held:${operationId}`,
        })),
      );
    }
    if (options.recoverOrphanProviders !== false) {
      const providerRecovery = yield* recoverOrganizationProviderProcessesAtStartup;
      held.push(...providerRecovery.held);
    }
    return { held };
  });

/** Retries exact broker stops while HTTP is running. The startup gate remains
 * responsible for owner recovery and for unresolved provider processes.
 */
export const makeOrganizationEmergencyStopReconciliationLoopLayer = (broker: Broker) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep("30 seconds").pipe(
            Effect.andThen(
              reconcileOrganizationEmergencyStopsAfterRecovery(broker, {
                recoverOrphanProviders: false,
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
            ),
            Effect.tap((report) =>
              report.held.length > 0
                ? Effect.logWarning("Organization emergency stop recovery remains held", {
                    held: report.held,
                  })
                : Effect.void,
            ),
            Effect.catch(() =>
              Effect.logWarning("Organization emergency stop recovery needs a retry"),
            ),
          ),
        ),
      );
    }),
  );

/** The durable fence commits before any in-process phase is interrupted. */
export const requestOrganizationEmergencyStop = (
  input: { readonly organizationId: OrganizationId; readonly requestId: string },
  principal: OrganizationEmergencyStopPrincipal,
) =>
  Effect.gen(function* () {
    if (
      !principal.interactive ||
      !principal.subject.trim() ||
      Buffer.byteLength(principal.subject, "utf8") > 160
    )
      return yield* fail("forbidden", "Emergency stop requires an authenticated interactive user.");
    if (!input.requestId.trim() || Buffer.byteLength(input.requestId, "utf8") > 160)
      return yield* fail("invalid", "Emergency stop request ID is invalid.");
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const org = (yield* sql<{
          lifecycle: string;
        }>`UPDATE organizations SET updated_at = updated_at
          WHERE organization_id = ${input.organizationId} RETURNING lifecycle`)[0];
        if (!org) return yield* fail("not_found", "Organization is unavailable.");
        if (org.lifecycle === "draft" || org.lifecycle === "archived")
          return yield* fail("conflict", "This Organization has no active Project work to stop.");
        const prior = (yield* sql<StopRow>`SELECT * FROM organization_emergency_stops
          WHERE organization_id = ${input.organizationId}`)[0];
        if (prior) {
          if (prior.request_id !== input.requestId)
            return yield* fail(
              "conflict",
              "This Organization already has an emergency stop request.",
            );
          return;
        }
        const used = yield* sql<{ request_id: string }>`SELECT request_id
          FROM organization_emergency_stops WHERE request_id = ${input.requestId}`;
        if (used.length > 0)
          return yield* fail("conflict", "Emergency stop request ID has already been used.");
        const requestedAt = new Date().toISOString();
        yield* sql`INSERT INTO organization_emergency_stops
          (organization_id, request_id, requested_by, requested_at)
          VALUES (${input.organizationId}, ${input.requestId}, ${principal.subject}, ${requestedAt})`;
      }),
    );
    // A timed-out interruption leaves the durable stop fence in place. A retry
    // interrupts remaining locally owned phases without admitting new work.
    yield* interruptOrganizationLivePhases(input.organizationId).pipe(
      Effect.timeoutOption("10 seconds"),
    );
    return yield* readOrganizationEmergencyStop(input.organizationId);
  });

/** Called only after the exact spawned provider handle reports exited. */
export const recordOrganizationProviderExit = (input: {
  readonly organizationId: OrganizationId;
  readonly workId: OrganizationWorkId;
  readonly processId: number;
}) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(input.processId) || input.processId <= 0)
      return yield* fail("invalid", "Provider process identity is invalid.");
    const sql = yield* SqlClient.SqlClient;
    const verifiedAt = new Date().toISOString();
    yield* sql`INSERT INTO organization_emergency_provider_exits
      (work_id, organization_id, process_id, verified_at)
      SELECT ${input.workId}, ${input.organizationId}, ${input.processId}, ${verifiedAt}
      WHERE EXISTS (SELECT 1 FROM organization_emergency_stops stop
        WHERE stop.organization_id = ${input.organizationId})
        AND EXISTS (SELECT 1 FROM organization_work_items w
          WHERE w.work_id = ${input.workId} AND w.organization_id = ${input.organizationId})
      ON CONFLICT(work_id) DO NOTHING`;
  });

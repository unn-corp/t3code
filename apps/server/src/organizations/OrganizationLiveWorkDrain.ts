// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off - Durable local process claims use a process epoch and UTC receipts.
import * as NodeCrypto from "node:crypto";
import {
  OrganizationWorkError,
  type OrganizationId,
  type OrganizationWorkId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import {
  OrganizationLiveWorkEmergencyDeferred,
  hasUnverifiedOrganizationProvider,
  makeOrganizationEmergencyProviderObserver,
  registerOrganizationLivePhase,
} from "./OrganizationLiveWorkEmergencyStop.ts";
import { OrganizationPatchProcessObserver } from "../textGeneration/OrganizationPatchProcessObserver.ts";

type Phase = "attempt" | "qa" | "integration";
type DrainRow = {
  organization_id: string;
  request_id: string;
  requested_by: string;
  requested_at: string;
  completed_at: string | null;
};
export type OrganizationWorkDrainState = "none" | "draining" | "paused";
export interface OrganizationWorkDrainStatus {
  readonly organizationId: OrganizationId;
  readonly state: OrganizationWorkDrainState;
  readonly requestedAt: string | null;
}
export interface OrganizationWorkDrainPrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}

const processEpoch = NodeCrypto.randomUUID();
const workError = (code: OrganizationWorkError["code"], message: string) =>
  new OrganizationWorkError({ code, message });
const status = (
  organizationId: OrganizationId,
  row: DrainRow | undefined,
): OrganizationWorkDrainStatus => ({
  organizationId,
  state: row === undefined ? "none" : row.completed_at === null ? "draining" : "paused",
  requestedAt: row?.requested_at ?? null,
});

export class OrganizationLiveWorkDrainDeferred extends Error {
  readonly _tag = "OrganizationLiveWorkDrainDeferred";
  constructor() {
    super("Organization drain defers new work phases.");
  }
}

/** This transaction is also called after the last admitted phase settles. */
const finishDrain = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql<DrainRow>`SELECT * FROM organization_live_work_drains
      WHERE organization_id = ${organizationId}`)[0];
    if (!row || row.completed_at !== null) return status(organizationId, row);
    const open = yield* sql<{
      work_id: string;
    }>`SELECT work_id FROM organization_live_work_phase_claims
      WHERE organization_id = ${organizationId} LIMIT 1`;
    if (open.length > 0) return status(organizationId, row);
    const unresolved = yield* sql<{ attempt_id: string }>`SELECT a.attempt_id
      FROM organization_work_attempts a
      JOIN organization_work_items w ON w.work_id = a.work_id
      LEFT JOIN organization_work_scopes s ON s.attempt_id = a.attempt_id
      LEFT JOIN organization_work_scope_preparations prep ON prep.attempt_id = a.attempt_id
      LEFT JOIN organization_work_scope_recovery_receipts recovery
        ON recovery.attempt_id = prep.attempt_id
          AND recovery.operation_id = prep.attempt_id
          AND recovery.unit_name = prep.unit_name
          AND recovery.kind IN ('never-dispatched', 'verified-stopped-unattached')
      WHERE w.organization_id = ${organizationId}
        AND (a.status = 'running'
          OR (s.attempt_id IS NOT NULL AND s.verified_stopped_at IS NULL)
          OR (prep.attempt_id IS NOT NULL AND s.verified_stopped_at IS NULL
            AND recovery.attempt_id IS NULL))
      LIMIT 1`;
    if (unresolved.length > 0) return status(organizationId, row);
    const organization = (yield* sql<{ lifecycle: string; draft_revision: number }>`
      UPDATE organizations SET updated_at = updated_at WHERE organization_id = ${organizationId}
      RETURNING lifecycle, draft_revision`)[0];
    if (!organization) return yield* workError("not_found", "Organization is unavailable.");
    if (organization.lifecycle === "active") {
      yield* OrganizationStore.pipe(
        Effect.flatMap((store) =>
          store.setLifecycle({
            organizationId,
            mutationId: row.request_id,
            baseRevision: organization.draft_revision,
            actor: "user",
            lifecycle: "paused",
          }),
        ),
        Effect.provide(Layer.fresh(OrganizationStoreLive)),
        Effect.mapError((error) =>
          workError(error.code === "duplicate_mutation" ? "conflict" : error.code, error.message),
        ),
      );
    } else if (organization.lifecycle !== "paused") {
      return yield* workError(
        "conflict",
        "Organization cannot complete a drain in this lifecycle.",
      );
    }
    const completedAt = new Date().toISOString();
    yield* sql`UPDATE organization_live_work_drains SET completed_at = ${completedAt}
      WHERE organization_id = ${organizationId} AND completed_at IS NULL`;
    return { organizationId, state: "paused" as const, requestedAt: row.requested_at };
  });

export const readOrganizationWorkDrain = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const exists = yield* sql<{ lifecycle: string }>`SELECT lifecycle FROM organizations
      WHERE organization_id = ${organizationId}`;
    if (exists.length === 0) return yield* workError("not_found", "Organization is unavailable.");
    if (exists[0]?.lifecycle === "archived") return status(organizationId, undefined);
    const row = (yield* sql<DrainRow>`SELECT * FROM organization_live_work_drains
      WHERE organization_id = ${organizationId}`)[0];
    return status(organizationId, row);
  });

/** A durable request stops admitting new phases before it waits for admitted work. */
export const requestOrganizationWorkDrain = (
  input: { readonly organizationId: OrganizationId; readonly requestId: string },
  principal: OrganizationWorkDrainPrincipal,
) =>
  Effect.gen(function* () {
    if (
      !principal.interactive ||
      !principal.subject.trim() ||
      Buffer.byteLength(principal.subject, "utf8") > 160
    )
      return yield* workError(
        "forbidden",
        "Draining work requires an authenticated interactive user.",
      );
    if (!input.requestId.trim() || Buffer.byteLength(input.requestId, "utf8") > 160)
      return yield* workError("invalid", "Drain request ID is invalid.");
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const org = (yield* sql<{
          lifecycle: string;
        }>`UPDATE organizations SET updated_at = updated_at
          WHERE organization_id = ${input.organizationId} RETURNING lifecycle`)[0];
        if (!org) return yield* workError("not_found", "Organization is unavailable.");
        if (org.lifecycle === "archived")
          return yield* workError("conflict", "Archived Organizations cannot drain work.");
        const existing = (yield* sql<DrainRow>`SELECT * FROM organization_live_work_drains
          WHERE organization_id = ${input.organizationId}`)[0];
        if (existing) return yield* finishDrain(input.organizationId);
        if (org.lifecycle !== "active")
          return yield* workError("conflict", "Only active Organizations can drain work.");
        const used = yield* sql<{ request_id: string }>`
          SELECT mutation_id AS request_id FROM organization_audit
          WHERE mutation_id = ${input.requestId}
          UNION SELECT request_id FROM organization_live_work_drains
          WHERE request_id = ${input.requestId} LIMIT 1`;
        if (used.length > 0)
          return yield* workError("conflict", "Drain request ID has already been used.");
        const requestedAt = new Date().toISOString();
        yield* sql`INSERT INTO organization_live_work_drains
          (organization_id, request_id, requested_by, requested_at, completed_at)
          VALUES (${input.organizationId}, ${input.requestId}, ${principal.subject}, ${requestedAt}, NULL)`;
        return yield* finishDrain(input.organizationId);
      }),
    );
  });

const claimPhase = (workId: OrganizationWorkId, phase: Phase) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const work = (yield* sql<{ organization_id: string; lifecycle: string }>`
          SELECT w.organization_id, o.lifecycle FROM organization_work_items w
          JOIN organization_work_intent_activations activation ON activation.work_id = w.work_id
            AND activation.organization_id = w.organization_id
          JOIN organizations o ON o.organization_id = w.organization_id
          WHERE w.work_id = ${workId}`)[0];
        if (!work || work.lifecycle !== "active")
          return yield* Effect.fail(new OrganizationLiveWorkDrainDeferred());
        const emergencyStop = yield* sql<{ organization_id: string }>`SELECT organization_id
          FROM organization_emergency_stops WHERE organization_id = ${work.organization_id}`;
        if (emergencyStop.length > 0)
          return yield* Effect.fail(new OrganizationLiveWorkEmergencyDeferred());
        const drain = yield* sql<{ organization_id: string }>`SELECT organization_id
          FROM organization_live_work_drains WHERE organization_id = ${work.organization_id}`;
        if (drain.length > 0) return yield* Effect.fail(new OrganizationLiveWorkDrainDeferred());
        const startedAt = new Date().toISOString();
        yield* sql`INSERT INTO organization_live_work_phase_claims
          (work_id, organization_id, phase, owner_epoch, started_at)
          VALUES (${workId}, ${work.organization_id}, ${phase}, ${processEpoch}, ${startedAt})`;
        return { organizationId: work.organization_id as OrganizationId, workId };
      }),
    );
  });

const releasePhase = (claim: {
  readonly organizationId: OrganizationId;
  readonly workId: OrganizationWorkId;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (hasUnverifiedOrganizationProvider(claim.workId)) {
      yield* Effect.logError("Organization provider exit is unverified; retaining phase claim", {
        organizationId: claim.organizationId,
        workId: claim.workId,
      });
      return;
    }
    yield* sql`DELETE FROM organization_live_work_phase_claims
      WHERE work_id = ${claim.workId} AND organization_id = ${claim.organizationId}
        AND owner_epoch = ${processEpoch}`;
    yield* sql.withTransaction(finishDrain(claim.organizationId)).pipe(
      Effect.catch(() =>
        Effect.logWarning("Organization drain completion needs a retry", {
          organizationId: claim.organizationId,
        }),
      ),
    );
  });

/** The claim spans provider, scoped worker/QA, and integration effects. */
export const withOrganizationLiveWorkPhaseClaim = <A, E, R>(
  workId: OrganizationWorkId,
  phase: Phase,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    claimPhase(workId, phase),
    (claim) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const sql = yield* SqlClient.SqlClient;
          const observer = makeOrganizationEmergencyProviderObserver(
            claim.organizationId,
            workId,
            sql,
          );
          const fiber = yield* Effect.forkChild(
            Deferred.await(gate).pipe(
              Effect.andThen(
                restore(
                  action.pipe(Effect.provideService(OrganizationPatchProcessObserver, observer)),
                ),
              ),
            ),
          );
          return yield* Effect.acquireUseRelease(
            registerOrganizationLivePhase(claim.organizationId, workId, () =>
              Fiber.interrupt(fiber).pipe(Effect.asVoid),
            ),
            () =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const stop = yield* sql<{ organization_id: string }>`SELECT organization_id
                  FROM organization_emergency_stops
                  WHERE organization_id = ${claim.organizationId}`;
                if (stop.length > 0)
                  return yield* Effect.fail(new OrganizationLiveWorkEmergencyDeferred());
                yield* Deferred.succeed(gate, undefined);
                return yield* restore(Fiber.join(fiber)).pipe(
                  Effect.catchCauseIf(Cause.hasInterruptsOnly, () =>
                    Effect.fail(new OrganizationLiveWorkEmergencyDeferred()),
                  ),
                );
              }),
            (unregister) =>
              Fiber.interrupt(fiber).pipe(
                Effect.tap(() => Effect.sync(unregister)),
                Effect.asVoid,
              ),
          );
        }),
      ),
    releasePhase,
  );

/** Exclusive broker owner recovery has completed before stale claims are discarded. */
export const reconcileOrganizationWorkDrainsAfterRecovery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const stillOwned = yield* sql<{ work_id: string }>`SELECT work_id
    FROM organization_live_work_phase_claims WHERE owner_epoch = ${processEpoch} LIMIT 1`;
  if (stillOwned.length > 0)
    return { held: [{ workId: stillOwned[0]!.work_id, reason: "live_phase_claim" }] };
  const stale = yield* sql<{ organization_id: string }>`SELECT DISTINCT organization_id
    FROM organization_live_work_phase_claims WHERE owner_epoch <> ${processEpoch}`;
  for (const row of stale) {
    yield* sql`DELETE FROM organization_live_work_phase_claims
      WHERE organization_id = ${row.organization_id} AND owner_epoch <> ${processEpoch}`;
  }
  const drains = yield* sql<{ organization_id: string }>`SELECT organization_id
    FROM organization_live_work_drains WHERE completed_at IS NULL`;
  const held: { workId: string; reason: string }[] = [];
  for (const row of drains) {
    const result = yield* Effect.exit(
      sql.withTransaction(finishDrain(row.organization_id as OrganizationId)),
    );
    if (Exit.isFailure(result))
      held.push({ workId: row.organization_id, reason: "drain_finalization_failed" });
  }
  return { held };
});

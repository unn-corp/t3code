import type {
  OrganizationId,
  OrganizationLifecycleInput,
  OrganizationWorkId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrganizationLiveWorkRuntimeReadiness } from "./OrganizationLiveWorkExecutor.ts";
import {
  OrganizationLifecycleActivationAuthority,
  OrganizationStore,
  OrganizationStoreLayer,
} from "./OrganizationStore.ts";
import {
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

export interface OrganizationLiveWorkLifecyclePrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}

export class OrganizationLiveWorkLifecycleError extends Schema.TaggedError<OrganizationLiveWorkLifecycleError>()(
  "OrganizationLiveWorkLifecycleError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
const fail = (code: OrganizationLiveWorkLifecycleError["code"], message: string) =>
  new OrganizationLiveWorkLifecycleError({ code, message });
const isLifecycleError = Schema.is(OrganizationLiveWorkLifecycleError);

const requireInteractive = (principal: OrganizationLiveWorkLifecyclePrincipal) =>
  principal.interactive &&
  typeof principal.subject === "string" &&
  principal.subject.trim().length > 0 &&
  Buffer.byteLength(principal.subject, "utf8") <= 160;

/** Pausing uses OrganizationStore's existing idle-only transition. Resuming
 * receives a private exact-request authority after readiness and scope checks.
 */
export const resumePausedOrganization = (
  input: OrganizationLifecycleInput,
  principal: OrganizationLiveWorkLifecyclePrincipal,
) =>
  Effect.gen(function* () {
    if (!requireInteractive(principal))
      return yield* fail("forbidden", "Resuming work requires an authenticated interactive user.");
    if (input.actor !== "user" || input.lifecycle !== "active")
      return yield* fail("invalid", "Resume requires the active lifecycle action.");
    const readiness = yield* OrganizationLiveWorkRuntimeReadiness;
    if (!readiness.status().ready)
      return yield* fail("unavailable", "Organization work runtime is not ready.");
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // The write lock serializes resume with pause, archive and scope changes.
          const row = (yield* sql<{
            lifecycle: string;
            draft_revision: number;
            published_revision: number | null;
          }>`UPDATE organizations SET updated_at = updated_at
            WHERE organization_id = ${input.organizationId}
            RETURNING lifecycle, draft_revision, published_revision`)[0];
          if (!row) return yield* fail("not_found", "Organization is unavailable.");
          if (row.lifecycle !== "paused")
            return yield* fail("conflict", "Only a paused Organization can resume.");
          if (row.draft_revision !== input.baseRevision)
            return yield* fail("conflict", "Organization revision changed before resume.");
          if (row.published_revision === null)
            return yield* fail("conflict", "Publish configuration before resuming work.");
          const emergencyStop = yield* sql<{ organization_id: string }>`
            SELECT organization_id FROM organization_emergency_stops
            WHERE organization_id = ${input.organizationId} LIMIT 1`;
          if (emergencyStop.length > 0)
            return yield* fail("conflict", "Resolve emergency stop before resuming Project work.");
          const drain = (yield* sql<{ completed_at: string | null }>`
            SELECT completed_at FROM organization_live_work_drains
            WHERE organization_id = ${input.organizationId}`)[0];
          if (drain?.completed_at === null)
            return yield* fail("conflict", "Finish the Organization drain before resuming.");
          const phaseClaims = yield* sql<{ work_id: string }>`
            SELECT work_id FROM organization_live_work_phase_claims
            WHERE organization_id = ${input.organizationId} LIMIT 1`;
          if (phaseClaims.length > 0)
            return yield* fail("conflict", "Admitted work phases must settle before resuming.");
          const open = yield* sql<{ attempt_id: string }>`SELECT a.attempt_id
            FROM organization_work_attempts a
            JOIN organization_work_items w ON w.work_id = a.work_id
            LEFT JOIN organization_work_scopes s ON s.attempt_id = a.attempt_id
            LEFT JOIN organization_work_scope_preparations prep ON prep.attempt_id = a.attempt_id
            LEFT JOIN organization_work_scope_recovery_receipts recovery
              ON recovery.attempt_id = prep.attempt_id
                AND recovery.operation_id = prep.attempt_id
                AND recovery.unit_name = prep.unit_name
                AND recovery.kind IN ('never-dispatched', 'verified-stopped-unattached')
            WHERE w.organization_id = ${input.organizationId}
              AND (a.status = 'running'
                OR (s.attempt_id IS NOT NULL AND s.verified_stopped_at IS NULL)
                OR (prep.attempt_id IS NOT NULL AND s.verified_stopped_at IS NULL
                  AND recovery.attempt_id IS NULL))
            LIMIT 1`;
          if (open.length > 0)
            return yield* fail(
              "conflict",
              "Verify or recover the existing worker scope before resuming.",
            );
          if (!readiness.status().ready)
            return yield* fail("unavailable", "Organization work runtime is not ready.");
          const exactAuthority = Layer.succeed(OrganizationLifecycleActivationAuthority, {
            permits: (request: OrganizationLifecycleInput) =>
              request === input && readiness.status().ready,
          });
          const resumed = yield* OrganizationStore.pipe(
            Effect.flatMap((store) => store.setLifecycle(input)),
            Effect.provide(Layer.fresh(OrganizationStoreLayer.pipe(Layer.provide(exactAuthority)))),
            Effect.mapError((error) =>
              fail(error.code === "duplicate_mutation" ? "conflict" : error.code, error.message),
            ),
          );
          yield* sql`DELETE FROM organization_live_work_drains
            WHERE organization_id = ${input.organizationId} AND completed_at IS NOT NULL`;
          return resumed;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isLifecycleError(error)
            ? error
            : fail("unavailable", "Organization resume is unavailable."),
        ),
      );
  });

export interface CancelActivatedOrganizationWorkInput {
  readonly organizationId: OrganizationId;
  readonly workId: OrganizationWorkId;
  readonly transitionId: string;
}

/** Cancellation never stops a process by itself. WorkStore keeps active
 * permits when a prepared worker scope lacks verified stop evidence.
 */
export const cancelActivatedOrganizationWork = (
  input: CancelActivatedOrganizationWorkInput,
  principal: OrganizationLiveWorkLifecyclePrincipal,
) =>
  Effect.gen(function* () {
    if (!requireInteractive(principal))
      return yield* fail("forbidden", "Canceling work requires an authenticated interactive user.");
    if (
      typeof input.transitionId !== "string" ||
      !input.transitionId.trim() ||
      Buffer.byteLength(input.transitionId, "utf8") > 160
    )
      return yield* fail("invalid", "Cancellation transition ID is invalid.");
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const target = (yield* sql<{
            organization_id: string;
            project_id: string;
            binding_id: string;
            scope: string | null;
          }>`SELECT w.organization_id, w.project_id, w.binding_id, w.scope
            FROM organization_work_intent_activations activation
            JOIN organization_work_items w ON w.work_id = activation.work_id
            WHERE activation.organization_id = ${input.organizationId}
              AND activation.work_id = ${input.workId}
              AND w.organization_id = ${input.organizationId}`)[0];
          if (!target)
            return yield* fail("not_found", "Activated Organization work is unavailable.");
          if (target.scope !== null)
            return yield* fail("forbidden", "This cancellation supports flat Project work only.");
          const exactAuthority = Layer.succeed(OrganizationWorkExecutionAuthority, {
            permits: (action, actor, candidate) =>
              action === "cancel" &&
              actor.subject === principal.subject &&
              candidate.organizationId === target.organization_id &&
              candidate.projectId === target.project_id &&
              candidate.bindingId === target.binding_id &&
              candidate.workId === input.workId &&
              candidate.scope === null,
          });
          const workLayer = OrganizationWorkStoreLayer.pipe(
            Layer.provide(exactAuthority),
            Layer.provide(OrganizationWorkArtifactVerifierDisabled),
            Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
            Layer.provide(OrganizationWorkApprovalVerifierDisabled),
            Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
          );
          return yield* OrganizationWorkStore.pipe(
            Effect.flatMap((store) =>
              store.cancelWork(
                { workId: input.workId, transitionId: input.transitionId },
                { subject: principal.subject },
              ),
            ),
            Effect.provide(Layer.fresh(workLayer)),
            Effect.mapError((error) => fail(error.code, error.message)),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isLifecycleError(error)
            ? error
            : fail("unavailable", "Organization work cancellation is unavailable."),
        ),
      );
  });

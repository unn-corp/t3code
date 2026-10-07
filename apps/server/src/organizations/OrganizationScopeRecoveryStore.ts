import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { organizationScopeLaunchBrokerClient } from "./OrganizationScopeLaunchBroker.ts";
import { stopAndVerifyOrganizationScopedSandbox } from "./OrganizationScopedSandboxHost.ts";

export class OrganizationScopeRecoveryError extends Schema.TaggedError<OrganizationScopeRecoveryError>()(
  "OrganizationScopeRecoveryError",
  {
    code: Schema.Literals(["invalid", "unavailable", "conflict"]),
    message: Schema.String,
  },
) {}

const failure = (code: OrganizationScopeRecoveryError["code"], message: string) =>
  new OrganizationScopeRecoveryError({ code, message });
const isRecoveryError = Schema.is(OrganizationScopeRecoveryError);

export interface OrganizationScopeRecoveryReceipt {
  readonly attemptId: string;
  readonly operationId: string;
  readonly unitName: string;
  readonly kind: "never-dispatched" | "verified-stopped-unattached";
  readonly recordedAt: string;
}

/** A recovery-only DB transition. The receipt is derived from the singleton
 * broker's terminal journal state, never from caller-provided OS observations.
 */
export const recordOrganizationUnattachedScopeRecovery = (baseDir: string, attemptId: string) =>
  Effect.gen(function* () {
    if (typeof attemptId !== "string" || !attemptId.trim() || attemptId.length > 160)
      return yield* failure("invalid", "Recovery attempt ID is invalid.");
    const sql = yield* SqlClient.SqlClient;
    const operation = yield* Effect.tryPromise({
      try: () => organizationScopeLaunchBrokerClient(baseDir).get(attemptId),
      catch: () =>
        failure("unavailable", "Organization launch broker recovery state is unavailable."),
    });
    const kind =
      operation?.phase === "never-dispatched" && operation.identity === null
        ? "never-dispatched"
        : operation?.phase === "stopped" && operation.identity !== null
          ? "verified-stopped-unattached"
          : null;
    if (!operation || !kind)
      return yield* failure("conflict", "Scope launch lacks a broker-certified terminal state.");
    if (kind === "verified-stopped-unattached") {
      const identity = operation.identity;
      if (!identity) return yield* failure("conflict", "Stopped scope identity is missing.");
      yield* Effect.tryPromise({
        try: () => stopAndVerifyOrganizationScopedSandbox(identity),
        catch: () => failure("unavailable", "Scope stop cannot be verified for recovery."),
      });
    }
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const prep = (yield* sql<{ unit_name: string | null; launch_state: string }>`
          SELECT unit_name, launch_state FROM organization_work_scope_preparations
          WHERE attempt_id = ${attemptId}`)[0];
          if (
            !prep ||
            prep.unit_name !== operation.unitName ||
            (prep.launch_state !== "reserved" && prep.launch_state !== "requested")
          )
            return yield* failure("conflict", "Scope reservation does not match broker recovery.");
          const existing = (yield* sql<{
            attempt_id: string;
            operation_id: string;
            unit_name: string;
            kind: OrganizationScopeRecoveryReceipt["kind"];
            recorded_at: string;
          }>`SELECT * FROM organization_work_scope_recovery_receipts
          WHERE attempt_id = ${attemptId}`)[0];
          if (existing) {
            if (
              existing.operation_id !== attemptId ||
              existing.unit_name !== operation.unitName ||
              existing.kind !== kind
            )
              return yield* failure(
                "conflict",
                "A different scope recovery receipt already exists.",
              );
            return {
              attemptId: existing.attempt_id,
              operationId: existing.operation_id,
              unitName: existing.unit_name,
              kind: existing.kind,
              recordedAt: existing.recorded_at,
            } satisfies OrganizationScopeRecoveryReceipt;
          }
          const time = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const inserted = (yield* sql<{
            attempt_id: string;
            operation_id: string;
            unit_name: string;
            kind: OrganizationScopeRecoveryReceipt["kind"];
            recorded_at: string;
          }>`INSERT INTO organization_work_scope_recovery_receipts
          (attempt_id, operation_id, unit_name, kind, recorded_at)
          VALUES (${attemptId}, ${attemptId}, ${operation.unitName}, ${kind}, ${time})
          RETURNING *`)[0];
          if (!inserted)
            return yield* failure("unavailable", "Scope recovery receipt was not recorded.");
          return {
            attemptId: inserted.attempt_id,
            operationId: inserted.operation_id,
            unitName: inserted.unit_name,
            kind: inserted.kind,
            recordedAt: inserted.recorded_at,
          } satisfies OrganizationScopeRecoveryReceipt;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isRecoveryError(error)
            ? error
            : failure("unavailable", "Scope recovery receipt could not be recorded."),
        ),
      );
  });

/** Compatibility alias for callers that explicitly need the no-dispatch case. */
export const recordOrganizationNeverDispatchedScopeRecovery = (
  baseDir: string,
  attemptId: string,
) =>
  recordOrganizationUnattachedScopeRecovery(baseDir, attemptId).pipe(
    Effect.filterOrFail(
      (receipt) => receipt.kind === "never-dispatched",
      () => failure("conflict", "Scope launch was dispatched before recovery."),
    ),
  );

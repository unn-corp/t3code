import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { stopAndVerifyOrganizationScopedSandbox } from "./OrganizationScopedSandboxHost.ts";
import { recordOrganizationUnattachedScopeRecovery } from "./OrganizationScopeRecoveryStore.ts";
import {
  OrganizationWorkScopeError,
  OrganizationWorkScopeStopVerifier,
  OrganizationWorkScopeStore,
  OrganizationWorkScopeStoreLayer,
} from "./OrganizationWorkScopeStore.ts";

const exactVerifier = Layer.succeed(OrganizationWorkScopeStopVerifier, {
  verifyStopped: (identity: Parameters<typeof stopAndVerifyOrganizationScopedSandbox>[0]) =>
    Effect.tryPromise({
      try: () => stopAndVerifyOrganizationScopedSandbox(identity),
      catch: () =>
        new OrganizationWorkScopeError({
          code: "unavailable",
          message: "Exact Organization scope stop could not be verified.",
        }),
    }),
});

export interface OrganizationScopeStartupRecoveryReport {
  readonly verifiedStopped: readonly string[];
  readonly neverDispatched: readonly string[];
  readonly verifiedStoppedUnattached: readonly string[];
  /** These attempts keep their resource permits and require manual review. */
  readonly held: readonly { attemptId: string; reason: string }[];
}

/** Runs after the new server owns its HTTP listener and broker epoch, before
 * Organization command readiness. The authenticated broker journal proves
 * never-dispatch; persisted OS identities get an exact stop check.
 */
export const reconcileOrganizationScopesAtStartup = (baseDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scopes = yield* OrganizationWorkScopeStore;
    const verifiedStopped: string[] = [];
    const neverDispatched: string[] = [];
    const verifiedStoppedUnattached: string[] = [];
    const held: { attemptId: string; reason: string }[] = [];
    const attached = yield* sql<{ attempt_id: string }>`SELECT attempt_id
      FROM organization_work_scopes WHERE verified_stopped_at IS NULL
      ORDER BY prepared_at, attempt_id`;
    for (const row of attached) {
      const stopped = yield* Effect.result(
        scopes
          .requestStop(row.attempt_id)
          .pipe(Effect.andThen(scopes.recordStopped(row.attempt_id))),
      );
      if (Result.isSuccess(stopped)) verifiedStopped.push(row.attempt_id);
      else held.push({ attemptId: row.attempt_id, reason: stopped.failure.message });
    }
    const unscoped = yield* sql<{ attempt_id: string }>`SELECT prep.attempt_id
      FROM organization_work_scope_preparations prep
      LEFT JOIN organization_work_scopes scope ON scope.attempt_id = prep.attempt_id
      LEFT JOIN organization_work_scope_recovery_receipts receipt
        ON receipt.attempt_id = prep.attempt_id
      WHERE scope.attempt_id IS NULL AND receipt.attempt_id IS NULL
      ORDER BY prep.preparation_started_at, prep.attempt_id`;
    for (const row of unscoped) {
      const recovered = yield* Effect.result(
        recordOrganizationUnattachedScopeRecovery(baseDir, row.attempt_id),
      );
      if (Result.isSuccess(recovered)) {
        if (recovered.success.kind === "never-dispatched") neverDispatched.push(row.attempt_id);
        else verifiedStoppedUnattached.push(row.attempt_id);
      } else held.push({ attemptId: row.attempt_id, reason: recovered.failure.message });
    }
    return {
      verifiedStopped,
      neverDispatched,
      verifiedStoppedUnattached,
      held,
    } satisfies OrganizationScopeStartupRecoveryReport;
  }).pipe(Effect.provide(OrganizationWorkScopeStoreLayer.pipe(Layer.provide(exactVerifier))));

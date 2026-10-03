import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  OrganizationLiveWorkRuntimeReadiness,
  type OrganizationLiveWorkRuntimeStatus,
} from "./OrganizationLiveWorkExecutor.ts";
import { OrganizationWorkIntentActivationReadiness } from "./OrganizationWorkIntentActivation.ts";

export type OrganizationLiveWorkReadinessReason =
  | "scoped_broker_and_recovery_not_verified"
  | "broker_owner_unavailable"
  | "scope_recovery_unavailable"
  | "scope_recovery_held"
  | "work_recovery_unavailable"
  | "work_recovery_held"
  | "ready"
  | "server_stopping";

export interface OrganizationLiveWorkRecoveryReport {
  readonly held: ReadonlyArray<unknown>;
}

/** Process-local grant. A new server starts closed and must claim the broker
 * owner epoch before reconciling persisted scopes. Any failed check closes it.
 */
export const makeOrganizationLiveWorkReadinessGate = () => {
  let generation = 0;
  let current: OrganizationLiveWorkRuntimeStatus = Object.freeze({
    ready: false,
    reason: "scoped_broker_and_recovery_not_verified",
  });
  const status = () => current;
  const revoke = (
    reason: Exclude<
      OrganizationLiveWorkReadinessReason,
      "ready"
    > = "scoped_broker_and_recovery_not_verified",
  ) => {
    generation++;
    current = Object.freeze({ ready: false, reason });
  };
  const initialize = <EC, RC, ES, RS, EW, RW>(
    claimOwner: Effect.Effect<string, EC, RC>,
    recoverScopes: Effect.Effect<OrganizationLiveWorkRecoveryReport, ES, RS>,
    recoverWork: Effect.Effect<OrganizationLiveWorkRecoveryReport, EW, RW>,
  ): Effect.Effect<OrganizationLiveWorkRuntimeStatus, never, RC | RS | RW> =>
    Effect.gen(function* () {
      revoke();
      const ownGeneration = generation;
      const owner = yield* Effect.exit(claimOwner);
      if (ownGeneration !== generation) return current;
      if (Exit.isFailure(owner) || !owner.value.trim()) {
        revoke("broker_owner_unavailable");
        return current;
      }
      const recovered = yield* Effect.exit(recoverScopes);
      if (ownGeneration !== generation) return current;
      if (Exit.isFailure(recovered)) {
        revoke("scope_recovery_unavailable");
        return current;
      }
      if (recovered.value.held.length > 0) {
        revoke("scope_recovery_held");
        return current;
      }
      const work = yield* Effect.exit(recoverWork);
      if (ownGeneration !== generation) return current;
      if (Exit.isFailure(work)) {
        revoke("work_recovery_unavailable");
        return current;
      }
      if (work.value.held.length > 0) {
        revoke("work_recovery_held");
        return current;
      }
      current = Object.freeze({ ready: true, reason: "ready" });
      return current;
    });
  const permits = (organizationId: string, intentId: string) =>
    current.ready && organizationId.trim().length > 0 && intentId.trim().length > 0;
  const retryUntilReady = <E, R, EW, RW>(
    check: () => Effect.Effect<OrganizationLiveWorkRuntimeStatus, E, R>,
    wait: Effect.Effect<void, EW, RW>,
  ): Effect.Effect<void, E | EW, R | RW> =>
    Effect.gen(function* () {
      while (!current.ready) {
        yield* wait;
        if (!current.ready) yield* check();
      }
    });
  const monitorOwner = <E, R, EW, RW>(
    checkOwner: () => Effect.Effect<boolean, E, R>,
    wait: Effect.Effect<void, EW, RW>,
  ): Effect.Effect<void, EW, R | RW> =>
    Effect.gen(function* () {
      while (current.ready) {
        yield* wait;
        if (!current.ready) return;
        const checked = yield* Effect.exit(checkOwner());
        if (Exit.isFailure(checked) || checked.value !== true) {
          revoke("broker_owner_unavailable");
          return;
        }
      }
    });
  return {
    status,
    permits,
    revoke,
    initialize,
    retryUntilReady,
    monitorOwner,
    runtimeReadinessLayer: Layer.succeed(OrganizationLiveWorkRuntimeReadiness, { status }),
    activationReadinessLayer: Layer.succeed(OrganizationWorkIntentActivationReadiness, { permits }),
  };
};

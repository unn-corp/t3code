import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import type { TrialTarget } from "./maintenanceCore.ts";

/**
 * Raised when a backend must not start: a device transaction is in flight and this launch cannot give the backend its
 * one-use capability, or the coordinator could not say the device is idle. The backend manager treats it as a failed
 * configuration (no process is spawned) and retries, so a transient coordinator error delays startup instead of
 * letting a backend open data under a held fence.
 */
export class MaintenanceStartBlocked extends Schema.TaggedError<MaintenanceStartBlocked>()(
  "MaintenanceStartBlocked",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface DesktopMaintenanceBridgeShape {
  /**
   * The environment a backend starts with when an update transaction is waiting for its health receipt. Empty
   * in normal operation. Read at every (re)start so each launch gets a fresh one-use capability.
   */
  readonly trialEnv: (
    target: TrialTarget,
  ) => Effect.Effect<Record<string, string>, MaintenanceStartBlocked>;
  /** The maintenance service fills these in; the backend configuration sits below it in the layer graph. */
  readonly provide: (hooks: BridgeHooks) => Effect.Effect<void>;
  /** A WSL runtime tree this build uses, recorded so a later recovery or pin can keep it. */
  readonly recordWslRuntime: (runtimeId: string) => Effect.Effect<void>;
  /** Runtime trees the current build, a pinned build and the retained recoveries still need. Never pruned. */
  readonly retainedWslRuntimes: Effect.Effect<ReadonlyArray<string>>;
}

export interface BridgeHooks {
  readonly trialEnv: (target: TrialTarget) => Promise<Record<string, string>>;
  readonly recordWslRuntime: (runtimeId: string) => Promise<void>;
  readonly retainedWslRuntimes: () => Promise<ReadonlyArray<string>>;
}

/**
 * Breaks the cycle between the backend configuration (which needs a trial capability) and the maintenance
 * service (which needs the backend pool). A reference with a no-capability default keeps every composition that
 * has no maintenance service (isolated tests) valid without extra layers.
 */
export const DesktopMaintenanceBridge = Context.Reference<DesktopMaintenanceBridgeShape>(
  "@t3tools/desktop/maintenance/DesktopMaintenanceBridge",
  {
    defaultValue: () => {
      let hooks: BridgeHooks | null = null;
      // Bookkeeping hooks never block a start; only the trial capability does, and it fails closed.
      const quietly = <A>(fallback: A, work: (active: BridgeHooks) => Promise<A>) =>
        hooks === null
          ? Effect.succeed(fallback)
          : Effect.promise(() => work(hooks!)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Device maintenance hook failed.", { cause: String(cause) }).pipe(
                  Effect.as(fallback),
                ),
              ),
            );
      return {
        // No service installed (isolated compositions): there is no coordinator, so there is nothing to hold a start for.
        trialEnv: (target) =>
          hooks === null
            ? Effect.succeed({} as Record<string, string>)
            : Effect.tryPromise({
                try: () => hooks!.trialEnv(target),
                catch: (cause) =>
                  new MaintenanceStartBlocked({
                    reason: cause instanceof Error ? cause.message : String(cause),
                  }),
              }),
        provide: (next) => Effect.sync(() => void (hooks = next)),
        recordWslRuntime: (runtimeId) =>
          quietly(undefined, (active) => active.recordWslRuntime(runtimeId)),
        retainedWslRuntimes: quietly([] as ReadonlyArray<string>, (active) =>
          active.retainedWslRuntimes(),
        ),
      };
    },
  },
);

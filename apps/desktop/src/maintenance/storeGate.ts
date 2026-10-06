import type { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";

export interface StoreGate {
  /** The store every maintenance path uses. Until the gate closes it is the real store. */
  readonly store: CoordinatorStore;
  /**
   * Stops new registry operations and waits for the ones in flight. Resolves with the process holding no registry lock
   * and starting no new operation, which is the state it must be in when it exits for a binary replacement: a process that
   * dies inside a registry operation leaves a lock the next launch can only treat as an exited owner needing offline repair.
   */
  readonly closeAndDrain: () => Promise<void>;
  /** The exit did not happen: operations are allowed again so the transaction can still be aborted or finished here. */
  readonly reopen: () => void;
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/**
 * A view of the coordinator store that can be closed. Operations the controller starts without awaiting (status refreshes)
 * are among the ones drained, and anything attempted after closing fails instead of racing the exit.
 */
export function createStoreGate(real: CoordinatorStore): StoreGate {
  let closed = false;
  const inflight = new Set<Promise<unknown>>();
  const store = new Proxy(real, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (closed)
          return Promise.reject(
            new Error(
              "This process is exiting for a binary replacement and starts no registry operation.",
            ),
          );
        const result: unknown = value.apply(target, args);
        if (!isPromiseLike(result)) return result;
        const tracked = Promise.resolve(result).then(
          () => undefined,
          () => undefined,
        );
        inflight.add(tracked);
        void tracked.then(() => inflight.delete(tracked));
        return result;
      };
    },
  });
  return {
    store,
    closeAndDrain: async () => {
      closed = true;
      while (inflight.size > 0) await Promise.all(inflight);
    },
    reopen: () => {
      closed = false;
    },
  };
}

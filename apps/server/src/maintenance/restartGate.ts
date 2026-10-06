// @effect-diagnostics nodeBuiltinImport:off globalDate:off processEnv:off
import { CoordinatorStore, coordinatorDirectory } from "@t3tools/shared/forkMaintenanceStore";

/**
 * Whether an operator-driven restart of a running service is allowed right now. `t3 update` and
 * `t3 service restart` replace the running version, which stops anything in it, so they follow the
 * same rule as every other install path: unknown activity, a missing coordinator, or any active
 * agent blocks. The service keeps running its current version; nothing is stopped for an update.
 */
export async function deviceRestartBlockers(
  namespace: string | undefined = process.env.T3CODE_MAINTENANCE_NAMESPACE,
): Promise<ReadonlyArray<string>> {
  try {
    const store = await CoordinatorStore.open(coordinatorDirectory(namespace));
    const status = await store.status(Date.now());
    if (status.participants.length === 0) {
      return [
        "No runtime is registered with the device coordinator, so activity cannot be known (this service may predate device maintenance).",
      ];
    }
    return [...new Set(status.blockers.map((blocker) => blocker.label))];
  } catch (cause) {
    return [
      `The device coordinator could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    ];
  }
}

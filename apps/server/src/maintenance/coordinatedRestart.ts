// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off processEnv:off
import * as NodeCrypto from "node:crypto";
import { newJournal } from "@t3tools/shared/forkMaintenanceJournal";
import { CoordinatorStore, coordinatorDirectory } from "@t3tools/shared/forkMaintenanceStore";

/** The device is not quiet, so nothing may be stopped. The reasons are the coordinator's own. */
export class DeviceRestartBlocked extends Error {
  override readonly name = "DeviceRestartBlocked";
  readonly blockers: ReadonlyArray<string>;
  constructor(blockers: ReadonlyArray<string>) {
    super(blockers.join(" "));
    this.blockers = blockers;
  }
}

export interface DeviceGuard {
  /** Admission stays fenced until this is called. Call it once the service is stopped and before it starts again. */
  readonly release: () => Promise<void>;
}
export type AcquireDeviceGuard = () => Promise<DeviceGuard>;

const ACK_ATTEMPTS = 40;

/**
 * Quiesces the whole device for an operator-driven stop of a background service (`t3 service restart`,
 * `t3 update` with a restart, `t3 service uninstall`). It is the same admission an update takes: every
 * registered participant must have been idle for five minutes, nothing may be orphaned, the fence is taken,
 * and every participant must acknowledge it before anything is stopped. Unknown activity, an empty
 * registry or an unreadable coordinator blocks. Work cannot start between the check and the stop because
 * the fence rejects it atomically.
 */
export const quiesceDeviceForRestart = async (
  options: {
    readonly namespace?: string | undefined;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<DeviceGuard> => {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let store: CoordinatorStore;
  try {
    store = await CoordinatorStore.open(
      coordinatorDirectory(options.namespace ?? process.env.T3CODE_MAINTENANCE_NAMESPACE),
    );
  } catch (cause) {
    throw new DeviceRestartBlocked([
      `The device coordinator could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  }
  const status = await store.status(now()).catch((cause: unknown) => {
    throw new DeviceRestartBlocked([
      `The device coordinator could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  });
  if (status.participants.length === 0) {
    throw new DeviceRestartBlocked([
      "No runtime is registered with the device coordinator, so activity cannot be known (this service may predate device maintenance).",
    ]);
  }
  if (status.blockers.length > 0)
    throw new DeviceRestartBlocked([...new Set(status.blockers.map((blocker) => blocker.label))]);

  const transactionId = `s${now()}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  try {
    await store.freeze(transactionId, now());
  } catch (cause) {
    throw new DeviceRestartBlocked([cause instanceof Error ? cause.message : String(cause)]);
  }
  /** Nothing changed on disk: a restart is not a data transaction, so its journal is the aborted boundary that lets admission reopen. */
  const release = async () => {
    const journal = {
      ...newJournal({
        id: transactionId,
        kind: "update",
        homes: [],
        previous: { version: "service-restart", artifactSha256: "" },
        target: null,
        now: now(),
      }),
      phase: "aborted" as const,
      failure: "Operator-requested service stop; no data changed.",
    };
    await store.writeJournal(journal);
    await store.releaseFence(transactionId);
  };
  // Participants re-observe every few seconds; each must have seen the fence and still be idle.
  let lastReason = "";
  for (let attempt = 0; attempt < ACK_ATTEMPTS; attempt += 1) {
    try {
      await store.recheck(transactionId, now());
      return { release };
    } catch (cause) {
      lastReason = cause instanceof Error ? cause.message : String(cause);
      if (!lastReason.includes("acknowledged")) break;
      await sleep(1000);
    }
  }
  await release().catch(() => undefined);
  throw new DeviceRestartBlocked([`A participant changed activity after the fence: ${lastReason}`]);
};

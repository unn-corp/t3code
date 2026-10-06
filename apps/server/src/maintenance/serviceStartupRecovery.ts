/**
 * Pre-database resolution of a transaction whose owner exited, for a launcher-managed
 * runtime. The launcher is the only process that outlives a binary swap, so the successor
 * decides from durable facts (the journal and the launcher's recorded outcome) and never
 * from timing. Runs before the database opens: restoring files under a live database would
 * corrupt it.
 */
import { restoreSnapshot } from "@t3tools/shared/forkMaintenanceSnapshot";
import { RELEASABLE_PHASES, type MaintenanceJournal } from "@t3tools/shared/forkMaintenanceJournal";
import type { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import type { ServiceLauncherContext } from "../cloud/serviceProtocol.ts";

export type ServiceStartupDecision =
  /** The fence is gone (or was never ours): start normally. */
  | { readonly action: "proceed" }
  /** Start without work admission; the controller finishes the transaction once this runtime is healthy. */
  | { readonly action: "adopt"; readonly transactionId: string }
  /** Needs explicit recovery. */
  | { readonly action: "blocked"; readonly reason: string };

export async function resolveAbandonedFenceForService(input: {
  readonly store: CoordinatorStore;
  readonly home: string;
  readonly transactionId: string;
  readonly launcher: ServiceLauncherContext | undefined;
  readonly now: () => number;
  /** Test seam; production uses the filesystem restore. */
  readonly restore?: (home: string, snapshotId: string, transactionId: string) => Promise<void>;
}): Promise<ServiceStartupDecision> {
  const { store, home, transactionId } = input;
  const journal = await store.readJournal(transactionId);
  if (journal === null)
    return {
      action: "blocked",
      reason: "The device transaction has no journal. Run `t3 maintenance status`.",
    };
  if (journal.homes.length !== 1 || journal.homes[0] !== home)
    return {
      action: "blocked",
      reason: "The device transaction affects other data homes and must be resolved by its owner.",
    };
  const persist = (phase: MaintenanceJournal["phase"], patch: Partial<MaintenanceJournal> = {}) =>
    store.writeJournal({ ...journal, ...patch, phase, updatedAt: input.now() });
  const restore =
    input.restore ??
    ((target: string, snapshotId: string, id: string) => restoreSnapshot(target, snapshotId, id));

  if (RELEASABLE_PHASES.has(journal.phase)) {
    await store.releaseFence(transactionId);
    return { action: "proceed" };
  }
  switch (journal.phase) {
    case "fenced":
    case "snapshotted":
      // The trial never began, so nothing changed. Releasing is the safe boundary.
      await persist("aborted", { failure: "The update was interrupted before installation." });
      await store.releaseFence(transactionId);
      return { action: "proceed" };
    case "trial":
    case "verified": {
      const launcherCommitted =
        journal.kind === "update" &&
        input.launcher?.update?.status === "committed" &&
        input.launcher.childVersion === journal.target?.version;
      // The new version is the committed active version: its trial child recorded health before
      // the launcher committed, so the controller verifies those receipts and commits the journal.
      if (launcherCommitted) return { action: "adopt", transactionId };
      break;
    }
    case "restore-failed":
      return {
        action: "blocked",
        reason: journal.failure ?? "A previous restoration failed. Run `t3 maintenance recover`.",
      };
    case "restoring":
    case "restored":
      break;
    default:
      break;
  }
  // The launcher rolled back or failed (or never committed): older data comes back before the database opens.
  if (journal.phase !== "restored") {
    const restoring =
      journal.phase === "restoring"
        ? journal
        : { ...journal, phase: "restoring" as const, updatedAt: input.now() };
    await store.writeJournal(restoring);
    const snapshotId = restoring.snapshots[home];
    if (snapshotId === undefined) {
      await store.writeJournal({
        ...restoring,
        phase: "restore-failed",
        failure: "No restore point exists for this home.",
        updatedAt: input.now(),
      });
      return { action: "blocked", reason: "No restore point exists for this home." };
    }
    try {
      await restore(home, snapshotId, transactionId);
    } catch (cause) {
      const failure = `Restoration failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      await store.writeJournal({
        ...restoring,
        phase: "restore-failed",
        failure,
        updatedAt: input.now(),
      });
      return { action: "blocked", reason: failure };
    }
    await store.writeJournal({ ...restoring, phase: "restored", updatedAt: input.now() });
  }
  return { action: "adopt", transactionId };
}

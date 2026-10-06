import {
  IN_FLIGHT_PHASES,
  RELEASABLE_PHASES,
  type MaintenanceJournal,
  type MaintenancePhase,
} from "./forkMaintenanceJournal.ts";

/**
 * Side effects of one device transaction. Production adapters (desktop,
 * launcher, recovery helper) implement these; every method must be idempotent
 * because a crash restarts a step, never the whole transaction.
 */
export interface TransactionPorts {
  /** Durable (fsync + atomic rename). A throw is ambiguous: the write may have landed. */
  readonly persist: (journal: MaintenanceJournal) => Promise<void>;
  readonly load: (transactionId: string) => Promise<MaintenanceJournal | null>;
  readonly now: () => number;
  /** Verified restore point for one home. */
  readonly snapshot: (home: string, transactionId: string) => Promise<string>;
  readonly discardSnapshot: (home: string, snapshotId: string) => Promise<void>;
  /** Verified copy of the home's current data, taken before a destructive restore. */
  readonly rescue: (home: string, transactionId: string) => Promise<string>;
  /**
   * Swaps binaries and launches trial runtimes. May end this process (desktop install). It must
   * throw only before any irreversible step; a throw aborts the transaction as unchanged.
   */
  readonly startTrial: (journal: MaintenanceJournal) => Promise<void>;
  /** Health receipt from the trial runtime of one home. Empty or a throw means unhealthy. */
  readonly verifyTrial: (home: string, transactionId: string) => Promise<string>;
  /** Stops whatever runs against the home, restores its snapshot, leaves it stopped. */
  readonly restore: (home: string, snapshotId: string, transactionId: string) => Promise<void>;
  /** Starts the restored (previous) runtime for the home and proves it healthy. */
  readonly verifyRestored: (home: string, transactionId: string) => Promise<string>;
  /** Releases admission. The coordinator store refuses unless the journal is durably releasable. */
  readonly release: (transactionId: string) => Promise<void>;
}

export class MaintenanceTransactionError extends Error {
  override readonly name = "MaintenanceTransactionError";
  readonly phase: MaintenancePhase;
  constructor(message: string, phase: MaintenancePhase, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.phase = phase;
  }
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

async function advanceTo(
  ports: TransactionPorts,
  journal: MaintenanceJournal,
  phase: MaintenancePhase,
  patch: Partial<MaintenanceJournal> = {},
): Promise<MaintenanceJournal> {
  const next = { ...journal, ...patch, phase, updatedAt: ports.now() };
  await ports.persist(next);
  return next;
}

/**
 * Begins an update transaction whose fence is already held by the caller.
 * Snapshot failure before the trial is a safe aborted boundary: nothing live changed.
 */
export async function beginUpdateTransaction(
  initial: MaintenanceJournal,
  ports: TransactionPorts,
): Promise<MaintenanceJournal> {
  if (initial.kind !== "update" || initial.phase !== "fenced")
    throw new MaintenanceTransactionError("An update transaction starts fenced.", initial.phase);
  let journal = initial;
  await ports.persist(journal);
  try {
    const snapshots: Record<string, string> = { ...journal.snapshots };
    for (const home of journal.homes) {
      snapshots[home] = await ports.snapshot(home, journal.id);
      journal = Object.assign({}, journal, {
        snapshots: Object.assign({}, snapshots),
        updatedAt: ports.now(),
      });
      // Persist each id as soon as it exists so a crash can discard exactly what was created.
      await ports.persist(journal);
    }
    journal = await advanceTo(ports, journal, "snapshotted");
  } catch (cause) {
    return abortBeforeTrial(journal, ports, reason(cause), cause);
  }
  journal = await advanceTo(ports, journal, "trial");
  try {
    await ports.startTrial(journal);
  } catch (cause) {
    // startTrial throws only before any irreversible step (a rejected request, a missing
    // capability): the live data is untouched, so this is the safe aborted boundary.
    return abortBeforeTrial(journal, ports, reason(cause), cause);
  }
  return advanceTransaction(journal.id, ports);
}

async function abortBeforeTrial(
  journal: MaintenanceJournal,
  ports: TransactionPorts,
  failure: string,
  cause?: unknown,
): Promise<MaintenanceJournal> {
  // An update owns the restore points it created. A recovery owns only its rescue
  // copies: the restore points it was asked to use are retained history.
  const owned = journal.kind === "update" ? journal.snapshots : journal.rescues;
  for (const [home, id] of Object.entries(owned)) {
    // A copy that cannot be discarded stays on disk; retention cleanup owns it.
    await ports.discardSnapshot(home, id).catch(() => undefined);
  }
  const aborted = await advanceTo(
    ports,
    journal,
    "aborted",
    journal.kind === "update" ? { snapshots: {}, failure } : { rescues: {}, failure },
  );
  await ports.release(aborted.id);
  if (cause !== undefined)
    throw new MaintenanceTransactionError(
      `Update aborted before any change: ${failure}`,
      "aborted",
      { cause },
    );
  return aborted;
}

/**
 * Resumes a transaction from its journal in whatever process is alive. This is
 * the only way a transaction progresses after the trial begins, so a desktop
 * that exits to install picks it up on the next launch.
 */
export async function advanceTransaction(
  transactionId: string,
  ports: TransactionPorts,
  options: { readonly stopAt?: MaintenancePhase } = {},
): Promise<MaintenanceJournal> {
  let journal = await ports.load(transactionId);
  if (journal === null)
    throw new MaintenanceTransactionError("Unknown maintenance transaction.", "aborted");
  for (;;) {
    // The recovery helper stops after the files are restored: only a started, healthy runtime may verify.
    if (options.stopAt === journal.phase) return journal;
    switch (journal.phase) {
      case "fenced":
      case "snapshotted":
        // The trial never began. Abandoning is the safe boundary; the user simply retries.
        return abortBeforeTrial(
          journal,
          ports,
          "The device update was interrupted before installation.",
        );
      case "trial": {
        const receipts: Record<string, string> = { ...journal.receipts };
        try {
          for (const home of journal.homes) {
            const receipt = await ports.verifyTrial(home, journal.id);
            if (receipt.length === 0) throw new Error("Missing transaction health receipt.");
            receipts[home] = receipt;
          }
        } catch (cause) {
          journal = await advanceTo(ports, journal, "restoring", {
            receipts,
            failure: reason(cause),
          });
          continue;
        }
        journal = await advanceTo(ports, journal, "verified", { receipts });
        continue;
      }
      case "verified":
        // A commit-write error is ambiguous: the fence stays and the journal decides on resume.
        journal = await advanceTo(ports, journal, "committed");
        continue;
      case "committed":
      case "restore-verified":
      case "aborted":
        await ports.release(journal.id);
        return journal;
      case "restoring": {
        const source = journal.snapshots;
        if (journal.homes.some((home) => source[home] === undefined)) {
          journal = await advanceTo(ports, journal, "restore-failed", {
            failure: "Incomplete snapshot set; restoration is unavailable.",
          });
          continue;
        }
        try {
          for (const home of journal.homes) await ports.restore(home, source[home]!, journal.id);
        } catch (cause) {
          journal = await advanceTo(ports, journal, "restore-failed", {
            failure: `Restoration failed: ${reason(cause)}`,
          });
          continue;
        }
        journal = await advanceTo(ports, journal, "restored");
        continue;
      }
      case "restored": {
        const restoredReceipts: Record<string, string> = { ...journal.restoredReceipts };
        try {
          for (const home of journal.homes) {
            const receipt = await ports.verifyRestored(home, journal.id);
            if (receipt.length === 0) throw new Error("Missing restored runtime health receipt.");
            restoredReceipts[home] = receipt;
          }
        } catch (cause) {
          journal = await advanceTo(ports, journal, "restore-failed", {
            restoredReceipts,
            failure: `Restored runtime could not be verified: ${reason(cause)}`,
          });
          continue;
        }
        journal = await advanceTo(ports, journal, "restore-verified", { restoredReceipts });
        continue;
      }
      case "restore-failed":
        // Admission stays fenced. Only explicit recovery (a new transaction) may continue.
        throw new MaintenanceTransactionError(
          journal.failure ?? "Restoration did not complete.",
          "restore-failed",
        );
    }
  }
}

/**
 * Explicit recovery to a retained restore point. Current data is copied and
 * verified first, so a bad choice can itself be reverted. Never automatic.
 */
export async function beginRecoveryTransaction(
  initial: MaintenanceJournal,
  ports: TransactionPorts,
  options: { readonly stopAt?: MaintenancePhase } = {},
): Promise<MaintenanceJournal> {
  if (initial.kind !== "recovery" || initial.phase !== "fenced")
    throw new MaintenanceTransactionError("A recovery transaction starts fenced.", initial.phase);
  if (initial.homes.some((home) => initial.snapshots[home] === undefined)) {
    throw new MaintenanceTransactionError(
      "Recovery needs a restore point for every affected home.",
      initial.phase,
    );
  }
  let journal = initial;
  await ports.persist(journal);
  try {
    const rescues: Record<string, string> = {};
    for (const home of journal.homes) {
      rescues[home] = await ports.rescue(home, journal.id);
      journal = Object.assign({}, journal, {
        rescues: Object.assign({}, rescues),
        updatedAt: ports.now(),
      });
      await ports.persist(journal);
    }
  } catch (cause) {
    // Nothing was replaced: failing to prove the rescue copy is the safe boundary.
    return abortBeforeTrial(journal, ports, `Rescue copy failed: ${reason(cause)}`, cause);
  }
  journal = await advanceTo(ports, journal, "snapshotted");
  journal = await advanceTo(ports, journal, "restoring");
  return advanceTransaction(journal.id, ports, options);
}

export const isInFlight = (journal: MaintenanceJournal) => IN_FLIGHT_PHASES.has(journal.phase);
export const isReleasable = (journal: MaintenanceJournal) => RELEASABLE_PHASES.has(journal.phase);

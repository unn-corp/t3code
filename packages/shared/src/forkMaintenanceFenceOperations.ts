// @effect-diagnostics nodeBuiltinImport:off
/**
 * The registry side of the explicit Windows/WSL control channel. A WSL distribution keeps its own
 * coordinator registry (its processes are invisible to Windows), so its Windows parent drives the
 * distribution's fence through these verbs, run inside the distribution as
 * `t3 maintenance fence <verb> ...`. The parent holds the fence remotely: it is never inferred from
 * an address, and never released without a terminal journal mirrored into the distribution.
 */
import { decodeJournal, type MaintenanceJournal } from "./forkMaintenanceJournal.ts";
import type { CoordinatorStore, ReceiptSlot } from "./forkMaintenanceStore.ts";

export type FenceOperation =
  | { readonly op: "status" }
  | { readonly op: "confirm-bootstrap" }
  | {
      readonly op: "freeze";
      readonly transactionId: string;
      readonly parent: string;
      readonly forRecovery?: boolean;
    }
  | { readonly op: "recheck"; readonly transactionId: string }
  | { readonly op: "journal"; readonly journal: MaintenanceJournal }
  | { readonly op: "issue-trial"; readonly transactionId: string; readonly home: string }
  | { readonly op: "release"; readonly transactionId: string }
  /** The health receipt the trial or restored runtime in this registry recorded for a home, or null. */
  | {
      readonly op: "receipt";
      readonly transactionId: string;
      readonly home: string;
      readonly slot: ReceiptSlot;
    };

export type FenceOperationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

export async function runFenceOperation(
  store: CoordinatorStore,
  operation: FenceOperation,
  now: number,
): Promise<FenceOperationResult> {
  try {
    switch (operation.op) {
      case "status": {
        const status = await store.status(now);
        return {
          ok: true,
          value: {
            coordinatorId: status.coordinatorId,
            bootstrapped: status.bootstrapped,
            fence: status.fence,
            blockers: status.blockers,
            participants: status.participants.map((participant) => ({
              id: participant.id,
              label: participant.label,
              kind: participant.kind,
              homes: participant.homes,
              updateTarget: participant.updateTarget,
              orphaned: participant.orphaned,
              observedAt: participant.observedAt,
              blockers: participant.blockers,
              descendants: participant.descendants,
            })),
          },
        };
      }
      case "confirm-bootstrap":
        await store.confirmBootstrap();
        return { ok: true, value: true };
      case "freeze":
        await store.freeze(operation.transactionId, now, {
          remote: operation.parent,
          ...(operation.forRecovery === true ? { forRecovery: true } : {}),
        });
        return { ok: true, value: true };
      case "recheck":
        return {
          ok: true,
          value: (await store.recheck(operation.transactionId, now)).map(
            (participant) => participant.id,
          ),
        };
      case "journal":
        await store.writeJournal(operation.journal);
        return { ok: true, value: true };
      case "issue-trial":
        return { ok: true, value: await store.issueTrial(operation.transactionId, operation.home) };
      case "release":
        await store.releaseFence(operation.transactionId);
        return { ok: true, value: true };
      case "receipt":
        return {
          ok: true,
          value: await store.readReceipt(operation.transactionId, operation.home, operation.slot),
        };
    }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function parseFenceOperation(
  args: ReadonlyArray<string>,
): FenceOperation | { readonly error: string } {
  const [op, ...rest] = args;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined)
      return { error: `Malformed arguments near ${key ?? "end"}.` };
    flags.set(key.slice(2), value);
  }
  const transactionId = flags.get("transaction");
  switch (op) {
    case "status":
    case "confirm-bootstrap":
      return { op };
    case "freeze": {
      const parent = flags.get("parent");
      return transactionId === undefined || parent === undefined
        ? { error: "--transaction and --parent are required." }
        : {
            op,
            transactionId,
            parent,
            ...(flags.get("for-recovery") === "true" ? { forRecovery: true } : {}),
          };
    }
    case "recheck":
    case "release":
      return transactionId === undefined
        ? { error: "--transaction is required." }
        : { op, transactionId };
    case "issue-trial": {
      const home = flags.get("home");
      return transactionId === undefined || home === undefined
        ? { error: "--transaction and --home are required." }
        : { op, transactionId, home };
    }
    case "receipt": {
      const home = flags.get("home");
      const slot = flags.get("slot");
      return transactionId === undefined ||
        home === undefined ||
        (slot !== "trial" && slot !== "restored")
        ? { error: "--transaction, --home and --slot trial|restored are required." }
        : { op, transactionId, home, slot };
    }
    case "journal": {
      const encoded = flags.get("journal-base64");
      if (encoded === undefined) return { error: "--journal-base64 is required." };
      try {
        return {
          op,
          journal: decodeJournal(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))),
        };
      } catch {
        return { error: "The journal is not valid." };
      }
    }
    default:
      return { error: `Unknown fence operation ${op ?? "(none)"}.` };
  }
}

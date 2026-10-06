// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * One-shot operations on a single data home, run by the process that owns that filesystem. This is
 * the explicit control channel for a WSL distribution: the Windows desktop invokes
 * `t3 maintenance home <op>` inside the distribution (so it never reaches into \\wsl$ paths or guesses
 * an address), and each operation returns JSON. The same dispatcher backs the Windows side.
 */
import * as NodeFSP from "node:fs/promises";
import {
  assertCapacity,
  createSnapshot,
  discardSnapshot,
  listRestorePoints,
  pruneRestorePoints,
  restoreSnapshot,
  snapshotRequirement,
  verifySnapshot,
} from "./forkMaintenanceSnapshot.ts";
import type { CoordinatorStore } from "./forkMaintenanceStore.ts";

export type HomeOperation =
  | { readonly op: "requirement" }
  /** The realpath of the home. Journal and restore-point identities must use this, never a configured spelling. */
  | { readonly op: "canonical" }
  | { readonly op: "capacity"; readonly rescue?: boolean; readonly artifactBytes?: number }
  | { readonly op: "snapshot"; readonly transactionId: string }
  | { readonly op: "rescue"; readonly transactionId: string }
  | { readonly op: "verify"; readonly snapshotId: string }
  | { readonly op: "restore"; readonly snapshotId: string; readonly transactionId: string }
  | { readonly op: "discard"; readonly snapshotId: string }
  | { readonly op: "list" }
  | { readonly op: "prune"; readonly keep: number; readonly pinned: ReadonlyArray<string> };

export type HomeOperationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * `store` lets the dispatcher refuse a restore while a live runtime owns the home: replacing files
 * under a running database corrupts it. Operations never take the fence themselves; the caller's
 * transaction (on whichever side owns the fence) already holds admission.
 */
export async function runHomeOperation(
  home: string,
  operation: HomeOperation,
  options: { readonly store?: CoordinatorStore } = {},
): Promise<HomeOperationResult> {
  try {
    switch (operation.op) {
      case "requirement":
        return { ok: true, value: await snapshotRequirement(home) };
      case "canonical":
        return { ok: true, value: await NodeFSP.realpath(home) };
      case "capacity":
        await assertCapacity([home], {
          ...(operation.rescue === undefined ? {} : { rescue: operation.rescue }),
          ...(operation.artifactBytes === undefined
            ? {}
            : { artifactBytesByHome: { [home]: operation.artifactBytes } }),
        });
        return { ok: true, value: true };
      case "snapshot":
        return { ok: true, value: await createSnapshot(home, operation.transactionId) };
      case "rescue":
        return {
          ok: true,
          value: await createSnapshot(home, operation.transactionId, { kind: "rescue" }),
        };
      case "verify": {
        const manifest = await verifySnapshot(home, operation.snapshotId);
        return {
          ok: true,
          value: { id: manifest.id, createdAt: manifest.createdAt, files: manifest.files.length },
        };
      }
      case "restore": {
        if (options.store !== undefined) {
          const status = await options.store.status(Date.now());
          const owners = status.participants.filter(
            (participant) => participant.homes.includes(home) && participant.trialFor === null,
          );
          if (owners.length > 0)
            return {
              ok: false,
              reason: "A runtime still owns this data home. Stop it before restoring.",
            };
        }
        await restoreSnapshot(home, operation.snapshotId, operation.transactionId);
        return { ok: true, value: true };
      }
      case "discard":
        await discardSnapshot(home, operation.snapshotId);
        return { ok: true, value: true };
      case "list":
        return { ok: true, value: await listRestorePoints(home) };
      case "prune":
        return {
          ok: true,
          value: await pruneRestorePoints(home, {
            keep: operation.keep,
            pinned: new Set(operation.pinned),
          }),
        };
    }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Parses the CLI argument vector of `t3 maintenance home <op> ...` (everything after `home`). */
export function parseHomeOperation(
  args: ReadonlyArray<string>,
): { readonly home: string; readonly operation: HomeOperation } | { readonly error: string } {
  const [op, ...rest] = args;
  const flags = new Map<string, string>();
  const multi = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined)
      return { error: `Malformed arguments near ${key ?? "end"}.` };
    flags.set(key.slice(2), value);
    multi.set(key.slice(2), [...(multi.get(key.slice(2)) ?? []), value]);
  }
  const home = flags.get("home");
  if (home === undefined) return { error: "--home is required." };
  const need = (name: string) => flags.get(name);
  switch (op) {
    case "requirement":
    case "list":
    case "canonical":
      return { home, operation: { op } };
    case "capacity": {
      const artifactBytes =
        need("artifact-bytes") === undefined ? undefined : Number(need("artifact-bytes"));
      if (artifactBytes !== undefined && !Number.isFinite(artifactBytes))
        return { error: "--artifact-bytes must be a number." };
      return {
        home,
        operation: {
          op,
          rescue: need("rescue") === "true",
          ...(artifactBytes === undefined ? {} : { artifactBytes }),
        },
      };
    }
    case "snapshot":
    case "rescue": {
      const transactionId = need("transaction");
      return transactionId === undefined
        ? { error: "--transaction is required." }
        : { home, operation: { op, transactionId } };
    }
    case "verify":
    case "discard": {
      const snapshotId = need("snapshot");
      return snapshotId === undefined
        ? { error: "--snapshot is required." }
        : { home, operation: { op, snapshotId } };
    }
    case "restore": {
      const snapshotId = need("snapshot");
      const transactionId = need("transaction");
      return snapshotId === undefined || transactionId === undefined
        ? { error: "--snapshot and --transaction are required." }
        : { home, operation: { op, snapshotId, transactionId } };
    }
    case "prune": {
      const keep = Number(need("keep") ?? "2");
      return Number.isInteger(keep) && keep >= 0
        ? { home, operation: { op, keep, pinned: multi.get("pin") ?? [] } }
        : { error: "--keep must be a non-negative integer." };
    }
    default:
      return { error: `Unknown home operation ${op ?? "(none)"}.` };
  }
}

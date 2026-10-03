import type { OrganizationRepositoryRecord } from "@t3tools/contracts";
import { recordDigest } from "./OrganizationRepositoryGit.ts";

export const DELETED_REMOTE_DIGEST = "0".repeat(64);

export interface AcceptedRepositoryRecord {
  readonly acceptedLocalDigest: string | null;
  readonly acceptedRemoteDigest: string | null;
  readonly remoteDigest: string;
  readonly state: "incoming" | "shared" | "conflict";
  readonly resolution: "local" | "remote" | null;
}
export interface RepositoryMergeEntry {
  readonly state: "incoming" | "shared" | "conflict" | "local-only";
  readonly local: OrganizationRepositoryRecord | null;
  readonly remote: OrganizationRepositoryRecord | null;
  readonly localDigest: string | null;
  readonly remoteDigest: string | null;
  readonly writeLocal: boolean;
}

/** Per-record three-way merge. Neither divergent content nor deletions are silently chosen. */
export function planOrganizationRepositoryMerge(
  local: ReadonlyMap<string, OrganizationRepositoryRecord>,
  remote: ReadonlyMap<string, OrganizationRepositoryRecord>,
  accepted: ReadonlyMap<string, AcceptedRepositoryRecord>,
): Map<string, RepositoryMergeEntry> {
  const plan = new Map<string, RepositoryMergeEntry>();
  for (const key of new Set([...local.keys(), ...remote.keys(), ...accepted.keys()])) {
    const ours = local.get(key) ?? null;
    const theirs = remote.get(key) ?? null;
    const previous = accepted.get(key);
    const localDigest = ours ? recordDigest(ours) : null;
    const remoteDigest = theirs ? recordDigest(theirs) : null;
    let state: RepositoryMergeEntry["state"];
    let writeLocal = false;
    if (localDigest === remoteDigest && localDigest !== null) state = "shared";
    else if (
      previous?.resolution === "remote" &&
      localDigest === previous.acceptedLocalDigest &&
      (remoteDigest ?? DELETED_REMOTE_DIGEST) === previous.remoteDigest
    ) {
      state = "incoming";
    } else if (
      previous?.resolution === "local" &&
      (remoteDigest ?? DELETED_REMOTE_DIGEST) === previous.remoteDigest &&
      ours
    ) {
      state = "local-only";
      writeLocal = true;
    } else if (!ours && theirs) state = "incoming";
    else if (ours && !theirs) {
      if (previous?.acceptedRemoteDigest) state = "conflict";
      else {
        state = "local-only";
        writeLocal = true;
      }
    } else if (ours && theirs) {
      const localChanged = previous ? localDigest !== previous.acceptedLocalDigest : true;
      const remoteChanged = previous ? remoteDigest !== previous.acceptedRemoteDigest : true;
      if (previous?.state === "incoming" && previous.acceptedLocalDigest === null)
        state = "conflict";
      else if (localChanged && remoteChanged) state = "conflict";
      else if (localChanged) {
        state = "local-only";
        writeLocal = true;
      } else state = previous?.state === "conflict" ? "conflict" : "incoming";
    } else continue;
    plan.set(key, { state, local: ours, remote: theirs, localDigest, remoteDigest, writeLocal });
  }
  return plan;
}

import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Thread List v2 model, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts + SidebarV2.tsx).
 *
 * Four visual states, three colors: color is reserved for "act now"
 * (approval), "in motion" (working), and "broken" (failed). Ready is the
 * unlabeled resting state.
 */
export type ThreadListV2Status = "approval" | "working" | "failed" | "ready";

export function resolveThreadListV2Status(
  thread: Pick<EnvironmentThreadShell, "hasPendingApprovals" | "session">,
): ThreadListV2Status {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") {
    return "failed";
  }
  return "ready";
}

/**
 * v2 sort: static creation order, newest thread on top. Activity NEVER
 * reorders the list — a row holds its position from open until settled, so
 * the screen only moves at lifecycle transitions. Mirrors web's
 * sortThreadsForSidebarV2.
 */
export function sortThreadsForListV2<T extends { readonly id: string; readonly createdAt: string }>(
  threads: readonly T[],
): T[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id),
  );
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** First settled row after the card block draws the SETTLED divider. */
  readonly showSettledDivider: boolean;
  readonly isLast: boolean;
}

/**
 * Partitions visible threads into the active card block (creation order) and
 * the settled recency tail, matching the web v2 list. `autoSettleAfterDays`
 * mirrors the web default of 3 — mobile has no client-settings sync yet, so
 * the default is fixed here rather than user-configurable.
 */
export function buildThreadListV2Items(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly autoSettleAfterDays?: number;
  /** Injectable for tests; defaults to now. */
  readonly now?: string;
}): ThreadListV2Item[] {
  const now = input.now ?? new Date().toISOString();
  const autoSettleAfterDays = input.autoSettleAfterDays ?? 3;
  const query = input.searchQuery.trim().toLocaleLowerCase();

  const active: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) continue;
    if (query.length > 0 && !thread.title.toLocaleLowerCase().includes(query)) continue;
    // PR state feeds the web partition per-row; mobile shells don't watch PRs
    // from the list, so the partition here is override/session/inactivity.
    if (effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState: null })) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  const orderedActive = sortThreadsForListV2(active);
  const orderedSettled = [...settled].sort(
    (left, right) =>
      Date.parse(right.latestUserMessageAt ?? right.updatedAt) -
      Date.parse(left.latestUserMessageAt ?? left.updatedAt),
  );

  const items: ThreadListV2Item[] = [];
  for (const thread of orderedActive) {
    items.push({ thread, variant: "card", showSettledDivider: false, isLast: false });
  }
  for (const [index, thread] of orderedSettled.entries()) {
    items.push({
      thread,
      variant: "slim",
      showSettledDivider: index === 0,
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return items;
}

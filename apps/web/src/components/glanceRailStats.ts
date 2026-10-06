import type { ServerProviderUsageWindow, WorktreeStorageUsage } from "@t3tools/contracts";

export interface GlanceRailThreadSignal {
  readonly archivedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly latestTurn?: { readonly state: string } | null;
  readonly latestRun?: { readonly status: string } | null;
  readonly runtime?: { readonly status: string } | null;
  readonly session?: { readonly status: string } | null;
}

export interface GlanceRailStats {
  readonly running: number;
  readonly needsAttention: number;
  readonly threads: number;
}

export interface GlanceRailUsageSignal {
  readonly accountLabel: string;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly unavailable?: boolean | undefined;
}

export interface GlanceRailUsage {
  readonly accountLabel: string;
  readonly windowLabel: string;
  readonly remainingPercent: number;
}

export interface GlanceRailGitStatusSignal {
  readonly isRepo: boolean;
  readonly refName: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly aheadOfDefaultCount?: number | undefined;
}

export type GlanceRailGitPosition =
  | { readonly state: "synced"; readonly label: "Synced" }
  | { readonly state: "ahead"; readonly label: string }
  | { readonly state: "behind"; readonly label: string }
  | { readonly state: "diverged"; readonly label: string }
  | { readonly state: "not-repository"; readonly label: "Not a Git repo" };

export function summarizeGlanceRail(
  threads: ReadonlyArray<GlanceRailThreadSignal>,
): GlanceRailStats {
  let running = 0;
  let needsAttention = 0;
  let visibleThreads = 0;

  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    visibleThreads += 1;

    if (
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.latestRun?.status === "failed" ||
      thread.latestTurn?.state === "error" ||
      thread.session?.status === "error"
    ) {
      needsAttention += 1;
      continue;
    }

    if (
      ["preparing", "queued", "starting", "running", "waiting"].includes(
        thread.runtime?.status ?? thread.latestRun?.status ?? "",
      ) ||
      thread.latestTurn?.state === "running" ||
      thread.session?.status === "starting" ||
      thread.session?.status === "running"
    ) {
      running += 1;
    }
  }

  return { running, needsAttention, threads: visibleThreads };
}

/**
 * Select the primary usage window for the active provider account. Session
 * limits are the most useful glance value; providers without one fall back to
 * the first window they publish.
 */
export function resolveGlanceRailUsage(
  signal: GlanceRailUsageSignal | null,
): GlanceRailUsage | null {
  if (signal === null || signal.unavailable === true || signal.windows.length === 0) {
    return null;
  }

  const window =
    signal.windows.find((candidate) => candidate.kind === "session") ?? signal.windows[0];
  if (window === undefined) return null;
  return {
    accountLabel: signal.accountLabel,
    windowLabel: window.label,
    remainingPercent: Math.round(100 - window.usedPercent),
  };
}

export function resolveGlanceRailGitPosition(
  status: GlanceRailGitStatusSignal,
): GlanceRailGitPosition {
  if (!status.isRepo) {
    return { state: "not-repository", label: "Not a Git repo" };
  }

  const ahead = status.aheadOfDefaultCount ?? status.aheadCount;
  const behind = status.behindCount;

  if (ahead > 0 && behind > 0) {
    return { state: "diverged", label: `${ahead} ahead · ${behind} behind` };
  }
  if (ahead > 0) {
    return { state: "ahead", label: `${ahead} ahead` };
  }
  if (behind > 0) {
    return { state: "behind", label: `${behind} behind` };
  }
  return { state: "synced", label: "Synced" };
}

function formatStorageBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const index =
    bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${(bytes / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}

export function resolveGlanceRailStorage(usage: WorktreeStorageUsage): {
  value: string;
  detail: string;
} {
  const size = formatStorageBytes(usage.bytes);
  switch (usage.measurement) {
    case "exclusive":
      return {
        value: size,
        detail: `Exclusive data · ${formatStorageBytes(usage.sharedBytes ?? 0)} shared`,
      };
    case "allocated":
      return { value: `~${size}`, detail: "Allocated estimate · may include shared data" };
    case "logical":
      return { value: size, detail: "File size · disk usage unavailable" };
  }
}

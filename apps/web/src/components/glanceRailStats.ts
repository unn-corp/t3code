export interface GlanceRailThreadSignal {
  readonly archivedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly latestTurn: { readonly state: string } | null;
  readonly session: { readonly status: string } | null;
}

export interface GlanceRailStats {
  readonly running: number;
  readonly needsAttention: number;
  readonly threads: number;
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
      thread.latestTurn?.state === "error" ||
      thread.session?.status === "error"
    ) {
      needsAttention += 1;
      continue;
    }

    if (
      thread.latestTurn?.state === "running" ||
      thread.session?.status === "starting" ||
      thread.session?.status === "running"
    ) {
      running += 1;
    }
  }

  return { running, needsAttention, threads: visibleThreads };
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

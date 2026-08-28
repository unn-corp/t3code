export type DashboardNeedsYouThreadState = "needs-input" | "error";
export type DashboardNeedsYouFindingStatus =
  | "open"
  | "in-progress"
  | "snoozed"
  | "done"
  | "archived";
export type DashboardNeedsYouCoverageStatus =
  | "never"
  | "current"
  | "due"
  | "overdue"
  | "stale"
  | "failing";

export interface DashboardNeedsYouThreadSignal {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectName: string;
  readonly state: DashboardNeedsYouThreadState;
  readonly updatedAt: string;
}

export interface DashboardNeedsYouFeedSignal {
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly title: string;
  readonly projectName: string;
  readonly summary: string;
  readonly updatedAt: string;
}

export interface DashboardNeedsYouFindingSignal {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "info";
  readonly status: DashboardNeedsYouFindingStatus;
  readonly updatedAt: string;
}

export interface DashboardNeedsYouRunSignal {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
}

export interface DashboardNeedsYouCoverageSignal {
  readonly projectId: string;
  readonly projectName: string;
  readonly status: DashboardNeedsYouCoverageStatus;
  readonly lastRunId: string | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

type DashboardNeedsYouItemBase = {
  readonly key: string;
  readonly title: string;
  readonly projectName: string;
  readonly reason: string;
  readonly updatedAt: string;
  readonly priority: number;
};

export type DashboardNeedsYouItem =
  | (DashboardNeedsYouItemBase & {
      readonly kind: "thread";
      readonly state: DashboardNeedsYouThreadState;
      readonly environmentId: string;
      readonly threadId: string;
      readonly actionLabel: "Respond" | "Inspect error";
    })
  | (DashboardNeedsYouItemBase & {
      readonly kind: "finding";
      readonly projectId: string;
      readonly findingId: string;
      readonly actionLabel: "Triage finding" | "Review findings";
    })
  | (DashboardNeedsYouItemBase & {
      readonly kind: "run";
      readonly projectId: string;
      readonly runId: string;
      readonly actionLabel: "Diagnose run";
    })
  | (DashboardNeedsYouItemBase & {
      readonly kind: "coverage";
      readonly projectId: string;
      readonly actionLabel: "Review coverage";
    });

export interface DashboardNeedsYouInput {
  readonly threads: ReadonlyArray<DashboardNeedsYouThreadSignal>;
  readonly feedInputRequests: ReadonlyArray<DashboardNeedsYouFeedSignal>;
  readonly findings: ReadonlyArray<DashboardNeedsYouFindingSignal>;
  readonly runs: ReadonlyArray<DashboardNeedsYouRunSignal>;
  readonly coverage: ReadonlyArray<DashboardNeedsYouCoverageSignal>;
}

const ATTENTION_COVERAGE_STATUSES = new Set<DashboardNeedsYouCoverageStatus>([
  "due",
  "overdue",
  "stale",
  "failing",
]);

function compareNeedsYouItems(left: DashboardNeedsYouItem, right: DashboardNeedsYouItem): number {
  const priority = left.priority - right.priority;
  if (priority !== 0) return priority;
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function coverageReason(signal: DashboardNeedsYouCoverageSignal): string {
  if (signal.status === "failing" && signal.lastError) return signal.lastError;
  switch (signal.status) {
    case "due":
      return "Repository review is due";
    case "overdue":
      return "Repository review is overdue";
    case "stale":
      return "Repository review is stale";
    case "failing":
      return "Repository review is failing";
    case "never":
    case "current":
      return "Repository review coverage";
  }
}

function coveragePriority(status: DashboardNeedsYouCoverageStatus): number {
  switch (status) {
    case "failing":
      return 4;
    case "overdue":
      return 5;
    case "stale":
      return 6;
    case "due":
      return 7;
    case "never":
    case "current":
      return 8;
  }
}

/** Builds one explainable queue whose count and destinations come from the same records. */
export function buildDashboardNeedsYouItems(
  input: DashboardNeedsYouInput,
): ReadonlyArray<DashboardNeedsYouItem> {
  const threadItems = new Map<string, Extract<DashboardNeedsYouItem, { kind: "thread" }>>();

  for (const thread of input.threads) {
    const key = `${thread.environmentId}:${thread.threadId}`;
    threadItems.set(key, {
      kind: "thread",
      key: `thread:${key}`,
      state: thread.state,
      environmentId: thread.environmentId,
      threadId: thread.threadId,
      title: thread.title,
      projectName: thread.projectName,
      reason:
        thread.state === "needs-input"
          ? "Waiting for your response"
          : "Agent stopped with an error",
      actionLabel: thread.state === "needs-input" ? "Respond" : "Inspect error",
      updatedAt: thread.updatedAt,
      priority: thread.state === "needs-input" ? 0 : 1,
    });
  }

  for (const feedItem of input.feedInputRequests) {
    if (feedItem.threadId === null) continue;
    const key = `${feedItem.environmentId}:${feedItem.threadId}`;
    const existing = threadItems.get(key);
    threadItems.set(key, {
      kind: "thread",
      key: `thread:${key}`,
      state: "needs-input",
      environmentId: feedItem.environmentId,
      threadId: feedItem.threadId,
      title: existing?.title ?? feedItem.title,
      projectName: existing?.projectName ?? feedItem.projectName,
      reason: feedItem.summary,
      actionLabel: "Respond",
      updatedAt:
        existing && Date.parse(existing.updatedAt) > Date.parse(feedItem.updatedAt)
          ? existing.updatedAt
          : feedItem.updatedAt,
      priority: 0,
    });
  }

  const items: Array<DashboardNeedsYouItem> = [...threadItems.values()];
  const actionableFindings = input.findings.filter(
    (finding) => finding.status === "open" || finding.status === "in-progress",
  );
  const criticalProjects = new Set<string>();

  for (const finding of actionableFindings) {
    if (finding.severity !== "critical") continue;
    criticalProjects.add(finding.projectId);
    items.push({
      kind: "finding",
      key: `finding:${finding.id}`,
      findingId: finding.id,
      projectId: finding.projectId,
      title: finding.title,
      projectName: finding.projectName,
      reason: "Critical finding needs triage",
      actionLabel: "Triage finding",
      updatedAt: finding.updatedAt,
      priority: 2,
    });
  }

  const findingsByProject = new Map<string, Array<DashboardNeedsYouFindingSignal>>();
  for (const finding of actionableFindings) {
    if (criticalProjects.has(finding.projectId)) continue;
    const projectFindings = findingsByProject.get(finding.projectId);
    if (projectFindings) projectFindings.push(finding);
    else findingsByProject.set(finding.projectId, [finding]);
  }
  for (const [projectId, projectFindings] of findingsByProject) {
    const sorted = projectFindings.toSorted(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    const latest = sorted[0];
    if (!latest) continue;
    items.push({
      kind: "finding",
      key: `repository-findings:${projectId}`,
      findingId: latest.id,
      projectId,
      title: `${latest.projectName} has ${sorted.length} open ${sorted.length === 1 ? "finding" : "findings"}`,
      projectName: latest.projectName,
      reason: "Repository health needs review",
      actionLabel: "Review findings",
      updatedAt: latest.updatedAt,
      priority: 8,
    });
  }

  const failedRunIds = new Set<string>();
  for (const run of input.runs) {
    if (run.status !== "failed") continue;
    failedRunIds.add(run.id);
    items.push({
      kind: "run",
      key: `run:${run.id}`,
      runId: run.id,
      projectId: run.projectId,
      title: run.title,
      projectName: run.projectName,
      reason: "Automation run failed",
      actionLabel: "Diagnose run",
      updatedAt: run.updatedAt,
      priority: 3,
    });
  }

  for (const repositoryCoverage of input.coverage) {
    if (!ATTENTION_COVERAGE_STATUSES.has(repositoryCoverage.status)) continue;
    if (repositoryCoverage.lastRunId && failedRunIds.has(repositoryCoverage.lastRunId)) continue;
    items.push({
      kind: "coverage",
      key: `coverage:${repositoryCoverage.projectId}`,
      projectId: repositoryCoverage.projectId,
      title: `${repositoryCoverage.projectName} review coverage`,
      projectName: repositoryCoverage.projectName,
      reason: coverageReason(repositoryCoverage),
      actionLabel: "Review coverage",
      updatedAt: repositoryCoverage.updatedAt,
      priority: coveragePriority(repositoryCoverage.status),
    });
  }

  return items.toSorted(compareNeedsYouItems);
}

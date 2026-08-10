import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  AgentDashboardFeedCard,
  AgentDashboardFeedKind,
  AgentDashboardFeedStatus,
  AgentDashboardFinding,
  AgentDashboardReviewSuggestion,
  AgentDashboardSnapshot,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";

export type NativeAgentState =
  | "running"
  | "needs-input"
  | "error"
  | "completed"
  | "paused"
  | "idle";

export interface NativeAgentFeedItem {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly provider: string;
  readonly model: string;
  readonly summary: string;
  readonly kind: AgentDashboardFeedKind | "thread";
  readonly level: "info" | "success" | "warn" | "error";
  readonly tags: ReadonlyArray<string>;
  readonly state: NativeAgentState;
  readonly updatedAt: string;
  readonly chatLabel?: string;
  readonly durableCard?: AgentDashboardFeedCard;
}

type FeedProjectContext = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "workspaceRoot"
>;
type FeedThreadContext = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "modelSelection"
  | "branch"
  | "worktreePath"
  | "updatedAt"
  | "archivedAt"
>;

export interface NativeResearchFinding {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly url: string | null;
  readonly timestamp: string;
  readonly abstract: string | null;
  readonly authors: ReadonlyArray<string>;
  readonly published: string | null;
  readonly categories: ReadonlyArray<string>;
  readonly relevanceScore: number;
  readonly topicContext: string | null;
  readonly repositories: ReadonlyArray<string>;
  readonly watchDir: string | null;
  readonly pdfUrl: string | null;
  readonly citationCount: number | null;
  readonly occurrences: number;
}

export interface NativeResearchRecord {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly repositoryName: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly summary: string;
  readonly signal: "active" | "needs-attention" | "connected";
  readonly latestActivityAt: string;
  readonly threadCount: number;
  readonly activeThreadCount: number;
  readonly latestThreadTitle: string | null;
  readonly source: string;
  readonly relevanceScore: number;
  readonly categories: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
  readonly remoteUrl: string | null;
  readonly durableFinding?: NativeResearchFinding;
}

export interface NativeSuggestion {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly projectName: string;
  readonly title: string;
  readonly description: string;
  readonly category: "bug" | "feature" | "gap" | "insight";
  readonly confidence: "high" | "medium" | "low";
  readonly impact: "high" | "medium" | "low";
  readonly evidence: ReadonlyArray<string>;
  readonly nextStep: string;
  readonly report: string;
  readonly priority: "high" | "normal";
  readonly kind:
    | "needs-input"
    | "error"
    | "stale-agent"
    | "review-changes"
    | "sync-branch"
    | "respond-to-thread"
    | "review-plan"
    | "inspect-error";
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly repositoryPath: string;
  readonly githubIssueUrl: string | null;
  readonly durableSuggestion?: AgentDashboardReviewSuggestion;
  readonly legacySuggestionId?: string;
  readonly findingId?: string;
  readonly findingState?: AgentDashboardFinding["disposition"]["state"];
  readonly findingSnoozeUntil?: string | null;
}

/** Builds the implementation brief used when a suggestion starts a new thread. */
export function buildSuggestionWorkPrompt(
  suggestion: Pick<
    NativeSuggestion,
    | "repositoryPath"
    | "projectName"
    | "category"
    | "title"
    | "description"
    | "report"
    | "evidence"
    | "nextStep"
  >,
): string {
  const evidence = suggestion.evidence.map((item) => `- ${item}`).join("\n");
  const findingDetails =
    suggestion.description.trim() === suggestion.report.trim()
      ? suggestion.report
      : `${suggestion.description}\n\n${suggestion.report}`;

  return [
    "Investigate and complete the repository work described below.",
    "",
    `Repository: \`${suggestion.repositoryPath || suggestion.projectName}\``,
    `Category: ${suggestion.category}`,
    "",
    "## Finding",
    suggestion.title,
    "",
    findingDetails,
    "",
    "## Evidence",
    evidence || "No additional evidence was recorded.",
    "",
    "## Recommended next step",
    suggestion.nextStep,
    "",
    "Work in the repository above, verify the finding against the current code, and implement the appropriate fix or improvement. Run focused validation before you finish. If the finding is no longer applicable, explain what changed and why instead of making speculative edits.",
  ].join("\n");
}

function timestampValue(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

/** Sorts dashboard records newest first, with an id tie-breaker for stability. */
export function compareDashboardRecency(
  left: { readonly updatedAt: string; readonly id: string },
  right: { readonly updatedAt: string; readonly id: string },
): number {
  return (
    timestampValue(right.updatedAt) - timestampValue(left.updatedAt) ||
    right.id.localeCompare(left.id)
  );
}

function projectKey(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

function feedLevelForState(state: NativeAgentState): NativeAgentFeedItem["level"] {
  switch (state) {
    case "error":
      return "error";
    case "needs-input":
      return "warn";
    case "completed":
      return "success";
    case "running":
    case "paused":
    case "idle":
      return "info";
  }
}

function resolveAgentState(thread: EnvironmentThreadShell): NativeAgentState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return "needs-input";
  }

  switch (thread.latestTurn?.state) {
    case "running":
      return "running";
    case "error":
      return "error";
    case "completed":
      return "completed";
    case "interrupted":
      return "paused";
  }

  switch (thread.session?.status) {
    case "starting":
    case "running":
      return "running";
    case "error":
      return "error";
    case "stopped":
    case "interrupted":
      return "paused";
    default:
      return "idle";
  }
}

export function nativeAgentStateLabel(state: NativeAgentState): string {
  switch (state) {
    case "running":
      return "Running";
    case "needs-input":
      return "Needs input";
    case "error":
      return "Error";
    case "completed":
      return "Completed";
    case "paused":
      return "Paused";
    case "idle":
      return "Idle";
  }
}

export function buildNativeAgentFeed(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<NativeAgentFeedItem> {
  const projectByKey = new Map(
    projects.map((project) => [projectKey(project.environmentId, project.id), project]),
  );

  return threads
    .filter((thread) => thread.archivedAt === null)
    .map((thread) => {
      const project = projectByKey.get(projectKey(thread.environmentId, thread.projectId));
      return {
        id: `thread:${thread.environmentId}:${thread.id}`,
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        projectName: project?.title ?? "Unknown project",
        workspaceRoot: project?.workspaceRoot ?? "",
        threadId: thread.id,
        title: thread.title,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        provider: thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
        summary: `${nativeAgentStateLabel(resolveAgentState(thread))} agent activity`,
        kind: "thread",
        level: feedLevelForState(resolveAgentState(thread)),
        tags: [resolveAgentState(thread), thread.branch ?? "no-branch"],
        state: resolveAgentState(thread),
        updatedAt: thread.updatedAt,
      } satisfies NativeAgentFeedItem;
    })
    .toSorted(compareDashboardRecency);
}

function snapshotThreads(snapshot: AgentDashboardSnapshot): ReadonlyArray<{
  readonly projectId: string;
  readonly threadId: string;
  readonly title: string;
  readonly model: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly provider: string;
}> {
  return snapshot.repositories.flatMap((repository) => [
    ...repository.threads.map((thread) => ({
      projectId: repository.projectId,
      threadId: thread.threadId,
      title: thread.title,
      model: thread.model,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      provider: thread.agent?.providerName ?? thread.agent?.providerInstanceId ?? "Agent",
    })),
    ...repository.worktrees.flatMap((worktree) =>
      worktree.threads.map((thread) => ({
        projectId: repository.projectId,
        threadId: thread.threadId,
        title: thread.title,
        model: thread.model,
        branch: thread.branch,
        worktreePath: thread.worktreePath ?? worktree.path,
        provider: thread.agent?.providerName ?? thread.agent?.providerInstanceId ?? "Agent",
      })),
    ),
  ]);
}

function nativeStateFromFeedStatus(status: AgentDashboardFeedStatus): NativeAgentState {
  switch (status) {
    case "running":
      return "running";
    case "needs-input":
      return "needs-input";
    case "error":
      return "error";
    case "completed":
      return "completed";
    case "paused":
      return "paused";
    case "ready":
    case "info":
      return "idle";
  }
}

/** Adapts the server's event-sourced feed to the feed card view model. */
export function buildNativeAgentFeedFromSnapshot(
  snapshot: AgentDashboardSnapshot,
): ReadonlyArray<NativeAgentFeedItem> {
  const repositories = new Map(
    snapshot.repositories.map((repository) => [repository.projectId, repository]),
  );
  const threads = new Map(snapshotThreads(snapshot).map((thread) => [thread.threadId, thread]));

  return snapshot.feed
    .map((update) => {
      const repository = repositories.get(update.repository.projectId);
      const thread = update.thread === null ? null : threads.get(update.thread.threadId);
      return {
        id: update.id,
        environmentId: "native",
        projectId: update.repository.projectId,
        projectName: repository?.title ?? "Unknown project",
        workspaceRoot: repository?.workspaceRoot ?? "",
        threadId: thread?.threadId ?? "",
        title: thread?.title ?? update.summary,
        branch: thread?.branch ?? null,
        worktreePath: thread?.worktreePath ?? null,
        provider: thread?.provider ?? "Agent",
        model: thread?.model ?? "",
        summary: update.summary,
        kind: update.kind,
        level:
          update.status === "error"
            ? "error"
            : update.status === "needs-input"
              ? "warn"
              : update.status === "completed" || update.status === "ready"
                ? "success"
                : "info",
        tags: [update.kind, update.status, thread?.branch ?? "no-branch"],
        state: nativeStateFromFeedStatus(update.status),
        updatedAt: update.occurredAt,
      } satisfies NativeAgentFeedItem;
    })
    .filter((item) => item.threadId.length > 0)
    .toSorted(compareDashboardRecency);
}

/** Adapts cards from the T3-owned feed store without reducing them to thread activity. */
export function buildNativeAgentFeedFromDurableCards(
  cards: ReadonlyArray<AgentDashboardFeedCard>,
  environmentId: string,
  projects: ReadonlyArray<FeedProjectContext> = [],
  threads: ReadonlyArray<FeedThreadContext> = [],
): ReadonlyArray<NativeAgentFeedItem> {
  return cards
    .map((card) => {
      const origin = card.origin ?? null;
      const threadById = origin?.threadId
        ? (threads.find(
            (thread) => thread.environmentId === environmentId && thread.id === origin.threadId,
          ) ?? null)
        : null;
      const threadByPath = origin?.projectPath
        ? (threads.find(
            (thread) =>
              thread.environmentId === environmentId &&
              thread.worktreePath !== null &&
              normalizeProjectPathForComparison(thread.worktreePath) ===
                normalizeProjectPathForComparison(origin.projectPath!),
          ) ?? null)
        : null;
      const referencedThread = threadById ?? (origin?.threadId ? null : threadByPath);
      let project: FeedProjectContext | null = null;
      if (referencedThread) {
        project =
          projects.find(
            (candidate) =>
              candidate.environmentId === environmentId &&
              candidate.id === referencedThread.projectId,
          ) ?? null;
      }
      if (!project && origin?.projectId) {
        project =
          projects.find(
            (candidate) =>
              candidate.environmentId === environmentId && candidate.id === origin.projectId,
          ) ?? null;
      }
      if (!project && origin?.projectPath) {
        project =
          projects.find(
            (candidate) =>
              candidate.environmentId === environmentId &&
              normalizeProjectPathForComparison(candidate.workspaceRoot) ===
                normalizeProjectPathForComparison(origin.projectPath!),
          ) ?? null;
      }
      const latestProjectThread = project
        ? (threads
            .filter(
              (thread) => thread.environmentId === environmentId && thread.projectId === project.id,
            )
            .toSorted(compareDashboardRecency)[0] ?? null)
        : null;
      const targetThread = referencedThread ?? (origin?.threadId ? null : latestProjectThread);
      const targetThreadId = targetThread?.id ?? origin?.threadId ?? "";
      const projectPath = project?.workspaceRoot ?? origin?.projectPath ?? "";
      const projectName =
        project?.title ??
        origin?.projectName ??
        projectPathLeaf(projectPath) ??
        "Project unavailable";
      const updatedAt = new Date(card.ts * 1_000).toISOString();
      const state: NativeAgentState =
        card.level === "error"
          ? "error"
          : card.level === "warn"
            ? "needs-input"
            : card.level === "success"
              ? "completed"
              : "idle";
      return {
        id: `feed:${card.id}`,
        environmentId,
        projectId: project?.id ?? targetThread?.projectId ?? origin?.projectId ?? "agent-feed",
        projectName,
        workspaceRoot: projectPath,
        threadId: targetThreadId,
        title: card.title ?? `${card.agent} update`,
        branch: targetThread?.branch ?? null,
        worktreePath: targetThread?.worktreePath ?? null,
        provider: targetThread?.modelSelection.instanceId ?? card.agent,
        model: targetThread?.modelSelection.model ?? "",
        summary: card.text ?? card.title ?? `${card.agent} update`,
        kind: "activity",
        level: card.level,
        tags: card.tags,
        state,
        updatedAt,
        ...(targetThreadId
          ? { chatLabel: threadById || threadByPath ? "Open chat" : "Open latest chat" }
          : {}),
        durableCard: card,
      } satisfies NativeAgentFeedItem;
    })
    .toSorted(compareDashboardRecency);
}

/** Merges native and migrated feed records while retaining both source kinds. */
export function mergeNativeAgentFeedRecords(
  ...sources: ReadonlyArray<ReadonlyArray<NativeAgentFeedItem>>
): ReadonlyArray<NativeAgentFeedItem> {
  const byIdentity = new Map<string, NativeAgentFeedItem>();
  for (const records of sources) {
    for (const record of records) {
      const identity = record.durableCard
        ? `durable:${record.durableCard.id}`
        : record.threadId
          ? `thread:${record.threadId}:${record.kind}`
          : record.id;
      const previous = byIdentity.get(identity);
      if (!previous || timestampValue(record.updatedAt) >= timestampValue(previous.updatedAt)) {
        byIdentity.set(identity, record);
      }
    }
  }
  return [...byIdentity.values()].toSorted(compareDashboardRecency);
}

function projectPathLeaf(path: string): string | null {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  if (!normalized) return null;
  const leaf = normalized.split(/[\\/]/).at(-1)?.trim();
  return leaf || null;
}

export function buildNativeResearchFindingsFromSnapshot(
  snapshot: AgentDashboardSnapshot,
): ReadonlyArray<NativeResearchFinding> {
  return snapshot.researchFindings
    .map((finding) => ({
      id: finding.id,
      title: finding.title,
      source: finding.source,
      url: finding.url,
      timestamp: finding.timestamp,
      abstract: finding.abstract,
      authors: finding.authors,
      published: finding.published,
      categories: finding.categories,
      relevanceScore: finding.relevanceScore,
      topicContext: finding.topicContext,
      repositories: finding.repositories,
      watchDir: finding.watchDir,
      pdfUrl: finding.pdfUrl,
      citationCount: finding.citationCount,
      occurrences: finding.occurrences,
    }))
    .toSorted((left, right) => {
      return (
        timestampValue(right.timestamp) - timestampValue(left.timestamp) ||
        right.id.localeCompare(left.id)
      );
    });
}

export function buildNativeResearchRecordsFromDurableFindings(
  snapshot: AgentDashboardSnapshot,
  environmentId: string,
): ReadonlyArray<NativeResearchRecord> {
  return buildNativeResearchFindingsFromSnapshot(snapshot).map((finding) => {
    const repository = snapshot.repositories.find(
      (candidate) =>
        (finding.watchDir !== null &&
          normalizeProjectPathForComparison(candidate.workspaceRoot) ===
            normalizeProjectPathForComparison(finding.watchDir)) ||
        finding.repositories.some((name) => candidate.title === name),
    );
    return {
      id: `research-finding:${finding.id}`,
      projectId: repository?.projectId ?? finding.repositories[0] ?? finding.id,
      environmentId,
      repositoryName: finding.repositories[0] ?? finding.source,
      workspaceRoot: finding.watchDir ?? "",
      title: finding.title,
      summary: finding.abstract ?? "No abstract was recorded for this finding.",
      signal:
        finding.relevanceScore >= 70
          ? "active"
          : finding.relevanceScore >= 45
            ? "connected"
            : "needs-attention",
      latestActivityAt: finding.timestamp,
      threadCount: 0,
      activeThreadCount: 0,
      latestThreadTitle: null,
      source: finding.source,
      relevanceScore: finding.relevanceScore,
      categories: finding.categories,
      evidence: [
        ...(finding.authors.length > 0 ? [`Authors: ${finding.authors.join(", ")}`] : []),
        ...(finding.published ? [`Published: ${finding.published}`] : []),
        ...(finding.citationCount !== null ? [`${finding.citationCount} citations`] : []),
      ],
      remoteUrl: finding.url,
      durableFinding: finding,
    } satisfies NativeResearchRecord;
  });
}

export function buildNativeResearchRecordsFromCanonicalFindings(
  snapshot: AgentDashboardSnapshot,
): ReadonlyArray<NativeResearchRecord> {
  return snapshot.findings.map((finding) => {
    const repository = snapshot.repositories.find(
      (candidate) => candidate.projectId === finding.repository.projectId,
    );
    const signal =
      finding.severity === "critical" || finding.severity === "high"
        ? "needs-attention"
        : finding.kind === "research"
          ? "active"
          : "connected";
    return {
      id: `canonical-finding:${finding.id}`,
      projectId: finding.repository.projectId,
      environmentId: "native",
      repositoryName: repository?.title ?? finding.repositoryPath ?? "Unknown repository",
      workspaceRoot: repository?.workspaceRoot ?? finding.repositoryPath ?? "",
      title: finding.title,
      summary: finding.summary,
      signal,
      latestActivityAt: finding.lastSeenAt,
      threadCount: 0,
      activeThreadCount: 0,
      latestThreadTitle: null,
      source: finding.provenance.source,
      relevanceScore: signal === "needs-attention" ? 40 : 75,
      categories: [finding.kind, ...(finding.category ? [finding.category] : [])],
      evidence: finding.evidence,
      remoteUrl: finding.externalIssueUrl,
    } satisfies NativeResearchRecord;
  });
}

export function mergeNativeResearchRecords(
  ...sources: ReadonlyArray<ReadonlyArray<NativeResearchRecord>>
): ReadonlyArray<NativeResearchRecord> {
  const byIdentity = new Map<string, NativeResearchRecord>();
  for (const records of sources) {
    for (const record of records) {
      const identity = `${record.projectId}:${record.title.trim().toLocaleLowerCase()}:${record.source}`;
      const previous = byIdentity.get(identity);
      if (
        !previous ||
        timestampValue(record.latestActivityAt) >= timestampValue(previous.latestActivityAt)
      ) {
        byIdentity.set(identity, record);
      }
    }
  }
  return [...byIdentity.values()].toSorted((left, right) =>
    compareDashboardRecency(
      { updatedAt: left.latestActivityAt, id: left.id },
      { updatedAt: right.latestActivityAt, id: right.id },
    ),
  );
}

export function buildNativeResearchRecords(
  input: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly repositoryName: string;
    readonly workspaceRoot: string;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  }>,
): ReadonlyArray<NativeResearchRecord> {
  return input
    .map((group) => {
      const activeThreads = group.threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          (thread.latestTurn?.state === "running" ||
            thread.session?.status === "running" ||
            thread.session?.status === "starting"),
      );
      const latestThread = group.threads.toSorted(compareDashboardRecency)[0] ?? null;
      const needsAttention = group.threads.some(
        (thread) =>
          thread.hasPendingApprovals ||
          thread.hasPendingUserInput ||
          thread.latestTurn?.state === "error" ||
          thread.session?.status === "error",
      );
      const latestActivityAt =
        latestThread?.updatedAt ?? group.projects[0]?.updatedAt ?? new Date(0).toISOString();

      return {
        id: `research:${group.environmentId}:${group.id}`,
        projectId: group.projectId,
        environmentId: group.environmentId,
        repositoryName: group.repositoryName,
        workspaceRoot: group.workspaceRoot,
        title: `${group.repositoryName} workspace signal`,
        summary:
          activeThreads.length > 0
            ? `${activeThreads.length} agent${activeThreads.length === 1 ? " is" : "s are"} active in this repository.`
            : needsAttention
              ? "This repository has an agent that needs attention."
              : "Repository and agent state are connected to T3 Code.",
        signal: needsAttention
          ? "needs-attention"
          : activeThreads.length > 0
            ? "active"
            : "connected",
        latestActivityAt,
        threadCount: group.threads.length,
        activeThreadCount: activeThreads.length,
        latestThreadTitle: latestThread?.title ?? null,
        source: "T3 Code",
        relevanceScore: needsAttention ? 45 : activeThreads.length > 0 ? 80 : 65,
        categories: ["repository", needsAttention ? "needs-attention" : "connected"],
        evidence: [
          `${group.threads.length} agent${group.threads.length === 1 ? "" : "s"} associated`,
          ...(latestThread ? [`Latest activity: ${latestThread.title}`] : []),
        ],
        remoteUrl: null,
      } satisfies NativeResearchRecord;
    })
    .toSorted((left, right) =>
      compareDashboardRecency(
        { updatedAt: left.latestActivityAt, id: left.id },
        { updatedAt: right.latestActivityAt, id: right.id },
      ),
    );
}

/** Adapts repository observations from the native server snapshot. */
export function buildNativeResearchRecordsFromSnapshot(
  snapshot: AgentDashboardSnapshot,
): ReadonlyArray<NativeResearchRecord> {
  const threadCounts = new Map(
    snapshot.repositories.map((repository) => [
      repository.projectId,
      repository.threads.length +
        repository.worktrees.reduce((count, worktree) => count + worktree.threads.length, 0),
    ]),
  );
  return snapshot.research
    .map((record) => {
      const repository = snapshot.repositories.find(
        (candidate) => candidate.projectId === record.repository.projectId,
      );
      const repositoryThreads = repository
        ? [...repository.threads, ...repository.worktrees.flatMap((worktree) => worktree.threads)]
        : [];
      const latestThread = record.latestThread
        ? repositoryThreads.find((thread) => thread.threadId === record.latestThread?.threadId)
        : repositoryThreads.toSorted((left, right) =>
            compareDashboardRecency(
              { updatedAt: left.updatedAt, id: left.threadId },
              { updatedAt: right.updatedAt, id: right.threadId },
            ),
          )[0];
      const signal =
        record.status === "clean" || record.status === "ahead" ? "connected" : "needs-attention";
      return {
        id: record.id,
        projectId: record.repository.projectId,
        environmentId: "native",
        repositoryName: record.title,
        workspaceRoot: repository?.workspaceRoot ?? "",
        title: record.title,
        summary: record.summary,
        signal,
        latestActivityAt: latestThread?.updatedAt ?? record.observedAt,
        threadCount: threadCounts.get(record.repository.projectId) ?? record.threadCount,
        activeThreadCount:
          record.activeThreadCount ??
          repositoryThreads.filter((thread) => thread.state === "running").length,
        latestThreadTitle: latestThread?.title ?? null,
        source: "T3 Code",
        relevanceScore: record.status === "clean" ? 100 : record.status === "ahead" ? 80 : 45,
        categories: ["repository", record.status],
        evidence: [
          record.summary,
          ...(record.branch ? [`Branch: ${record.branch}`] : []),
          ...(record.defaultBranch ? [`Default branch: ${record.defaultBranch}`] : []),
        ],
        remoteUrl: repository?.repositoryIdentity?.locator.remoteUrl ?? null,
      } satisfies NativeResearchRecord;
    })
    .toSorted((left, right) =>
      compareDashboardRecency(
        { updatedAt: left.latestActivityAt, id: left.id },
        { updatedAt: right.latestActivityAt, id: right.id },
      ),
    );
}

export function buildNativeSuggestions(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<NativeSuggestion> {
  const projectByKey = new Map(
    projects.map((project) => [projectKey(project.environmentId, project.id), project]),
  );
  const suggestions: NativeSuggestion[] = [];

  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const project = projectByKey.get(projectKey(thread.environmentId, thread.projectId));
    const projectName = project?.title ?? "Unknown project";

    if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      suggestions.push({
        id: `suggestion:input:${thread.environmentId}:${thread.id}`,
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectName,
        title: `Respond to ${thread.title}`,
        description: "This agent is waiting for approval or input before it can continue.",
        category: "gap",
        confidence: "high",
        impact: "high",
        evidence: ["The thread has pending approval or user input."],
        nextStep: "Open the agent and respond to its request.",
        report: "This agent cannot continue until the pending request is resolved.",
        priority: "high",
        kind: "needs-input",
        updatedAt: thread.updatedAt,
        expiresAt: null,
        repositoryPath: project?.workspaceRoot ?? "",
        githubIssueUrl: null,
      });
      continue;
    }

    if (thread.latestTurn?.state === "error" || thread.session?.status === "error") {
      suggestions.push({
        id: `suggestion:error:${thread.environmentId}:${thread.id}`,
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectName,
        title: `Review ${thread.title}`,
        description: "The latest agent turn ended with an error. Open the thread to inspect it.",
        category: "bug",
        confidence: "high",
        impact: "high",
        evidence: ["The latest native agent turn or session is in an error state."],
        nextStep: "Open the agent and inspect the latest error.",
        report: "The latest agent activity ended in an error and may need a retry or correction.",
        priority: "high",
        kind: "error",
        updatedAt: thread.updatedAt,
        expiresAt: null,
        repositoryPath: project?.workspaceRoot ?? "",
        githubIssueUrl: null,
      });
    }
  }

  return suggestions.toSorted(compareDashboardRecency);
}

/** Adapts deterministic native suggestions from the server read model. */
export function buildNativeSuggestionsFromSnapshot(
  snapshot: AgentDashboardSnapshot,
): ReadonlyArray<NativeSuggestion> {
  const repositories = new Map(
    snapshot.repositories.map((repository) => [repository.projectId, repository]),
  );
  return snapshot.suggestions
    .map((suggestion) => {
      const repository = repositories.get(suggestion.repository.projectId);
      return {
        id: suggestion.id,
        projectId: suggestion.repository.projectId,
        environmentId: "native",
        threadId: suggestion.thread?.threadId ?? null,
        projectName: repository?.title ?? "Unknown project",
        title: suggestion.title,
        description: suggestion.summary,
        category:
          suggestion.kind === "inspect-error"
            ? "bug"
            : suggestion.kind === "review-plan"
              ? "feature"
              : suggestion.kind === "respond-to-thread"
                ? "gap"
                : "insight",
        confidence: suggestion.kind === "inspect-error" ? "high" : "medium",
        impact:
          suggestion.kind === "review-changes" || suggestion.kind === "sync-branch"
            ? "high"
            : "medium",
        evidence: [suggestion.summary],
        nextStep:
          suggestion.action === "open-thread"
            ? "Open the linked agent thread."
            : "Open the Agent Dashboard repository overview.",
        report: suggestion.summary,
        priority:
          suggestion.kind === "respond-to-thread" || suggestion.kind === "inspect-error"
            ? "high"
            : "normal",
        kind: suggestion.kind,
        updatedAt: suggestion.updatedAt,
        expiresAt: null,
        repositoryPath: repository?.workspaceRoot ?? "",
        githubIssueUrl: null,
      } satisfies NativeSuggestion;
    })
    .toSorted(compareDashboardRecency);
}

export function buildNativeReviewSuggestionsFromSnapshot(
  snapshot: AgentDashboardSnapshot,
  environmentId: string,
): ReadonlyArray<NativeSuggestion> {
  const repositories = snapshot.repositories;
  const legacySuggestionByFindingId = new Map(
    snapshot.reviewSuggestions.map(
      (suggestion) => [suggestion.id.replace(/^t3-review-/, "finding:"), suggestion] as const,
    ),
  );
  const projectForPath = (path: string): string =>
    repositories.find(
      (repository) =>
        normalizeProjectPathForComparison(repository.workspaceRoot) ===
        normalizeProjectPathForComparison(path),
    )?.projectId ?? "agent-dashboard";
  // This page is reserved for findings produced by scheduled repository review
  // runs. Native navigation suggestions and other collector domains belong on
  // their own dashboard pages.
  const canonicalSuggestions = snapshot.findings
    .filter((finding) => finding.kind === "review")
    .map((finding) => {
      const repository = repositories.find(
        (candidate) => candidate.projectId === finding.repository.projectId,
      );
      const legacySuggestion = legacySuggestionByFindingId.get(finding.id);
      const category =
        finding.category === "bug" || finding.category === "feature" || finding.category === "gap"
          ? finding.category
          : "insight";
      const impact =
        finding.severity === "critical" || finding.severity === "high"
          ? "high"
          : finding.severity === "low" || finding.severity === "info"
            ? "low"
            : "medium";
      return {
        id: finding.id,
        ...(legacySuggestion ? { legacySuggestionId: legacySuggestion.id } : {}),
        findingId: finding.id,
        findingState: finding.disposition.state,
        findingSnoozeUntil: finding.disposition.snoozeUntil,
        projectId: finding.repository.projectId,
        environmentId,
        threadId: finding.thread?.threadId ?? null,
        projectName: repository?.title ?? finding.repositoryPath ?? "Unknown project",
        title: finding.title,
        description: finding.summary,
        category,
        confidence: finding.confidence,
        impact,
        evidence: finding.evidence,
        nextStep: "Verify the finding, then acknowledge, assign, snooze, dismiss, or reopen it.",
        report: finding.summary,
        priority: impact === "high" ? "high" : "normal",
        kind: finding.kind === "security" ? "inspect-error" : "review-changes",
        updatedAt: finding.lastSeenAt,
        expiresAt: null,
        repositoryPath: repository?.workspaceRoot ?? finding.repositoryPath ?? "",
        githubIssueUrl: finding.externalIssueUrl,
        ...(legacySuggestion ? { durableSuggestion: legacySuggestion } : {}),
      } satisfies NativeSuggestion;
    });
  const canonicalIds = new Set(canonicalSuggestions.map((suggestion) => suggestion.id));
  const canonicalLegacyIds = new Set(
    canonicalSuggestions.map((suggestion) => `t3-review-${suggestion.id.replace(/^finding:/, "")}`),
  );
  const legacySuggestions = snapshot.reviewSuggestions
    .map(
      (suggestion) =>
        ({
          id: suggestion.id,
          projectId: projectForPath(suggestion.repository.path),
          environmentId,
          threadId:
            snapshot.findings.find(
              (finding) =>
                finding.id === suggestion.id ||
                finding.id === suggestion.id.replace(/^t3-review-/, "finding:"),
            )?.thread?.threadId ?? null,
          projectName: suggestion.repository.name,
          title: suggestion.title,
          description: suggestion.description,
          category:
            suggestion.category === "bug" ||
            suggestion.category === "feature" ||
            suggestion.category === "gap"
              ? suggestion.category
              : "insight",
          confidence:
            suggestion.confidence === "high" || suggestion.confidence === "low"
              ? suggestion.confidence
              : "medium",
          impact:
            suggestion.impact === "high" || suggestion.impact === "low"
              ? suggestion.impact
              : "medium",
          evidence: suggestion.evidence,
          nextStep: suggestion.nextStep,
          report: suggestion.report,
          priority: suggestion.impact === "high" ? "high" : "normal",
          kind: suggestion.category === "bug" ? "inspect-error" : "review-changes",
          updatedAt: suggestion.createdAt,
          expiresAt: suggestion.expiresAt,
          repositoryPath: suggestion.repository.path,
          githubIssueUrl: suggestion.githubIssue.url,
          durableSuggestion: suggestion,
        }) satisfies NativeSuggestion,
    )
    .filter(
      (suggestion) => !canonicalIds.has(suggestion.id) && !canonicalLegacyIds.has(suggestion.id),
    );
  return [...canonicalSuggestions, ...legacySuggestions].toSorted(compareDashboardRecency);
}

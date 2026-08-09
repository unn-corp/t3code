import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  AgentDashboardFeedCard,
  AgentDashboardFeedKind,
  AgentDashboardFeedStatus,
  AgentDashboardReviewSuggestion,
  AgentDashboardSnapshot,
} from "@t3tools/contracts";

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
  readonly durableCard?: AgentDashboardFeedCard;
}

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
): ReadonlyArray<NativeAgentFeedItem> {
  return cards
    .map((card) => {
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
        projectId: "agent-feed",
        projectName: "Agent Feed",
        workspaceRoot: "",
        threadId: "",
        title: card.title ?? `${card.agent} update`,
        branch: null,
        worktreePath: null,
        provider: card.agent,
        model: "",
        summary: card.text ?? card.title ?? `${card.agent} update`,
        kind: "activity",
        level: card.level,
        tags: card.tags,
        state,
        updatedAt,
        durableCard: card,
      } satisfies NativeAgentFeedItem;
    })
    .toSorted(compareDashboardRecency);
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
  return buildNativeResearchFindingsFromSnapshot(snapshot).map((finding) => ({
    id: `research-finding:${finding.id}`,
    projectId: finding.repositories[0] ?? finding.id,
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
  }));
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
  return snapshot.reviewSuggestions
    .map(
      (suggestion) =>
        ({
          id: suggestion.id,
          projectId: suggestion.repository.path,
          environmentId,
          threadId: null,
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
    .toSorted(compareDashboardRecency);
}

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RepositoryIdentity } from "./environment.ts";
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { OrchestrationLatestTurn, OrchestrationSessionStatus } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentDashboardGetSnapshotInput = Schema.Struct({});
export type AgentDashboardGetSnapshotInput = typeof AgentDashboardGetSnapshotInput.Type;

export const AgentDashboardVcsAvailability = Schema.Literals([
  "available",
  "not-a-repository",
  "unavailable",
]);
export type AgentDashboardVcsAvailability = typeof AgentDashboardVcsAvailability.Type;

export const AgentDashboardVcsState = Schema.Literals(["clean", "dirty", "unknown"]);
export type AgentDashboardVcsState = typeof AgentDashboardVcsState.Type;

export const AgentDashboardThreadState = Schema.Literals([
  "running",
  "needs-input",
  "error",
  "ready",
  "paused",
  "idle",
]);
export type AgentDashboardThreadState = typeof AgentDashboardThreadState.Type;

/** Stable native project reference used by dashboard records for navigation. */
export const AgentDashboardRepositoryRef = Schema.Struct({
  projectId: ProjectId,
});
export type AgentDashboardRepositoryRef = typeof AgentDashboardRepositoryRef.Type;

/** Stable native thread reference used by dashboard records for navigation. */
export const AgentDashboardThreadRef = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type AgentDashboardThreadRef = typeof AgentDashboardThreadRef.Type;

export const AgentDashboardVcsStatus = Schema.Struct({
  availability: AgentDashboardVcsAvailability,
  isRepo: Schema.Boolean,
  state: AgentDashboardVcsState,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
  isDefaultBranch: Schema.Boolean,
  hasUpstream: Schema.NullOr(Schema.Boolean),
  aheadCount: Schema.NullOr(NonNegativeInt),
  behindCount: Schema.NullOr(NonNegativeInt),
  aheadOfDefaultCount: Schema.NullOr(NonNegativeInt),
});
export type AgentDashboardVcsStatus = typeof AgentDashboardVcsStatus.Type;

export const AgentDashboardAgent = Schema.Struct({
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: OrchestrationSessionStatus,
  activeTurnId: Schema.NullOr(TurnId),
  updatedAt: IsoDateTime,
});
export type AgentDashboardAgent = typeof AgentDashboardAgent.Type;

export const AgentDashboardThread = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  agent: Schema.NullOr(AgentDashboardAgent),
  state: AgentDashboardThreadState.pipe(Schema.withDecodingDefault(Effect.succeed("idle"))),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  hasPendingApprovals: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  hasPendingUserInput: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  hasActionableProposedPlan: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  updatedAt: IsoDateTime,
});
export type AgentDashboardThread = typeof AgentDashboardThread.Type;

export const AgentDashboardWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  threads: Schema.Array(AgentDashboardThread),
});
export type AgentDashboardWorktree = typeof AgentDashboardWorktree.Type;

export const AgentDashboardRepository = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  vcs: AgentDashboardVcsStatus,
  threads: Schema.Array(AgentDashboardThread),
  worktrees: Schema.Array(AgentDashboardWorktree),
});
export type AgentDashboardRepository = typeof AgentDashboardRepository.Type;

export const AgentDashboardFeedKind = Schema.Literals(["activity", "session", "turn", "attention"]);
export type AgentDashboardFeedKind = typeof AgentDashboardFeedKind.Type;

export const AgentDashboardFeedStatus = Schema.Literals([
  "info",
  "running",
  "needs-input",
  "error",
  "ready",
  "paused",
  "completed",
]);
export type AgentDashboardFeedStatus = typeof AgentDashboardFeedStatus.Type;

/** The durable feed level used by the former standalone agent widget. */
export const AgentDashboardFeedLevel = Schema.Literals(["info", "success", "warn", "error"]);
export type AgentDashboardFeedLevel = typeof AgentDashboardFeedLevel.Type;

export const AgentDashboardFeedAction = Schema.Struct({
  label: TrimmedNonEmptyString,
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  file: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  reveal: Schema.optional(Schema.Boolean),
});
export type AgentDashboardFeedAction = typeof AgentDashboardFeedAction.Type;

/** Origin metadata used to connect an external feed card back to T3. */
export const AgentDashboardFeedOrigin = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  projectName: Schema.NullOr(TrimmedNonEmptyString),
  projectPath: Schema.NullOr(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
});
export type AgentDashboardFeedOrigin = typeof AgentDashboardFeedOrigin.Type;

/**
 * The original agent-widget card, normalized into a T3-owned contract.
 * Structured chart/research/focus payloads remain opaque so migrating older
 * cards does not discard fields the standalone renderer knew how to display.
 */
export const AgentDashboardFeedCard = Schema.Struct({
  id: NonNegativeInt,
  ts: Schema.Number,
  agent: TrimmedNonEmptyString,
  kind: Schema.NullOr(TrimmedNonEmptyString),
  title: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.NullOr(TrimmedNonEmptyString),
  imageUrl: Schema.NullOr(TrimmedNonEmptyString),
  level: AgentDashboardFeedLevel,
  tags: Schema.Array(TrimmedNonEmptyString),
  chart: Schema.optional(Schema.Unknown),
  research: Schema.optional(Schema.Unknown),
  focus: Schema.optional(Schema.Unknown),
  actions: Schema.Array(AgentDashboardFeedAction),
  /** Optional so cards written by older feed clients continue to decode. */
  origin: Schema.NullOr(AgentDashboardFeedOrigin).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type AgentDashboardFeedCard = typeof AgentDashboardFeedCard.Type;

/** Durable intelligent-research finding migrated from Hermes. */
export const AgentDashboardResearchFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  timestamp: TrimmedNonEmptyString,
  abstract: Schema.NullOr(TrimmedNonEmptyString),
  authors: Schema.Array(TrimmedNonEmptyString),
  published: Schema.NullOr(TrimmedNonEmptyString),
  categories: Schema.Array(TrimmedNonEmptyString),
  relevanceScore: NonNegativeInt,
  topicContext: Schema.NullOr(TrimmedNonEmptyString),
  repositories: Schema.Array(TrimmedNonEmptyString),
  watchDir: Schema.NullOr(TrimmedNonEmptyString),
  sinceDays: Schema.NullOr(NonNegativeInt),
  pdfUrl: Schema.NullOr(TrimmedNonEmptyString),
  citationCount: Schema.NullOr(NonNegativeInt),
  occurrences: NonNegativeInt,
});
export type AgentDashboardResearchFinding = typeof AgentDashboardResearchFinding.Type;

export const AgentDashboardReviewSuggestionRepository = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  githubRepo: Schema.NullOr(TrimmedNonEmptyString),
});
export type AgentDashboardReviewSuggestionRepository =
  typeof AgentDashboardReviewSuggestionRepository.Type;

export const AgentDashboardReviewSuggestionIssue = Schema.Struct({
  title: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  number: Schema.NullOr(NonNegativeInt),
});
export type AgentDashboardReviewSuggestionIssue = typeof AgentDashboardReviewSuggestionIssue.Type;

/** Durable repository-review suggestion migrated from Hermes. */
export const AgentDashboardReviewSuggestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  profile: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "accepted", "dismissed", "blocked"]),
  createdAt: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(TrimmedNonEmptyString),
  repository: AgentDashboardReviewSuggestionRepository,
  category: TrimmedNonEmptyString,
  impact: TrimmedNonEmptyString,
  confidence: TrimmedNonEmptyString,
  evidence: Schema.Array(TrimmedNonEmptyString),
  nextStep: TrimmedNonEmptyString,
  report: TrimmedNonEmptyString,
  githubIssue: AgentDashboardReviewSuggestionIssue,
  jobId: Schema.NullOr(TrimmedNonEmptyString),
});
export type AgentDashboardReviewSuggestion = typeof AgentDashboardReviewSuggestion.Type;

export const AgentDashboardFeedCardIdInput = Schema.Struct({ id: NonNegativeInt });
export type AgentDashboardFeedCardIdInput = typeof AgentDashboardFeedCardIdInput.Type;

export const AgentDashboardReviewSuggestionAction = Schema.Literals(["dismiss", "block"]);
export type AgentDashboardReviewSuggestionAction = typeof AgentDashboardReviewSuggestionAction.Type;

export const AgentDashboardReviewSuggestionActionInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: AgentDashboardReviewSuggestionAction,
});
export type AgentDashboardReviewSuggestionActionInput =
  typeof AgentDashboardReviewSuggestionActionInput.Type;

export const AgentDashboardReviewSuggestionIdInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AgentDashboardReviewSuggestionIdInput =
  typeof AgentDashboardReviewSuggestionIdInput.Type;

export const AgentDashboardMutationResult = Schema.Struct({ ok: Schema.Boolean });
export type AgentDashboardMutationResult = typeof AgentDashboardMutationResult.Type;

/** A compact activity item; raw activity payloads stay in the thread read model. */
export const AgentDashboardFeedUpdate = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentDashboardFeedKind,
  status: AgentDashboardFeedStatus,
  summary: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
  repository: AgentDashboardRepositoryRef,
  thread: Schema.NullOr(AgentDashboardThreadRef),
  activityId: Schema.optional(EventId),
  activityKind: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.NullOr(TurnId),
});
export type AgentDashboardFeedUpdate = typeof AgentDashboardFeedUpdate.Type;

export const AgentDashboardResearchKind = Schema.Literals(["repository", "worktree"]);
export type AgentDashboardResearchKind = typeof AgentDashboardResearchKind.Type;

export const AgentDashboardResearchStatus = Schema.Literals([
  "clean",
  "dirty",
  "behind",
  "ahead",
  "diverged",
  "not-a-repository",
  "unavailable",
]);
export type AgentDashboardResearchStatus = typeof AgentDashboardResearchStatus.Type;

/** A repository/worktree observation derived from T3's known project and VCS state. */
export const AgentDashboardResearchRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentDashboardResearchKind,
  status: AgentDashboardResearchStatus,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  observedAt: IsoDateTime,
  repository: AgentDashboardRepositoryRef,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  threadCount: NonNegativeInt,
  activeThreadCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  latestThread: Schema.NullOr(AgentDashboardThreadRef).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type AgentDashboardResearchRecord = typeof AgentDashboardResearchRecord.Type;

export const AgentDashboardSuggestionKind = Schema.Literals([
  "review-changes",
  "sync-branch",
  "respond-to-thread",
  "review-plan",
  "inspect-error",
]);
export type AgentDashboardSuggestionKind = typeof AgentDashboardSuggestionKind.Type;

export const AgentDashboardSuggestionStatus = Schema.Literals(["actionable"]);
export type AgentDashboardSuggestionStatus = typeof AgentDashboardSuggestionStatus.Type;

export const AgentDashboardSuggestionAction = Schema.Literals(["open-repository", "open-thread"]);
export type AgentDashboardSuggestionAction = typeof AgentDashboardSuggestionAction.Type;

/** Runtime status for the T3-owned recurring repository review. */
export const AgentDashboardReviewScheduleStatus = Schema.Literals([
  "idle",
  "running",
  "completed",
  "failed",
]);
export type AgentDashboardReviewScheduleStatus = typeof AgentDashboardReviewScheduleStatus.Type;

export const AgentDashboardReviewSchedule = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  intervalMinutes: NonNegativeInt,
  nextRunAt: IsoDateTime,
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastCompletedAt: Schema.NullOr(IsoDateTime),
  lastStatus: AgentDashboardReviewScheduleStatus,
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  lastTarget: Schema.NullOr(TrimmedNonEmptyString),
  heartbeatAt: IsoDateTime,
  runCount: NonNegativeInt,
});
export type AgentDashboardReviewSchedule = typeof AgentDashboardReviewSchedule.Type;

/** Legacy native-navigation signal kept for wire compatibility; not Suggestions content. */
export const AgentDashboardSuggestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AgentDashboardSuggestionKind,
  status: AgentDashboardSuggestionStatus,
  action: AgentDashboardSuggestionAction,
  title: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  repository: AgentDashboardRepositoryRef,
  thread: Schema.NullOr(AgentDashboardThreadRef),
});
export type AgentDashboardSuggestion = typeof AgentDashboardSuggestion.Type;

export const AgentDashboardSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  observedAt: IsoDateTime,
  repositories: Schema.Array(AgentDashboardRepository),
  feed: Schema.Array(AgentDashboardFeedUpdate).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Cards owned by the migrated T3 feed store. */
  externalFeed: Schema.Array(AgentDashboardFeedCard).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  research: Schema.Array(AgentDashboardResearchRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Durable findings migrated from the former intelligent-research page. */
  researchFindings: Schema.Array(AgentDashboardResearchFinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Legacy native-navigation signals; Suggestions consumes reviewSuggestions instead. */
  suggestions: Schema.Array(AgentDashboardSuggestion).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Durable review suggestions migrated from the former Hermes page. */
  reviewSuggestions: Schema.Array(AgentDashboardReviewSuggestion).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Status of the T3-owned two-hour repository review scheduler. */
  reviewSchedule: Schema.optionalKey(AgentDashboardReviewSchedule),
});
export type AgentDashboardSnapshot = typeof AgentDashboardSnapshot.Type;

export class AgentDashboardError extends Schema.TaggedErrorClass<AgentDashboardError>()(
  "AgentDashboardError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

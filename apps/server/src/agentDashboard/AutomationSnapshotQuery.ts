/** Adapts v2 projections to the fork's stable automation/dashboard wire model. */
import {
  EventId,
  OrchestrationThread,
  OrchestrationThreadShell,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { EventStoreV2 } from "../orchestration-v2/EventStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";

export class AutomationQueryError extends Schema.TaggedError<AutomationQueryError>()(
  "AutomationQueryError",
  { cause: Schema.Defect() },
) {}
export type ProjectionActivitySummary = Pick<
  OrchestrationThreadActivity,
  "id" | "turnId" | "tone" | "kind" | "summary" | "createdAt"
> & { readonly threadId: ThreadId };
function iso(value: DateTime.Utc): string;
function iso(value: DateTime.Utc | null | undefined): string | null;
function iso(value: DateTime.Utc | null | undefined): string | null {
  return value == null ? null : DateTime.formatIso(value);
}

export function automationThreadShell(
  thread: OrchestrationV2ThreadShell,
): OrchestrationThreadShell {
  const active = ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status);
  const turnId = thread.latestRunId === null ? null : TurnId.make(thread.latestRunId);
  const state =
    thread.status === "failed"
      ? "error"
      : thread.status === "interrupted" || thread.status === "cancelled"
        ? "interrupted"
        : active
          ? "running"
          : "completed";
  return Schema.decodeSync(OrchestrationThreadShell)({
    ...thread,
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
    archivedAt: iso(thread.archivedAt),
    settledAt: iso(thread.settledAt),
    unsettledAt: iso(thread.unsettledAt),
    snoozedAt: iso(thread.snoozedAt),
    snoozedUntil: iso(thread.snoozedUntil),
    pinnedAt: iso(thread.pinnedAt),
    autoSettleDisabledAt: iso(thread.autoSettleDisabledAt),
    titleRegeneration:
      thread.titleRegeneration == null
        ? null
        : { ...thread.titleRegeneration, startedAt: iso(thread.titleRegeneration.startedAt) },
    latestUserMessageAt: iso(thread.latestUserMessageAt),
    latestTurn:
      turnId === null
        ? null
        : {
            turnId,
            state,
            requestedAt: iso(thread.latestRunRequestedAt) ?? iso(thread.createdAt),
            startedAt: iso(thread.latestRunStartedAt),
            completedAt: iso(thread.latestRunCompletedAt),
            assistantMessageId: null,
          },
    session: {
      threadId: thread.id,
      providerName: thread.modelSelection.instanceId,
      providerInstanceId: thread.providerInstanceId,
      runtimeMode: thread.runtimeMode,
      activeTurnId: thread.activeRunId === null ? null : TurnId.make(thread.activeRunId),
      status:
        thread.status === "failed"
          ? "error"
          : thread.status === "interrupted"
            ? "interrupted"
            : active
              ? "running"
              : "ready",
      lastError: thread.lastError ?? null,
      updatedAt: iso(thread.updatedAt),
    },
    hasPendingApprovals:
      thread.pendingRuntimeRequest != null &&
      thread.pendingRuntimeRequest.kind !== "user_input" &&
      thread.pendingRuntimeRequest.kind !== "auth_refresh",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    backgroundLiveness: (thread.pendingBackgroundTasks ?? []).length === 0 ? null : "working",
  });
}

export function automationActivities(
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems" | "runtimeRequests">,
): ReadonlyArray<OrchestrationThreadActivity> {
  const items = projection.turnItems.flatMap((item): Array<OrchestrationThreadActivity> => {
    if (["user_message", "assistant_message", "reasoning", "checkpoint"].includes(item.type))
      return [];
    const request =
      item.type === "approval_request" || item.type === "user_input_request"
        ? projection.runtimeRequests.find((request) => request.id === item.requestId)
        : undefined;
    const summary =
      item.type === "command_execution"
        ? item.input
        : item.type === "dynamic_tool"
          ? (item.toolName ?? item.title ?? "Provider tool")
          : item.type === "error"
            ? item.failure.message
            : (item.title ?? item.type.replaceAll("_", " "));
    return [
      {
        id: EventId.make(item.id),
        turnId: item.runId === null ? null : TurnId.make(item.runId),
        tone:
          item.status === "failed" ? "error" : request?.status === "pending" ? "approval" : "info",
        kind:
          item.type === "command_execution" || item.type === "dynamic_tool"
            ? `tool.${item.status === "completed" ? "completed" : item.status}`
            : `${item.type}.${request?.status ?? item.status}`,
        summary: summary.trim() || item.type.replaceAll("_", " "),
        payload: {
          ...item,
          ...(request === undefined ? {} : { request }),
          startedAt: iso(item.startedAt),
          completedAt: iso(item.completedAt),
          updatedAt: iso(item.updatedAt),
        },
        createdAt: iso(item.updatedAt),
      },
    ];
  });
  const requestIds = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "approval_request" || item.type === "user_input_request"
        ? [item.requestId]
        : [],
    ),
  );
  return [
    ...items,
    ...projection.runtimeRequests
      .filter((request) => !requestIds.has(request.id))
      .map((request): OrchestrationThreadActivity => ({
        id: EventId.make(request.id),
        turnId: null,
        tone: request.status === "pending" ? "approval" : "info",
        kind: `${request.kind}.${request.status === "pending" ? "requested" : request.status}`,
        summary: `Provider ${request.kind.replaceAll("_", " ")} ${request.status}`,
        payload: {
          ...request,
          createdAt: iso(request.createdAt),
          resolvedAt: iso(request.resolvedAt),
        },
        createdAt: iso(request.createdAt),
      })),
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function automationThreadDetail(
  shell: OrchestrationV2ThreadShell,
  projection: OrchestrationV2ThreadProjection,
): OrchestrationThread {
  return Schema.decodeSync(OrchestrationThread)({
    ...automationThreadShell(shell),
    deletedAt: iso(shell.deletedAt),
    messages: projection.messages.map((message) => ({
      ...message,
      turnId: message.runId === null ? null : TurnId.make(message.runId),
      createdAt: iso(message.createdAt),
      updatedAt: iso(message.updatedAt),
    })),
    proposedPlans: projection.plans
      .filter((plan) => plan.kind === "proposed_plan")
      .map((plan) => ({
        id: plan.id,
        turnId: plan.runId === null ? null : TurnId.make(plan.runId),
        planMarkdown: plan.kind === "proposed_plan" ? plan.markdown : "",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: iso(shell.createdAt),
        updatedAt: iso(shell.updatedAt),
      })),
    activities: automationActivities(projection),
    checkpoints: projection.checkpoints.map((checkpoint) => ({
      turnId: TurnId.make(checkpoint.runId ?? checkpoint.id),
      checkpointTurnCount: checkpoint.appRunOrdinal ?? checkpoint.ordinalWithinScope,
      checkpointRef: checkpoint.ref,
      status: checkpoint.status === "stale" ? "missing" : checkpoint.status,
      files: checkpoint.files,
      assistantMessageId: null,
      completedAt: iso(checkpoint.capturedAt),
    })),
  });
}

export interface AutomationSnapshotQueryShape {
  // Older automation fixtures may include unused query stubs.
  readonly [key: string]: unknown;
  readonly getShellSnapshot: (options?: {
    readonly unsettledOnly?: boolean;
  }) => Effect.Effect<OrchestrationShellSnapshot, AutomationQueryError>;
  readonly getThreadShellById: (
    id: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, AutomationQueryError>;
  readonly getThreadDetailById: (
    id: ThreadId,
    query?: { readonly activityKinds?: ReadonlyArray<string> },
  ) => Effect.Effect<Option.Option<OrchestrationThread>, AutomationQueryError>;
  readonly getProjectShellById: (
    id: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, AutomationQueryError>;
  readonly getActiveProjectByWorkspaceRoot: (
    root: string,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, AutomationQueryError>;
  readonly getRecentActivitySummaries?: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ProjectionActivitySummary>, AutomationQueryError>;
}
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  AutomationSnapshotQueryShape
>()("t3/agentDashboard/AutomationSnapshotQuery/ProjectionSnapshotQuery") {}
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const events = yield* EventStoreV2;
  const mapError = (cause: unknown) => new AutomationQueryError({ cause });
  const getShellSnapshot = (options?: { readonly unsettledOnly?: boolean }) =>
    Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      return {
        snapshotSequence: snapshot.snapshotSequence,
        projects: yield* projects.listShells(),
        threads: snapshot.threads
          .map(automationThreadShell)
          .filter((thread) => !options?.unsettledOnly || thread.settledOverride !== "settled"),
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
    }).pipe(Effect.mapError(mapError));
  return {
    getShellSnapshot,
    getThreadShellById: (id: ThreadId) =>
      threads.getThreadShell(id).pipe(
        Effect.map((shell) =>
          shell === null ? Option.none() : Option.some(automationThreadShell(shell)),
        ),
        Effect.mapError(mapError),
      ),
    getThreadDetailById: (
      id: ThreadId,
      query?: { readonly activityKinds?: ReadonlyArray<string> },
    ) =>
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(id);
        const projection = shell === null ? null : yield* threads.getThreadProjection(id);
        return shell === null || projection === null
          ? Option.none()
          : Option.some(
              (() => {
                const detail = automationThreadDetail(shell, projection);
                return query?.activityKinds === undefined
                  ? detail
                  : {
                      ...detail,
                      activities: detail.activities.filter((activity) =>
                        query.activityKinds!.includes(activity.kind),
                      ),
                    };
              })(),
            );
      }).pipe(Effect.mapError(mapError)),
    getProjectShellById: (id: ProjectId) => projects.getShell(id).pipe(Effect.mapError(mapError)),
    getActiveProjectByWorkspaceRoot: (root: string) =>
      Effect.gen(function* () {
        const project = yield* projects.findActiveByWorkspaceRoot(root);
        return Option.isNone(project)
          ? Option.none()
          : yield* projects.getShell(project.value.projectId);
      }).pipe(Effect.mapError(mapError)),
    getRecentActivitySummaries: (limit: number) =>
      Effect.gen(function* () {
        const snapshot = yield* getShellSnapshot();
        const count = Math.max(0, Math.min(500, Math.floor(limit)));
        if (count === 0) return [];
        // Bound the event window instead of loading every conversation's transcript.
        const sequence = yield* events.latestApplicationSequence;
        const recent = yield* events
          .read({
            afterSequence: Math.max(0, sequence - 2000),
            throughSequence: sequence,
            limit: 2000,
          })
          .pipe(Stream.runCollect);
        const byId = new Map<string, ProjectionActivitySummary>();
        const visibleThreads = new Set(snapshot.threads.map((thread) => thread.id));
        for (const { event } of recent) {
          if (!visibleThreads.has(event.threadId)) continue;
          const activities =
            event.type === "turn-item.updated"
              ? automationActivities({ turnItems: [event.payload], runtimeRequests: [] })
              : event.type === "runtime-request.updated"
                ? automationActivities({ turnItems: [], runtimeRequests: [event.payload] })
                : [];
          for (const activity of activities) {
            const { payload: _payload, ...summary } = activity;
            byId.set(activity.id, { ...summary, threadId: event.threadId });
          }
        }
        const runs = snapshot.threads
          .filter((thread) => thread.latestTurn !== null)
          .map((thread) => ({
            id: EventId.make(`${thread.id}:${thread.latestTurn!.turnId}`),
            threadId: thread.id,
            turnId: thread.latestTurn!.turnId,
            tone: thread.latestTurn!.state === "error" ? ("error" as const) : ("info" as const),
            kind: "run.status",
            summary: `${thread.title}: ${thread.latestTurn!.state}`,
            createdAt: thread.updatedAt,
          }));
        return [...byId.values(), ...runs]
          .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, count);
      }).pipe(Effect.mapError(mapError)),
  } satisfies AutomationSnapshotQueryShape;
});
export const layer = Layer.effect(ProjectionSnapshotQuery, make);

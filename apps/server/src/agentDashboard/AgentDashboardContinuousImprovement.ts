import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type {
  AgentDashboardAutomationRun,
  AgentDashboardAutomationRunTrigger,
  AgentDashboardFinding,
  AgentDashboardRepositoryPolicy,
  ContinuousImprovementSettings,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import * as AgentDashboardRunHistory from "./AgentDashboardRunHistory.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import {
  AgentDashboardImplementationRunner,
  AgentDashboardImplementationRunnerError,
  type AgentDashboardImplementationRunResult,
} from "./AgentDashboardImplementationRunner.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";

const POLL_INTERVAL = Duration.seconds(15);
const FAILURE_BACKOFF = Duration.minutes(5);
const IMPLEMENTATION_MONITOR_INTERVAL = Duration.seconds(10);
const IMPLEMENTATION_MONITOR_TIMEOUT = Duration.hours(6);
const IMPLEMENTATION_NUDGE_DELAYS = [
  Duration.minutes(10),
  Duration.minutes(20),
  Duration.minutes(40),
] as const;
const MAX_IMPLEMENTATION_NUDGES = IMPLEMENTATION_NUDGE_DELAYS.length;
const MAX_IMPLEMENTATION_RETRIES = 3;

export const CONTINUOUS_IMPROVEMENT_RUN_KIND = "continuous-improvement";

export class AgentDashboardContinuousImprovementError extends Schema.TaggedErrorClass<AgentDashboardContinuousImprovementError>()(
  "AgentDashboardContinuousImprovementError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isContinuousImprovementError = Schema.is(AgentDashboardContinuousImprovementError);
const isImplementationRunnerError = Schema.is(AgentDashboardImplementationRunnerError);

export interface AgentDashboardContinuousImprovementService {
  /** Runs one scheduler decision. Null means disabled, busy, or no eligible work. */
  readonly runOnce: Effect.Effect<
    AgentDashboardImplementationRunResult | null,
    AgentDashboardContinuousImprovementError
  >;
  readonly retryRun: (
    runId: string,
  ) => Effect.Effect<
    AgentDashboardImplementationRunResult | null,
    AgentDashboardContinuousImprovementError
  >;
}

export class AgentDashboardContinuousImprovement extends Context.Service<
  AgentDashboardContinuousImprovement,
  AgentDashboardContinuousImprovementService
>()("t3/agentDashboard/AgentDashboardContinuousImprovement") {}

const severityWeight: Readonly<Record<AgentDashboardFinding["severity"], number>> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const confidenceWeight: Readonly<Record<AgentDashboardFinding["confidence"], number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

const riskWeight = { low: 1, medium: 2, high: 3, critical: 4 } as const;

const modelLabel = (selection: ContinuousImprovementSettings["modelSelection"]): string => {
  const effort = selection.options?.find((option) => option.id === "reasoningEffort");
  return effort ? `${selection.model}/${String(effort.value)}` : selection.model;
};

export type ImplementationWatchdogDecision =
  | { readonly kind: "wait" }
  | { readonly kind: "nudge"; readonly attempt: number }
  | { readonly kind: "exhausted" };

export const evaluateImplementationWatchdog = (input: {
  readonly nowMs: number;
  readonly lastActivityAtMs: number;
  readonly lastNudgeAtMs: number | null;
  readonly nudgeCount: number;
}): ImplementationWatchdogDecision => {
  const cappedNudgeCount = Math.max(0, input.nudgeCount);
  const lastProgressAtMs = Math.max(
    input.lastActivityAtMs,
    input.lastNudgeAtMs ?? Number.NEGATIVE_INFINITY,
  );
  const delayIndex = Math.min(cappedNudgeCount, MAX_IMPLEMENTATION_NUDGES - 1);
  const delay = IMPLEMENTATION_NUDGE_DELAYS[delayIndex] ?? IMPLEMENTATION_NUDGE_DELAYS[0];
  const delayMs = Duration.toMillis(delay);
  if (input.nowMs - lastProgressAtMs < delayMs) return { kind: "wait" };
  if (cappedNudgeCount >= MAX_IMPLEMENTATION_NUDGES) return { kind: "exhausted" };
  return { kind: "nudge", attempt: cappedNudgeCount + 1 };
};

export const findImplementationPullRequest = <
  PullRequest extends { readonly headRefName: string },
>(input: {
  readonly pullRequests: ReadonlyArray<PullRequest>;
  readonly launchBranch: string;
  readonly currentBranch: string | null;
}): PullRequest | undefined =>
  (input.currentBranch
    ? input.pullRequests.find((candidate) => candidate.headRefName === input.currentBranch)
    : undefined) ??
  input.pullRequests.find((candidate) => candidate.headRefName === input.launchBranch);

export const createContinuousImprovementRun = (input: {
  readonly id: string;
  readonly finding: AgentDashboardFinding;
  readonly model: string;
  readonly createdAt: string;
  readonly trigger: AgentDashboardAutomationRunTrigger;
  readonly retryCount: number;
}): AgentDashboardAutomationRun => ({
  id: input.id,
  status: "queued",
  trigger: input.trigger,
  kind: CONTINUOUS_IMPROVEMENT_RUN_KIND,
  repository: input.finding.repository,
  target: input.finding.title,
  threadId: null,
  jobId: input.finding.id,
  model: input.model,
  retryCount: input.retryCount,
  findingCount: 1,
  costUnits: null,
  error: null,
  createdAt: input.createdAt,
  startedAt: null,
  updatedAt: input.createdAt,
  completedAt: null,
});

type ContinuousImprovementRunTransition =
  | {
      readonly state: "working";
      readonly result: AgentDashboardImplementationRunResult;
      readonly at: string;
    }
  | { readonly state: "pr-opened"; readonly at: string }
  | { readonly state: "needs-attention"; readonly error: string; readonly at: string }
  | { readonly state: "failed"; readonly error: string; readonly at: string }
  | { readonly state: "stopped"; readonly error: string | null; readonly at: string };

export const transitionContinuousImprovementRun = (
  run: AgentDashboardAutomationRun,
  transition: ContinuousImprovementRunTransition,
): AgentDashboardAutomationRun => {
  switch (transition.state) {
    case "working":
      return {
        ...run,
        status: "running",
        threadId: transition.result.threadId,
        target: transition.result.branch,
        error: null,
        startedAt: run.startedAt ?? transition.at,
        updatedAt: transition.at,
        completedAt: null,
      };
    case "pr-opened":
      return {
        ...run,
        status: "succeeded",
        error: null,
        updatedAt: transition.at,
        completedAt: transition.at,
      };
    case "needs-attention":
      return {
        ...run,
        status: "partial",
        error: transition.error,
        updatedAt: transition.at,
        completedAt: transition.at,
      };
    case "failed":
      return {
        ...run,
        status: "failed",
        error: transition.error,
        updatedAt: transition.at,
        completedAt: transition.at,
      };
    case "stopped":
      return {
        ...run,
        status: "cancelled",
        error: transition.error,
        updatedAt: transition.at,
        completedAt: transition.at,
      };
    default: {
      const exhaustive: never = transition;
      throw new Error(`Unhandled continuous improvement transition: ${String(exhaustive)}`);
    }
  }
};

export const isFindingEligibleForContinuousImprovement = (
  finding: AgentDashboardFinding,
  guardrails: Pick<ContinuousImprovementSettings, "maxRiskTier" | "minimumConfidence">,
): boolean =>
  finding.actionability?.readiness === "ready" &&
  riskWeight[finding.actionability.riskTier] <= riskWeight[guardrails.maxRiskTier] &&
  confidenceWeight[finding.confidence] >= confidenceWeight[guardrails.minimumConfidence];

export const selectContinuousImprovementFinding = (input: {
  readonly findings: ReadonlyArray<AgentDashboardFinding>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly policies: ReadonlyArray<AgentDashboardRepositoryPolicy>;
  readonly guardrails?: Pick<ContinuousImprovementSettings, "maxRiskTier" | "minimumConfidence">;
}): {
  readonly finding: AgentDashboardFinding;
  readonly project: OrchestrationProjectShell;
} | null => {
  const projects = new Map(input.projects.map((project) => [String(project.id), project]));
  const policies = new Map(
    input.policies.map((policy) => [String(policy.repository.projectId), policy]),
  );
  const guardrails = input.guardrails ?? {
    maxRiskTier: "medium",
    minimumConfidence: "medium",
  };
  return (
    input.findings
      .filter(
        (finding) =>
          finding.thread === null &&
          finding.disposition.state === "open" &&
          isFindingEligibleForContinuousImprovement(finding, guardrails) &&
          projects.has(String(finding.repository.projectId)) &&
          policies.get(String(finding.repository.projectId))?.enabled !== false,
      )
      .toSorted(
        (left, right) =>
          severityWeight[right.severity] - severityWeight[left.severity] ||
          confidenceWeight[right.confidence] - confidenceWeight[left.confidence] ||
          Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt) ||
          left.id.localeCompare(right.id),
      )
      .map((finding) => ({
        finding,
        project: projects.get(String(finding.repository.projectId))!,
      }))[0] ?? null
  );
};

export const hasActiveFindingImplementation = (
  findings: ReadonlyArray<AgentDashboardFinding>,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): boolean => {
  const threadsById = new Map(threads.map((thread) => [String(thread.id), thread]));
  return findings.some((finding) => {
    if (finding.thread === null) return false;
    const thread = threadsById.get(String(finding.thread.threadId));
    return (
      thread?.session?.status === "starting" ||
      thread?.session?.status === "running" ||
      thread?.latestTurn?.state === "running" ||
      thread?.backgroundLiveness != null
    );
  });
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const runner = yield* AgentDashboardImplementationRunner;
  const history = yield* AgentDashboardRunHistory.AgentDashboardRunHistory;
  const sourceControl = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const store = AgentDashboardStore.getStore(config.stateDir);
  const scope = yield* Effect.scope;
  const busy = yield* SynchronizedRef.make(false);
  const lastFailureAt = yield* Ref.make<number | null>(null);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const persistRun = (run: AgentDashboardAutomationRun) =>
    history.upsert(run).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDashboardContinuousImprovementError({
            operation: "persist implementation run",
            message: cause.message,
            cause,
          }),
      ),
    );

  const monitorImplementation = (input: {
    readonly run: AgentDashboardAutomationRun;
    readonly result: AgentDashboardImplementationRunResult;
    readonly project: OrchestrationProjectShell;
    readonly finding: AgentDashboardFinding;
    readonly automationSettings: ContinuousImprovementSettings;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      let nudgeCount = 0;
      let lastNudgeAtMs: number | null = null;
      let lastNudgedCompletedTurnId: string | null = null;
      const sendNudge = (reason: "stalled" | "missing-pull-request") =>
        Effect.gen(function* () {
          const attempt = nudgeCount + 1;
          const nudgeResult = yield* Effect.result(
            runner.nudgeFinding({
              finding: input.finding,
              result: input.result,
              modelSelection: input.automationSettings.modelSelection,
              runId: input.run.id,
              reason,
              attempt,
              maxAttempts: MAX_IMPLEMENTATION_NUDGES,
            }),
          );
          if (Result.isFailure(nudgeResult)) {
            const failedAt = yield* nowIso;
            yield* persistRun(
              transitionContinuousImprovementRun(input.run, {
                state: "needs-attention",
                error: `T3 could not send an automated progress check to the implementation agent: ${nudgeResult.failure.message}`,
                at: failedAt,
              }),
            );
            return false;
          }
          nudgeCount = attempt;
          lastNudgeAtMs = DateTime.toEpochMillis(yield* DateTime.now);
          yield* Effect.logInfo("Continuous Improvement Mode nudged an implementation agent", {
            runId: input.run.id,
            threadId: input.result.threadId,
            attempt,
            reason,
          });
          return true;
        });

      const maxPolls = Math.max(
        1,
        Math.ceil(
          Duration.toMillis(IMPLEMENTATION_MONITOR_TIMEOUT) /
            Duration.toMillis(IMPLEMENTATION_MONITOR_INTERVAL),
        ),
      );
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const shell = yield* projection.getShellSnapshot();
        const thread = shell.threads.find((candidate) => candidate.id === input.result.threadId);
        const turnState = thread?.latestTurn?.state ?? null;
        const hasBackgroundWork = thread?.backgroundLiveness != null;
        if (thread?.hasPendingApprovals === true || thread?.hasPendingUserInput === true) {
          const blockedAt = yield* nowIso;
          yield* persistRun(
            transitionContinuousImprovementRun(input.run, {
              state: "needs-attention",
              error:
                thread.hasPendingApprovals === true
                  ? "The implementation agent is waiting for approval. Open the work session to review the request."
                  : "The implementation agent is waiting for user input. Open the work session to answer it.",
              at: blockedAt,
            }),
          );
          return;
        }
        if (turnState === "completed" && !hasBackgroundWork) {
          const completedTurnId = String(thread?.latestTurn?.turnId ?? "");
          if (completedTurnId === lastNudgedCompletedTurnId) {
            const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
            const parsedThreadUpdatedAt = Date.parse(thread?.updatedAt ?? input.run.updatedAt);
            const parsedRunStartedAt = Date.parse(input.run.startedAt ?? input.run.createdAt);
            const decision = evaluateImplementationWatchdog({
              nowMs,
              lastActivityAtMs: Number.isFinite(parsedThreadUpdatedAt)
                ? parsedThreadUpdatedAt
                : parsedRunStartedAt,
              lastNudgeAtMs,
              nudgeCount,
            });
            if (decision.kind === "wait") {
              if (poll + 1 < maxPolls) yield* Effect.sleep(IMPLEMENTATION_MONITOR_INTERVAL);
              continue;
            }
            if (decision.kind === "exhausted") {
              const stalledAt = yield* nowIso;
              yield* persistRun(
                transitionContinuousImprovementRun(input.run, {
                  state: "needs-attention",
                  error: `The implementation agent did not resume after ${MAX_IMPLEMENTATION_NUDGES} automated progress checks. Open the work session to inspect its current state.`,
                  at: stalledAt,
                }),
              );
              return;
            }
          }
          const completedAt = yield* nowIso;
          const repository = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(
            input.project.repositoryIdentity?.locator.remoteUrl ?? null,
          );
          if (!repository) {
            yield* persistRun(
              transitionContinuousImprovementRun(input.run, {
                state: "needs-attention",
                error:
                  "The agent finished, but T3 could not verify a pull request because this project has no GitHub remote.",
                at: completedAt,
              }),
            );
            return;
          }
          const pullRequestExit = yield* Effect.exit(
            sourceControl.listProjectPullRequests({
              cwd: input.project.workspaceRoot,
              repository,
              limit: 100,
            }),
          );
          if (Exit.isFailure(pullRequestExit)) {
            yield* persistRun(
              transitionContinuousImprovementRun(input.run, {
                state: "needs-attention",
                error:
                  "The agent finished, but T3 could not verify whether its pull request was opened. Refresh the project pull requests and inspect the agent thread.",
                at: completedAt,
              }),
            );
            return;
          }
          const pullRequest = findImplementationPullRequest({
            pullRequests: pullRequestExit.value,
            launchBranch: input.result.branch,
            currentBranch: thread?.branch ?? null,
          });
          if (!pullRequest) {
            if (nudgeCount < MAX_IMPLEMENTATION_NUDGES) {
              const nudged = yield* sendNudge("missing-pull-request");
              if (!nudged) return;
              lastNudgedCompletedTurnId = completedTurnId;
              if (poll + 1 < maxPolls) yield* Effect.sleep(IMPLEMENTATION_MONITOR_INTERVAL);
              continue;
            }
            yield* persistRun(
              transitionContinuousImprovementRun(input.run, {
                state: "needs-attention",
                error: `The agent finished without opening a pull request from ${input.result.branch} after ${MAX_IMPLEMENTATION_NUDGES} automated progress checks. Open the work session to review the result or retry it.`,
                at: completedAt,
              }),
            );
            return;
          }
          if (!pullRequest.isDraft) {
            if (nudgeCount < MAX_IMPLEMENTATION_NUDGES) {
              const nudged = yield* sendNudge("pull-request-not-draft");
              if (!nudged) return;
              lastNudgedCompletedTurnId = completedTurnId;
              if (poll + 1 < maxPolls) yield* Effect.sleep(IMPLEMENTATION_MONITOR_INTERVAL);
              continue;
            }
            yield* persistRun(
              transitionContinuousImprovementRun(input.run, {
                state: "needs-attention",
                error: `The agent opened pull request #${pullRequest.number} as ready for review and did not convert it to draft after ${MAX_IMPLEMENTATION_NUDGES} automated progress checks. Open the work session or pull request to review it.`,
                at: completedAt,
              }),
            );
            return;
          }
          yield* persistRun(
            transitionContinuousImprovementRun(input.run, {
              state: "pr-opened",
              at: completedAt,
            }),
          );
          yield* store
            .appendExternalAction({
              id: `action:continuous-improvement-pr:${yield* crypto.randomUUIDv4}`,
              kind: "other",
              status: "succeeded",
              actor: "continuous-improvement",
              targetId: String(pullRequest.number),
              targetUrl: pullRequest.url,
              findingId: input.finding.id,
              runId: input.run.id,
              result: `Pull request #${pullRequest.number} opened from ${pullRequest.headRefName} into ${pullRequest.baseRefName}.`,
              occurredAt: completedAt,
            })
            .pipe(Effect.ignore);
          yield* runner
            .settleCompletedFinding({
              finding: input.finding,
              result: { ...input.result, branch: pullRequest.headRefName },
              runId: input.run.id,
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logWarning(
                  "Continuous improvement could not stop the completed implementation session",
                  {
                    findingId: input.finding.id,
                    threadId: input.result.threadId,
                    cause,
                  },
                ),
              ),
              Effect.ignore,
            );
          return;
        }
        if (turnState === "error" && !hasBackgroundWork) {
          const failedAt = yield* nowIso;
          yield* persistRun(
            transitionContinuousImprovementRun(input.run, {
              state: "failed",
              error:
                "The implementation agent ended with an error. Open the work session to inspect the failing turn, then retry when ready.",
              at: failedAt,
            }),
          );
          return;
        }
        if (turnState === "interrupted" && !hasBackgroundWork) {
          const stoppedAt = yield* nowIso;
          yield* persistRun(
            transitionContinuousImprovementRun(input.run, {
              state: "stopped",
              error: "The implementation agent was interrupted before it opened a pull request.",
              at: stoppedAt,
            }),
          );
          return;
        }
        const implementationIsActive =
          turnState === "running" ||
          thread?.session?.status === "starting" ||
          thread?.session?.status === "running" ||
          hasBackgroundWork;
        if (thread && implementationIsActive) {
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const parsedThreadUpdatedAt = Date.parse(thread.updatedAt);
          const parsedRunStartedAt = Date.parse(input.run.startedAt ?? input.run.createdAt);
          const decision = evaluateImplementationWatchdog({
            nowMs,
            lastActivityAtMs: Number.isFinite(parsedThreadUpdatedAt)
              ? parsedThreadUpdatedAt
              : parsedRunStartedAt,
            lastNudgeAtMs,
            nudgeCount,
          });
          if (decision.kind === "nudge") {
            const nudged = yield* sendNudge("stalled");
            if (!nudged) return;
          } else if (decision.kind === "exhausted") {
            const stalledAt = yield* nowIso;
            yield* persistRun(
              transitionContinuousImprovementRun(input.run, {
                state: "needs-attention",
                error: `The implementation agent remained inactive after ${MAX_IMPLEMENTATION_NUDGES} automated progress checks. Open the work session to inspect its current state.`,
                at: stalledAt,
              }),
            );
            return;
          }
        }
        if (poll + 1 < maxPolls) yield* Effect.sleep(IMPLEMENTATION_MONITOR_INTERVAL);
      }

      const timedOutAt = yield* nowIso;
      yield* persistRun(
        transitionContinuousImprovementRun(input.run, {
          state: "needs-attention",
          error:
            "T3 stopped monitoring this implementation after six hours. Open the work session to inspect its current state.",
          at: timedOutAt,
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Continuous Improvement Mode could not update run history", {
          runId: input.run.id,
          threadId: input.result.threadId,
          cause,
        }),
      ),
    );

  const launchSelection = (input: {
    readonly finding: AgentDashboardFinding;
    readonly project: OrchestrationProjectShell;
    readonly automationSettings: ContinuousImprovementSettings;
    readonly trigger: AgentDashboardAutomationRunTrigger;
    readonly retryCount: number;
  }) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const queued = createContinuousImprovementRun({
        id: `implementation:${yield* crypto.randomUUIDv4}`,
        finding: input.finding,
        model: modelLabel(input.automationSettings.modelSelection),
        createdAt,
        trigger: input.trigger,
        retryCount: input.retryCount,
      });
      yield* persistRun(queued);
      const launchResult = yield* Effect.result(
        runner.runFinding({
          finding: input.finding,
          project: input.project,
          modelSelection: input.automationSettings.modelSelection,
        }),
      );
      if (Result.isFailure(launchResult)) {
        const error = launchResult.failure;
        const failedAt = yield* nowIso;
        yield* persistRun(
          transitionContinuousImprovementRun(queued, {
            state: "failed",
            error: error.message,
            at: failedAt,
          }),
        );
        return yield* error;
      }
      if (launchResult.success === null) {
        const stoppedAt = yield* nowIso;
        yield* persistRun(
          transitionContinuousImprovementRun(queued, {
            state: "stopped",
            error: "The finding was claimed by another session before this run could start.",
            at: stoppedAt,
          }),
        );
        return null;
      }
      const startedAt = yield* nowIso;
      const working = transitionContinuousImprovementRun(queued, {
        state: "working",
        result: launchResult.success,
        at: startedAt,
      });
      yield* persistRun(working);
      yield* monitorImplementation({
        run: working,
        result: launchResult.success,
        project: input.project,
        finding: input.finding,
        automationSettings: input.automationSettings,
      }).pipe(Effect.forkIn(scope));
      return launchResult.success;
    });

  const mapLaunchError = (cause: unknown): AgentDashboardContinuousImprovementError => {
    if (isContinuousImprovementError(cause)) return cause;
    if (isImplementationRunnerError(cause)) {
      return new AgentDashboardContinuousImprovementError({
        operation: cause.operation,
        message: cause.message,
        cause,
      });
    }
    return new AgentDashboardContinuousImprovementError({
      operation: "launch implementation",
      message: "Continuous implementation failed to start.",
      cause,
    });
  };

  const runOnce: AgentDashboardContinuousImprovementService["runOnce"] = Effect.gen(function* () {
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new AgentDashboardContinuousImprovementError({
            operation: "read settings",
            message: "Continuous Improvement Mode could not read its settings.",
            cause,
          }),
      ),
    );
    if (!currentSettings.continuousImprovement.enabled) return null;

    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const failedAt = yield* Ref.get(lastFailureAt);
    if (failedAt !== null && nowMs - failedAt < Duration.toMillis(FAILURE_BACKOFF)) return null;

    const claimedScheduler = yield* SynchronizedRef.modify(busy, (isBusy) =>
      isBusy ? ([false, true] as const) : ([true, true] as const),
    );
    if (!claimedScheduler) return null;

    return yield* Effect.gen(function* () {
      const [findings, policies, shell] = yield* Effect.all({
        findings: store.readFindings,
        policies: store.readRepositoryPolicies,
        shell: projection.getShellSnapshot(),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardContinuousImprovementError({
              operation: "select finding",
              message: "Continuous Improvement Mode could not load pending findings.",
              cause,
            }),
        ),
        Effect.map(({ findings, policies, shell }) => [findings, policies, shell] as const),
      );
      if (hasActiveFindingImplementation(findings, shell.threads)) return null;

      const selected = selectContinuousImprovementFinding({
        findings,
        projects: shell.projects,
        policies,
        guardrails: currentSettings.continuousImprovement,
      });
      if (!selected) return null;

      const stable = yield* Effect.tryPromise({
        try: () => AgentDashboardStore.isStableRepositoryPath(selected.project.workspaceRoot),
        catch: (cause) =>
          new AgentDashboardContinuousImprovementError({
            operation: "validate repository",
            message: `Continuous Improvement Mode could not validate ${selected.project.title}.`,
            cause,
          }),
      });
      if (!stable) return null;

      return yield* launchSelection({
        ...selected,
        automationSettings: currentSettings.continuousImprovement,
        trigger: "scheduled",
        retryCount: 0,
      }).pipe(Effect.mapError(mapLaunchError));
    }).pipe(
      Effect.tap(() => Ref.set(lastFailureAt, null)),
      Effect.tapError(() => Ref.set(lastFailureAt, nowMs)),
      Effect.ensuring(SynchronizedRef.set(busy, false)),
    );
  });

  const retryRun: AgentDashboardContinuousImprovementService["retryRun"] = (runId) =>
    Effect.gen(function* () {
      const existing = yield* history.get(runId).pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardContinuousImprovementError({
              operation: "load implementation run",
              message: cause.message,
              cause,
            }),
        ),
      );
      if (existing === null || existing.kind !== CONTINUOUS_IMPROVEMENT_RUN_KIND) {
        return yield* new AgentDashboardContinuousImprovementError({
          operation: "retry implementation",
          message: "That Continuous Improvement run was not found.",
        });
      }
      if (
        existing.status === "queued" ||
        existing.status === "running" ||
        existing.status === "ingesting"
      ) {
        return yield* new AgentDashboardContinuousImprovementError({
          operation: "retry implementation",
          message: "That implementation is still in progress.",
        });
      }
      if (existing.retryCount >= MAX_IMPLEMENTATION_RETRIES) {
        return yield* new AgentDashboardContinuousImprovementError({
          operation: "retry implementation",
          message: `Continuous Improvement retry limit (${MAX_IMPLEMENTATION_RETRIES}) reached.`,
        });
      }
      if (existing.jobId === null) {
        return yield* new AgentDashboardContinuousImprovementError({
          operation: "retry implementation",
          message: "That run no longer has a finding to retry.",
        });
      }

      const currentSettings = yield* settings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardContinuousImprovementError({
              operation: "read settings",
              message: "Continuous Improvement Mode could not read its settings.",
              cause,
            }),
        ),
      );
      const [findings, shell] = yield* Effect.all([
        store.readFindings,
        projection.getShellSnapshot(),
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardContinuousImprovementError({
              operation: "load retry target",
              message: "T3 could not load the finding for this retry.",
              cause,
            }),
        ),
      );
      const finding = findings.find((candidate) => candidate.id === existing.jobId) ?? null;
      const project = shell.projects.find(
        (candidate) => candidate.id === existing.repository.projectId,
      );
      if (finding === null || project === undefined) {
        return yield* new AgentDashboardContinuousImprovementError({
          operation: "retry implementation",
          message: "The finding or repository for that run is no longer available.",
        });
      }
      if (
        !isFindingEligibleForContinuousImprovement(finding, currentSettings.continuousImprovement)
      ) {
        return yield* new AgentDashboardContinuousImprovementError({
          operation: "retry implementation",
          message: "That finding is no longer inside the configured automation guardrails.",
        });
      }
      const stable = yield* Effect.tryPromise({
        try: () => AgentDashboardStore.isStableRepositoryPath(project.workspaceRoot),
        catch: (cause) =>
          new AgentDashboardContinuousImprovementError({
            operation: "validate repository",
            message: `Continuous Improvement Mode could not validate ${project.title}.`,
            cause,
          }),
      });
      if (!stable) {
        return yield* new AgentDashboardContinuousImprovementError({
          operation: "validate repository",
          message: `${project.title} is not a stable local repository path.`,
        });
      }

      const claimedScheduler = yield* SynchronizedRef.modify(busy, (isBusy) =>
        isBusy ? ([false, true] as const) : ([true, true] as const),
      );
      if (!claimedScheduler) {
        return yield* new AgentDashboardContinuousImprovementError({
          operation: "retry implementation",
          message: "Another Continuous Improvement launch is already starting.",
        });
      }
      return yield* Effect.gen(function* () {
        if (finding.thread !== null) {
          const linkedThread = shell.threads.find(
            (candidate) => candidate.id === finding.thread?.threadId,
          );
          if (
            linkedThread?.latestTurn?.state === "running" ||
            linkedThread?.session?.status === "starting" ||
            linkedThread?.session?.status === "running"
          ) {
            return yield* new AgentDashboardContinuousImprovementError({
              operation: "retry implementation",
              message: "The linked implementation agent is still working.",
            });
          }
          yield* store
            .releaseFindingThread({
              id: finding.id,
              projectId: finding.thread.projectId,
              threadId: finding.thread.threadId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AgentDashboardContinuousImprovementError({
                    operation: "release previous implementation",
                    message: "T3 could not release the previous implementation session.",
                    cause,
                  }),
              ),
            );
        }
        return yield* launchSelection({
          finding,
          project,
          automationSettings: currentSettings.continuousImprovement,
          trigger: "retry",
          retryCount: existing.retryCount + 1,
        }).pipe(Effect.mapError(mapLaunchError));
      }).pipe(Effect.ensuring(SynchronizedRef.set(busy, false)));
    });

  const tick = runOnce.pipe(
    Effect.tap((result) =>
      result
        ? Effect.logInfo("Continuous Improvement Mode started an implementation agent", {
            findingId: result.findingId,
            threadId: result.threadId,
            baseBranch: result.baseBranch,
          })
        : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logError("Continuous Improvement Mode scheduler tick failed", { cause }),
    ),
    Effect.asVoid,
  );
  yield* Effect.forkScoped(
    startup.awaitCommandReady.pipe(
      Effect.andThen(tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)))),
      Effect.catchCause((cause) =>
        Effect.logError("Continuous Improvement Mode could not reach command readiness", {
          cause,
        }),
      ),
    ),
  );

  return { runOnce, retryRun } satisfies AgentDashboardContinuousImprovementService;
});

export const layer = Layer.effect(AgentDashboardContinuousImprovement, make);

export const __testing = {
  POLL_INTERVAL,
  FAILURE_BACKOFF,
  IMPLEMENTATION_MONITOR_INTERVAL,
  IMPLEMENTATION_MONITOR_TIMEOUT,
  IMPLEMENTATION_NUDGE_DELAYS,
  MAX_IMPLEMENTATION_NUDGES,
  MAX_IMPLEMENTATION_RETRIES,
};

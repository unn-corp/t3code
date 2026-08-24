// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type {
  AgentDashboardAutomationRun,
  AgentDashboardAutomationRunStatus,
  AgentDashboardAutomationRunTrigger,
  ModelSelection,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";

import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import * as AgentDashboardRunHistory from "./AgentDashboardRunHistory.ts";
import {
  AgentDashboardReviewRunner,
  type AgentDashboardReviewRunResult,
  type AgentDashboardReviewRunnerError,
  REVIEW_KIND,
} from "./AgentDashboardReviewRunner.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Server-scoped concurrency for repository reviews. */
export const MAX_CONCURRENT_REVIEW_RUNS = 1;
/** Max automatic retries for a failed review lineage. */
export const MAX_REVIEW_RETRIES = 2;
/** Poll interval while waiting for the review turn to settle. TestClock-friendly. */
export const MONITOR_POLL_INTERVAL = Duration.seconds(1);
/** Wall-clock budget for turn completion + ingestion. */
export const MONITOR_TIMEOUT = Duration.minutes(30);
export const REVIEW_IDEMPOTENCY_KIND = "repository-review";

/** Test-only override so monitor timeouts can be driven with a small TestClock jump. */
let monitorTimeoutOverride: Duration.Duration | null = null;
const activeMonitorTimeout = (): Duration.Duration => monitorTimeoutOverride ?? MONITOR_TIMEOUT;

export class AgentDashboardReviewJobServiceError extends Schema.TaggedErrorClass<AgentDashboardReviewJobServiceError>()(
  "AgentDashboardReviewJobServiceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface EnqueueReviewInput {
  readonly trigger: AgentDashboardAutomationRunTrigger;
  /** When set, review that project; otherwise select one stable project. */
  readonly projectId?: ProjectId | null | undefined;
  /** Optional human target label (branch/path). Defaults to project title after dispatch. */
  readonly target?: string | null | undefined;
  /**
   * When provided, an in-flight run with the same key is returned instead of
   * creating a second job (manual double-click, overlapping schedule ticks).
   */
  readonly idempotencyKey?: string | null | undefined;
  /** Parent run for retry lineage. */
  readonly parentRunId?: string | null | undefined;
  readonly retryCount?: number | undefined;
}

export interface AgentDashboardReviewJobServiceService {
  readonly listRuns: Effect.Effect<ReadonlyArray<AgentDashboardAutomationRun>>;
  readonly enqueueReview: (
    input: EnqueueReviewInput,
  ) => Effect.Effect<
    AgentDashboardAutomationRun,
    AgentDashboardReviewJobServiceError | AgentDashboardReviewRunnerError
  >;
  readonly retryRun: (
    runId: string,
  ) => Effect.Effect<
    AgentDashboardAutomationRun,
    AgentDashboardReviewJobServiceError | AgentDashboardReviewRunnerError
  >;
}

export class AgentDashboardReviewJobService extends Context.Service<
  AgentDashboardReviewJobService,
  AgentDashboardReviewJobServiceService
>()("t3/agentDashboard/AgentDashboardReviewJobService") {}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const stringValue = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const stringList = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value
        .map(stringValue)
        .filter((item): item is string => item !== null)
        .slice(0, 24)
    : [];

const riskTier = (value: unknown): "low" | "medium" | "high" | "critical" => {
  const candidate = stringValue(value);
  return candidate === "low" || candidate === "high" || candidate === "critical"
    ? candidate
    : "medium";
};

const estimatedEffort = (value: unknown): "small" | "medium" | "large" => {
  const candidate = stringValue(value);
  return candidate === "small" || candidate === "large" ? candidate : "medium";
};

const findingTargets = (
  value: unknown,
): Array<{ path: string; symbol: string | null; evidence: string }> =>
  Array.isArray(value)
    ? value
        .map(asObject)
        .filter((target): target is JsonObject => target !== null)
        .map((target) => ({
          path: stringValue(target.path),
          symbol: stringValue(target.symbol),
          evidence: stringValue(target.evidence),
        }))
        .filter(
          (target): target is { path: string; symbol: string | null; evidence: string } =>
            target.path !== null && target.evidence !== null,
        )
        .slice(0, 24)
    : [];

const findingSources = (value: unknown): Array<{ title: string; url: string; kind: string }> =>
  Array.isArray(value)
    ? value
        .map(asObject)
        .filter((source): source is JsonObject => source !== null)
        .map((source) => ({
          title: stringValue(source.title),
          url: stringValue(source.url),
          kind: stringValue(source.kind),
        }))
        .filter(
          (source): source is { title: string; url: string; kind: string } =>
            source.title !== null && source.url !== null && source.kind !== null,
        )
        .slice(0, 24)
    : [];

export type ParsedReviewMetadata =
  | { readonly kind: "missing" }
  | { readonly kind: "silent" }
  | { readonly kind: "parse-failure"; readonly message: string }
  | {
      readonly kind: "parsed";
      readonly findings: ReadonlyArray<AgentDashboardStore.AgentDashboardReviewFindingInput>;
      readonly qualifications: ReadonlyArray<AgentDashboardStore.AgentDashboardFindingQualificationInput>;
    };

const parseQualification = (
  value: unknown,
): AgentDashboardStore.AgentDashboardFindingQualificationInput | null => {
  const qualification = asObject(value);
  const id = stringValue(qualification?.finding_id);
  const outcome = stringValue(qualification?.outcome);
  const reason = stringValue(qualification?.reason);
  if (!id || !reason) return null;
  if (outcome === "dismiss") return { id, outcome, reason };
  if (outcome !== "ready" && outcome !== "needs-research") return null;

  const proposal = stringValue(qualification?.proposal);
  const expectedValue = stringValue(qualification?.expected_value);
  if (!proposal || !expectedValue) return null;
  return {
    id,
    outcome,
    proposal,
    expectedValue,
    targets: findingTargets(qualification?.targets),
    validationPlan: stringList(qualification?.validation_plan),
    sources: findingSources(qualification?.sources),
    riskTier: riskTier(qualification?.automation_risk),
    estimatedEffort: estimatedEffort(qualification?.estimated_effort),
    reason,
  };
};

/** Parse the machine-readable review line from an assistant message. */
export const parseReviewMetadata = (text: string): ParsedReviewMetadata => {
  const trimmed = text.trim();
  if (trimmed === "[SILENT]") return { kind: "silent" };

  const metadataLine = text
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith("T3_REVIEW_METADATA:"));
  if (!metadataLine) return { kind: "missing" };

  try {
    const parsed = JSON.parse(
      metadataLine.slice(
        metadataLine.indexOf("T3_REVIEW_METADATA:") + "T3_REVIEW_METADATA:".length,
      ),
    );
    const rawFindings = asObject(parsed)?.findings;
    const rawQualifications = asObject(parsed)?.qualifications;
    if (!Array.isArray(rawFindings)) {
      return {
        kind: "parsed",
        findings: [],
        qualifications: Array.isArray(rawQualifications)
          ? rawQualifications.map(parseQualification).filter((item) => item !== null)
          : [],
      };
    }
    const findings = rawFindings
      .map(asObject)
      .filter((finding): finding is JsonObject => finding !== null)
      .slice(0, 6)
      .map((finding) => {
        const title = stringValue(finding.title) ?? "";
        const summary = stringValue(finding.summary) ?? title;
        const markdown = stringValue(finding.markdown);
        const rawType = stringValue(finding.type);
        const type =
          rawType === "bug" ||
          rawType === "security" ||
          rawType === "research" ||
          rawType === "improvement" ||
          rawType === "operations"
            ? rawType
            : "review";
        return {
          title,
          type,
          category: stringValue(finding.category) ?? "insight",
          summary,
          impact: stringValue(finding.impact) ?? "",
          confidence: stringValue(finding.confidence) ?? "medium",
          evidence: stringList(finding.evidence),
          nextStep: stringValue(finding.next_step) ?? "",
          targets: findingTargets(finding.targets),
          validationPlan: stringList(finding.validation_plan),
          sources: findingSources(finding.sources),
          automationRisk: riskTier(finding.automation_risk),
          estimatedEffort: estimatedEffort(finding.estimated_effort),
          qualificationReason: stringValue(finding.qualification_reason),
          githubIssueTitle: stringValue(finding.github_issue_title) ?? title,
          githubIssueBody: stringValue(finding.github_issue_body) ?? markdown ?? summary,
          ...(markdown ? { markdown } : {}),
        } satisfies AgentDashboardStore.AgentDashboardReviewFindingInput;
      })
      .filter((finding) => finding.title.length > 0);
    const qualifications = Array.isArray(rawQualifications)
      ? rawQualifications.map(parseQualification).filter((item) => item !== null)
      : [];
    return { kind: "parsed", findings, qualifications };
  } catch (cause) {
    return {
      kind: "parse-failure",
      message: cause instanceof Error ? cause.message : "Review metadata JSON could not be parsed.",
    };
  }
};

export interface TerminalDecisionInput {
  readonly timedOut: boolean;
  readonly hasAssistantMessage: boolean;
  readonly assistantText: string | null;
  readonly persistedFindingCount: number | null;
}

export interface TerminalDecision {
  readonly status: Extract<AgentDashboardAutomationRunStatus, "succeeded" | "partial" | "failed">;
  readonly findingCount: number;
  readonly error: string | null;
  readonly findings: ReadonlyArray<AgentDashboardStore.AgentDashboardReviewFindingInput>;
  readonly qualifications: ReadonlyArray<AgentDashboardStore.AgentDashboardFindingQualificationInput>;
  readonly shouldPersistFindings: boolean;
  readonly shouldPersistQualifications: boolean;
}

/**
 * Truthful terminal status from monitor outcome. Success is only selected when
 * structured findings are available to persist (callers set succeeded only after
 * the store write returns a positive count).
 */
export const decideTerminalOutcome = (input: TerminalDecisionInput): TerminalDecision => {
  if (input.timedOut) {
    return {
      status: "failed",
      findingCount: 0,
      error: "Repository review timed out before the agent finished.",
      findings: [],
      qualifications: [],
      shouldPersistFindings: false,
      shouldPersistQualifications: false,
    };
  }
  if (!input.hasAssistantMessage || input.assistantText === null) {
    return {
      status: "failed",
      findingCount: 0,
      error: "Repository review finished without assistant output.",
      findings: [],
      qualifications: [],
      shouldPersistFindings: false,
      shouldPersistQualifications: false,
    };
  }

  const parsed = parseReviewMetadata(input.assistantText);
  switch (parsed.kind) {
    case "missing":
      return {
        status: "failed",
        findingCount: 0,
        error: "Repository review output was missing structured findings metadata.",
        findings: [],
        qualifications: [],
        shouldPersistFindings: false,
        shouldPersistQualifications: false,
      };
    case "silent":
      return {
        status: "partial",
        findingCount: 0,
        error: "Repository review completed with [SILENT] (nothing new to report).",
        findings: [],
        qualifications: [],
        shouldPersistFindings: false,
        shouldPersistQualifications: false,
      };
    case "parse-failure":
      return {
        status: "failed",
        findingCount: 0,
        error: `Repository review metadata parse failure: ${parsed.message}`,
        findings: [],
        qualifications: [],
        shouldPersistFindings: false,
        shouldPersistQualifications: false,
      };
    case "parsed":
      if (parsed.findings.length === 0 && parsed.qualifications.length === 0) {
        return {
          status: "partial",
          findingCount: 0,
          error: "Repository review completed with zero usable findings or qualifications.",
          findings: [],
          qualifications: [],
          shouldPersistFindings: false,
          shouldPersistQualifications: false,
        };
      }
      // Callers mark succeeded only after appendReviewSuggestions persists > 0.
      return {
        status: "succeeded",
        findingCount: parsed.findings.length + parsed.qualifications.length,
        error: null,
        findings: parsed.findings,
        qualifications: parsed.qualifications,
        shouldPersistFindings: parsed.findings.length > 0,
        shouldPersistQualifications: parsed.qualifications.length > 0,
      };
  }
};

const isActiveStatus = (status: AgentDashboardAutomationRunStatus): boolean =>
  status === "queued" || status === "running" || status === "ingesting";

const activeCount = (runs: ReadonlyArray<AgentDashboardAutomationRun>): number =>
  runs.filter((run) => isActiveStatus(run.status)).length;

const findIdempotentMatch = (
  runs: ReadonlyArray<AgentDashboardAutomationRun>,
  idempotencyKey: string,
): AgentDashboardAutomationRun | null =>
  runs.find(
    (run) => isActiveStatus(run.status) && run.kind === REVIEW_KIND && run.jobId === idempotencyKey,
  ) ?? null;

const modelLabel = (selection: ModelSelection): string => {
  const effort = selection.options?.find((option) => option.id === "reasoningEffort");
  return effort ? `${selection.model}/${String(effort.value)}` : selection.model;
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* AgentDashboardReviewRunner;
  const history = yield* AgentDashboardRunHistory.AgentDashboardRunHistory;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const dashboardStore = AgentDashboardStore.getStore(config.stateDir);
  const scope = yield* Effect.scope;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // In-memory mirror for concurrency decisions without thrashing disk on every claim.
  const runsRef = yield* Ref.make<ReadonlyArray<AgentDashboardAutomationRun>>([]);
  const workerSlots = yield* Ref.make(0);
  // Coverage writes are best-effort so disk latency cannot stall lifecycle
  // transitions, but they remain ordered so an older heartbeat cannot overwrite
  // a newer terminal result.
  const coverageTail = yield* Ref.make<Effect.Effect<void>>(Effect.void);

  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new AgentDashboardReviewJobServiceError({
          operation: "generate identifier",
          message: "T3 could not generate an identifier for the review job.",
          cause,
        }),
    ),
  );

  const persist = (run: AgentDashboardAutomationRun) =>
    history.upsert(run).pipe(
      Effect.tap((saved) =>
        Ref.update(runsRef, (runs) => {
          const without = runs.filter((item) => item.id !== saved.id);
          return [saved, ...without];
        }),
      ),
      Effect.tap((saved) =>
        Ref.modify(coverageTail, (previous) => {
          const next = previous.pipe(
            Effect.flatMap(() =>
              dashboardStore.recordAutomationRun(saved).pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("T3 repository review coverage persistence failed", {
                    runId: saved.id,
                    cause,
                  }),
                ),
                Effect.orElseSucceed(() => undefined),
              ),
            ),
            Effect.asVoid,
          );
          return [next, next] as const;
        }).pipe(Effect.flatMap((next) => next.pipe(Effect.forkIn(scope), Effect.asVoid))),
      ),
      Effect.mapError(
        (cause) =>
          new AgentDashboardReviewJobServiceError({
            operation: "persist run",
            message: cause.message,
            cause,
          }),
      ),
    );

  const loadInitial = yield* history.list.pipe(
    Effect.mapError(
      (cause) =>
        new AgentDashboardReviewJobServiceError({
          operation: "load run history",
          message: cause.message,
          cause,
        }),
    ),
  );
  const recoveredAt = yield* nowIso;
  const recovered = AgentDashboardRunHistory.recoverInterruptedRuns(loadInitial, recoveredAt);
  if (recovered.some((run, index) => run.status !== loadInitial[index]?.status)) {
    yield* history.replaceAll(recovered).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDashboardReviewJobServiceError({
            operation: "recover run history",
            message: cause.message,
            cause,
          }),
      ),
    );
  }
  yield* Ref.set(runsRef, recovered);
  if (
    recovered.length !== loadInitial.length ||
    recovered.some((run, index) => run.status !== loadInitial[index]?.status)
  ) {
    yield* Effect.forEach(
      recovered.filter((run, index) => run.status !== loadInitial[index]?.status),
      (run) => dashboardStore.recordAutomationRun(run).pipe(Effect.orElseSucceed(() => undefined)),
      { concurrency: 1, discard: true },
    );
  }

  // Older builds created repository reviews as ordinary visible chats. Hide
  // every durable review session on startup so historical research does not
  // leak back into the sidebar after an upgrade.
  if (runner.hideReviewThread) {
    yield* Effect.forEach(
      recovered.flatMap((run) =>
        run.kind === REVIEW_KIND && run.threadId !== null ? [run.threadId] : [],
      ),
      (threadId) =>
        runner.hideReviewThread?.(threadId).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("T3 could not hide a historical repository review session", {
              threadId,
              cause,
            }),
          ),
          Effect.ignore,
        ) ?? Effect.void,
      { concurrency: 4, discard: true },
    );
  }

  const listRuns = Ref.get(runsRef);

  const hideReviewSession = (
    run: AgentDashboardAutomationRun,
    review: AgentDashboardReviewRunResult,
  ) =>
    runner.hideReviewThread
      ? runner.hideReviewThread(review.threadId).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("T3 could not hide a completed repository review session", {
              runId: run.id,
              threadId: review.threadId,
              cause,
            }),
          ),
          Effect.ignore,
        )
      : Effect.void;

  const monitorAndIngest = (
    run: AgentDashboardAutomationRun,
    review: AgentDashboardReviewRunResult,
  ): Effect.Effect<AgentDashboardAutomationRun, never> =>
    Effect.gen(function* () {
      // Poll budget (not wall Clock) so TestClock-driven sleeps alone can time out.
      const pollMs = Duration.toMillis(MONITOR_POLL_INTERVAL);
      const maxPolls = Math.max(
        1,
        Math.ceil(Duration.toMillis(activeMonitorTimeout()) / Math.max(1, pollMs)),
      );
      let timedOut = true;
      let hasAssistantMessage = false;
      let assistantText: string | null = null;
      const heartbeatEveryPolls = 15;

      for (let poll = 0; poll < maxPolls; poll += 1) {
        const thread = yield* projectionSnapshotQuery
          .getThreadDetailById(review.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));

        if (Option.isSome(thread)) {
          const latestTurn = thread.value.latestTurn;
          if (latestTurn !== null && latestTurn.state !== "running") {
            timedOut = false;
            const message = latestTurn.assistantMessageId
              ? (thread.value.messages.find((item) => item.id === latestTurn.assistantMessageId) ??
                null)
              : null;
            hasAssistantMessage = message !== null;
            assistantText = message?.text ?? null;
            break;
          }
        }

        // Persist a real worker heartbeat while the provider turn is still
        // running. The scheduler and external health checks consume this
        // timestamp, so a long review cannot look dead merely because its
        // terminal state has not changed yet.
        if (poll > 0 && poll % heartbeatEveryPolls === 0) {
          const heartbeatAt = yield* nowIso;
          yield* persist({
            ...run,
            status: "running",
            threadId: review.threadId,
            target: review.projectName,
            repository: { projectId: review.projectId },
            jobId: run.jobId ?? String(review.threadId),
            updatedAt: heartbeatAt,
          }).pipe(Effect.orElseSucceed(() => run));
        }

        if (poll + 1 < maxPolls) {
          yield* Effect.sleep(MONITOR_POLL_INTERVAL);
        }
      }

      const ingestingAt = yield* nowIso;
      const ingestingRun: AgentDashboardAutomationRun = {
        ...run,
        status: "ingesting",
        threadId: review.threadId,
        target: review.projectName,
        repository: { projectId: review.projectId },
        jobId: run.jobId ?? String(review.threadId),
        updatedAt: ingestingAt,
      };
      yield* persist(ingestingRun).pipe(Effect.orElseSucceed(() => ingestingRun));

      const decision = decideTerminalOutcome({
        timedOut,
        hasAssistantMessage,
        assistantText,
        persistedFindingCount: null,
      });

      let findingCount = 0;
      let status = decision.status;
      let error = decision.error;
      let persistenceFailed = false;

      if (decision.shouldPersistFindings && decision.findings.length > 0) {
        const writtenExit = yield* Effect.exit(
          dashboardStore.appendReviewSuggestions({
            jobId: String(review.threadId),
            runId: run.id,
            projectId: String(review.projectId),
            repository: {
              name: review.projectName,
              path: review.workspaceRoot,
              githubRepo: review.githubRepo,
            },
            findings: decision.findings,
          }),
        );

        if (Exit.isFailure(writtenExit)) {
          persistenceFailed = true;
          error = "Failed to persist structured review findings.";
        } else {
          findingCount += writtenExit.value;
        }
      }

      if (decision.shouldPersistQualifications && decision.qualifications.length > 0) {
        const qualificationExit = yield* Effect.exit(
          dashboardStore.applyFindingQualifications(decision.qualifications),
        );
        if (Exit.isFailure(qualificationExit)) {
          persistenceFailed = true;
          error = "Failed to persist finding qualifications.";
        } else {
          findingCount += qualificationExit.value;
        }
      }

      if (persistenceFailed) {
        status = "failed";
        findingCount = 0;
      } else if (findingCount > 0) {
        status = "succeeded";
        error = null;
      } else if (decision.status === "succeeded") {
        status = "partial";
        error = "Structured findings or qualifications did not change the portfolio.";
      }

      const completedAt = yield* nowIso;
      const terminal: AgentDashboardAutomationRun = {
        ...ingestingRun,
        status,
        findingCount,
        error,
        updatedAt: completedAt,
        completedAt,
      };
      yield* hideReviewSession(run, review);
      return yield* persist(terminal).pipe(Effect.orElseSucceed(() => terminal));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const failedAt = yield* nowIso;
          const failed: AgentDashboardAutomationRun = {
            ...run,
            status: "failed",
            error: "Repository review ingestion failed unexpectedly.",
            updatedAt: failedAt,
            completedAt: failedAt,
            threadId: review.threadId,
            target: review.projectName,
            repository: { projectId: review.projectId },
          };
          yield* Effect.logWarning("T3 repository review ingestion failed", {
            runId: run.id,
            threadId: review.threadId,
            cause,
          });
          yield* hideReviewSession(run, review);
          return yield* persist(failed).pipe(Effect.orElseSucceed(() => failed));
        }),
      ),
    );

  const executeRun = (run: AgentDashboardAutomationRun): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      // Wait for a concurrency slot without busy-polling wall clocks.
      while (true) {
        const claimed = yield* Ref.modify(workerSlots, (active) => {
          if (active >= MAX_CONCURRENT_REVIEW_RUNS) return [false, active] as const;
          return [true, active + 1] as const;
        });
        if (claimed) break;
        yield* Effect.sleep(MONITOR_POLL_INTERVAL);
      }

      try {
        const startedAt = yield* nowIso;
        const reviewModelSelection = yield* settings.getSettings.pipe(
          Effect.map((currentSettings) => currentSettings.repositoryReview.modelSelection),
          Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.repositoryReview.modelSelection),
        );
        const running: AgentDashboardAutomationRun = {
          ...run,
          status: "running",
          startedAt: run.startedAt ?? startedAt,
          updatedAt: startedAt,
          model: modelLabel(reviewModelSelection),
        };
        yield* persist(running).pipe(Effect.orElseSucceed(() => running));

        const reviewExit = yield* Effect.exit(
          runner.runReview({
            projectId: run.repository.projectId,
          }),
        );

        if (Exit.isFailure(reviewExit)) {
          const failedAt = yield* nowIso;
          const squashed = Cause.squash(reviewExit.cause);
          const failureMessage =
            squashed instanceof Error && squashed.message.length > 0
              ? squashed.message
              : "Repository review dispatch failed.";
          const failed: AgentDashboardAutomationRun = {
            ...running,
            status: "failed",
            error: failureMessage,
            updatedAt: failedAt,
            completedAt: failedAt,
          };
          yield* persist(failed).pipe(Effect.orElseSucceed(() => failed));
          return;
        }

        const review = reviewExit.value;
        const dispatchedAt = yield* nowIso;
        const withThread: AgentDashboardAutomationRun = {
          ...running,
          threadId: review.threadId,
          target: review.projectName,
          repository: { projectId: review.projectId },
          jobId: running.jobId ?? String(review.threadId),
          updatedAt: dispatchedAt,
        };
        yield* persist(withThread).pipe(Effect.orElseSucceed(() => withThread));
        yield* monitorAndIngest(withThread, review);
      } finally {
        yield* Ref.update(workerSlots, (active) => Math.max(0, active - 1));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const failedAt = yield* nowIso;
          const failed: AgentDashboardAutomationRun = {
            ...run,
            status: "failed",
            error: "Repository review job failed unexpectedly.",
            updatedAt: failedAt,
            completedAt: failedAt,
          };
          yield* Effect.logWarning("T3 repository review job failed", {
            runId: run.id,
            cause,
          });
          yield* persist(failed).pipe(Effect.ignore);
        }),
      ),
    );

  const enqueueReview: AgentDashboardReviewJobServiceService["enqueueReview"] = (input) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(runsRef);
      const idempotencyKey =
        stringValue(input.idempotencyKey) ??
        (input.trigger === "manual" && !input.projectId
          ? `manual:${REVIEW_KIND}`
          : input.trigger === "scheduled"
            ? `scheduled:${REVIEW_KIND}`
            : null);

      if (idempotencyKey) {
        const existing = findIdempotentMatch(current, idempotencyKey);
        if (existing) return existing;
      }

      // Bound total in-flight work: refuse enqueue when the queue is already full
      // of active runs at the concurrency limit *and* more are waiting... For
      // simplicity with maxConcurrent=1, any active run with the same kind for
      // scheduled/manual default keys is already handled. Additional targeted
      // runs may still queue; cap absolute active+queued depth.
      const active = activeCount(current.filter((run) => run.kind === REVIEW_KIND));
      if (active >= MAX_CONCURRENT_REVIEW_RUNS * 4) {
        return yield* new AgentDashboardReviewJobServiceError({
          operation: "enqueue review",
          message: "Too many repository reviews are already queued or running.",
        });
      }

      const createdAt = yield* nowIso;
      const reviewModelSelection = yield* settings.getSettings.pipe(
        Effect.map((currentSettings) => currentSettings.repositoryReview.modelSelection),
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.repositoryReview.modelSelection),
      );
      const id = yield* randomId;
      const projectId =
        input.projectId ??
        // Placeholder until dispatch selects a project; still satisfies the contract.
        ProjectId.make("pending-selection");

      const run: AgentDashboardAutomationRun = {
        id,
        status: "queued",
        trigger: input.trigger,
        kind: REVIEW_KIND,
        repository: { projectId },
        target: stringValue(input.target),
        threadId: null,
        jobId: idempotencyKey ?? id,
        model: modelLabel(reviewModelSelection),
        retryCount: input.retryCount ?? 0,
        findingCount: 0,
        costUnits: null,
        error: null,
        createdAt,
        startedAt: null,
        updatedAt: createdAt,
        completedAt: null,
      };

      const saved = yield* persist(run);
      yield* executeRun(saved).pipe(Effect.forkIn(scope));
      return saved;
    });

  const retryRun: AgentDashboardReviewJobServiceService["retryRun"] = (runId) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(runsRef)).find((run) => run.id === runId) ?? null;
      if (!existing) {
        return yield* new AgentDashboardReviewJobServiceError({
          operation: "retry run",
          message: "That automation run was not found.",
        });
      }
      if (isActiveStatus(existing.status)) {
        return yield* new AgentDashboardReviewJobServiceError({
          operation: "retry run",
          message: "That automation run is still in progress.",
        });
      }
      if (existing.retryCount >= MAX_REVIEW_RETRIES) {
        return yield* new AgentDashboardReviewJobServiceError({
          operation: "retry run",
          message: `Repository review retry limit (${MAX_REVIEW_RETRIES}) reached.`,
        });
      }
      if (existing.repository.projectId === ProjectId.make("pending-selection")) {
        return yield* new AgentDashboardReviewJobServiceError({
          operation: "retry run",
          message: "That automation run has no durable repository target to retry.",
        });
      }

      return yield* enqueueReview({
        trigger: "retry",
        projectId: existing.repository.projectId,
        target: existing.target,
        parentRunId: existing.id,
        retryCount: existing.retryCount + 1,
        idempotencyKey: `retry:${existing.id}:${existing.retryCount + 1}`,
      });
    });

  return {
    listRuns,
    enqueueReview,
    retryRun,
  } satisfies AgentDashboardReviewJobServiceService;
});

/** Core job service without default dependencies (tests provide fakes). */
export const layerWithoutDefaults = Layer.effect(AgentDashboardReviewJobService, make);

/** Production layer: durable run history under the server state directory. */
export const layer = layerWithoutDefaults.pipe(Layer.provide(AgentDashboardRunHistory.layer));

export const __testing = {
  parseReviewMetadata,
  decideTerminalOutcome,
  findIdempotentMatch,
  isActiveStatus,
  maxConcurrent: MAX_CONCURRENT_REVIEW_RUNS,
  maxRetries: MAX_REVIEW_RETRIES,
  monitorPollInterval: MONITOR_POLL_INTERVAL,
  monitorTimeout: MONITOR_TIMEOUT,
  setMonitorTimeoutOverride: (timeout: Duration.Duration | null) => {
    monitorTimeoutOverride = timeout;
  },
};

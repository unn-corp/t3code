// @effect-diagnostics globalDate:off - tests pin ISO timestamps and TestClock.
// @effect-diagnostics nodeBuiltinImport:off - temp fixture directories use Node fs/path at the test boundary.
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ThreadId,
  type AgentDashboardAutomationRun,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectionSnapshotQuery from "../agentDashboard/AutomationSnapshotQuery.ts";
import * as AgentDashboardRunHistory from "./AgentDashboardRunHistory.ts";
import * as AgentDashboardReviewJobService from "./AgentDashboardReviewJobService.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import {
  AgentDashboardReviewRunner,
  AgentDashboardReviewRunnerError,
  type AgentDashboardReviewRunResult,
} from "./AgentDashboardReviewRunner.ts";
import * as AgentDashboardReviewScheduler from "./AgentDashboardReviewScheduler.ts";
import {
  MaintenanceWorkHeld,
  WorkAdmission,
  type WorkAdmissionShape,
} from "../maintenance/WorkAdmission.ts";

const PROJECT_ID = ProjectId.make("project-review-1");
const THREAD_ID = ThreadId.make("thread-review-1");
const ASSISTANT_ID = MessageId.make("assistant-review-1");

const sampleFindingMetadata = [
  'T3_REVIEW_METADATA: {"findings":[{"title":"Parser bug","type":"bug","category":"parser","summary":"Drops the last item","impact":"Import loss","confidence":"high","evidence":["src/parser.ts:42"],"next_step":"Flush before return","github_issue_title":"Fix parser flush","github_issue_body":"## Problem"}]}',
  "# Random Codebase Review",
].join("\n");

const reviewResult: AgentDashboardReviewRunResult = {
  projectId: PROJECT_ID,
  projectName: "t3code",
  workspaceRoot: "/tmp/t3code-review-fixture",
  githubRepo: "pingdotgg/t3code",
  threadId: THREAD_ID,
  startedAt: "2026-08-10T00:00:00.000Z",
};

describe("review progress watchdog", () => {
  it("bounds inactivity without imposing a total run duration", () => {
    const tenMinutes = Duration.toMillis(Duration.minutes(10));
    expect(
      AgentDashboardReviewJobService.evaluateReviewProgressWatchdog({
        nowMs: tenMinutes - 1,
        lastProgressAtMs: 0,
        lastNudgeAtMs: null,
        nudgeCount: 0,
      }),
    ).toEqual({ kind: "wait" });
    expect(
      AgentDashboardReviewJobService.evaluateReviewProgressWatchdog({
        nowMs: tenMinutes,
        lastProgressAtMs: 0,
        lastNudgeAtMs: null,
        nudgeCount: 0,
      }),
    ).toEqual({ kind: "nudge", attempt: 1 });
    expect(
      AgentDashboardReviewJobService.evaluateReviewProgressWatchdog({
        nowMs: Duration.toMillis(Duration.minutes(40)),
        lastProgressAtMs: 0,
        lastNudgeAtMs: 0,
        nudgeCount: 3,
      }),
    ).toEqual({ kind: "exhausted" });
  });
});

describe("parseReviewMetadata", () => {
  it("parses structured findings", () => {
    const parsed = AgentDashboardReviewJobService.parseReviewMetadata(sampleFindingMetadata);
    expect(parsed).toEqual({
      kind: "parsed",
      findings: [
        {
          title: "Parser bug",
          type: "bug",
          category: "parser",
          summary: "Drops the last item",
          impact: "Import loss",
          confidence: "high",
          evidence: ["src/parser.ts:42"],
          nextStep: "Flush before return",
          targets: [],
          validationPlan: [],
          sources: [],
          automationRisk: "medium",
          estimatedEffort: "medium",
          qualificationReason: null,
          githubIssueTitle: "Fix parser flush",
          githubIssueBody: "## Problem",
        },
      ],
      qualifications: [],
    });
  });

  it("parses qualification decisions for existing collector findings", () => {
    expect(
      AgentDashboardReviewJobService.parseReviewMetadata(
        'T3_REVIEW_METADATA: {"findings":[],"qualifications":[{"finding_id":"finding:ci","outcome":"ready","proposal":"Add CI checks.","expected_value":"Catch regressions.","targets":[{"path":".github/workflows/checks.yml","symbol":null,"evidence":"No workflow exists."}],"validation_plan":["Validate workflow syntax."],"sources":[],"automation_risk":"low","estimated_effort":"small","reason":"The repository exposes a deterministic test command."},{"finding_id":"finding:fixture","outcome":"dismiss","reason":"This is an inert test fixture."}]}',
      ),
    ).toEqual({
      kind: "parsed",
      findings: [],
      qualifications: [
        {
          id: "finding:ci",
          outcome: "ready",
          proposal: "Add CI checks.",
          expectedValue: "Catch regressions.",
          targets: [
            {
              path: ".github/workflows/checks.yml",
              symbol: null,
              evidence: "No workflow exists.",
            },
          ],
          validationPlan: ["Validate workflow syntax."],
          sources: [],
          riskTier: "low",
          estimatedEffort: "small",
          reason: "The repository exposes a deterministic test command.",
        },
        {
          id: "finding:fixture",
          outcome: "dismiss",
          reason: "This is an inert test fixture.",
        },
      ],
    });
  });

  it("accepts only product opportunities with complete user-value evidence", () => {
    const accepted = AgentDashboardReviewJobService.parseReviewMetadata(
      'T3_REVIEW_METADATA: {"findings":[{"title":"Retry only failed automation stages","type":"improvement","category":"product-opportunity","summary":"Users must rerun an entire workflow","impact":"ignored","confidence":"high","evidence":["src/workflow.ts:42"],"next_step":"Add retry controls","qualification_reason":"Choose retry semantics","product_opportunity":{"user":"automation operator","current_experience":"reruns every stage","proposed_experience":"retries one failed stage","expected_value":"faster recovery with less repeated work","product_context_evidence":["Primary workflow is supervising automations"]},"github_issue_title":"Add stage retry","github_issue_body":"## Opportunity"}],"qualifications":[]}',
    );
    expect(accepted).toMatchObject({
      kind: "parsed",
      findings: [
        {
          category: "product-opportunity",
          impact: "faster recovery with less repeated work",
          qualificationReason: "Choose retry semantics",
        },
      ],
    });
    if (accepted.kind === "parsed") {
      expect(accepted.findings[0]?.evidence).toContain("Current experience: reruns every stage");
    }

    expect(
      AgentDashboardReviewJobService.parseReviewMetadata(
        'T3_REVIEW_METADATA: {"findings":[{"title":"Generic refactor","type":"improvement","category":"product-opportunity","summary":"Clean up code","impact":"Cleaner code","confidence":"medium","evidence":[],"next_step":"Refactor","product_opportunity":{"user":"developer"}}]}',
      ),
    ).toEqual({ kind: "parsed", findings: [], qualifications: [] });
    expect(
      AgentDashboardReviewJobService.parseReviewMetadata(
        'T3_REVIEW_METADATA: {"findings":[{"title":"A mislabeled bug","type":"bug","category":"product-opportunity","summary":"A control crashes","confidence":"high","evidence":["src/control.ts:10"],"product_opportunity":{"user":"operator","current_experience":"the control crashes","proposed_experience":"the control works","expected_value":"the task completes","product_context_evidence":["Operators use this control"]}}]}',
      ),
    ).toEqual({ kind: "parsed", findings: [], qualifications: [] });
  });

  it("treats missing metadata, silent, empty and parse failure distinctly", () => {
    expect(AgentDashboardReviewJobService.parseReviewMetadata("no metadata here")).toEqual({
      kind: "missing",
    });
    expect(AgentDashboardReviewJobService.parseReviewMetadata("[SILENT]")).toEqual({
      kind: "silent",
    });
    expect(
      AgentDashboardReviewJobService.parseReviewMetadata('T3_REVIEW_METADATA: {"findings":[]}'),
    ).toEqual({ kind: "parsed", findings: [], qualifications: [] });
    expect(
      AgentDashboardReviewJobService.parseReviewMetadata("T3_REVIEW_METADATA: {not-json"),
    ).toMatchObject({ kind: "parse-failure" });
  });
});

describe("decideTerminalOutcome", () => {
  it("fails on timeout, missing output and parse failure", () => {
    expect(
      AgentDashboardReviewJobService.decideTerminalOutcome({
        timedOut: true,
        hasAssistantMessage: false,
        assistantText: null,
        persistedFindingCount: null,
      }).status,
    ).toBe("failed");

    expect(
      AgentDashboardReviewJobService.decideTerminalOutcome({
        timedOut: false,
        hasAssistantMessage: false,
        assistantText: null,
        persistedFindingCount: null,
      }),
    ).toMatchObject({
      status: "failed",
      error: "Repository review finished without assistant output.",
    });

    expect(
      AgentDashboardReviewJobService.decideTerminalOutcome({
        timedOut: false,
        hasAssistantMessage: true,
        assistantText: "T3_REVIEW_METADATA: {bad",
        persistedFindingCount: null,
      }).status,
    ).toBe("failed");
  });

  it("marks partial for silent and zero usable findings", () => {
    expect(
      AgentDashboardReviewJobService.decideTerminalOutcome({
        timedOut: false,
        hasAssistantMessage: true,
        assistantText: "[SILENT]",
        persistedFindingCount: null,
      }),
    ).toMatchObject({ status: "partial", shouldPersistFindings: false });

    expect(
      AgentDashboardReviewJobService.decideTerminalOutcome({
        timedOut: false,
        hasAssistantMessage: true,
        assistantText: 'T3_REVIEW_METADATA: {"findings":[]}',
        persistedFindingCount: null,
      }),
    ).toMatchObject({
      status: "partial",
      error: "Repository review completed with zero usable findings or qualifications.",
      shouldPersistFindings: false,
    });
  });

  it("only proposes success when findings are available to persist", () => {
    const decision = AgentDashboardReviewJobService.decideTerminalOutcome({
      timedOut: false,
      hasAssistantMessage: true,
      assistantText: sampleFindingMetadata,
      persistedFindingCount: null,
    });
    expect(decision).toMatchObject({
      status: "succeeded",
      shouldPersistFindings: true,
      findingCount: 1,
      error: null,
    });
  });
});

describe("run history restart recovery", () => {
  it("marks queued, running and ingesting runs failed after restart", () => {
    const now = "2026-08-10T01:00:00.000Z";
    const base = {
      trigger: "scheduled" as const,
      kind: "repository-review",
      repository: { projectId: PROJECT_ID },
      target: "t3code",
      threadId: THREAD_ID,
      jobId: "job-1",
      model: "gpt-5.6-luna",
      retryCount: 0,
      findingCount: 0,
      costUnits: null,
      error: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      startedAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      completedAt: null,
    };
    const recovered = AgentDashboardRunHistory.recoverInterruptedRuns(
      [
        { ...base, id: "queued", status: "queued" },
        { ...base, id: "running", status: "running" },
        { ...base, id: "ingesting", status: "ingesting" },
        {
          ...base,
          id: "succeeded",
          status: "succeeded",
          findingCount: 2,
          completedAt: "2026-08-10T00:30:00.000Z",
        },
      ],
      now,
    );

    expect(recovered.map((run) => run.status)).toEqual(["failed", "failed", "failed", "succeeded"]);
    expect(recovered[0]?.error).toContain("restarted");
    expect(recovered[3]?.findingCount).toBe(2);
  });

  it("can recover only the automation kind owned by a service", () => {
    const now = "2026-08-10T01:00:00.000Z";
    const base = {
      status: "running" as const,
      trigger: "scheduled" as const,
      repository: { projectId: PROJECT_ID },
      target: "t3code",
      threadId: THREAD_ID,
      jobId: "job-1",
      model: "gpt-5.6-luna",
      retryCount: 0,
      findingCount: 0,
      costUnits: null,
      error: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      startedAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      completedAt: null,
    };
    const recovered = AgentDashboardRunHistory.recoverInterruptedRuns(
      [
        { ...base, id: "review", kind: "repository-review" },
        { ...base, id: "implementation", kind: "continuous-improvement" },
      ],
      now,
      "review restarted",
      (run) => run.kind === "repository-review",
    );

    expect(recovered.map((run) => run.status)).toEqual(["failed", "running"]);
  });
});

const unusedProjection = {
  getUserInputActivity: () => Effect.die("unused"),
  getCommandReadModel: () => Effect.die("unused"),
  listActivitiesByKind: () => Effect.die("unused"),
  listThreadsWithPullRequests: () => Effect.die("unused"),
  getDeletedWorktreeThreads: () => Effect.die("unused"),
  getProjectShells: () => Effect.die("unused"),
  getSnapshot: () => Effect.die("unused"),
  getShellSnapshot: () => Effect.die("unused"),
  getArchivedShellSnapshot: () => Effect.die("unused"),
  getSnapshotSequence: () => Effect.die("unused"),
  getCounts: () => Effect.die("unused"),
  getRecentActivitySummaries: () => Effect.die("unused"),
  getEventReplayStats: () => Effect.die("unused"),
  getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
  getProjectShellById: () => Effect.succeed(Option.none()),
  getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
  getImportedAgentSessionSources: () => Effect.succeed([]),
  getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  getFullThreadDiffContext: () => Effect.succeed(Option.none()),
  getThreadShellById: () => Effect.succeed(Option.none()),
  getThreadRuntimeContext: () => Effect.succeed(Option.none()),
  getTurnStartMessage: () => Effect.succeed(Option.none()),
  getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
  searchThreads: () => Effect.succeed({ matches: [] }),
};

const makeTempStateDir = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-adw-03-")));

const makeObservedRunHistory = (baseDir: string) =>
  Effect.gen(function* () {
    const persisted = yield* Effect.gen(function* () {
      return yield* AgentDashboardRunHistory.AgentDashboardRunHistory;
    }).pipe(
      Effect.provide(AgentDashboardRunHistory.layerForStateDir(NodePath.join(baseDir, "userdata"))),
    );
    const writes = yield* Queue.unbounded<AgentDashboardAutomationRun>();
    const service: AgentDashboardRunHistory.AgentDashboardRunHistoryService = {
      ...persisted,
      upsert: (run) =>
        persisted
          .upsert(run)
          .pipe(Effect.tap((saved) => Queue.offer(writes, saved).pipe(Effect.asVoid))),
    };
    return { service, writes };
  });

const awaitRunWrite = (
  writes: Queue.Queue<AgentDashboardAutomationRun>,
  runId: string,
  status: AgentDashboardAutomationRun["status"],
) =>
  Effect.gen(function* () {
    while (true) {
      const run = yield* Queue.take(writes);
      if (run.id === runId && run.status === status) return run;
    }
  });

const observeCoverageWrites = (
  stateDir: string,
  writes: Queue.Queue<AgentDashboardAutomationRun>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const store = AgentDashboardStore.getStore(stateDir);
      const original = store.recordAutomationRun;
      Object.defineProperty(store, "recordAutomationRun", {
        configurable: true,
        value: (run: AgentDashboardAutomationRun) =>
          original(run).pipe(Effect.tap(() => Queue.offer(writes, run).pipe(Effect.asVoid))),
      });
      return () =>
        Object.defineProperty(store, "recordAutomationRun", {
          configurable: true,
          value: original,
        });
    }),
    (restore) => Effect.sync(restore),
  );

const waitForTerminal = (
  jobService: AgentDashboardReviewJobService.AgentDashboardReviewJobService["Service"],
  runId: string,
  maxSteps = 200,
) =>
  Effect.gen(function* () {
    for (let step = 0; step < maxSteps; step += 1) {
      const runs = yield* jobService.listRuns;
      const run = runs.find((item) => item.id === runId);
      if (
        run &&
        (run.status === "succeeded" ||
          run.status === "partial" ||
          run.status === "failed" ||
          run.status === "cancelled")
      ) {
        return run;
      }
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      // Durable finding ingestion uses real filesystem promises. Give the
      // Node event loop a turn after advancing TestClock so this test waits
      // for the worker receipt rather than sampling the intermediate state.
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    const runs = yield* jobService.listRuns;
    return runs.find((item) => item.id === runId) ?? null;
  });

const jobServiceLayer = (input: {
  readonly baseDir: string;
  readonly runner: AgentDashboardReviewRunner["Service"];
  readonly getThreadDetailById: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]["getThreadDetailById"];
  readonly getShellSnapshot?: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]["getShellSnapshot"];
  readonly workAdmission?: WorkAdmissionShape;
  readonly runHistory?: AgentDashboardRunHistory.AgentDashboardRunHistoryService;
}) => {
  const layer = AgentDashboardReviewJobService.layerWithoutDefaults.pipe(
    Layer.provide(Layer.succeed(AgentDashboardReviewRunner, input.runner)),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...unusedProjection,
        ...(input.getShellSnapshot ? { getShellSnapshot: input.getShellSnapshot } : {}),
        getThreadDetailById: input.getThreadDetailById,
      }),
    ),
    Layer.provide(
      input.runHistory === undefined
        ? AgentDashboardRunHistory.layer
        : Layer.succeed(AgentDashboardRunHistory.AgentDashboardRunHistory, input.runHistory),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(NodeServices.layer),
  );
  return input.workAdmission
    ? layer.pipe(Layer.provide(Layer.succeed(WorkAdmission, input.workAdmission)))
    : layer;
};

describe("AgentDashboardReviewJobService lifecycle", () => {
  it.effect("records each failed review once across repeated detached coverage writes", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const history = yield* makeObservedRunHistory(baseDir);
      const coverageWrites = yield* Queue.unbounded<AgentDashboardAutomationRun>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* observeCoverageWrites(NodePath.join(baseDir, "userdata"), coverageWrites);
          yield* Effect.gen(function* () {
            const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
            const first = yield* jobService.enqueueReview({
              trigger: "manual",
              projectId: PROJECT_ID,
              idempotencyKey: "coverage-failure-first",
            });
            yield* awaitRunWrite(history.writes, first.id, "failed");

            const second = yield* jobService.enqueueReview({
              trigger: "manual",
              projectId: PROJECT_ID,
              idempotencyKey: "coverage-failure-second",
            });
            yield* awaitRunWrite(history.writes, second.id, "failed");

            const third = yield* jobService.enqueueReview({
              trigger: "manual",
              projectId: PROJECT_ID,
              idempotencyKey: "coverage-failure-third",
            });
            yield* awaitRunWrite(history.writes, third.id, "failed");
            yield* awaitRunWrite(coverageWrites, third.id, "failed");

            const coverage = yield* AgentDashboardStore.getStore(NodePath.join(baseDir, "userdata"))
              .readRepositoryCoverage;
            expect(coverage).toHaveLength(1);
            expect(coverage[0]).toMatchObject({
              consecutiveFailures: 3,
              lastRunId: third.id,
              lastTerminalRunId: third.id,
            });
          }).pipe(
            Effect.provide(
              jobServiceLayer({
                baseDir,
                runHistory: history.service,
                runner: {
                  runReview: () =>
                    Effect.fail(
                      new AgentDashboardReviewRunnerError({
                        operation: "run review",
                        message: "review dispatch failed",
                      }),
                    ),
                  runRandomReview: Effect.succeed({ ...reviewResult, workspaceRoot: baseDir }),
                },
                getThreadDetailById: () => Effect.succeed(Option.none()),
              }),
            ),
          );
        }),
      );
    }),
  );

  it.effect("acquires with historical reviews before command readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* makeTempStateDir();
        const gate = yield* ServerRuntimeStartup.makeCommandGate;
        const hiding = yield* Deferred.make<void>();
        const hidden = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const history = yield* AgentDashboardRunHistory.AgentDashboardRunHistory;
          yield* history.upsert({
            id: "historical-review",
            status: "succeeded",
            trigger: "manual",
            kind: "repository-review",
            repository: { projectId: PROJECT_ID },
            target: "Historical review",
            threadId: THREAD_ID,
            jobId: null,
            model: null,
            retryCount: 0,
            findingCount: 0,
            costUnits: null,
            error: null,
            createdAt: reviewResult.startedAt,
            startedAt: reviewResult.startedAt,
            updatedAt: reviewResult.startedAt,
            completedAt: reviewResult.startedAt,
          });
        }).pipe(
          Effect.provide(
            AgentDashboardRunHistory.layer.pipe(
              Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const service = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
          expect(yield* service.listRuns).toHaveLength(1);
          yield* Deferred.await(hiding);
          expect(yield* Deferred.isDone(hidden)).toBe(false);
          yield* gate.signalCommandReady;
          yield* Deferred.await(hidden);
        }).pipe(
          Effect.provide(
            jobServiceLayer({
              baseDir,
              runner: {
                runReview: () => Effect.succeed(reviewResult),
                runRandomReview: Effect.succeed(reviewResult),
                hideReviewThread: () =>
                  Deferred.succeed(hiding, undefined).pipe(
                    Effect.andThen(
                      gate.enqueueCommand(Deferred.succeed(hidden, undefined)).pipe(Effect.orDie),
                    ),
                    Effect.asVoid,
                  ),
              },
              getThreadDetailById: () => Effect.succeed(Option.none()),
            }),
          ),
        );
      }),
    ),
  );

  it.effect("completes a scheduled no-op when no repository is due", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const dispatchCount = yield* Ref.make(0);

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const enqueued = yield* jobService.enqueueReview({ trigger: "scheduled" });
        const terminal = yield* waitForTerminal(jobService, enqueued.id, 200);
        expect(terminal?.status).toBe("succeeded");
        expect(terminal?.target).toBe("No repository due");
        expect(yield* Ref.get(dispatchCount)).toBe(0);
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runner: {
              selectNextProject: () => Effect.succeed(null),
              runReview: () =>
                Ref.update(dispatchCount, (count) => count + 1).pipe(Effect.as(reviewResult)),
              runRandomReview: Effect.succeed(reviewResult),
            },
            getThreadDetailById: () => Effect.succeed(Option.none()),
          }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("dispatches through ingestion and succeeds only after findings persist", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const workspaceRoot = NodePath.join(baseDir, "repo");
      yield* Effect.tryPromise(() => NodeFSP.mkdir(workspaceRoot, { recursive: true }));

      const turnComplete = yield* Ref.make(false);
      const dispatchCount = yield* Ref.make(0);
      const hiddenThreadCount = yield* Ref.make(0);

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const enqueued = yield* jobService.enqueueReview({
          trigger: "manual",
          projectId: PROJECT_ID,
          idempotencyKey: "test-success",
        });
        expect(enqueued.status).toBe("queued");

        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;

        yield* Ref.set(turnComplete, true);
        const terminal = yield* waitForTerminal(jobService, enqueued.id, 1_000);
        expect(terminal?.status).toBe("succeeded");
        expect(terminal?.findingCount).toBe(1);
        expect(terminal?.threadId).toEqual(THREAD_ID);
        expect(terminal?.error).toBeNull();
        expect(yield* Ref.get(dispatchCount)).toBe(1);
        expect(yield* Ref.get(hiddenThreadCount)).toBe(1);
        const findings = yield* AgentDashboardStore.getStore(NodePath.join(baseDir, "userdata"))
          .readFindings;
        expect(findings).toHaveLength(1);
        expect(findings[0]?.thread).toBeNull();
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runner: {
              runReview: () =>
                Ref.updateAndGet(dispatchCount, (count) => count + 1).pipe(
                  Effect.as({
                    ...reviewResult,
                    workspaceRoot,
                  }),
                ),
              hideReviewThread: () => Ref.update(hiddenThreadCount, (count) => count + 1),
              runRandomReview: Effect.succeed({ ...reviewResult, workspaceRoot }),
            },
            getThreadDetailById: () =>
              Ref.get(turnComplete).pipe(
                Effect.map((done) =>
                  Option.some({
                    latestTurn: {
                      turnId: "turn-1",
                      state: done ? "completed" : "running",
                      assistantMessageId: done ? ASSISTANT_ID : null,
                      requestedAt: "2026-08-10T00:00:00.000Z",
                      startedAt: "2026-08-10T00:00:00.000Z",
                      completedAt: done ? "2026-08-10T00:00:10.000Z" : null,
                    },
                    messages: done
                      ? [{ id: ASSISTANT_ID, role: "assistant", text: sampleFindingMetadata }]
                      : [],
                  } as never),
                ),
              ),
          }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("returns the in-flight run for the same idempotency key", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const hang = yield* Ref.make(true);

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const first = yield* jobService.enqueueReview({
          trigger: "manual",
          idempotencyKey: "manual:repository-review",
        });
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;

        const second = yield* jobService.enqueueReview({
          trigger: "manual",
          idempotencyKey: "manual:repository-review",
        });
        expect(second.id).toBe(first.id);

        yield* Ref.set(hang, false);
        yield* TestClock.adjust(Duration.seconds(1));
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runner: {
              runReview: () =>
                Effect.gen(function* () {
                  while (yield* Ref.get(hang)) {
                    yield* Effect.sleep(Duration.seconds(1));
                  }
                  return { ...reviewResult, workspaceRoot: baseDir };
                }),
              runRandomReview: Effect.succeed(reviewResult),
            },
            getThreadDetailById: () => Effect.succeed(Option.none()),
          }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("keeps monitoring a healthy running review without a wall-clock limit", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const history = yield* makeObservedRunHistory(baseDir);
      const activityCount = yield* Ref.make(0);
      const reviewStarted = yield* Deferred.make<void>();
      const monitorObserved = yield* Deferred.make<void>();
      const postAdvanceObserved = yield* Deferred.make<void>();
      const advancing = yield* Ref.make(false);

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const enqueued = yield* jobService.enqueueReview({
          trigger: "scheduled",
          projectId: PROJECT_ID,
          idempotencyKey: "long-running-case",
        });
        yield* awaitRunWrite(history.writes, enqueued.id, "running");
        yield* Deferred.await(reviewStarted);
        yield* Deferred.await(monitorObserved);
        // Await the thread binding and then the monitor's first progress write.
        // Both follow the initial running write, and the latter follows observation.
        yield* awaitRunWrite(history.writes, enqueued.id, "running");
        yield* awaitRunWrite(history.writes, enqueued.id, "running");
        yield* Ref.set(advancing, true);
        yield* TestClock.adjust(Duration.hours(2));
        yield* Deferred.await(postAdvanceObserved);
        yield* awaitRunWrite(history.writes, enqueued.id, "running");
        const current = (yield* jobService.listRuns).find((run) => run.id === enqueued.id);
        expect(current?.status).toBe("running");
        expect(current?.completedAt).toBeNull();
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runHistory: history.service,
            runner: {
              runReview: () =>
                Deferred.succeed(reviewStarted, undefined).pipe(
                  Effect.as({ ...reviewResult, workspaceRoot: baseDir }),
                ),
              runRandomReview: Effect.succeed({ ...reviewResult, workspaceRoot: baseDir }),
            },
            getThreadDetailById: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(monitorObserved, undefined);
                if (yield* Ref.get(advancing)) {
                  yield* Deferred.succeed(postAdvanceObserved, undefined);
                }
                const count = yield* Ref.updateAndGet(activityCount, (count) => count + 1);
                return Option.some({
                  latestTurn: {
                    turnId: "turn-timeout",
                    state: "running",
                    assistantMessageId: null,
                    requestedAt: "2026-08-10T00:00:00.000Z",
                    startedAt: "2026-08-10T00:00:00.000Z",
                    completedAt: null,
                  },
                  messages: [],
                  activities: Array.from({ length: count }, (_, index) => ({ id: index })),
                } as never);
              }),
          }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("nudges a settled review once when its structured output is missing", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const nudgeCount = yield* Ref.make(0);

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const enqueued = yield* jobService.enqueueReview({
          trigger: "scheduled",
          projectId: PROJECT_ID,
          idempotencyKey: "correction-case",
        });

        const terminal = yield* waitForTerminal(jobService, enqueued.id, 200);
        expect(terminal?.status).toBe("succeeded");
        expect(yield* Ref.get(nudgeCount)).toBe(1);
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runner: {
              runReview: () => Effect.succeed({ ...reviewResult, workspaceRoot: baseDir }),
              nudgeReview: () => Ref.update(nudgeCount, (count) => count + 1),
              runRandomReview: Effect.succeed({ ...reviewResult, workspaceRoot: baseDir }),
            },
            getThreadDetailById: () =>
              Ref.get(nudgeCount).pipe(
                Effect.map((nudges) =>
                  Option.some({
                    latestTurn: {
                      turnId: nudges === 0 ? "turn-missing" : "turn-corrected",
                      state: "completed",
                      assistantMessageId: ASSISTANT_ID,
                      requestedAt: "2026-08-10T00:00:00.000Z",
                      startedAt: "2026-08-10T00:00:00.000Z",
                      completedAt: "2026-08-10T00:00:10.000Z",
                    },
                    messages: [
                      {
                        id: ASSISTANT_ID,
                        role: "assistant",
                        text:
                          nudges === 0 ? "Human report without metadata." : sampleFindingMetadata,
                      },
                    ],
                  } as never),
                ),
              ),
          }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("fails instead of hanging when an output nudge cannot be dispatched", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const history = yield* makeObservedRunHistory(baseDir);

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const enqueued = yield* jobService.enqueueReview({
          trigger: "scheduled",
          projectId: PROJECT_ID,
          idempotencyKey: "correction-dispatch-failure",
        });

        const terminal = yield* awaitRunWrite(history.writes, enqueued.id, "failed");
        expect(terminal.status).toBe("failed");
        expect(terminal.error).toContain("missing structured findings metadata");
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runHistory: history.service,
            runner: {
              runReview: () => Effect.succeed({ ...reviewResult, workspaceRoot: baseDir }),
              nudgeReview: () => Effect.die("nudge dispatch failed"),
              runRandomReview: Effect.succeed({ ...reviewResult, workspaceRoot: baseDir }),
            },
            getThreadDetailById: () =>
              Effect.succeed(
                Option.some({
                  latestTurn: {
                    turnId: "turn-missing",
                    state: "completed",
                    assistantMessageId: ASSISTANT_ID,
                    requestedAt: "2026-08-10T00:00:00.000Z",
                    startedAt: "2026-08-10T00:00:00.000Z",
                    completedAt: "2026-08-10T00:00:10.000Z",
                  },
                  messages: [
                    {
                      id: ASSISTANT_ID,
                      role: "assistant",
                      text: "Human report without metadata.",
                    },
                  ],
                } as never),
              ),
          }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("bounds concurrent execution to one active worker", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const release = yield* Ref.make(false);

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const first = yield* jobService.enqueueReview({
          trigger: "manual",
          projectId: PROJECT_ID,
          idempotencyKey: "concurrent-a",
        });
        const second = yield* jobService.enqueueReview({
          trigger: "manual",
          projectId: PROJECT_ID,
          idempotencyKey: "concurrent-b",
        });
        expect(first.id).not.toBe(second.id);

        // Drain the forked workers enough for the first to claim the slot.
        for (let step = 0; step < 10 && (yield* Ref.get(peak)) === 0; step += 1) {
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(peak)).toBe(1);
        expect(yield* Ref.get(active)).toBe(1);

        yield* Ref.set(release, true);
        for (let step = 0; step < 10; step += 1) {
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(peak)).toBe(1);
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runner: {
              runReview: () =>
                Effect.gen(function* () {
                  const current = yield* Ref.updateAndGet(active, (count) => count + 1);
                  yield* Ref.update(peak, (value) => Math.max(value, current));
                  while (!(yield* Ref.get(release))) {
                    yield* Effect.sleep(Duration.seconds(1));
                  }
                  yield* Ref.update(active, (count) => Math.max(0, count - 1));
                  return {
                    ...reviewResult,
                    threadId: ThreadId.make(`thread-${current}`),
                    workspaceRoot: baseDir,
                  };
                }),
              runRandomReview: Effect.succeed(reviewResult),
            },
            getThreadDetailById: () =>
              Effect.succeed(
                Option.some({
                  latestTurn: {
                    turnId: "turn-done",
                    state: "completed",
                    assistantMessageId: ASSISTANT_ID,
                    requestedAt: "2026-08-10T00:00:00.000Z",
                    startedAt: "2026-08-10T00:00:00.000Z",
                    completedAt: "2026-08-10T00:00:01.000Z",
                  },
                  messages: [
                    {
                      id: ASSISTANT_ID,
                      role: "assistant",
                      text: sampleFindingMetadata,
                    },
                  ],
                } as never),
              ),
          }),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("keeps interrupted runs durable until startup reconnection is admitted", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const held = yield* Ref.make(true);
      const admissionChecked = yield* Deferred.make<void>();
      const workAdmission: WorkAdmissionShape = {
        acquire: Effect.succeed(() => Effect.void),
        acquirePassive: Effect.succeed(() => Effect.void),
        check: Effect.void,
        checkAutomation: Effect.gen(function* () {
          yield* Deferred.succeed(admissionChecked, undefined);
          if (yield* Ref.get(held)) {
            return yield* new MaintenanceWorkHeld({ cause: "review admission held" });
          }
        }),
      };
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provideMerge(NodeServices.layer),
      );

      const interrupted: AgentDashboardAutomationRun = {
        id: "run-interrupted",
        status: "running",
        trigger: "scheduled",
        kind: "repository-review",
        repository: { projectId: PROJECT_ID },
        target: "t3code",
        threadId: THREAD_ID,
        jobId: "job-interrupted",
        model: "gpt-5.6-luna",
        retryCount: 0,
        findingCount: 0,
        costUnits: null,
        error: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        startedAt: "2026-08-10T00:00:01.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
        completedAt: null,
      };
      yield* Effect.gen(function* () {
        const store = yield* AgentDashboardRunHistory.AgentDashboardRunHistory;
        yield* store.upsert(interrupted);
      }).pipe(
        Effect.provide(Layer.provideMerge(AgentDashboardRunHistory.layer, configLayer)),
        Effect.scoped,
      );

      const runHistory = yield* makeObservedRunHistory(baseDir);

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        yield* Deferred.await(admissionChecked);
        yield* Effect.yieldNow;
        const stillInterrupted = (yield* jobService.listRuns).find(
          (item) => item.id === "run-interrupted",
        );
        expect(stillInterrupted?.status).toBe("running");
        expect(stillInterrupted?.updatedAt).toBe(interrupted.updatedAt);

        yield* Ref.set(held, false);
        yield* TestClock.adjust(Duration.seconds(1));
        const terminal = yield* awaitRunWrite(runHistory.writes, "run-interrupted", "succeeded");
        expect(terminal.id).toBe("run-interrupted");
        expect(terminal.status).toBe("succeeded");
        expect(terminal.error).toBeNull();
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            workAdmission,
            runHistory: runHistory.service,
            runner: {
              runReview: () => Effect.succeed(reviewResult),
              runRandomReview: Effect.succeed(reviewResult),
            },
            getShellSnapshot: () =>
              Effect.succeed({
                projects: [
                  {
                    id: PROJECT_ID,
                    title: "t3code",
                    workspaceRoot: baseDir,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-08-01T00:00:00.000Z",
                    updatedAt: "2026-08-01T00:00:00.000Z",
                  },
                ],
                threads: [],
              } as never),
            getThreadDetailById: () =>
              Effect.succeed(
                Option.some({
                  latestTurn: {
                    turnId: "turn-resumed",
                    state: "completed",
                    assistantMessageId: ASSISTANT_ID,
                    requestedAt: "2026-08-10T00:00:00.000Z",
                    startedAt: "2026-08-10T00:00:00.000Z",
                    completedAt: "2026-08-10T00:00:10.000Z",
                  },
                  messages: [{ id: ASSISTANT_ID, role: "assistant", text: sampleFindingMetadata }],
                  activities: [],
                } as never),
              ),
          }),
        ),
        Effect.scoped,
      );
    }),
  );
});

describe("schedule status mapping", () => {
  it("maps automation run status onto the legacy schedule surface", () => {
    const { scheduleStatusFromRun } = AgentDashboardReviewScheduler.__testing;
    expect(
      scheduleStatusFromRun({
        status: "queued",
      } as AgentDashboardAutomationRun),
    ).toBe("running");
    expect(
      scheduleStatusFromRun({
        status: "ingesting",
      } as AgentDashboardAutomationRun),
    ).toBe("running");
    expect(
      scheduleStatusFromRun({
        status: "succeeded",
      } as AgentDashboardAutomationRun),
    ).toBe("completed");
    expect(
      scheduleStatusFromRun({
        status: "partial",
      } as AgentDashboardAutomationRun),
    ).toBe("completed");
    expect(
      scheduleStatusFromRun({
        status: "failed",
      } as AgentDashboardAutomationRun),
    ).toBe("failed");
  });
});

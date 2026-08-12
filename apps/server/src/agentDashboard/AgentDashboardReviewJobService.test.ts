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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentDashboardRunHistory from "./AgentDashboardRunHistory.ts";
import * as AgentDashboardReviewJobService from "./AgentDashboardReviewJobService.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import {
  AgentDashboardReviewRunner,
  type AgentDashboardReviewRunResult,
} from "./AgentDashboardReviewRunner.ts";
import * as AgentDashboardReviewScheduler from "./AgentDashboardReviewScheduler.ts";

const PROJECT_ID = ProjectId.make("project-review-1");
const THREAD_ID = ThreadId.make("thread-review-1");
const ASSISTANT_ID = MessageId.make("assistant-review-1");

const sampleFindingMetadata = [
  'T3_REVIEW_METADATA: {"findings":[{"title":"Parser bug","category":"bug","summary":"Drops the last item","impact":"Import loss","confidence":"high","evidence":["src/parser.ts:42"],"next_step":"Flush before return","github_issue_title":"Fix parser flush","github_issue_body":"## Problem"}]}',
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

describe("parseReviewMetadata", () => {
  it("parses structured findings", () => {
    const parsed = AgentDashboardReviewJobService.parseReviewMetadata(sampleFindingMetadata);
    expect(parsed).toEqual({
      kind: "parsed",
      findings: [
        {
          title: "Parser bug",
          category: "bug",
          summary: "Drops the last item",
          impact: "Import loss",
          confidence: "high",
          evidence: ["src/parser.ts:42"],
          nextStep: "Flush before return",
          githubIssueTitle: "Fix parser flush",
          githubIssueBody: "## Problem",
        },
      ],
    });
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
    ).toEqual({ kind: "parsed", findings: [] });
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
      error: "Repository review completed with zero usable findings.",
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
});

const unusedProjection = {
  getCommandReadModel: () => Effect.die("unused"),
  getSnapshot: () => Effect.die("unused"),
  getShellSnapshot: () => Effect.die("unused"),
  getArchivedShellSnapshot: () => Effect.die("unused"),
  getSnapshotSequence: () => Effect.die("unused"),
  getCounts: () => Effect.die("unused"),
  getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
  getProjectShellById: () => Effect.succeed(Option.none()),
  getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
  getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  getFullThreadDiffContext: () => Effect.succeed(Option.none()),
  getThreadShellById: () => Effect.succeed(Option.none()),
  getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
  searchThreads: () => Effect.succeed({ matches: [] }),
};

const makeTempStateDir = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-adw-03-")));

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
}) =>
  AgentDashboardReviewJobService.layerWithoutDefaults.pipe(
    Layer.provide(Layer.succeed(AgentDashboardReviewRunner, input.runner)),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...unusedProjection,
        getThreadDetailById: input.getThreadDetailById,
      }),
    ),
    Layer.provide(AgentDashboardRunHistory.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(NodeServices.layer),
  );

describe("AgentDashboardReviewJobService lifecycle", () => {
  it.effect("dispatches through ingestion and succeeds only after findings persist", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const workspaceRoot = NodePath.join(baseDir, "repo");
      yield* Effect.tryPromise(() => NodeFSP.mkdir(workspaceRoot, { recursive: true }));

      const turnComplete = yield* Ref.make(false);
      const dispatchCount = yield* Ref.make(0);

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
        const terminal = yield* waitForTerminal(jobService, enqueued.id);
        expect(terminal?.status).toBe("succeeded");
        expect(terminal?.findingCount).toBe(1);
        expect(terminal?.threadId).toEqual(THREAD_ID);
        expect(terminal?.error).toBeNull();
        expect(yield* Ref.get(dispatchCount)).toBe(1);
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

  it.effect("fails truthfully on timeout and supports retry with bounded attempts", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const dispatchCount = yield* Ref.make(0);
      AgentDashboardReviewJobService.__testing.setMonitorTimeoutOverride(Duration.seconds(3));

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const enqueued = yield* jobService.enqueueReview({
          trigger: "scheduled",
          projectId: PROJECT_ID,
          idempotencyKey: "timeout-case",
        });

        const failed = yield* waitForTerminal(jobService, enqueued.id, 200);
        expect(failed?.status).toBe("failed");
        expect(failed?.error).toContain("timed out");

        const retry1 = yield* jobService.retryRun(enqueued.id);
        expect(retry1.trigger).toBe("retry");
        expect(retry1.retryCount).toBe(1);

        yield* waitForTerminal(jobService, retry1.id, 200);

        const retry2 = yield* jobService.retryRun(retry1.id);
        expect(retry2.retryCount).toBe(2);
        yield* waitForTerminal(jobService, retry2.id, 200);

        const overLimit = yield* Effect.flip(jobService.retryRun(retry2.id));
        expect(overLimit.message).toContain("retry limit");
        expect(yield* Ref.get(dispatchCount)).toBeGreaterThanOrEqual(3);
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runner: {
              runReview: () =>
                Ref.updateAndGet(dispatchCount, (count) => count + 1).pipe(
                  Effect.as({ ...reviewResult, workspaceRoot: baseDir }),
                ),
              runRandomReview: Effect.succeed({ ...reviewResult, workspaceRoot: baseDir }),
            },
            getThreadDetailById: () =>
              Effect.succeed(
                Option.some({
                  latestTurn: {
                    turnId: "turn-timeout",
                    state: "running",
                    assistantMessageId: null,
                    requestedAt: "2026-08-10T00:00:00.000Z",
                    startedAt: "2026-08-10T00:00:00.000Z",
                    completedAt: null,
                  },
                  messages: [],
                } as never),
              ),
          }),
        ),
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() =>
            AgentDashboardReviewJobService.__testing.setMonitorTimeoutOverride(null),
          ),
        ),
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

  it.effect("recovers interrupted runs from disk on service start", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempStateDir();
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const store = yield* AgentDashboardRunHistory.AgentDashboardRunHistory;
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
        yield* store.upsert(interrupted);
      }).pipe(
        Effect.provide(Layer.provideMerge(AgentDashboardRunHistory.layer, configLayer)),
        Effect.scoped,
      );

      yield* Effect.gen(function* () {
        const jobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
        const runs = yield* jobService.listRuns;
        expect(runs[0]?.id).toBe("run-interrupted");
        expect(runs[0]?.status).toBe("failed");
        expect(runs[0]?.error).toContain("restarted");
      }).pipe(
        Effect.provide(
          jobServiceLayer({
            baseDir,
            runner: {
              runReview: () => Effect.succeed(reviewResult),
              runRandomReview: Effect.succeed(reviewResult),
            },
            getThreadDetailById: () => Effect.succeed(Option.none()),
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

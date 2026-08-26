// @effect-diagnostics globalDate:off - schedule normalization is intentionally tested with fixed timestamps.
import { it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentDashboardAutomationRun,
  type AgentDashboardReviewSchedule,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { expect } from "vite-plus/test";

import * as AgentDashboardReviewScheduler from "./AgentDashboardReviewScheduler.ts";

it("starts consolidated portfolio coverage immediately on a two-hour cadence", () => {
  const now = Date.parse("2026-08-09T23:00:00.000Z");
  const schedule = AgentDashboardReviewScheduler.__testing.defaultSchedule(now);

  expect(AgentDashboardReviewScheduler.__testing.intervalMs).toBe(2 * 60 * 60 * 1_000);
  expect(schedule).toMatchObject({
    enabled: true,
    intervalMinutes: 120,
    nextRunAt: "2026-08-09T23:00:00.000Z",
    lastStatus: "idle",
    lastCoveredTypes: [],
    lastSuccessfulTypes: [],
  });
});

it("makes an interrupted T3 review due immediately after restart", () => {
  const schedule = AgentDashboardReviewScheduler.__testing.normalizeSchedule(
    {
      enabled: true,
      nextRunAt: "2026-08-10T01:00:00.000Z",
      lastStatus: "running",
      heartbeatAt: "2026-08-09T23:30:00.000Z",
      runCount: 2,
    },
    Date.parse("2026-08-10T00:00:00.000Z"),
  );

  expect(schedule).toMatchObject({
    lastStatus: "failed",
    nextRunAt: "2026-08-10T00:00:00.000Z",
    lastError: "T3 restarted before the findings portfolio cycle completed.",
  });
});

it("makes a failed T3 review due immediately after restart", () => {
  const schedule = AgentDashboardReviewScheduler.__testing.normalizeSchedule(
    {
      enabled: true,
      nextRunAt: "2026-08-10T02:00:00.000Z",
      lastStatus: "failed",
      lastError: "Repository review output was missing structured findings metadata.",
      heartbeatAt: "2026-08-09T23:55:00.000Z",
      runCount: 3,
    },
    Date.parse("2026-08-10T00:00:00.000Z"),
  );

  expect(schedule).toMatchObject({
    lastStatus: "failed",
    nextRunAt: "2026-08-10T00:00:00.000Z",
    lastError: "Repository review output was missing structured findings metadata.",
  });
});

it("applies qualification enablement and cadence changes to the next run", () => {
  const now = Date.parse("2026-08-10T00:00:00.000Z");
  const disabled = {
    ...AgentDashboardReviewScheduler.__testing.defaultSchedule(now),
    enabled: false,
    nextRunAt: "2026-08-10T04:00:00.000Z",
  };

  expect(
    AgentDashboardReviewScheduler.__testing.syncScheduleSettings(
      disabled,
      {
        enabled: true,
        intervalMinutes: 30,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-luna",
        },
      },
      now,
    ),
  ).toMatchObject({
    enabled: true,
    intervalMinutes: 30,
    nextRunAt: "2026-08-10T00:00:00.000Z",
  });

  expect(
    AgentDashboardReviewScheduler.__testing.syncScheduleSettings(
      { ...disabled, enabled: true },
      {
        enabled: true,
        intervalMinutes: 30,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-luna",
        },
      },
      now,
    ).nextRunAt,
  ).toBe("2026-08-10T00:30:00.000Z");
});

it("counts a queued deep review exactly once when it completes", () => {
  const startedAt = "2026-08-10T00:00:00.000Z";
  const startedAtMs = Date.parse(startedAt);
  const queued: AgentDashboardAutomationRun = {
    id: "review-run-1",
    status: "queued",
    trigger: "scheduled",
    kind: "repository-review",
    repository: { projectId: ProjectId.make("project-1") },
    target: "Project one",
    threadId: null,
    jobId: null,
    model: null,
    retryCount: 0,
    findingCount: 0,
    costUnits: null,
    error: null,
    createdAt: startedAt,
    startedAt: null,
    updatedAt: startedAt,
    completedAt: null,
  };
  const collected = {
    ...AgentDashboardReviewScheduler.__testing.defaultSchedule(startedAtMs),
    lastFindingCount: 4,
  };
  const running = AgentDashboardReviewScheduler.__testing.scheduleFromRun(
    collected,
    queued,
    startedAtMs,
    startedAt,
  );
  const completed = AgentDashboardReviewScheduler.__testing.scheduleFromRun(
    running,
    {
      ...queued,
      status: "succeeded",
      threadId: ThreadId.make("review-thread-1"),
      findingCount: 2,
      updatedAt: "2026-08-10T00:01:00.000Z",
      completedAt: "2026-08-10T00:01:00.000Z",
    },
    startedAtMs,
    startedAt,
  );
  const replayed = AgentDashboardReviewScheduler.__testing.scheduleFromRun(
    completed,
    {
      ...queued,
      status: "succeeded",
      threadId: ThreadId.make("review-thread-1"),
      findingCount: 2,
      updatedAt: "2026-08-10T00:01:00.000Z",
      completedAt: "2026-08-10T00:01:00.000Z",
    },
    startedAtMs,
    startedAt,
  );

  expect(running.lastFindingCount).toBe(4);
  expect(running.lastCoveredTypes).toEqual([]);
  expect(completed.lastFindingCount).toBe(6);
  expect(completed.lastSuccessfulTypes).toEqual([
    "bug",
    "security",
    "research",
    "improvement",
    "review",
    "operations",
  ]);
  expect(replayed.lastFindingCount).toBe(6);
});

it("preserves prior coverage when deep-review dispatch fails", () => {
  const startedAt = "2026-08-10T00:00:00.000Z";
  const startedAtMs = Date.parse(startedAt);
  const current: AgentDashboardReviewSchedule = {
    ...AgentDashboardReviewScheduler.__testing.defaultSchedule(startedAtMs),
    lastCoveredTypes: ["bug", "security"],
    lastSuccessfulTypes: ["security"],
  };
  const failed: AgentDashboardAutomationRun = {
    id: "review-dispatch-failure",
    status: "failed",
    trigger: "scheduled",
    kind: "repository-review",
    repository: { projectId: ProjectId.make("project-1") },
    target: "Project one",
    threadId: null,
    jobId: "review-dispatch-failure",
    model: null,
    retryCount: 0,
    findingCount: 0,
    costUnits: null,
    error: "Repository review dispatch failed.",
    createdAt: startedAt,
    startedAt,
    updatedAt: "2026-08-10T00:01:00.000Z",
    completedAt: "2026-08-10T00:01:00.000Z",
  };

  const next = AgentDashboardReviewScheduler.__testing.scheduleFromRun(
    current,
    failed,
    startedAtMs,
    startedAt,
  );

  expect(next.lastStatus).toBe("failed");
  expect(next.lastCoveredTypes).toEqual(current.lastCoveredTypes);
  expect(next.lastSuccessfulTypes).toEqual(current.lastSuccessfulTypes);
});

it("does not claim deep-review coverage for a cancelled run before dispatch", () => {
  const startedAt = "2026-08-10T00:00:00.000Z";
  const startedAtMs = Date.parse(startedAt);
  const current = AgentDashboardReviewScheduler.__testing.defaultSchedule(startedAtMs);
  const cancelled: AgentDashboardAutomationRun = {
    id: "review-cancelled-before-dispatch",
    status: "cancelled",
    trigger: "scheduled",
    kind: "repository-review",
    repository: { projectId: ProjectId.make("project-1") },
    target: "Project one",
    threadId: null,
    jobId: "review-cancelled-before-dispatch",
    model: null,
    retryCount: 0,
    findingCount: 0,
    costUnits: null,
    error: "Repository review was cancelled before dispatch.",
    createdAt: startedAt,
    startedAt: null,
    updatedAt: "2026-08-10T00:01:00.000Z",
    completedAt: "2026-08-10T00:01:00.000Z",
  };

  const next = AgentDashboardReviewScheduler.__testing.scheduleFromRun(
    current,
    cancelled,
    startedAtMs,
    startedAt,
  );

  expect(next.lastCoveredTypes).toEqual([]);
  expect(next.lastSuccessfulTypes).toEqual([]);
});

it("counts a completed [SILENT] review as successful deep-review coverage", () => {
  const startedAt = "2026-08-10T00:00:00.000Z";
  const startedAtMs = Date.parse(startedAt);
  const current = AgentDashboardReviewScheduler.__testing.defaultSchedule(startedAtMs);
  const partial: AgentDashboardAutomationRun = {
    id: "review-silent",
    status: "partial",
    trigger: "scheduled",
    kind: "repository-review",
    repository: { projectId: ProjectId.make("project-1") },
    target: "Project one",
    threadId: ThreadId.make("review-silent-thread"),
    jobId: "review-silent",
    model: null,
    retryCount: 0,
    findingCount: 0,
    costUnits: null,
    error: "Repository review completed with [SILENT] (nothing new to report).",
    createdAt: startedAt,
    startedAt,
    updatedAt: "2026-08-10T00:01:00.000Z",
    completedAt: "2026-08-10T00:01:00.000Z",
  };

  const next = AgentDashboardReviewScheduler.__testing.scheduleFromRun(
    current,
    partial,
    startedAtMs,
    startedAt,
  );

  expect(next.lastSuccessfulTypes).toEqual([
    "bug",
    "security",
    "research",
    "improvement",
    "review",
    "operations",
  ]);
});

it("counts duplicate-only partial output as completed deep-review coverage", () => {
  const startedAt = "2026-08-10T00:00:00.000Z";
  const startedAtMs = Date.parse(startedAt);
  const current = AgentDashboardReviewScheduler.__testing.defaultSchedule(startedAtMs);
  const partial: AgentDashboardAutomationRun = {
    id: "review-duplicates",
    status: "partial",
    trigger: "scheduled",
    kind: "repository-review",
    repository: { projectId: ProjectId.make("project-1") },
    target: "Project one",
    threadId: ThreadId.make("review-duplicates-thread"),
    jobId: "review-duplicates",
    model: null,
    retryCount: 0,
    findingCount: 0,
    costUnits: null,
    error: "Structured findings did not change the portfolio.",
    createdAt: startedAt,
    startedAt,
    updatedAt: "2026-08-10T00:01:00.000Z",
    completedAt: "2026-08-10T00:01:00.000Z",
  };

  const next = AgentDashboardReviewScheduler.__testing.scheduleFromRun(
    current,
    partial,
    startedAtMs,
    startedAt,
  );

  expect(next.lastCoveredTypes).toEqual([
    "bug",
    "security",
    "research",
    "improvement",
    "review",
    "operations",
  ]);
  expect(next.lastSuccessfulTypes).toEqual([
    "bug",
    "security",
    "research",
    "improvement",
    "review",
    "operations",
  ]);
});

it.effect("does not let a heartbeat restore stale running state after a terminal update", () =>
  Effect.gen(function* () {
    const initial: AgentDashboardReviewSchedule = {
      ...AgentDashboardReviewScheduler.__testing.defaultSchedule(
        Date.parse("2026-08-10T00:00:00.000Z"),
      ),
      lastStatus: "running" as const,
    };
    const stateRef = yield* SynchronizedRef.make(initial);
    const terminalPersistStarted = yield* Deferred.make<void>();
    const releaseTerminalPersist = yield* Deferred.make<void>();
    const writes = yield* Ref.make<Array<AgentDashboardReviewSchedule>>([]);

    const persist = (state: AgentDashboardReviewSchedule) =>
      Effect.gen(function* () {
        if (state.lastStatus === "failed") {
          yield* Deferred.succeed(terminalPersistStarted, undefined);
          yield* Deferred.await(releaseTerminalPersist);
        }
        yield* Ref.update(writes, (current) => [...current, state]);
      });

    const terminalFiber = yield* AgentDashboardReviewScheduler.__testing
      .modifyPersistedSchedule(stateRef, persist, (current) => [
        undefined,
        {
          ...current,
          lastStatus: "failed" as const,
          lastCompletedAt: "2026-08-10T00:30:00.000Z",
          heartbeatAt: "2026-08-10T00:30:00.000Z",
        },
      ])
      .pipe(Effect.forkChild);

    yield* Deferred.await(terminalPersistStarted);
    const heartbeatFiber = yield* AgentDashboardReviewScheduler.__testing
      .modifyPersistedSchedule(stateRef, persist, (current) => [
        undefined,
        { ...current, heartbeatAt: "2026-08-10T00:30:30.000Z" },
      ])
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseTerminalPersist, undefined);
    yield* Fiber.join(terminalFiber);
    yield* Fiber.join(heartbeatFiber);

    expect((yield* SynchronizedRef.get(stateRef)).lastStatus).toBe("failed");
    expect((yield* Ref.get(writes)).map((state) => state.lastStatus)).toEqual(["failed", "failed"]);
  }),
);

it.effect("parses the native metadata contract", () =>
  Effect.sync(() => {
    const findings = AgentDashboardReviewScheduler.__testing.parseReviewMetadata(
      [
        'T3_REVIEW_METADATA: {"findings":[{"title":"Parser bug","type":"bug","category":"parser","summary":"Drops the last item","impact":"Import loss","confidence":"high","evidence":["src/parser.ts:42"],"next_step":"Flush before return","github_issue_title":"Fix parser flush","github_issue_body":"## Problem"}]}',
        "# Random Codebase Review",
      ].join("\n"),
    );

    expect(findings).toEqual([
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
    ]);
  }),
);

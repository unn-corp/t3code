import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  storageCleanupEvidenceExpired,
  storageCleanupActivityAt,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("conversation evidence retention eligibility", () => {
  const rules = { ...DEFAULT_SERVER_SETTINGS.storageCleanup, conversationEvidenceAfterDays: 8 };

  it("retains evidence until a user enables cleanup", () => {
    expect(
      storageCleanupEvidenceExpired(
        shell({ archivedAt: at(-DAY_MS) }),
        DEFAULT_SERVER_SETTINGS.storageCleanup,
        NOW_MS,
        NOW_MS - 30 * DAY_MS,
      ),
    ).toBe(false);
  });

  it("expires old evidence in root conversations and retains files at the cutoff", () => {
    expect(storageCleanupEvidenceExpired(shell(), rules, NOW_MS, NOW_MS - 9 * DAY_MS)).toBe(true);
    expect(storageCleanupEvidenceExpired(shell(), rules, NOW_MS, NOW_MS - 8 * DAY_MS)).toBe(false);
  });

  it("archive cleanup removes fresh evidence only from archived threads", () => {
    const archiveRules = {
      ...rules,
      conversationEvidenceAfterDays: null,
      conversationEvidenceOnArchive: true,
    };
    expect(
      storageCleanupEvidenceExpired(shell({ archivedAt: at(0) }), archiveRules, NOW_MS, NOW_MS),
    ).toBe(true);
    expect(storageCleanupEvidenceExpired(shell(), archiveRules, NOW_MS, NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains evidence while a conversation is %s",
    (status) => {
      expect(storageCleanupEvidenceExpired(shell({ status }), rules, NOW_MS, 0)).toBe(false);
    },
  );

  it("retains background work and pending questions after the root run ends", () => {
    expect(
      storageCleanupEvidenceExpired(
        shell({ pendingBackgroundTasks: [{ taskId: "work", kind: "command" }] }),
        rules,
        NOW_MS,
        0,
      ),
    ).toBe(false);
    expect(
      storageCleanupEvidenceExpired(
        shell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("question"),
            kind: "user_input",
            createdAt: at(-1000),
          },
        }),
        rules,
        NOW_MS,
        0,
      ),
    ).toBe(false);
  });

  it("retains an active run and queued prompt", () => {
    expect(
      storageCleanupEvidenceExpired(shell({ activeRunId: RunId.make("run") }), rules, NOW_MS, 0),
    ).toBe(false);
    expect(
      storageCleanupEvidenceExpired(shell({ latestUserMessageAt: at(-1_000) }), rules, NOW_MS, 0),
    ).toBe(false);
  });
});

// Exercise the worker with real temporary files and SQL, without touching live user data.
import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MaintenanceWorkHeld, WorkAdmission } from "./maintenance/WorkAdmission.ts";
import * as ConversationEvidence from "./assets/ConversationEvidence.ts";
import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as StorageCleanup from "./storageCleanup.ts";

const EvidenceTestLayer = ConversationEvidence.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-evidence-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

effectIt.effect(
  "cleans on archive events, defers busy threads, and honors disabling a saved policy",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fs = yield* FileSystem.FileSystem;
      const evidence = yield* ConversationEvidence.ConversationEvidence;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, deleted_at TEXT)`;
      const checked = yield* Deferred.make<void>();
      const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
      const subscription = yield* PubSub.subscribe(events);
      const settingsLayer = Settings.layerTest({
        storageCleanup: { conversationEvidenceOnArchive: true },
      });
      let awaitingArchiveEvent = false;
      let thread = shell();
      const deleted = shell({ id: ThreadId.make("deleted"), deletedAt: at(0) });
      const terminalListeners: Array<
        Parameters<TerminalManager.TerminalManager["Service"]["subscribeMetadata"]>[0]
      > = [];
      const mockDependencies = Layer.mergeAll(
        settingsLayer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromSubscription(subscription),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.sync(() => ({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [thread],
              archivedThreads: [],
            })),
          getThreadShell: (id) =>
            Effect.gen(function* () {
              if (id === deleted.id) return null;
              if (awaitingArchiveEvent && thread.archivedAt !== null && thread.activeRunId === null)
                yield* Deferred.succeed(checked, undefined);
              return thread;
            }),
          getThreadProjection: () =>
            Effect.succeed({
              thread: { ...deleted, lastVisitedAt: null },
              runs: [],
              attempts: [],
              nodes: [],
              subagents: [],
              providerSessions: [],
              providerThreads: [],
              providerTurns: [],
              runtimeRequests: [],
              messages: [],
              plans: [],
              turnItems: [],
              checkpointScopes: [],
              checkpoints: [],
              contextHandoffs: [],
              contextTransfers: [],
              visibleTurnItems: [],
              updatedAt: at(0),
            }),
        }),
        Layer.mock(GitManager.GitManager)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(TerminalManager.TerminalManager)({
          subscribeMetadata: (listener) =>
            Effect.sync(() => {
              terminalListeners.push(listener);
              return () => {};
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        expect((yield* settings.getSettings).storageCleanup.conversationEvidenceOnArchive).toBe(
          true,
        );
        const cleanup = yield* StorageCleanup.make;
        const saved = yield* evidence.saveScreenshot(
          thread.id,
          "https://example.test",
          new Uint8Array([1]),
        );
        thread = shell({ archivedAt: at(0) });
        const fencedAdmission = {
          acquire: Effect.fail(new MaintenanceWorkHeld({ cause: "maintenance fence" })),
          acquirePassive: Effect.fail(new MaintenanceWorkHeld({ cause: "maintenance fence" })),
          check: Effect.fail(new MaintenanceWorkHeld({ cause: "maintenance fence" })),
        };
        const fencedSweep = yield* Effect.exit(
          cleanup.sweep().pipe(Effect.provideService(WorkAdmission, fencedAdmission)),
        );
        expect(fencedSweep._tag).toBe("Failure");
        expect(yield* fs.exists(saved)).toBe(true);
        thread = shell();
        yield* cleanup.start();
        yield* Effect.yieldNow;
        yield* cleanup.drain;
        expect(yield* fs.exists(saved)).toBe(true);
        // Busy archived threads keep their evidence, even when the archive rule is enabled.
        thread = shell({ archivedAt: at(0), activeRunId: RunId.make("active") });
        yield* cleanup.sweep();
        expect(yield* fs.exists(saved)).toBe(true);
        thread = shell({ archivedAt: at(0) });
        const terminal = {
          threadId: thread.id,
          terminalId: "terminal",
          cwd: "/project",
          worktreePath: null,
          status: "running" as const,
          hasRunningSubprocess: true,
          pid: 1,
          exitCode: null,
          exitSignal: null,
          label: "work",
          updatedAt: "2026-06-10T12:00:00.000Z",
        };
        yield* terminalListeners[0]!({ type: "upsert", terminal });
        yield* cleanup.sweep();
        expect(yield* fs.exists(saved)).toBe(true);
        // The shell may execute same-PID builtins without a reported child process.
        yield* terminalListeners[0]!({
          type: "upsert",
          terminal: { ...terminal, hasRunningSubprocess: false },
        });
        awaitingArchiveEvent = true;
        yield* PubSub.publish(events, {
          id: EventId.make("archive"),
          threadId: thread.id,
          type: "thread.archived",
          occurredAt: at(0),
          payload: { ...thread, lastVisitedAt: null },
        });
        yield* Effect.yieldNow;
        yield* Deferred.await(checked);
        yield* cleanup.drain;
        expect(yield* fs.exists(saved)).toBe(true);
        // Closing the shell removes the unobservable command state, so retention may proceed.
        yield* terminalListeners[0]!({
          type: "upsert",
          terminal: { ...terminal, status: "exited", hasRunningSubprocess: false },
        });
        yield* cleanup.sweep();
        expect(yield* fs.exists(saved)).toBe(false);
        const next = yield* evidence.saveScreenshot(
          thread.id,
          "https://example.test",
          new Uint8Array([2]),
        );
        yield* settings.updateSettings({
          storageCleanup: { conversationEvidenceOnArchive: false },
        });
        yield* cleanup.sweep();
        expect(yield* fs.exists(next)).toBe(true);
        const oldDeleted = yield* evidence.saveScreenshot(
          deleted.id,
          "https://example.test",
          new Uint8Array([3]),
        );
        const now = yield* Clock.currentTimeMillis;
        yield* fs.utimes(oldDeleted, (now - 9 * DAY_MS) / 1000, (now - 9 * DAY_MS) / 1000);
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${deleted.id}, 'deleted')`;
        yield* settings.updateSettings({ storageCleanup: { conversationEvidenceAfterDays: 8 } });
        yield* cleanup.sweep();
        expect(yield* fs.exists(oldDeleted)).toBe(false);
        expect(yield* fs.exists(next)).toBe(true);
      }).pipe(Effect.provide(mockDependencies));
    }).pipe(Effect.provide(EvidenceTestLayer)),
);

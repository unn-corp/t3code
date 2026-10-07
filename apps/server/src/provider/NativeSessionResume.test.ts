import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  emptyProjection,
  applyToProjection,
  threadShellFromProjection,
} from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { discoverAgentSessions } from "./agentSessionDiscovery.ts";
import { listNativeSessions, resumeNativeSession } from "./NativeSessionResume.ts";

vi.mock("./agentSessionDiscovery.ts", () => ({
  discoverAgentSessions: vi.fn(async () => [
    { sessionId: "native-session", rolloutPath: "/tmp/native-session.jsonl", cwd: "/project" },
  ]),
}));
vi.mock("./agentTranscript.ts", () => ({
  readAgentTranscript: vi.fn(async () => ({
    turns: [
      { role: "user", text: "Original task" },
      { role: "assistant", text: "Original answer" },
    ],
    omittedTurnCount: 3,
  })),
}));

const now = DateTime.makeUnsafe("2026-10-02T12:00:00Z");
const threadId = ThreadId.make("resume-thread");
const instanceId = ProviderInstanceId.make("codex-work");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("resume-project"),
  title: "Resume",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const input = {
  threadId,
  providerInstanceId: instanceId,
  sessionId: "native-session",
  driver: "codex",
};
function fixture() {
  let projection = emptyProjection({
    id: EventId.make("created"),
    threadId,
    type: "thread.created",
    occurredAt: now,
    payload: thread,
  });
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const instance = {
    instanceId,
    enabled: true,
    driverKind: ProviderDriverKind.make("codex"),
    snapshot: {
      getSnapshot: Effect.succeed({ models: [{ slug: "gpt-6-luna", isDefault: true }] }),
    },
  } as unknown as ProviderInstance;
  const layer = Layer.mergeAll(
    NodeSqliteClient.layer({ filename: ":memory:" }),
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: "/isolated/codex-work" },
            enabled: true,
          },
        },
      }),
    }),
    Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
    Layer.mock(ThreadManagementService)({
      getThreadShell: () => Effect.succeed(threadShellFromProjection(projection)),
      getThreadProjection: () => Effect.succeed(projection),
    }),
    Layer.mock(EventSinkV2)({
      commitCommand: (command) =>
        Effect.sync(() => {
          writes.push(command.events);
          for (const event of command.events) projection = applyToProjection(projection, event);
          return {
            receipt: {
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: command.commandType,
              acceptedAt: command.acceptedAt,
              resultSequence: writes.length,
              status: "accepted" as const,
              error: null,
            },
            storedEvents: [],
            committed: true,
            cancelledEffectCount: 0,
          };
        }),
    }),
  );
  return { layer, writes, projection: () => projection };
}

it.effect("binds the selected account's native session and imports history once", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT PRIMARY KEY, thread_id TEXT)`;
    yield* listNativeSessions(input);
    expect(discoverAgentSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ home: "/isolated/codex-work", driver: "codex" }),
    );
    expect(yield* resumeNativeSession(input)).toMatchObject({
      bound: true,
      importedMessageCount: 2,
      omittedTurnCount: 3,
    });
    expect(f.projection().thread.modelSelection).toEqual({ instanceId, model: "gpt-6-luna" });
    expect(f.projection().providerThreads[0]?.nativeThreadRef).toMatchObject({
      nativeId: "native-session",
      strength: "strong",
    });
    expect(f.projection().messages.map((message) => message.text)).toEqual([
      "Original task",
      "Original answer",
    ]);
    expect(yield* resumeNativeSession(input)).toMatchObject({
      bound: true,
      importedMessageCount: 0,
    });
    expect(f.projection().messages).toHaveLength(2);
  }).pipe(Effect.provide(f.layer));
});

it.effect("refuses to steal a native session owned by another T3 conversation", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = yield* IdAllocator.IdAllocatorV2;
    yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT PRIMARY KEY, thread_id TEXT)`;
    const id = ids.derive.providerThread({
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      nativeThreadId: input.sessionId,
    });
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES(${id}, 'other-thread')`;
    const error = yield* Effect.flip(resumeNativeSession(input));
    expect(error.message).toContain("already attached to another Arcwright Code thread");
    expect(f.writes).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

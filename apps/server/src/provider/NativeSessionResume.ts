// @effect-diagnostics nodeBuiltinImport:off
import {
  CommandId,
  EventId,
  NativeSessionResumeError,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeOS from "node:os";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { discoverAgentSessions } from "../provider/agentSessionDiscovery.ts";
import { readAgentTranscript } from "../provider/agentTranscript.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { ThreadCommandExecutor } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { agentSessionMessageEvents } from "../project/AgentSessionImporter.ts";
import { CodexSessionsListInput, CodexSessionsResumeInput } from "@t3tools/contracts";
const resolveSource = (instanceId?: string, driverHint?: string) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const instances = yield* ProviderInstanceRegistry;
    const current = yield* settings.getSettings;
    const instance =
      instanceId === undefined
        ? undefined
        : yield* instances.getInstance(ProviderInstanceId.make(instanceId));
    const driver = driverHint ?? instance?.driverKind ?? "codex";
    const config =
      instanceId === undefined
        ? undefined
        : current.providerInstances[ProviderInstanceId.make(instanceId)];
    const providerSettings =
      config?.driver === driver
        ? config.config
        : current.providers[driver as keyof typeof current.providers];
    const homePath =
      typeof providerSettings === "object" &&
      providerSettings !== null &&
      "homePath" in providerSettings &&
      typeof providerSettings.homePath === "string"
        ? providerSettings.homePath.trim()
        : "";
    const defaults: Record<string, string> = {
      codex: ".codex",
      claudeAgent: ".claude",
      claude: ".claude",
      grok: ".grok",
      hermes: ".hermes",
    };
    const home = homePath
      ? expandHomePath(homePath)
      : defaults[driver] === undefined
        ? undefined
        : `${NodeOS.homedir()}/${defaults[driver]}`;
    return { driver, home, instance };
  });
export const listNativeSessions = (input: typeof CodexSessionsListInput.Type) =>
  Effect.gen(function* () {
    const { driver, home } = yield* resolveSource(input.providerInstanceId, input.driver).pipe(
      Effect.orElseSucceed(() => ({ driver: input.driver ?? "codex", home: undefined })),
    );
    const sessions = yield* Effect.promise(() =>
      discoverAgentSessions({
        driver,
        ...(home === undefined ? {} : { home }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    );
    return {
      sessions: sessions.map(({ sessionId, cwd, originator, cliVersion, startedAt, preview }) => ({
        sessionId,
        ...(cwd === undefined ? {} : { cwd }),
        ...(originator === undefined ? {} : { originator }),
        ...(cliVersion === undefined ? {} : { cliVersion }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(preview === undefined ? {} : { preview }),
      })),
    };
  });
export const resumeNativeSession = (input: typeof CodexSessionsResumeInput.Type) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const events = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const executor = yield* ThreadCommandExecutor;
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.gen(function* () {
      const threadId = ThreadId.make(input.threadId);
      const { driver, home, instance } = yield* resolveSource(
        input.providerInstanceId,
        input.driver,
      );
      if (instance === undefined || !instance.enabled || instance.driverKind !== driver)
        return yield* new NativeSessionResumeError({
          message: "Choose an enabled provider account for this session.",
        });
      const discovered = yield* Effect.promise(() =>
        discoverAgentSessions({
          driver,
          ...(home === undefined ? {} : { home }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          limit: 200,
        }),
      );
      const source = discovered.find((entry) => entry.sessionId === input.sessionId);
      if (source === undefined)
        return yield* new NativeSessionResumeError({
          message: "This session is no longer available in the selected provider account.",
        });
      const transcript = yield* Effect.promise(() =>
        readAgentTranscript({ driver, path: source.rolloutPath }),
      );
      return yield* executor.withLock(
        threadId,
        sql.withTransaction(
          Effect.gen(function* () {
            const shell = yield* threads.getThreadShell(threadId);
            if (shell === null)
              return yield* new NativeSessionResumeError({
                message: "Create the thread before resuming a provider session.",
              });
            if (["preparing", "queued", "starting", "running", "waiting"].includes(shell.status))
              return yield* new NativeSessionResumeError({
                message: "Interrupt the current run before resuming another session.",
              });
            const projection = yield* threads.getThreadProjection(threadId);
            const now = yield* DateTime.now;
            const providerThreadId = ids.derive.providerThread({
              driver: ProviderDriverKind.make(driver),
              providerInstanceId: instance.instanceId,
              nativeThreadId: input.sessionId,
            });
            const owners = yield* sql<{
              readonly thread_id: string;
            }>`SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${providerThreadId}`;
            if (owners.some((owner) => owner.thread_id !== threadId))
              return yield* new NativeSessionResumeError({
                message:
                  "This native session is already attached to another Arcwright Code thread. Open that thread to continue it.",
              });
            const snapshot = yield* instance.snapshot.getSnapshot;
            const sameInstance =
              projection.thread.modelSelection.instanceId === instance.instanceId;
            const model = sameInstance
              ? projection.thread.modelSelection
              : {
                  instanceId: instance.instanceId,
                  model:
                    snapshot.models.find((model) => model.isDefault)?.slug ??
                    snapshot.models[0]?.slug ??
                    projection.thread.modelSelection.model,
                };
            const existing = projection.providerThreads.find(
              (entry) => entry.id === providerThreadId,
            );
            const providerThread: OrchestrationV2ProviderThread = {
              id: providerThreadId,
              driver: instance.driverKind,
              providerInstanceId: instance.instanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: instance.driverKind,
                nativeId: input.sessionId,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            };
            const importedPrefix = `resume:${instance.instanceId}:${input.sessionId}:`;
            const alreadyImported = projection.messages.some((message) =>
              message.id.startsWith(`${threadId}:${importedPrefix}`),
            );
            const importedEvents = alreadyImported
              ? []
              : transcript.turns.flatMap((turn, index) =>
                  agentSessionMessageEvents({
                    threadId,
                    index,
                    idPrefix: importedPrefix,
                    startOrdinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)),
                    message: {
                      role: turn.role,
                      text: turn.text,
                      createdAt: turn.timestamp ?? DateTime.formatIso(now),
                    },
                  }),
                );
            const nativeEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
              {
                id: EventId.make(`resume:${threadId}:${DateTime.toEpochMillis(now)}:provider`),
                threadId,
                occurredAt: now,
                type: "provider-thread.updated",
                payload: providerThread,
              },
              {
                id: EventId.make(`resume:${threadId}:${DateTime.toEpochMillis(now)}:thread`),
                threadId,
                occurredAt: now,
                type: "thread.provider-switched",
                payload: {
                  ...projection.thread,
                  providerInstanceId: instance.instanceId,
                  modelSelection: model,
                  activeProviderThreadId: providerThreadId,
                  updatedAt: now,
                },
              },
              ...importedEvents,
            ];
            yield* events.commitCommand({
              commandId: CommandId.make(
                `resume:${threadId}:${instance.instanceId}:${input.sessionId}:${DateTime.toEpochMillis(now)}`,
              ),
              threadId,
              commandType: "codexSessions.resume",
              acceptedAt: now,
              events: nativeEvents,
              effects: [],
            });
            return {
              bound: true,
              importedMessageCount: alreadyImported ? 0 : transcript.turns.length,
              omittedTurnCount: transcript.omittedTurnCount,
            };
          }),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(NativeSessionResumeError)(cause)
          ? cause
          : new NativeSessionResumeError({
              message: "The provider session could not be resumed.",
              cause,
            }),
      ),
    );
  });

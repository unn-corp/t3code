import {
  CommandId,
  MessageId,
  type DiscordBridgeSettings,
  type OrchestrationV2DomainEvent,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { DiscordBridgeLinkRepository } from "../../persistence/DiscordBridgeLinks.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectionSnapshotQuery } from "../../agentDashboard/AutomationSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../agentDashboard/AutomationOrchestration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { retryAutomationWork, withAutomationWork } from "../../maintenance/WorkAdmission.ts";
import {
  DiscordRestClient,
  isArchivedError,
  isAuthError,
  isGoneError,
  type DiscordMessage,
  type DiscordRestError,
} from "../DiscordRestClient.ts";
import {
  buildHeaderEmbed,
  isDiscordOriginatedMessageId,
  planChunks,
  threadNameFor,
  withStreamingCursor,
  type HeaderStatus,
} from "../render.ts";
import { DiscordBridge, type DiscordBridgeShape } from "../Services/DiscordBridge.ts";

/** Minimum gap between edits of the same Discord message while streaming. */
const EDIT_INTERVAL_MS = 2000;
/** Skip a streaming flush that would add fewer characters than this. */
const MIN_DELTA_CHARS = 24;
/** Inbound poll cadence. */
const POLL_INTERVAL = Duration.seconds(3);

type BridgeWork =
  | { readonly kind: "thread-created"; readonly threadId: ThreadId }
  | { readonly kind: "message"; readonly threadId: ThreadId; readonly messageId: MessageId }
  | { readonly kind: "header"; readonly threadId: ThreadId }
  | { readonly kind: "activity"; readonly threadId: ThreadId; readonly text: string }
  | {
      readonly kind: "lifecycle";
      readonly threadId: ThreadId;
      readonly action: "archived" | "unarchived" | "deleted";
    };

export const eventToWork = (
  event: OrchestrationV2DomainEvent,
  mirrorActivity: boolean,
): BridgeWork | null => {
  const threadId = event.threadId;
  switch (event.type) {
    case "thread.created":
      return { kind: "thread-created", threadId };
    case "message.updated":
      return { kind: "message", threadId, messageId: event.payload.id };
    case "thread.archived":
      return { kind: "lifecycle", threadId, action: "archived" };
    case "thread.unarchived":
      return { kind: "lifecycle", threadId, action: "unarchived" };
    case "thread.deleted":
      return { kind: "lifecycle", threadId, action: "deleted" };
    case "runtime-request.updated":
      return mirrorActivity
        ? {
            kind: "activity",
            threadId,
            text: `⏸ ${event.payload.kind.replaceAll("_", " ")} requested`,
          }
        : null;
    case "plan.updated":
      return mirrorActivity ? { kind: "activity", threadId, text: "📋 plan updated" } : null;
    case "thread.metadata-updated":
    case "thread.runtime-mode-updated":
    case "thread.provider-switched":
    case "run.updated":
    case "provider-session.updated":
      return { kind: "header", threadId };
    default:
      return null;
  }
};

const statusOf = (thread: OrchestrationThread): HeaderStatus => {
  const status = thread.session?.status;
  return status === undefined || status === null ? "idle" : (status as HeaderStatus);
};

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const links = yield* DiscordBridgeLinkRepository;
  const threads = yield* ThreadManagementService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const rest = yield* DiscordRestClient;

  /** messageId -> epoch millis of the last successful flush. */
  const lastFlushAt = yield* Ref.make(new Map<string, number>());

  const readConfig = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.discordBridge),
    Effect.orElseSucceed(() => null as DiscordBridgeSettings | null),
  );

  const threadDetail = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(Effect.orElseSucceed(() => Option.none()));

  const headerFor = (thread: OrchestrationThread, config: DiscordBridgeSettings) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      const displayName =
        settings === null ? null : (settings.providerInstances[instanceId]?.displayName ?? null);
      const project = yield* snapshots
        .getProjectShellById(thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const deepLink =
        config.publicOrigin === ""
          ? null
          : `${config.publicOrigin.replace(/\/$/, "")}/threads/${thread.id}`;
      return buildHeaderEmbed({
        title: thread.title,
        threadId: thread.id,
        model: thread.modelSelection.model,
        instanceId,
        instanceDisplayName: displayName,
        projectTitle: Option.isSome(project) ? (project.value.title ?? null) : null,
        branch: thread.branch ?? null,
        runtimeMode: thread.runtimeMode,
        status: statusOf(thread),
        deepLink,
        createdAt: thread.createdAt,
      });
    });

  /** Mark a link orphaned/archived rather than retrying forever. */
  const handleRestError = (threadId: ThreadId, error: DiscordRestError) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      if (isGoneError(error)) {
        // A deleted Discord thread means "stop mirroring this". Never recreate.
        yield* withAutomationWork(
          links.setState({ threadId, state: "orphaned", updatedAt: now }).pipe(Effect.ignore),
        );
        yield* Effect.logInfo("discord bridge orphaned a link", { threadId });
        return;
      }
      if (isAuthError(error)) {
        yield* Effect.logWarning("discord bridge auth failure; check token and permissions", {
          threadId,
          status: error._tag === "DiscordResponseError" ? error.status : undefined,
        });
        return;
      }
      yield* Effect.logWarning("discord bridge request failed", {
        threadId,
        error: error.message,
      });
    });

  const ensureUnarchived = (discordThreadId: string) =>
    rest.modifyThread({ threadId: discordThreadId, archived: false }).pipe(Effect.ignore);

  const createLinkedThread = (threadId: ThreadId, config: DiscordBridgeSettings) =>
    Effect.gen(function* () {
      const existing = yield* links.getByThreadId(threadId);
      if (Option.isSome(existing)) {
        return;
      }
      const detail = yield* threadDetail(threadId);
      if (Option.isNone(detail)) {
        return;
      }
      const thread = detail.value;
      if (
        config.projectAllowlist.length > 0 &&
        !config.projectAllowlist.includes(thread.projectId)
      ) {
        return;
      }

      const embed = yield* headerFor(thread, config);
      const starter = yield* rest.createMessage({ channelId: config.channelId, embeds: [embed] });
      const created = yield* rest.startThreadFromMessage({
        channelId: config.channelId,
        messageId: starter.id,
        name: threadNameFor({ title: thread.title, threadId }),
      });
      const now = yield* DateTime.now;
      yield* links.link({
        threadId,
        guildId: config.guildId,
        channelId: config.channelId,
        discordThreadId: created.id,
        headerMessageId: starter.id,
        // Anchor the inbound cursor at the starter message so pre-existing
        // chatter is never ingested.
        lastSeenDiscordMessageId: starter.id,
        createdAt: now,
      });
      yield* Effect.logInfo("discord bridge linked thread", {
        threadId,
        discordThreadId: created.id,
      });
    });

  const refreshHeader = (threadId: ThreadId, config: DiscordBridgeSettings) =>
    Effect.gen(function* () {
      const link = yield* links.getByThreadId(threadId);
      if (Option.isNone(link) || link.value.state !== "active") {
        return;
      }
      const detail = yield* threadDetail(threadId);
      if (Option.isNone(detail)) {
        return;
      }
      const embed = yield* headerFor(detail.value, config);
      yield* rest.editMessage({
        channelId: link.value.channelId,
        messageId: link.value.headerMessageId,
        embeds: [embed],
      });
      const name = threadNameFor({ title: detail.value.title, threadId });
      yield* rest.modifyThread({ threadId: link.value.discordThreadId, name }).pipe(Effect.ignore);
    });

  const flushMessage = (threadId: ThreadId, messageId: MessageId, _config: DiscordBridgeSettings) =>
    Effect.gen(function* () {
      // Never echo a message this bridge itself injected.
      if (isDiscordOriginatedMessageId(messageId)) {
        return;
      }
      const link = yield* links.getByThreadId(threadId);
      if (Option.isNone(link) || link.value.state !== "active") {
        return;
      }
      const discordThreadId = link.value.discordThreadId;

      // Read the authoritative text from the projection. Event payloads carry
      // only a delta fragment while streaming, and an empty string on the
      // completion event, so they must not be used as the message body.
      const detail = yield* threadDetail(threadId);
      if (Option.isNone(detail)) return;
      const message = detail.value.messages.find((entry) => entry.id === messageId);
      if (message === undefined) return;
      const record = { ...message, isStreaming: message.streaming };
      const now = yield* Clock.currentTimeMillis;
      const flushes = yield* Ref.get(lastFlushAt);
      const previous = flushes.get(messageId);

      const existingChunks = yield* links.listChunks(messageId);
      const publishedTotal = existingChunks.reduce((sum, c) => sum + c.publishedLength, 0);

      if (
        record.isStreaming &&
        previous !== undefined &&
        now - previous < EDIT_INTERVAL_MS &&
        record.text.length - publishedTotal < MIN_DELTA_CHARS
      ) {
        return;
      }

      const body = record.text.trimEnd();
      if (body.length === 0) {
        return;
      }
      const planned = planChunks(body);

      for (let index = 0; index < planned.length; index += 1) {
        const isLast = index === planned.length - 1;
        const content =
          isLast && record.isStreaming ? withStreamingCursor(planned[index]!) : planned[index]!;
        const existing = existingChunks.find((c) => c.chunkIndex === index);

        if (existing !== undefined) {
          if (existing.frozen || existing.publishedLength === content.length) {
            continue;
          }
          yield* rest.editMessage({
            channelId: discordThreadId,
            messageId: existing.discordMessageId,
            content,
          });
          yield* links.upsertChunk({
            messageId,
            chunkIndex: index,
            threadId,
            discordThreadId,
            discordMessageId: existing.discordMessageId,
            publishedLength: content.length,
            // Everything but the tail is complete and must never be edited again.
            frozen: !isLast,
            now: yield* DateTime.now,
          });
          continue;
        }

        const posted = yield* rest.createMessage({ channelId: discordThreadId, content });
        yield* links.upsertChunk({
          messageId,
          chunkIndex: index,
          threadId,
          discordThreadId,
          discordMessageId: posted.id,
          publishedLength: content.length,
          frozen: !isLast,
          now: yield* DateTime.now,
        });
      }

      yield* Ref.update(lastFlushAt, (map) => {
        const next = new Map(map);
        next.set(messageId, now);
        return next;
      });

      if (!record.isStreaming) {
        // Bound the map: a settled message never needs its debounce again.
        yield* Ref.update(lastFlushAt, (map) => {
          const next = new Map(map);
          next.delete(messageId);
          return next;
        });
      }
    });

  const postActivity = (threadId: ThreadId, text: string) =>
    Effect.gen(function* () {
      const link = yield* links.getByThreadId(threadId);
      if (Option.isNone(link) || link.value.state !== "active") {
        return;
      }
      for (const chunk of planChunks(text)) {
        yield* rest.createMessage({ channelId: link.value.discordThreadId, content: chunk });
      }
    });

  const applyLifecycle = (threadId: ThreadId, action: "archived" | "unarchived" | "deleted") =>
    Effect.gen(function* () {
      const link = yield* links.getByThreadId(threadId);
      if (Option.isNone(link)) {
        return;
      }
      const now = yield* DateTime.now;
      if (action === "unarchived") {
        yield* ensureUnarchived(link.value.discordThreadId);
        yield* links.setState({ threadId, state: "active", updatedAt: now });
        return;
      }
      yield* rest
        .modifyThread({ threadId: link.value.discordThreadId, archived: true })
        .pipe(Effect.ignore);
      yield* links.setState({ threadId, state: "archived", updatedAt: now });
    });

  const processWork = (work: BridgeWork) =>
    Effect.gen(function* () {
      const config = yield* readConfig;
      if (config === null || !config.enabled || config.channelId === "") {
        return;
      }
      switch (work.kind) {
        case "thread-created":
          yield* createLinkedThread(work.threadId, config);
          return;
        case "message":
          yield* flushMessage(work.threadId, work.messageId, config);
          return;
        case "header":
          yield* refreshHeader(work.threadId, config);
          return;
        case "activity":
          yield* postActivity(work.threadId, work.text);
          return;
        case "lifecycle":
          yield* applyLifecycle(work.threadId, work.action);
          return;
      }
    }).pipe(
      Effect.catchTag("DiscordResponseError", (error) =>
        isArchivedError(error) ? Effect.void : handleRestError(work.threadId, error),
      ),
      Effect.catchTag("DiscordRequestError", (error) => handleRestError(work.threadId, error)),
    );

  /**
   * The bridge is a post-commit observer. Any failure here is logged and
   * swallowed so it can never propagate back toward orchestration.
   */
  const processWorkSafely = (work: BridgeWork): Effect.Effect<void> =>
    retryAutomationWork(processWork(work)).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("discord bridge failed to process work", {
          kind: work.kind,
          threadId: work.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processWorkSafely);
  const enqueueEvent: DiscordBridgeShape["enqueueEvent"] = (event) =>
    readConfig.pipe(
      Effect.flatMap((config) => {
        if (config === null || !config.enabled || config.channelId === "") {
          return Effect.void;
        }
        const work = eventToWork(event, config.mirrorActivity);
        return work === null ? Effect.void : worker.enqueue(work).pipe(Effect.asVoid);
      }),
    );

  const dispatchInbound = (
    threadId: ThreadId,
    thread: OrchestrationThread,
    message: DiscordMessage,
  ) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        // Deterministic in the Discord message id: a re-read of the same
        // message short-circuits on the existing command receipt, so dedupe
        // is exact and survives restarts.
        commandId: CommandId.make(`discord:${message.id}`),
        threadId,
        message: {
          messageId: MessageId.make(`discord:${message.id}`),
          role: "user",
          text: message.content,
          attachments: [],
        },
        // The decider reads these off the thread; pass current values so this
        // never reads as an intent to change them.
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      });
    });

  const processInboundMessage = (
    threadId: ThreadId,
    discordThreadId: string,
    message: DiscordMessage,
    config: DiscordBridgeSettings,
  ) =>
    Effect.gen(function* () {
      const isSelf = message.author.id === config.applicationId || message.author.bot === true;
      const isWebhook = message.webhook_id !== undefined;
      if (isSelf || isWebhook) {
        yield* advanceCursor(threadId, message.id);
        return true;
      }
      if (!config.allowedAuthorIds.includes(message.author.id)) {
        yield* Effect.logWarning("discord bridge rejected unauthorized author", {
          threadId,
          authorId: message.author.id,
        });
        yield* react(discordThreadId, message.id, "❌");
        yield* advanceCursor(threadId, message.id);
        return true;
      }
      if (message.content.trim() === "") {
        yield* react(discordThreadId, message.id, "⚠️");
        yield* advanceCursor(threadId, message.id);
        return true;
      }

      const detail = yield* threadDetail(threadId);
      if (Option.isNone(detail)) {
        yield* advanceCursor(threadId, message.id);
        return true;
      }
      const status = statusOf(detail.value);
      if (status === "running" || status === "starting") {
        // Keep the durable cursor in place; the next poll rereads this message.
        yield* react(discordThreadId, message.id, "⏳");
        return false;
      }

      // Dispatch must succeed before the bridge acknowledges or persists the cursor.
      // Its deterministic command id makes retries safe if the process stops between these steps.
      yield* dispatchInbound(threadId, detail.value, message);
      yield* react(discordThreadId, message.id, "✅");
      yield* advanceCursor(threadId, message.id);
      return true;
    });

  const pollThread = (
    link: {
      readonly threadId: string;
      readonly discordThreadId: string;
      readonly lastSeenDiscordMessageId: string | null;
    },
    config: DiscordBridgeSettings,
  ) =>
    Effect.gen(function* () {
      const threadId = link.threadId as ThreadId;
      const batch = yield* rest.listMessagesAfter({
        channelId: link.discordThreadId,
        afterMessageId: link.lastSeenDiscordMessageId,
      });
      // Discord returns newest-first; process oldest-first so ordering holds.
      const ordered = batch.toReversed();

      for (const message of ordered) {
        const consumed = yield* withAutomationWork(
          processInboundMessage(threadId, link.discordThreadId, message, config),
        );
        // Do not let a later bot/ignored message move the cursor past this
        // oldest allowed message while its thread is still busy.
        if (!consumed) return;
      }
    });

  const react = (channelId: string, messageId: string, emoji: string) =>
    rest.createReaction({ channelId, messageId, emoji }).pipe(Effect.ignore);

  const advanceCursor = (threadId: ThreadId, discordMessageId: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* links.setLastSeen({
        threadId,
        lastSeenDiscordMessageId: discordMessageId,
        updatedAt: now,
      });
    });

  const pollOnce = Effect.gen(function* () {
    const config = yield* readConfig;
    if (config === null || !config.enabled || config.allowedAuthorIds.length === 0) {
      return;
    }
    const active = yield* links.listActive().pipe(Effect.orElseSucceed(() => []));
    for (const link of active) {
      yield* pollThread(link, config).pipe(
        Effect.catchTag("DiscordResponseError", (error) =>
          handleRestError(link.threadId as ThreadId, error),
        ),
        Effect.catchTag("DiscordRequestError", (error) =>
          handleRestError(link.threadId as ThreadId, error),
        ),
        Effect.catchTag("MaintenanceWorkHeld", () => Effect.void),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("discord bridge poll failed", {
                threadId: link.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
  });

  const start: DiscordBridgeShape["start"] = Effect.fn("DiscordBridge.start")(function* () {
    const config = yield* readConfig;
    if (config === null || !config.enabled) {
      yield* Effect.logInfo("discord bridge disabled");
      return;
    }
    if (config.channelId === "" || config.guildId === "") {
      yield* Effect.logWarning("discord bridge enabled but guildId/channelId are unset");
      return;
    }
    if (config.allowedAuthorIds.length === 0) {
      yield* Effect.logWarning(
        "discord bridge has an empty author allowlist; inbound replies are disabled (fail closed)",
      );
    }
    yield* Effect.logInfo("discord bridge started", {
      guildId: config.guildId,
      channelId: config.channelId,
      mirrorActivity: config.mirrorActivity,
    });

    yield* forkParked(Stream.runForEach(threads.streamDomainEvents, enqueueEvent));

    yield* forkParked(Effect.forever(pollOnce.pipe(Effect.andThen(Effect.sleep(POLL_INTERVAL)))));
  });

  return {
    start,
    drain: worker.drain,
    pollOnce: pollOnce.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("discord bridge poll failed", { cause: Cause.pretty(cause) }),
      ),
    ),
    enqueueEvent,
  } satisfies DiscordBridgeShape;
});

export const DiscordBridgeLive = Layer.effect(DiscordBridge, make);

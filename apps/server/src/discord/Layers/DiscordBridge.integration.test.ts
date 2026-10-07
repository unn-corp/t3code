import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type DiscordBridgeSettings,
  type OrchestrationThread,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as AutomationOrchestration from "../../agentDashboard/AutomationOrchestration.ts";
import { AutomationDispatchError } from "../../agentDashboard/AutomationOrchestration.ts";
import * as AutomationSnapshotQuery from "../../agentDashboard/AutomationSnapshotQuery.ts";
import { MaintenanceWorkHeld, WorkAdmission } from "../../maintenance/WorkAdmission.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DiscordBridgeLinks from "../../persistence/DiscordBridgeLinks.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as DiscordRest from "../DiscordRestClient.ts";
import * as DiscordBridgeLayer from "./DiscordBridge.ts";

const DB = it.layer(
  Layer.mergeAll(DiscordBridgeLinks.layer).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const config: DiscordBridgeSettings = {
  enabled: true,
  guildId: "guild-1",
  channelId: "channel-1",
  applicationId: "bot-1",
  allowedAuthorIds: ["person-1"],
  publicOrigin: "",
  projectAllowlist: [],
  mirrorActivity: false,
};

const linkFor = (id: string) => ({
  threadId: `thr_discord_bridge_${id}` as ThreadId,
  guildId: config.guildId,
  channelId: config.channelId,
  discordThreadId: `discord-thread-${id}`,
  headerMessageId: `discord-header-${id}`,
  lastSeenDiscordMessageId: `discord-header-${id}`,
  createdAt: Option.getOrThrow(DateTime.make(Date.parse("2026-01-01T00:00:00.000Z"))),
});

const thread = {
  id: "thr_discord_bridge_integration",
  projectId: "project-1",
  title: "A thread",
  runtimeMode: "full-access",
  interactionMode: "default",
  modelSelection: { instanceId: "codex", model: "test-model" },
  createdAt: "2026-01-01T00:00:00.000Z",
  session: { status: "idle" },
  messages: [],
} as unknown as OrchestrationThread;

const message = {
  id: "discord-message-1",
  channel_id: "discord-thread-1",
  content: "Please continue",
  author: { id: "person-1" },
};

const makeBridge = (input: {
  readonly links: DiscordBridgeLinks.DiscordBridgeLinkRepository["Service"];
  readonly dispatch: (commandId: string) => Effect.Effect<void, AutomationDispatchError>;
  readonly listMessagesAfter?: DiscordRest.DiscordRestClient["Service"]["listMessagesAfter"];
  readonly reactions: string[];
  readonly writes: string[];
  readonly domainEvents?: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly admission?: typeof WorkAdmission.Service;
  readonly threadId?: ThreadId;
  readonly getThread?: () => Effect.Effect<Option.Option<OrchestrationThread>>;
}) =>
  Effect.gen(function* () {
    const services = {
      links: input.links,
      orchestration: AutomationOrchestration.OrchestrationEngineService.of({
        dispatch: (command) =>
          input.dispatch(String(command.commandId)).pipe(Effect.as({ sequence: 1 })),
      }),
      threads: ThreadManagement.ThreadManagementService.of({
        streamDomainEvents: Stream.fromIterable(input.domainEvents ?? []),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      snapshots: AutomationSnapshotQuery.ProjectionSnapshotQuery.of({
        getThreadDetailById: () =>
          input.getThread?.() ??
          Effect.succeed(
            Option.some({ ...thread, id: input.threadId ?? thread.id } as OrchestrationThread),
          ),
        getProjectShellById: () => Effect.succeed(Option.none()),
      } as unknown as AutomationSnapshotQuery.AutomationSnapshotQueryShape),
      settings: ServerSettings.ServerSettingsService.of({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, discordBridge: config }),
      } as unknown as ServerSettings.ServerSettingsService["Service"]),
      rest: DiscordRest.DiscordRestClient.of({
        listMessagesAfter:
          input.listMessagesAfter ??
          ((request) =>
            Effect.succeed(
              request.afterMessageId?.startsWith("discord-message-") ? [] : [message],
            )),
        createReaction: ({ messageId, emoji }) =>
          Effect.sync(() => void input.reactions.push(`${messageId}:${emoji}`)),
        modifyThread: ({ threadId: id }) => Effect.sync(() => void input.writes.push(id)),
        createMessage: () => Effect.die("Unexpected Discord message create"),
        editMessage: () => Effect.die("Unexpected Discord message edit"),
        startThreadFromMessage: () => Effect.die("Unexpected Discord thread create"),
      }),
      admission: input.admission ?? {
        acquire: Effect.succeed(() => Effect.void),
        acquirePassive: Effect.succeed(() => Effect.void),
        check: Effect.void,
        checkAutomation: Effect.void,
      },
    };
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(DiscordBridgeLinks.DiscordBridgeLinkRepository, services.links),
        Effect.provideService(
          AutomationOrchestration.OrchestrationEngineService,
          services.orchestration,
        ),
        Effect.provideService(ThreadManagement.ThreadManagementService, services.threads),
        Effect.provideService(AutomationSnapshotQuery.ProjectionSnapshotQuery, services.snapshots),
        Effect.provideService(ServerSettings.ServerSettingsService, services.settings),
        Effect.provideService(DiscordRest.DiscordRestClient, services.rest),
        Effect.provideService(WorkAdmission, services.admission),
      );
    const bridge = yield* provide(DiscordBridgeLayer.make);
    return {
      ...bridge,
      start: () => provide(bridge.start()),
      pollOnce: provide(bridge.pollOnce),
      enqueueEvent: (event: OrchestrationV2DomainEvent) => provide(bridge.enqueueEvent(event)),
    };
  });

DB("Discord bridge fenced side effects", (test) => {
  test.effect("holds orphaning after a poll 404 until maintenance admission reopens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 36 });
        const links = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
        const testLink = linkFor("poll-404-maintenance");
        yield* links.link(testLink);
        const held = yield* Ref.make(true);
        const admission = {
          acquire: Effect.succeed(() => Effect.void),
          acquirePassive: Effect.succeed(() => Effect.void),
          check: Effect.void,
          checkAutomation: Effect.gen(function* () {
            if (yield* Ref.get(held))
              return yield* Effect.fail(new MaintenanceWorkHeld({ cause: "maintenance hold" }));
          }),
        };
        const bridge = yield* makeBridge({
          links,
          reactions: [],
          writes: [],
          dispatch: () => Effect.void,
          admission,
          listMessagesAfter: () =>
            Effect.fail(
              new DiscordRest.DiscordResponseError({
                route: "/channels/discord-thread-poll-404-maintenance/messages",
                method: "GET",
                status: 404,
                discordCode: 10003,
              }),
            ),
        });

        yield* bridge.pollOnce;
        assert.strictEqual(
          Option.getOrThrow(yield* links.getByThreadId(testLink.threadId)).state,
          "active",
        );

        yield* Ref.set(held, false);
        yield* bridge.pollOnce;
        assert.strictEqual(
          Option.getOrThrow(yield* links.getByThreadId(testLink.threadId)).state,
          "orphaned",
        );
      }),
    ),
  );

  test.effect("keeps an inbound cursor until dispatch succeeds, then retries and records it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 36 });
        const links = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
        const testLink = linkFor("dispatch-retry");
        yield* links.link(testLink);
        const dispatches: string[] = [];
        const reactions: string[] = [];
        let fail = true;
        const bridge = yield* makeBridge({
          links,
          reactions,
          writes: [],
          threadId: testLink.threadId,
          dispatch: (commandId) =>
            Effect.sync(() => void dispatches.push(commandId)).pipe(
              Effect.andThen(
                fail
                  ? Effect.fail(
                      new AutomationOrchestration.AutomationDispatchError({
                        commandType: "thread.turn.start",
                        cause: "maintenance fence",
                      }),
                    )
                  : Effect.void,
              ),
            ),
        });

        yield* bridge.pollOnce;
        const heldCursor = Option.getOrThrow(
          yield* links.getByThreadId(testLink.threadId),
        ).lastSeenDiscordMessageId;
        assert.strictEqual(heldCursor, testLink.headerMessageId);
        assert.deepEqual(reactions, []);

        fail = false;
        yield* bridge.pollOnce;
        const acceptedCursor = Option.getOrThrow(
          yield* links.getByThreadId(testLink.threadId),
        ).lastSeenDiscordMessageId;
        assert.strictEqual(acceptedCursor, message.id);
        assert.deepEqual(dispatches, ["discord:discord-message-1", "discord:discord-message-1"]);
        assert.deepEqual(reactions, ["discord-message-1:✅"]);

        yield* bridge.pollOnce;
        assert.strictEqual(dispatches.length, 2);
        yield* links.setState({
          threadId: testLink.threadId,
          state: "archived",
          updatedAt: testLink.createdAt,
        });
      }),
    ),
  );

  test.effect(
    "holds inbound effects and durable cursor while maintenance admission is closed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 36 });
          const links = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
          const testLink = linkFor("maintenance-inbound");
          yield* links.link(testLink);
          const reactions: string[] = [];
          const dispatches: string[] = [];
          const held = yield* Ref.make(true);
          const admission = {
            acquire: Effect.succeed(() => Effect.void),
            acquirePassive: Effect.succeed(() => Effect.void),
            check: Effect.void,
            checkAutomation: Effect.gen(function* () {
              if (yield* Ref.get(held))
                return yield* Effect.fail(new MaintenanceWorkHeld({ cause: "maintenance hold" }));
            }),
          };
          const bridge = yield* makeBridge({
            links,
            reactions,
            writes: [],
            admission,
            threadId: testLink.threadId,
            dispatch: (commandId) => Effect.sync(() => void dispatches.push(commandId)),
          });

          yield* bridge.pollOnce;
          assert.strictEqual(
            Option.getOrThrow(yield* links.getByThreadId(testLink.threadId))
              .lastSeenDiscordMessageId,
            testLink.headerMessageId,
          );
          assert.deepEqual(dispatches, []);
          assert.deepEqual(reactions, []);

          yield* Ref.set(held, false);
          yield* bridge.pollOnce;
          assert.strictEqual(
            Option.getOrThrow(yield* links.getByThreadId(testLink.threadId))
              .lastSeenDiscordMessageId,
            message.id,
          );
          assert.deepEqual(dispatches, ["discord:discord-message-1"]);
          yield* links.setState({
            threadId: testLink.threadId,
            state: "archived",
            updatedAt: testLink.createdAt,
          });
        }),
      ),
  );

  test.effect("does not acquire an automation lease for an empty poll", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 36 });
        const links = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
        const testLink = linkFor("empty-poll");
        yield* links.link(testLink);
        const checks = yield* Ref.make(0);
        const admission = {
          acquire: Effect.succeed(() => Effect.void),
          acquirePassive: Effect.succeed(() => Effect.void),
          check: Effect.void,
          checkAutomation: Ref.update(checks, (count) => count + 1),
        };
        const bridge = yield* makeBridge({
          links,
          reactions: [],
          writes: [],
          admission,
          threadId: testLink.threadId,
          listMessagesAfter: () => Effect.succeed([]),
          dispatch: () => Effect.void,
        });

        yield* bridge.pollOnce;
        assert.strictEqual(yield* Ref.get(checks), 0);
        yield* links.setState({
          threadId: testLink.threadId,
          state: "archived",
          updatedAt: testLink.createdAt,
        });
      }),
    ),
  );

  test.effect("does not skip a busy oldest message when a later bot message can be consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 36 });
        const links = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
        const testLink = linkFor("busy-order");
        yield* links.link(testLink);
        const status = yield* Ref.make("running");
        const reactions: string[] = [];
        const dispatches: string[] = [];
        const newestFirst = [
          { ...message, id: "discord-message-2", author: { id: "bot-2", bot: true } },
          { ...message, id: "discord-message-1" },
        ];
        const bridge = yield* makeBridge({
          links,
          reactions,
          writes: [],
          threadId: testLink.threadId,
          listMessagesAfter: () => Effect.succeed(newestFirst),
          getThread: () =>
            Ref.get(status).pipe(
              Effect.map((currentStatus) =>
                Option.some({
                  ...thread,
                  id: testLink.threadId,
                  session: { status: currentStatus },
                } as OrchestrationThread),
              ),
            ),
          dispatch: (commandId) => Effect.sync(() => void dispatches.push(commandId)),
        });

        yield* bridge.pollOnce;
        assert.strictEqual(
          Option.getOrThrow(yield* links.getByThreadId(testLink.threadId)).lastSeenDiscordMessageId,
          testLink.headerMessageId,
        );
        assert.deepEqual(dispatches, []);

        yield* Ref.set(status, "idle");
        yield* bridge.pollOnce;
        assert.strictEqual(
          Option.getOrThrow(yield* links.getByThreadId(testLink.threadId)).lastSeenDiscordMessageId,
          "discord-message-2",
        );
        assert.deepEqual(dispatches, ["discord:discord-message-1"]);
        yield* links.setState({
          threadId: testLink.threadId,
          state: "archived",
          updatedAt: testLink.createdAt,
        });
      }),
    ),
  );

  test.effect(
    "retries outbound work after a maintenance hold without sending early or dropping it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 36 });
          const links = yield* DiscordBridgeLinks.DiscordBridgeLinkRepository;
          const testLink = linkFor("maintenance-outbound");
          yield* links.link(testLink);
          const held = yield* Ref.make(true);
          const attempt = yield* Deferred.make<void>();
          const attempts = yield* Ref.make(0);
          const writes: string[] = [];
          const reactions: string[] = [];
          const admission = {
            acquire: Effect.succeed(() => Effect.void),
            acquirePassive: Effect.succeed(() => Effect.void),
            check: Effect.void,
            checkAutomation: Effect.gen(function* () {
              yield* Ref.update(attempts, (count) => count + 1);
              if ((yield* Ref.get(attempts)) === 1) yield* Deferred.succeed(attempt, undefined);
              if (yield* Ref.get(held))
                return yield* Effect.fail(new MaintenanceWorkHeld({ cause: "maintenance hold" }));
            }),
          };
          const event = {
            type: "thread.deleted",
            threadId: testLink.threadId,
            payload: {},
          } as unknown as OrchestrationV2DomainEvent;
          const bridge = yield* makeBridge({
            links,
            reactions,
            writes,
            admission,
            domainEvents: [event],
            threadId: testLink.threadId,
            dispatch: () => Effect.void,
          });

          yield* bridge.enqueueEvent(event);
          yield* Deferred.await(attempt);
          assert.deepEqual(writes, []);

          yield* Ref.set(held, false);
          yield* bridge.drain;
          assert.deepEqual(writes, [testLink.discordThreadId]);
        }),
      ),
  );
});

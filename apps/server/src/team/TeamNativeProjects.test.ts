import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import {
  ClientOrchestrationCommand,
  MessageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  SideThreadMessageId,
  ThreadId,
  TeamNativeRpcGroup,
  WsRpcGroup,
  WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  ServerConfig as WireServerConfig,
  type CollaborationUser,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { sideThreadIdForThread } from "@t3tools/shared/sideThread";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { RpcTest, RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { HttpRouter, HttpClient, HttpBody, HttpServer } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { TeamSpaces, TeamDenied } from "./TeamSpaces.ts";
import { TeamNativeProjects } from "./TeamNativeProjects.ts";
import type { TeamPrincipal, TeamAuthentication } from "./TeamAuthentication.ts";
import { nativeRpcLayer, makeNativeTickets, teamNativeRoutes } from "./nativeHttp.ts";
import { nativeShellStream, nativeThreadStream } from "./nativeStreams.ts";

// Intentionally no ChildProcessSpawner, ProcessRunner, or provider service.
// The real native runtime must initialize and function without host execution.
const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const encodeWireConfig = Schema.encodeEffect(WireServerConfig);
const decodeWireConfig = Schema.decodeEffect(WireServerConfig);
const decodeTicket = Schema.decodeUnknownEffect(Schema.Struct({ ticket: Schema.String }));
const basics = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer);
const principal = (userId: string): TeamPrincipal => ({
  userId,
  displayName: `Trusted ${userId}`,
  verifiedEmails: [`${userId}@example.test`],
  expiresAt: 1e12,
});
const owner = principal("owner");
const member = principal("member");
const viewer = principal("viewer");
const resolveUser = (subject: string): Effect.Effect<CollaborationUser> =>
  Effect.succeed({ subject, displayName: `Trusted ${subject}` });
const timestamp = "1970-01-01T00:00:00.000Z";
const layers = (baseDir?: string) =>
  TeamNativeProjects.layer.pipe(
    Layer.provideMerge(TeamSpaces.layer),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          return makeSqlitePersistenceLive((yield* ServerConfig).dbPath);
        }),
      ),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest("/untrusted-host-root", baseDir ?? { prefix: "t3-native-test-" }),
    ),
    Layer.provideMerge(basics),
  );
const seed = Effect.gen(function* () {
  const spaces = yield* TeamSpaces;
  const one = yield* spaces.execute(owner, { action: "create", name: "One" }, true);
  const two = yield* spaces.execute(owner, { action: "create", name: "Two" }, true);
  for (const [identity, role] of [
    [member, "contributor"],
    [viewer, "viewer"],
  ] as const) {
    const invite = yield* spaces.execute(owner, {
      action: "invite",
      spaceId: one.spaceId,
      email: identity.verifiedEmails[0]!,
      role,
    });
    yield* spaces.execute(identity, { action: "accept", token: invite.token! });
  }
  return { spaces, one, two, projects: yield* TeamNativeProjects };
});
const thread = (
  spaceId: string,
  id = "thread-one",
): Extract<OrchestrationCommand, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create:${id}`),
  threadId: ThreadId.make(id),
  projectId: ProjectId.make(spaceId),
  title: "Shared thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "local-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: timestamp,
});
const discussion = (threadId = ThreadId.make("thread-one")) => ({
  type: "sidethread.create" as const,
  commandId: CommandId.make(`discussion:${threadId}`),
  threadId,
  sideThreadId: sideThreadIdForThread(threadId),
  createdAt: timestamp,
});
const post = (threadId = ThreadId.make("thread-one"), id = "message-one") => ({
  type: "sidethread.message.post" as const,
  commandId: CommandId.make(`post:${id}`),
  threadId,
  sideThreadId: sideThreadIdForThread(threadId),
  messageId: SideThreadMessageId.make(id),
  text: "Hello team",
  createdAt: timestamp,
});

it.effect(
  "keeps independent private projects, original creator and trusted member attribution",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, one, two } = yield* seed;
        // A contributor opens the first runtime; bootstrapping must retain the owner.
        const [alice, again, other] = yield* Effect.all(
          [
            projects.connect(member, one.spaceId, resolveUser),
            projects.connect(owner, one.spaceId, resolveUser),
            projects.connect(owner, two.spaceId, resolveUser),
          ],
          { concurrency: "unbounded" },
        );
        expect(alice.engine).toBe(again.engine);
        expect(alice.engine).not.toBe(other.engine);
        const create = yield* decodeClientCommand({
          ...thread(one.spaceId),
          createdBy: { subject: "owner", displayName: "Forged" },
          collaborationUser: { subject: "owner", displayName: "Forged" },
        });
        const receipt = yield* alice.dispatch(create);
        expect(yield* alice.dispatch(create)).toEqual(receipt);
        yield* alice.dispatch(discussion());
        yield* alice.dispatch({
          ...post(),
          mentions: [{ subject: viewer.userId, displayName: "Forged name" }],
        });
        const snapshot = yield* alice.query.getSnapshot();
        expect(snapshot.projects).toHaveLength(1);
        expect(snapshot.projects[0]).toMatchObject({
          id: one.spaceId,
          workspaceRoot: "/workspace",
          createdBy: { subject: "owner" },
        });
        expect(snapshot.threads[0]?.createdBy).toEqual({
          subject: member.userId,
          displayName: member.displayName,
        });
        expect(snapshot.threads[0]?.sideThreads?.[0]?.messages[0]).toMatchObject({
          author: { subject: member.userId, displayName: member.displayName },
          mentions: [{ subject: viewer.userId, displayName: "Trusted viewer" }],
        });
        expect((yield* other.query.getSnapshot()).threads).toHaveLength(0);
        expect((yield* other.query.getSnapshot()).projects.map((project) => project.id)).toEqual([
          two.spaceId,
        ]);
        const wire = yield* encodeWireConfig(yield* alice.wireConfig).pipe(
          Effect.flatMap(decodeWireConfig),
        );
        expect(wire.teamProject?.agentExecution).toBe("local");
        expect(wire.providers).toEqual([]);
        expect(wire.teamProject?.capabilities.execution).toBe(false);
        expect(wire.environment.environmentId).not.toBe(
          (yield* again.wireConfig).environment.environmentId,
        );
        expect(wire.cwd).toBe("/workspace");
        expect(wire.observability.logsDirectoryPath).toBe("/unavailable");
      }),
    ).pipe(Effect.provide(layers())),
);

it.effect(
  "rejects unauthorized projects, viewer writes, foreign references, host paths and execution without events",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, one, two } = yield* seed;
        const oneMember = yield* projects.connect(member, one.spaceId, resolveUser);
        const oneViewer = yield* projects.connect(viewer, one.spaceId, resolveUser);
        const twoOwner = yield* projects.connect(owner, two.spaceId, resolveUser);
        yield* oneMember.dispatch(thread(one.spaceId));
        yield* oneMember.dispatch(discussion());
        yield* twoOwner.dispatch(thread(two.spaceId, "foreign"));
        for (const spaceId of [two.spaceId, "../secret", "0".repeat(32)])
          expect((yield* Effect.flip(projects.connect(member, spaceId, resolveUser)))._tag).toBe(
            "TeamDenied",
          );
        expect(
          (yield* Effect.flip(projects.connect(principal("stranger"), one.spaceId, resolveUser)))
            ._tag,
        ).toBe("TeamDenied");
        const before = yield* oneMember.engine.latestSequence;
        const invalid: ClientOrchestrationCommand[] = [
          {
            type: "thread.turn.start",
            commandId: CommandId.make("never-run"),
            threadId: ThreadId.make("thread-one"),
            message: {
              messageId: MessageId.make("never-run"),
              role: "user",
              text: "Must stay local",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: timestamp,
          },
          { ...post(), quotedMessageId: MessageId.make("foreign-message") },
          {
            ...post(),
            replyToSideThreadMessageId: SideThreadMessageId.make("foreign-discussion-message"),
          },
          thread(two.spaceId, "cross-project"),
          { ...thread(one.spaceId, "host-path"), worktreePath: "/etc" },
          {
            type: "project.create",
            commandId: CommandId.make("project-forgery"),
            projectId: ProjectId.make(two.spaceId),
            title: "No",
            workspaceRoot: "/etc",
            createdAt: timestamp,
          },
          {
            type: "thread.meta.update",
            commandId: CommandId.make("danger-meta"),
            threadId: ThreadId.make("thread-one"),
            worktreePath: "/etc",
          },
          { ...post(), linkedRef: { kind: "agent-thread", threadId: ThreadId.make("foreign") } },
          { ...post(), mentions: [{ subject: "stranger", displayName: "Owner" }] },
          {
            ...post(),
            attachments: [
              {
                type: "image",
                name: "bad",
                mimeType: "image/png",
                sizeBytes: 1,
                dataUrl: "data:image/png;base64,AA==",
              },
            ],
          },
          {
            type: "thread.archive",
            commandId: CommandId.make("foreign-archive"),
            threadId: ThreadId.make("foreign"),
          },
        ];
        for (const command of invalid)
          expect((yield* Effect.flip(oneMember.dispatch(command)))._tag).toBe("TeamDenied");
        expect((yield* Effect.flip(oneViewer.dispatch(post())))._tag).toBe("TeamDenied");
        expect(yield* oneMember.engine.latestSequence).toBe(before);
        yield* oneMember.dispatch(post());
        yield* oneViewer.dispatch({
          type: "sidethread.mark-read",
          commandId: CommandId.make("read"),
          threadId: ThreadId.make("thread-one"),
          sideThreadId: sideThreadIdForThread(ThreadId.make("thread-one")),
          lastReadAt: timestamp,
          createdAt: timestamp,
        });
        expect(
          (yield* oneViewer.query.getSnapshot()).threads[0]?.sideThreads?.[0]?.readBy,
        ).toContainEqual({
          user: { subject: "viewer", displayName: "Trusted viewer" },
          lastReadAt: timestamp,
        });
      }),
    ).pipe(Effect.provide(layers())),
);

it.effect(
  "typed RPC stays subscribed to config, supports native discussion and sanitizes denials",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, one } = yield* seed;
        const connection = yield* projects.connect(member, one.spaceId, resolveUser);
        yield* Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TeamNativeRpcGroup);
          const configReceived = yield* Deferred.make<void>();
          const configFiber = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
            Stream.runForEach(() => Deferred.succeed(configReceived, undefined)),
            Effect.forkScoped,
          );
          yield* Deferred.await(configReceived);
          expect(configFiber.pollUnsafe()).toBeUndefined();
          yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](thread(one.spaceId));
          yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](discussion());
          yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](post());
          const failure = yield* Effect.flip(
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.meta.update",
              commandId: CommandId.make("bad-path"),
              threadId: ThreadId.make("thread-one"),
              worktreePath: "/private/host/path",
            }),
          );
          expect(failure).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
          expect(String(failure)).not.toContain("/private/host/path");
          expect(TeamNativeRpcGroup.requests.has(WS_METHODS.projectsReadFile)).toBe(false);
          expect(TeamNativeRpcGroup.requests.has(WS_METHODS.terminalOpen)).toBe(false);
          yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("archive"),
            threadId: ThreadId.make("thread-one"),
          });
          expect(
            (yield* client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({})).threads,
          ).toHaveLength(1);
          yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.unarchive",
            commandId: CommandId.make("unarchive"),
            threadId: ThreadId.make("thread-one"),
          });
          expect(
            (yield* client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({})).threads,
          ).toHaveLength(0);
        }).pipe(Effect.provide(nativeRpcLayer(connection)));
      }),
    ).pipe(Effect.provide(layers())),
);

it.effect("persists shared state and stable member environment IDs across service restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-restart-" });
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const { projects, one } = yield* seed;
          const connection = yield* projects.connect(member, one.spaceId, resolveUser);
          yield* connection.dispatch(thread(one.spaceId));
          yield* connection.dispatch(discussion());
          const receipt = yield* connection.dispatch(post());
          return {
            spaceId: one.spaceId,
            receipt,
            environmentId: (yield* connection.wireConfig).environment.environmentId,
          };
        }),
      ).pipe(Effect.provide(layers(baseDir)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projects = yield* TeamNativeProjects;
          const connection = yield* projects.connect(member, first.spaceId, resolveUser);
          expect((yield* connection.wireConfig).environment.environmentId).toBe(
            first.environmentId,
          );
          expect(yield* connection.dispatch(post())).toEqual(first.receipt);
          const snapshot = yield* connection.query.getThreadDetailSnapshot(
            ThreadId.make("thread-one"),
          );
          expect(
            Option.isSome(snapshot) && snapshot.value.thread.sideThreads?.[0]?.messages,
          ).toHaveLength(1);
          expect((yield* connection.query.getShellSnapshot()).projects).toHaveLength(1);
        }),
      ).pipe(Effect.provide(Layer.fresh(layers(baseDir))));
    }),
  ).pipe(Effect.provide(basics)),
);

for (const revocation of ["project", "team-removal", "team-owner-demotion"] as const) {
  it.effect(
    `serializes queued mutations behind ${revocation}, invalidates role changes and rejects expired sessions`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { projects, spaces, one } = yield* seed;
          if (revocation === "team-owner-demotion") {
            yield* spaces.execute(owner, {
              action: "removeMember",
              spaceId: one.spaceId,
              userId: member.userId,
            });
            yield* spaces.rosterCommand(owner, {
              action: "setRole",
              userId: member.userId,
              role: "owner",
            });
          }
          const connection = yield* projects.connect(member, one.spaceId, resolveUser);
          yield* connection.dispatch(thread(one.spaceId));
          const before = yield* connection.engine.latestSequence;
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const blocker = yield* spaces
            .withAuthority(
              Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(held);
          const removal = yield* (
            revocation === "project"
              ? spaces.execute(owner, {
                  action: "removeMember",
                  spaceId: one.spaceId,
                  userId: member.userId,
                })
              : revocation === "team-removal"
                ? spaces.rosterCommand(owner, { action: "removeMember", userId: member.userId })
                : spaces.rosterCommand(owner, {
                    action: "setRole",
                    userId: member.userId,
                    role: "member",
                  })
          ).pipe(Effect.forkScoped({ startImmediately: true }));
          const write = yield* connection
            .dispatch(discussion())
            .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(blocker);
          yield* Fiber.join(removal);
          expect((yield* Fiber.join(write))._tag).toBe("Failure");
          expect(yield* connection.engine.latestSequence).toBe(before);
          expect((yield* Effect.flip(connection.check()))._tag).toBe("TeamDenied");
          const ownerConnection = yield* projects.connect(owner, one.spaceId, resolveUser);
          const viewerConnection = yield* projects.connect(viewer, one.spaceId, resolveUser);
          yield* spaces.execute(owner, {
            action: "setRole",
            spaceId: one.spaceId,
            userId: viewer.userId,
            role: "contributor",
          });
          expect((yield* Effect.flip(viewerConnection.check()))._tag).toBe("TeamDenied");
          expect(yield* ownerConnection.check()).toBe("owner");
          const expiresAt = (yield* Clock.currentTimeMillis) + 100;
          const expiring = yield* projects.connect(
            { ...owner, expiresAt },
            one.spaceId,
            resolveUser,
          );
          yield* TestClock.adjust("101 millis");
          expect((yield* Effect.flip(expiring.check()))._tag).toBe("TeamDenied");
        }),
      ).pipe(Effect.provide(layers())),
  );
}

it.effect(
  "native tickets are project-bound, one-use, bounded, and expire before the credential",
  () =>
    Effect.gen(function* () {
      const tickets = yield* makeNativeTickets;
      const grant = { authorization: "Bearer fixture", identity: owner, spaceId: "a".repeat(32) };
      const ticket = yield* tickets.issue(grant);
      expect((yield* tickets.redeem(ticket, grant.spaceId)).identity.userId).toBe(owner.userId);
      expect((yield* Effect.flip(tickets.redeem(ticket, grant.spaceId)))._tag).toBe("TeamDenied");
      const wrongProject = yield* tickets.issue(grant);
      expect((yield* Effect.flip(tickets.redeem(wrongProject, "b".repeat(32))))._tag).toBe(
        "TeamDenied",
      );
      expect((yield* Effect.flip(tickets.redeem(wrongProject, grant.spaceId)))._tag).toBe(
        "TeamDenied",
      );
      const expiring = yield* tickets.issue(grant);
      yield* TestClock.adjust("30 seconds");
      expect((yield* Effect.flip(tickets.redeem(expiring, grant.spaceId)))._tag).toBe("TeamDenied");
      for (let i = 0; i < 1000; i++) yield* tickets.issue(grant);
      expect((yield* Effect.flip(tickets.issue(grant))).reason).toBe("ticket_limit");
      yield* TestClock.adjust("30 seconds");
      expect(yield* tickets.issue(grant)).toHaveLength(64);
    }),
);

it.effect(
  "subscribes before snapshots, replays to a captured head, and emits a completion marker",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, one } = yield* seed;
        const connection = yield* projects.connect(member, one.spaceId, resolveUser);
        yield* connection.dispatch(thread(one.spaceId));
        yield* connection.dispatch(discussion());
        const cursor = yield* connection.engine.latestSequence;
        yield* connection.dispatch(post());
        const replay = yield* nativeThreadStream(connection, {
          threadId: ThreadId.make("thread-one"),
          afterSequence: cursor,
          requestCompletionMarker: true,
        });
        const replayed = yield* replay.pipe(Stream.take(2), Stream.runCollect);
        expect(replayed.map((item) => item.kind)).toEqual(["event", "synchronized"]);
        expect(replayed[0]?.kind === "event" && replayed[0].event.type).toBe(
          "sidethread.message-posted",
        );
        const loaded = yield* Deferred.make<void>();
        const continueSnapshot = yield* Deferred.make<void>();
        const racingConnection = {
          ...connection,
          query: {
            ...connection.query,
            getThreadDetailSnapshot: (
              ...args: Parameters<typeof connection.query.getThreadDetailSnapshot>
            ) =>
              connection.query.getThreadDetailSnapshot(...args).pipe(
                Effect.tap(() => Deferred.succeed(loaded, undefined)),
                Effect.tap(() => Deferred.await(continueSnapshot)),
              ),
          },
        };
        const stream = yield* nativeThreadStream(racingConnection, {
          threadId: ThreadId.make("thread-one"),
          requestCompletionMarker: true,
        }).pipe(
          Effect.flatMap((events) => events.pipe(Stream.take(3), Stream.runCollect)),
          Effect.forkScoped,
        );
        yield* Deferred.await(loaded);
        yield* connection.dispatch(post(ThreadId.make("thread-one"), "after-snapshot"));
        yield* Deferred.succeed(continueSnapshot, undefined);
        const raced = yield* Fiber.join(stream);
        expect(raced.map((item) => item.kind)).toEqual(["snapshot", "event", "synchronized"]);
        expect(raced[1]?.kind === "event" && raced[1].event.type).toBe("sidethread.message-posted");
        const reset = yield* nativeThreadStream(connection, {
          threadId: ThreadId.make("thread-one"),
          afterSequence: 1e9,
        });
        expect((yield* reset.pipe(Stream.take(1), Stream.runCollect))[0]?.kind).toBe("snapshot");
      }),
    ).pipe(Effect.provide(layers())),
);

for (const reason of [
  "removal",
  "role-change",
  "team-removal",
  "team-owner-demotion",
  "session-revocation",
  "expiry",
] as const) {
  it.effect(`native websocket delivers typed RPC and closes on ${reason}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, spaces, one } = yield* seed;
        if (reason === "team-owner-demotion") {
          yield* spaces.execute(owner, {
            action: "removeMember",
            spaceId: one.spaceId,
            userId: member.userId,
          });
          yield* spaces.rosterCommand(owner, {
            action: "setRole",
            userId: member.userId,
            role: "owner",
          });
        }
        let active = true;
        let authenticationCalls = 0;
        const identity = { ...member, expiresAt: (yield* Clock.currentTimeMillis) + 60000 };
        const auth: TeamAuthentication = {
          origins: ["https://team.example.test"],
          resolveUser,
          authenticate: (request) =>
            Effect.suspend(() => {
              authenticationCalls++;
              return active && request.headers.authorization === "Bearer member"
                ? Effect.succeed(identity)
                : Effect.fail(new TeamDenied({ reason: "sign_in_required" }));
            }),
        };
        yield* Layer.build(
          HttpRouter.serve(
            teamNativeRoutes(auth).pipe(
              Layer.provide(Layer.succeed(TeamNativeProjects, projects)),
              Layer.provide(Layer.succeed(TeamSpaces, spaces)),
            ),
            { disableListenLog: true, disableLogger: true },
          ),
        );
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag !== "TcpAddress")
          return yield* Effect.die("Expected TCP test server");
        const response = yield* HttpClient.post("/api/team/native/ticket", {
          headers: { authorization: "Bearer member", origin: "https://team.example.test" },
          body: yield* HttpBody.json({ spaceId: one.spaceId }),
        });
        const { ticket } = yield* response.json.pipe(Effect.flatMap(decodeTicket));
        const closed = yield* Deferred.make<void>();
        const protocol = RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            Socket.layerWebSocket(
              `ws://127.0.0.1:${server.address.port}/api/team/projects/${one.spaceId}/native/ws?ticket=${ticket}`,
            ).pipe(
              Layer.provide(
                Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
                  const socket = new NodeSocket.NodeWS.WebSocket(url, protocols, {
                    headers: { origin: "https://team.example.test" },
                  });
                  socket.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
                  return socket as unknown as globalThis.WebSocket;
                }),
              ),
            ),
          ),
          Layer.provide(RpcSerialization.layerJson),
        );
        yield* Effect.gen(function* () {
          const client = yield* RpcClient.make(WsRpcGroup);
          const ready = yield* Deferred.make<void>();
          const configFiber = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
            Stream.runForEach((event) => {
              expect(event.type).toBe("snapshot");
              return Deferred.succeed(ready, undefined);
            }),
            Effect.exit,
            Effect.forkScoped,
          );
          yield* Deferred.await(ready);
          const callsBefore = authenticationCalls;
          const native = yield* projects.connect(identity, one.spaceId, resolveUser);
          const initialSequence = yield* native.engine.latestSequence;
          const hostRead = yield* client[WS_METHODS.projectsReadFile]({
            cwd: "/workspace",
            relativePath: "/unrelated-controller-file",
          }).pipe(Effect.exit);
          expect(hostRead._tag).toBe("Failure");
          expect(yield* native.engine.latestSequence).toBe(initialSequence);
          yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](thread(one.spaceId));
          yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](discussion());
          yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](post());
          yield* client[WS_METHODS.serverProbe]({});
          expect(authenticationCalls).toBe(callsBefore);
          expect(configFiber.pollUnsafe()).toBeUndefined();
          if (reason === "removal")
            yield* spaces.execute(owner, {
              action: "removeMember",
              spaceId: one.spaceId,
              userId: member.userId,
            });
          else if (reason === "role-change")
            yield* spaces.execute(owner, {
              action: "setRole",
              spaceId: one.spaceId,
              userId: member.userId,
              role: "viewer",
            });
          else if (reason === "team-removal")
            yield* spaces.rosterCommand(owner, { action: "removeMember", userId: member.userId });
          else if (reason === "team-owner-demotion")
            yield* spaces.rosterCommand(owner, {
              action: "setRole",
              userId: member.userId,
              role: "member",
            });
          else if (reason === "session-revocation") {
            active = false;
            yield* TestClock.adjust("15 seconds");
          } else yield* TestClock.adjust("60 seconds");
          yield* Deferred.await(closed);
          const again = yield* HttpClient.get(
            `/api/team/projects/${one.spaceId}/native/ws?ticket=${ticket}`,
            {
              headers: { origin: "https://team.example.test" },
            },
          );
          expect(again.status).toBe(403);
        }).pipe(Effect.provide(protocol));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, layers()))),
  );
}

it.effect("releases inactive runtimes after the idle period and reopens their durable state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projects, one } = yield* seed;
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* projects.connect(member, one.spaceId, resolveUser);
          yield* connection.dispatch(thread(one.spaceId));
          return connection.engine;
        }),
      );
      yield* TestClock.adjust("31 seconds");
      const reopened = yield* projects.connect(member, one.spaceId, resolveUser);
      expect(reopened.engine).not.toBe(first);
      expect((yield* reopened.query.getShellSnapshot()).threads.map((item) => item.id)).toEqual([
        "thread-one",
      ]);
    }),
  ).pipe(Effect.provide(layers())),
);

it.effect(
  "bounded live delivery fails explicitly and oversized replay returns a fresh snapshot",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, one } = yield* seed;
        const connection = yield* projects.connect(member, one.spaceId, resolveUser);
        yield* connection.dispatch(thread(one.spaceId));
        yield* connection.dispatch(discussion());
        yield* connection.dispatch(post());
        const cursor = yield* connection.engine.latestSequence;
        const blocked = yield* nativeThreadStream(connection, {
          threadId: ThreadId.make("thread-one"),
        });
        // Do not pull the delivery stream while messages exceed its byte budget.
        for (let index = 0; index < 440; index++)
          yield* connection.dispatch({
            type: "sidethread.message.edit",
            commandId: CommandId.make(`edit:${index}`),
            threadId: ThreadId.make("thread-one"),
            sideThreadId: sideThreadIdForThread(ThreadId.make("thread-one")),
            messageId: SideThreadMessageId.make("message-one"),
            text: `${index}:` + "x".repeat(19990),
            createdAt: timestamp,
          });
        const overflow = yield* Effect.flip(blocked.pipe(Stream.take(2), Stream.runCollect));
        expect(overflow._tag).toBe("OrchestrationGetSnapshotError");
        const resumed = yield* nativeThreadStream(connection, {
          threadId: ThreadId.make("thread-one"),
          afterSequence: cursor,
        });
        expect((yield* resumed.pipe(Stream.take(1), Stream.runCollect))[0]?.kind).toBe("snapshot");
      }),
    ).pipe(Effect.provide(layers())),
);

for (const streamKind of ["shell", "thread"] as const) {
  it.effect(`${streamKind} overflow releases its source before the client pulls or closes`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, one } = yield* seed;
        const connection = yield* projects.connect(member, one.spaceId, resolveUser);
        yield* connection.dispatch(thread(one.spaceId));
        yield* connection.dispatch(discussion());
        const receipt = yield* connection.dispatch(post());
        const event = Option.getOrThrow(
          yield* connection.engine.readEvents(receipt.sequence - 1, 1).pipe(Stream.runHead),
        );
        const source = yield* PubSub.unbounded<OrchestrationEvent>();
        const subscriptionClosed = yield* Deferred.make<void>();
        const instrumentedConnection = {
          ...connection,
          engine: {
            ...connection.engine,
            subscribeDomainEvents: Effect.gen(function* () {
              // Register first so this barrier runs after PubSub unsubscribes.
              yield* Effect.addFinalizer(() => Deferred.succeed(subscriptionClosed, undefined));
              return Stream.fromSubscription(yield* PubSub.subscribe(source));
            }),
          },
        };
        if (streamKind === "shell")
          yield* nativeShellStream(instrumentedConnection, {}).pipe(Effect.asVoid);
        else
          yield* nativeThreadStream(instrumentedConnection, {
            threadId: ThreadId.make("thread-one"),
          }).pipe(Effect.asVoid);
        expect(yield* Deferred.isDone(subscriptionClosed)).toBe(false);
        // Leave both the delivery stream and its outer RPC scope open. The
        // producer must release the subscription without another client pull.
        yield* PubSub.publishAll(
          source,
          Array.from({ length: 1001 }, (_, index) => ({
            ...event,
            sequence: receipt.sequence + index + 1,
          })),
        );
        yield* Deferred.await(subscriptionClosed);
        expect(yield* PubSub.size(source)).toBe(0);
        yield* PubSub.publishAll(
          source,
          Array.from({ length: 100 }, (_, index) => ({
            ...event,
            sequence: receipt.sequence + index + 1002,
          })),
        );
        expect(yield* PubSub.size(source)).toBe(0);
      }),
    ).pipe(Effect.provide(layers())),
  );
}

it.effect("shell snapshot/live delivery drains captured writes before synchronized", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projects, one } = yield* seed;
      const connection = yield* projects.connect(member, one.spaceId, resolveUser);
      yield* connection.dispatch(thread(one.spaceId));
      const loaded = yield* Deferred.make<void>();
      const continueSnapshot = yield* Deferred.make<void>();
      const snapshotDelivered = yield* Deferred.make<void>();
      const racingConnection = {
        ...connection,
        query: {
          ...connection.query,
          getShellSnapshot: () =>
            connection.query.getShellSnapshot().pipe(
              Effect.tap(() => Deferred.succeed(loaded, undefined)),
              Effect.tap(() => Deferred.await(continueSnapshot)),
            ),
        },
      };
      const pending = yield* nativeShellStream(racingConnection, {
        requestCompletionMarker: true,
      }).pipe(
        Effect.flatMap((events) =>
          events.pipe(
            Stream.tap((item) =>
              item.kind === "snapshot"
                ? Deferred.succeed(snapshotDelivered, undefined)
                : Effect.void,
            ),
            Stream.take(3),
            Stream.runCollect,
          ),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(loaded);
      const receipt = yield* connection.dispatch(thread(one.spaceId, "created-during-snapshot"));
      yield* Deferred.succeed(continueSnapshot, undefined);
      yield* Deferred.await(snapshotDelivered);
      // Advance the production coalescing window after the snapshot has been
      // delivered. The Deferred barriers and dispatch receipt fix the race order.
      yield* TestClock.adjust("50 millis");
      const items = yield* Fiber.join(pending);
      expect(items.map((item) => item.kind)).toEqual([
        "snapshot",
        "thread-upserted",
        "synchronized",
      ]);
      expect(
        items[0]?.kind === "snapshot" && items[0].snapshot.threads.map((item) => item.id),
      ).toEqual(["thread-one"]);
      expect(items[1]).toMatchObject({
        kind: "thread-upserted",
        sequence: receipt.sequence,
        thread: { id: "created-during-snapshot" },
      });
    }),
  ).pipe(Effect.provide(layers())),
);

it.effect(
  "shell and thread replay exactly 1000 small events but reset above the event-count bound",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projects, one } = yield* seed;
        const connection = yield* projects.connect(member, one.spaceId, resolveUser);
        yield* connection.dispatch(thread(one.spaceId));
        yield* connection.dispatch(discussion());
        yield* connection.dispatch(post());
        const cursor = yield* connection.engine.latestSequence;
        const edit = (index: number) =>
          connection.dispatch({
            type: "sidethread.message.edit",
            commandId: CommandId.make(`small-edit:${index}`),
            threadId: ThreadId.make("thread-one"),
            sideThreadId: sideThreadIdForThread(ThreadId.make("thread-one")),
            messageId: SideThreadMessageId.make("message-one"),
            text: `Small edit ${index}`,
            createdAt: timestamp,
          });
        for (let index = 0; index < 1000; index++) yield* edit(index);
        const head = yield* connection.engine.latestSequence;
        expect(head - cursor).toBe(1000);
        const stats = yield* connection.engine.getThreadReplayStats({
          threadId: ThreadId.make("thread-one"),
          fromSequenceExclusive: cursor,
          toSequenceInclusive: head,
          maxEvents: 1001,
        });
        expect(stats.eventCount).toBe(1000);
        expect(stats.payloadBytes).toBeLessThan(8 * 1024 * 1024);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const shell = yield* nativeShellStream(connection, { afterSequence: cursor });
            const shellItems = yield* shell.pipe(
              Stream.takeUntil(
                (item) =>
                  item.kind === "snapshot" ||
                  (item.kind === "thread-upserted" && item.sequence === head),
              ),
              Stream.runCollect,
            );
            expect(shellItems.every((item) => item.kind === "thread-upserted")).toBe(true);
            expect(shellItems.at(-1)).toMatchObject({
              kind: "thread-upserted",
              sequence: head,
              thread: { id: "thread-one" },
            });
            const detail = yield* nativeThreadStream(connection, {
              threadId: ThreadId.make("thread-one"),
              afterSequence: cursor,
            });
            const detailItems = yield* detail.pipe(
              Stream.takeUntil(
                (item) =>
                  item.kind === "snapshot" ||
                  (item.kind === "event" && item.event.sequence === head),
              ),
              Stream.runCollect,
            );
            expect(detailItems).toHaveLength(1000);
            expect(detailItems.every((item) => item.kind === "event")).toBe(true);
            expect(detailItems[0]).toMatchObject({
              kind: "event",
              event: { sequence: cursor + 1 },
            });
            expect(detailItems.at(-1)).toMatchObject({ kind: "event", event: { sequence: head } });
          }),
        );
        const overflowReceipt = yield* edit(1000);
        expect(overflowReceipt.sequence - cursor).toBe(1001);
        const shellReset = yield* nativeShellStream(connection, { afterSequence: cursor });
        expect((yield* shellReset.pipe(Stream.take(1), Stream.runCollect))[0]).toMatchObject({
          kind: "snapshot",
          snapshot: { snapshotSequence: overflowReceipt.sequence },
        });
        const detailReset = yield* nativeThreadStream(connection, {
          threadId: ThreadId.make("thread-one"),
          afterSequence: cursor,
        });
        expect((yield* detailReset.pipe(Stream.take(1), Stream.runCollect))[0]).toMatchObject({
          kind: "snapshot",
          snapshot: { snapshotSequence: overflowReceipt.sequence },
        });
      }),
    ).pipe(Effect.provide(layers())),
);

it.effect(
  "viewer read/presence does not create a discussion, and the directory resolves trusted project members",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spaces, projects, one, two } = yield* seed;
        const ownerConnection = yield* projects.connect(owner, one.spaceId, resolveUser);
        const reader = yield* projects.connect(viewer, one.spaceId, resolveUser);
        yield* ownerConnection.engine.dispatch(thread(one.spaceId));
        const sequence = yield* ownerConnection.engine.latestSequence;
        const detail = yield* reader.query.getThreadDetailSnapshot(ThreadId.make("thread-one"));
        expect(Option.isSome(detail) && (detail.value.thread.sideThreads ?? []).length).toBe(0);
        yield* reader.heartbeat({ threadId: ThreadId.make("thread-one"), typing: false });
        expect(yield* ownerConnection.engine.latestSequence).toBe(sequence);
        const invitation = yield* spaces.execute(owner, {
          action: "invite",
          spaceId: one.spaceId,
          email: "future@example.test",
          role: "contributor",
        });
        const directory = yield* reader.directory;
        expect(directory.role).toBe("viewer");
        expect(directory.invites).toEqual([]);
        expect(directory.members.map((entry) => entry.user.displayName).sort()).toEqual([
          "Trusted member",
          "Trusted owner",
          "Trusted viewer",
        ]);
        expect((yield* ownerConnection.directory).invites[0]?.id).toBe(invitation.inviteId);
        const other = yield* projects.connect(owner, two.spaceId, resolveUser);
        yield* other.engine.dispatch(thread(two.spaceId, "foreign-presence"));
        expect(
          (yield* reader
            .heartbeat({ threadId: ThreadId.make("foreign-presence"), typing: true })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* ownerConnection.engine.latestSequence).toBe(sequence);
      }),
    ).pipe(Effect.provide(layers())),
);

it.effect(
  "cleans scoped presence on disconnect and membership revocation without accepting forged focus",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spaces, projects, one } = yield* seed;
        const observer = yield* projects.connect(owner, one.spaceId, resolveUser);
        yield* observer.engine.dispatch(thread(one.spaceId));
        const entered = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        const session = yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* projects.connect(member, one.spaceId, resolveUser);
            yield* connection.heartbeat({ threadId: ThreadId.make("thread-one"), typing: true });
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(hold);
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const active = yield* Stream.runHead(observer.presence);
        expect(
          Option.isSome(active) && active.value.entries.map((entry) => entry.user.subject),
        ).toEqual([member.userId]);
        yield* Fiber.interrupt(session);
        const disconnected = yield* Stream.runHead(observer.presence);
        expect(Option.isSome(disconnected) && disconnected.value.entries).toEqual([]);
        const connection = yield* projects.connect(member, one.spaceId, resolveUser);
        yield* connection.heartbeat({ threadId: ThreadId.make("thread-one"), typing: false });
        yield* spaces.execute(owner, {
          action: "removeMember",
          spaceId: one.spaceId,
          userId: member.userId,
        });
        expect(
          (yield* connection.heartbeat({ threadId: null, typing: true }).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        const revoked = yield* Stream.runHead(observer.presence);
        expect(Option.isSome(revoked) && revoked.value.entries).toEqual([]);
      }),
    ).pipe(Effect.provide(layers())),
);

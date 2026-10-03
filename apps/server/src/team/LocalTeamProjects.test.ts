import {
  createThread as createPersonalThread,
  startThreadTurn as startPersonalTurn,
} from "../../../../packages/client-runtime/src/operations/commands.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../../../../packages/client-runtime/src/connection/model.ts";
import * as EnvironmentSupervisor from "../../../../packages/client-runtime/src/connection/supervisor.ts";
import type { RpcSession } from "../../../../packages/client-runtime/src/rpc/session.ts";
import type { WsRpcProtocolClient } from "../../../../packages/client-runtime/src/rpc/protocol.ts";
import { LOCAL_TEAM_METHODS, type LocalTeamProjectControl } from "@t3tools/contracts/teamProjects";
import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import {
  contentHash,
  validateSharedTree,
  restrictedGit,
  gitIdentity,
  preflightRepository,
} from "./TeamGit.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpRouter, HttpServer, FetchHttpClient } from "effect/unstable/http";
import { teamNativeRoutes } from "./nativeHttp.ts";
import { TeamDenied } from "./TeamSpaces.ts";
import { makeTeamProjectTransport } from "./TeamProjectTransport.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError, RpcClientDefect } from "effect/unstable/rpc/RpcClientError";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as EffectPath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  MessageId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TeamSpaces } from "./TeamSpaces.ts";
import { TeamNativeProjects } from "./TeamNativeProjects.ts";
import { LocalTeamAccount } from "./LocalTeamAccount.ts";
import { LocalTeamProjectStore, makeLocalTeamProjectStore } from "./LocalTeamProjectStore.ts";
import {
  TeamProjectTransport,
  localTeamError,
  type TeamProjectCredential,
} from "./TeamProjectTransport.ts";
import { makeLocalTeamProjects } from "./LocalTeamProjects.ts";
import { fileIO } from "./LocalTeamFiles.ts";
// @effect-diagnostics nodeBuiltinImport:off - synthetic source repositories for preflight integration.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { nativeShellStream, nativeThreadStream } from "./nativeStreams.ts";

const basics = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, EffectPath.layer);
const layers = TeamNativeProjects.layer.pipe(
  Layer.provideMerge(TeamSpaces.layer),
  Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        return makeSqlitePersistenceLive((yield* ServerConfig).dbPath);
      }),
    ),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest("/untrusted-host-root", { prefix: "t3-local-project-test-" }),
  ),
  Layer.provideMerge(basics),
);
const time = "1970-01-01T00:00:00.000Z";
const principal = {
  userId: "owner",
  displayName: "Owner",
  verifiedEmails: ["owner@example.test"],
  expiresAt: 1e12,
};
const setup = Effect.gen(function* () {
  const spaces = yield* TeamSpaces;
  const projects = yield* TeamNativeProjects;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const sourceSpace = yield* spaces.execute(principal, { action: "create", name: "Source" }, true);
  const remoteSpace = yield* spaces.execute(principal, { action: "create", name: "Remote" }, true);
  const source = yield* projects.connect(principal, sourceSpace.spaceId, (subject) =>
    Effect.succeed({ subject, displayName: subject }),
  );
  const remote = yield* projects.connect(principal, remoteSpace.spaceId, (subject) =>
    Effect.succeed({ subject, displayName: subject }),
  );
  const projectId = ProjectId.make("local-project");
  const threadId = ThreadId.make("local-thread");
  let counter = 0;
  const commandId = () => CommandId.make(`test-${++counter}`);
  yield* source.engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId,
    title: "Local",
    workspaceRoot: root,
    createdAt: time,
  });
  const createThread = {
    type: "thread.create" as const,
    commandId: commandId(),
    threadId,
    projectId,
    title: "Local conversation",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "example" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdAt: time,
  };
  yield* source.engine.dispatch(createThread);
  const message = (text: string, streaming = false, role: "user" | "assistant" = "assistant") =>
    source.engine.dispatch({
      type: "thread.publication.message",
      commandId: commandId(),
      threadId,
      messageId: MessageId.make(role),
      turnId: TurnId.make("turn"),
      role,
      text,
      streaming,
      createdAt: time,
      updatedAt: time,
    });
  let credential: TeamProjectCredential = {
    serviceUrl: "http://localhost:3910",
    issuer: "https://issuer.example",
    clientId: "public",
    subject: "owner",
    generation: "generation-1",
    accessToken: "PRIVATE-TOKEN",
  };
  const changes = yield* PubSub.unbounded<string>();
  const secrets = new Map<string, Uint8Array>();
  const secretStore = ServerSecretStore.of({
    get: (key) => Effect.succeed(Option.fromNullishOr(secrets.get(key))),
    set: (key, value) =>
      Effect.sync(() => {
        secrets.set(key, value);
      }),
    create: (key, value) =>
      Effect.sync(() => {
        secrets.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        secrets.delete(key);
      }),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const account = LocalTeamAccount.of({
    refreshState: Effect.die("unused"),
    teamDirectory: Effect.die("unused"),
    teamCommand: () => Effect.die("unused"),
    state: Effect.sync(() => ({
      generation: credential.generation,
      serviceUrl: credential.serviceUrl,
      account: null,
      flow: null,
      message: null,
    })),
    withCredential: (use) => Effect.suspend(() => use(credential)),
    identityChanges: Stream.fromPubSub(changes),
    start: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    disconnect: Effect.die("unused"),
    projects: Effect.die("unused"),
  });
  let offline = false;
  let lostAck = false;
  let viewer = false;
  let createCalls = 0;
  let openCalls = 0;
  const heartbeatConnections: string[] = [];
  let allowCloudCreate = false;
  let beforeRepository: (action: string) => Effect.Effect<void> = () => Effect.void;
  const blockRepository = Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    beforeRepository = (action) =>
      action === "begin"
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void;
    return { entered: Deferred.await(entered), release: Deferred.succeed(release, undefined) };
  });
  const transport = TeamProjectTransport.of({
    membership: () => Effect.die("unused"),
    create: () => {
      createCalls++;
      return allowCloudCreate
        ? Effect.succeed({ spaceId: remoteSpace.spaceId })
        : Effect.die("unused");
    },
    open: () => {
      openCalls++;
      const connectionId = `presence-${openCalls}`;
      return offline
        ? Effect.fail(localTeamError("network"))
        : Effect.succeed({
            directory: remote.directory.pipe(Effect.mapError(() => localTeamError("access"))),
            presence: remote.presence,
            heartbeat: (focus) => {
              heartbeatConnections.push(connectionId);
              return remote.heartbeat(focus).pipe(Effect.mapError(() => localTeamError("access")));
            },
            repository: (command) =>
              beforeRepository(command.action).pipe(
                Effect.andThen(remote.repository.command(command)),
              ),
            files: remote.repository.subscribe.pipe(Stream.scoped),
            config: remote.wireConfig.pipe(
              Effect.map((config) =>
                viewer
                  ? { ...config, teamProject: { ...config.teamProject, role: "viewer" as const } }
                  : config,
              ),
              Effect.mapError(() => localTeamError("access")),
            ),
            register: remote.publications.register,
            publish: (input) =>
              remote.publications.publish(input).pipe(
                Effect.flatMap((ack) => {
                  if (lostAck) {
                    lostAck = false;
                    return Effect.fail(
                      new RpcClientError({
                        reason: new RpcClientDefect({
                          message: "PRIVATE-TOKEN ticket=PRIVATE-CAPABILITY",
                          cause: undefined,
                        }),
                      }),
                    );
                  }
                  return Effect.succeed(ack);
                }),
              ),
            shell: (input) =>
              Stream.unwrap(nativeShellStream(remote, input)).pipe(
                Stream.scoped,
                Stream.mapError(() => localTeamError("access")),
              ),
            thread: (input) =>
              Stream.unwrap(nativeThreadStream(remote, input)).pipe(
                Stream.scoped,
                Stream.mapError(() => localTeamError("access")),
              ),
            discussion: (input) =>
              remote.dispatch(input).pipe(Effect.mapError(() => localTeamError("access"))),
            snapshot: (id, window) =>
              remote.query.getThreadDetailSnapshot(id, window).pipe(
                Effect.flatMap((result) =>
                  Option.isSome(result)
                    ? Effect.succeed(result.value)
                    : Effect.fail(localTeamError("invalid")),
                ),
                Effect.mapError(() => localTeamError("network")),
              ),
          });
    },
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, source.sql),
    Layer.succeed(OrchestrationEngineService, source.engine),
    Layer.succeed(ProjectionSnapshotQuery, source.query),
    Layer.succeed(ServerSecretStore, secretStore),
    Layer.succeed(LocalTeamAccount, account),
    Layer.succeed(TeamProjectTransport, transport),
  );
  const store = yield* makeLocalTeamProjectStore.pipe(Effect.provide(dependencies));
  let beforeDetach: Effect.Effect<void> = Effect.void;
  const blockDetach = Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    beforeDetach = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    return { entered: Deferred.await(entered), release: Deferred.succeed(release, undefined) };
  });
  let notifyStatus: (status: string) => Effect.Effect<void> = () => Effect.void;
  const watchStatus = Effect.fnUntraced(function* (expected: string) {
    const receipt = yield* Deferred.make<void>();
    notifyStatus = (status) =>
      status === expected ? Deferred.succeed(receipt, undefined).pipe(Effect.asVoid) : Effect.void;
    return Deferred.await(receipt);
  });
  let beforePreflight: Effect.Effect<void> = Effect.void;
  const blockPreflight = Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    beforePreflight = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    return { entered: Deferred.await(entered), release: Deferred.succeed(release, undefined) };
  });
  const bridge = (workers = false) =>
    Effect.gen(function* () {
      const reloadedStore = yield* makeLocalTeamProjectStore;
      return yield* makeLocalTeamProjects(workers, (root) =>
        beforePreflight.pipe(Effect.andThen(fileIO((signal) => preflightRepository(root, signal)))),
      ).pipe(
        Effect.provideService(LocalTeamProjectStore, {
          ...reloadedStore,
          detach: (row) => beforeDetach.pipe(Effect.andThen(reloadedStore.detach(row))),
          status: (id, value) =>
            reloadedStore.status(id, value).pipe(Effect.andThen(notifyStatus(value))),
        }),
      );
    }).pipe(Effect.provide(dependencies));
  const service = yield* bridge();
  return {
    service,
    createCalls: () => createCalls,
    openCalls: () => openCalls,
    heartbeatConnections,
    allowCreate: () => {
      allowCloudCreate = true;
    },
    blockRepository,
    blockPreflight,
    bridge,
    store,
    reloadStore: makeLocalTeamProjectStore.pipe(Effect.provide(dependencies)),
    watchStatus,
    blockDetach,
    source,
    remote,
    projectId,
    threadId,
    root,
    commandId,
    createThread,
    message,
    secrets,
    remoteSpace,
    offline: (value: boolean) => {
      offline = value;
    },
    loseAck: () => {
      lostAck = true;
    },
    viewer: (value: boolean) => {
      viewer = value;
    },
    changeAccount: Effect.gen(function* () {
      credential = { ...credential, generation: "generation-2", subject: "other" };
      yield* PubSub.publish(changes, credential.generation);
    }),
  };
});

it.effect(
  "links without publishing history, then publishes a current snapshot and safe live replacements with durable lost-ACK retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.message("Before linking", false, "user");
        yield* f.message("old draft", true);
        yield* f.message("Current answer", false);
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        yield* f.service.flush(f.projectId);
        expect((yield* f.remote.query.getSnapshot()).threads).toHaveLength(0);
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        f.loseAck();
        const failure = yield* f.service.flush(f.projectId).pipe(Effect.flip);
        expect(failure.reason).toBe("network");
        expect(String(failure)).not.toContain("PRIVATE");
        const saved = (yield* f.service.state)[0]!;
        expect(saved.publications[0]?.revision).toBe(0);
        const resumed = yield* f.bridge();
        yield* resumed.flush(f.projectId);
        const cloud = (yield* f.remote.query.getSnapshot()).threads[0]!;
        expect(cloud.messages.map((item) => item.text)).toEqual(
          (yield* f.source.query.getSnapshot()).threads[0]!.messages.map((item) => item.text),
        );
        expect(cloud.session).toBeNull();
        expect(cloud.worktreePath).toBeNull();
        yield* f.message(" plus", true);
        yield* f.message("Final replacement", false);
        yield* resumed.flush(f.projectId);
        expect(
          (yield* f.remote.query.getSnapshot()).threads[0]?.messages.find(
            (message) => message.role === "assistant",
          )?.text,
        ).toBe("Final replacement");
        const view = yield* resumed.snapshot(f.projectId, cloud.id);
        expect(view.thread.source.executionRef).toEqual({
          projectId: f.projectId,
          threadId: f.threadId,
        });
        expect(view).not.toHaveProperty("session");
        expect((yield* f.source.query.getSnapshot()).threads).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "allows offline local work but blocks viewers and changed accounts without executing inbound cloud commands",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        f.offline(true);
        yield* f.service.guard({
          ...f.createThread,
          threadId: ThreadId.make("next"),
          commandId: f.commandId(),
        });
        expect(
          yield* f.service
            .control({ action: "publish", projectId: f.projectId, threadId: f.threadId })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "network" });
        f.offline(false);
        f.viewer(true);
        expect(yield* f.service.guard(f.createThread).pipe(Effect.flip)).toMatchObject({
          reason: "access",
        });
        expect(
          yield* f.service.discuss(f.projectId, f.createThread).pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid" });
        yield* f.changeAccount;
        expect(yield* f.service.flush(f.projectId).pipe(Effect.flip)).toMatchObject({
          reason: "changed",
        });
        expect((yield* f.service.state)[0]?.link.status).toBe("account-changed");
        expect((yield* f.source.query.getSnapshot()).threads[0]?.session).toBeNull();
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "pauses changed roots and detaches unlinked projects while preserving cloud history",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.message("Retained", false, "user");
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        yield* f.service.flush(f.projectId);
        yield* f.source.engine.dispatch({
          type: "project.meta.update",
          commandId: f.commandId(),
          projectId: f.projectId,
          workspaceRoot: "/missing-root",
        });
        expect(yield* f.service.flush(f.projectId).pipe(Effect.flip)).toMatchObject({
          reason: "root_changed",
        });
        yield* f.service.control({ action: "unlink", projectId: f.projectId });
        expect(yield* f.service.state).toEqual([]);
        expect((yield* f.remote.query.getSnapshot()).threads).toHaveLength(1);
        expect(
          [...f.secrets.keys()].filter((key) => key.startsWith("teams-publication-")),
        ).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "pages Unicode history with bounded pending batches and pauses a destructive reset before sending the pending page",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const long =
          "a".repeat(16360) + "[asset](/api/attachments/private-image)" + "😀".repeat(17000);
        yield* f.message(long);
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        yield* f.service.flush(f.projectId);
        expect((yield* f.remote.query.getSnapshot()).threads[0]?.messages[0]?.text).toBe(
          long.replace("/api/attachments/private-image", "[shared attachment unavailable]"),
        );
        const row = (yield* f.store.link(f.projectId))!;
        yield* f.message("pending addition", true);
        const mapping = (yield* f.store.publications(row.link_id))[0]!;
        const pending = yield* f.store.next(mapping);
        expect(pending?.changes.length).toBeLessThanOrEqual(64);
        yield* f.source.engine.dispatch({
          type: "thread.revert.complete",
          commandId: f.commandId(),
          threadId: f.threadId,
          turnCount: 0,
          createdAt: time,
        });
        expect(yield* f.service.flush(f.projectId).pipe(Effect.flip)).toMatchObject({
          reason: "reset_required",
        });
        expect((yield* f.service.state)[0]?.publications[0]?.status).toBe("reset-required");
        expect((yield* f.remote.query.getSnapshot()).threads[0]?.messages[0]?.text).not.toContain(
          "pending addition",
        );
        yield* f.service.control({ action: "unlink", projectId: f.projectId });
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        yield* f.service.flush(f.projectId);
        expect((yield* f.remote.query.getSnapshot()).threads).toHaveLength(2);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect("detaches a deleted local project and keeps its shared history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.service.control({
        action: "link",
        projectId: f.projectId,
        sharedProjectId: f.remoteSpace.spaceId,
      });
      yield* f.source.engine.dispatch({
        type: "project.delete",
        commandId: f.commandId(),
        projectId: f.projectId,
        force: true,
      });
      expect(yield* f.service.flush(f.projectId).pipe(Effect.flip)).toMatchObject({
        reason: "unlinked",
      });
      expect(yield* f.service.state).toEqual([]);
    }),
  ).pipe(Effect.provide(layers)),
);

it.effect(
  "runs the scoped worker from durable state and cancels it when the publishing account changes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.message("Worker snapshot", false, "user");
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        const synced = yield* f.watchStatus("synced");
        yield* f.bridge(true);
        yield* synced;
        expect((yield* f.remote.query.getSnapshot()).threads[0]?.messages[0]?.text).toBe(
          "Worker snapshot",
        );
        const updated = yield* f.watchStatus("synced");
        yield* f.message("Live worker update");
        yield* TestClock.adjust("100 millis");
        yield* updated;
        expect(
          (yield* f.remote.query.getSnapshot()).threads[0]?.messages.some(
            (message) => message.text === "Live worker update",
          ),
        ).toBe(true);
        const stopped = yield* f.watchStatus("account-changed");
        yield* f.changeAccount;
        yield* stopped;
        yield* f.message("Private after account change");
        expect(
          (yield* f.remote.query.getSnapshot()).threads[0]?.messages.some((message) =>
            message.text.includes("Private after"),
          ),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "closes peer streams on account change without importing cloud records into the local engine",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        const registration = {
          publicationId: "a".repeat(32),
          installationId: "b".repeat(32),
          capability: "c".repeat(64),
        };
        yield* f.remote.publications.register(registration);
        const ack = yield* f.remote.publications.publish({
          ...registration,
          fromRevision: 0,
          changes: [
            {
              kind: "create",
              title: "Peer",
              display: { provider: "claude", model: "safe-model" },
              createdAt: time,
            },
            { kind: "status", status: "working", updatedAt: time },
          ],
        });
        const snapshot = yield* f.service.snapshot(f.projectId, ack.threadId);
        expect(snapshot.thread.source.executionRef).toBeNull();
        expect(snapshot.thread.source.assetSource).toBe("unavailable");
        expect(snapshot.memberStatus).toEqual({
          status: "working",
          reportedBy: "owner",
          updatedAt: time,
        });
        const ready = yield* Deferred.make<void>();
        const fiber = yield* f.service.subscribeThread(f.projectId, ack.threadId).pipe(
          Stream.tap((item) =>
            item.kind === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.runDrain,
          Effect.result,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        yield* f.changeAccount;
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "changed" },
        });
        expect((yield* f.source.query.getSnapshot()).threads.map((thread) => thread.id)).toEqual([
          f.threadId,
        ]);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "uses the actual private ticket and WebSocket transport for publication, snapshots, and reconnect",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spaces = yield* TeamSpaces;
        const projects = yield* TeamNativeProjects;
        const { spaceId } = yield* spaces.execute(
          principal,
          { action: "create", name: "Socket project" },
          true,
        );
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag !== "InetAddressV4" && server.address._tag !== "InetAddressV6")
          return yield* Effect.die("Expected TCP test server");
        const serviceUrl = `http://127.0.0.1:${server.address.port}`;
        const auth = {
          origins: [serviceUrl],
          resolveUser: (subject: string) => Effect.succeed({ subject, displayName: subject }),
          authenticate: (
            request: import("effect/unstable/http/HttpServerRequest").HttpServerRequest,
          ) =>
            request.headers.authorization === "Bearer test-token"
              ? Effect.succeed({ ...principal, expiresAt: 1e15 })
              : Effect.fail(new TeamDenied({ reason: "sign_in_required" })),
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
        const transport = yield* makeTeamProjectTransport.pipe(
          Effect.provide(FetchHttpClient.layer),
        );
        const credential = {
          serviceUrl,
          issuer: "https://issuer.test",
          clientId: "public",
          subject: "owner",
          generation: "1",
          accessToken: "test-token",
        };
        const registration = {
          publicationId: "e".repeat(32),
          installationId: "f".repeat(32),
          capability: "a".repeat(64),
        };
        const batch = {
          ...registration,
          fromRevision: 0,
          changes: [
            {
              kind: "create" as const,
              title: "Socket publication",
              display: { provider: "codex" as const, model: "safe" },
              createdAt: time,
            },
          ],
        };
        const ack = yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* transport.open(credential, spaceId);
            expect((yield* connection.config).teamProject?.role).toBe("owner");
            yield* connection.repository({
              action: "begin",
              id: "b".repeat(32),
              branch: "main",
              commit: null,
              expected: null,
              bytes: 0,
              hash: contentHash(""),
            });
            yield* connection.repository({ action: "finish", id: "b".repeat(32) });
            const fileReceipt = yield* connection.repository({
              action: "mutate",
              mutation: {
                id: "c".repeat(32),
                changes: [
                  {
                    path: "socket.txt",
                    expected: null,
                    expectedExecutable: null,
                    content: Buffer.from("over websocket").toString("base64"),
                    executable: false,
                  },
                ],
              },
            });
            expect(fileReceipt.receipt?.status).toBe("accepted");
            expect(
              (yield* connection.repository({ action: "manifest" })).manifest?.files[0]?.hash,
            ).toBe(contentHash("over websocket"));
            const privateConnection = yield* projects.connect(principal, spaceId, auth.resolveUser);
            // Exercise the real receiver with 10,000 valid entries near the metadata ceiling.
            const metadataEntries = Array.from({ length: 9999 }, (_, index) => ({
              path: `${"p".repeat(105)}/${String(index).padStart(6, "0")}`,
              size: 0,
              hash: contentHash(""),
              executable: 0,
            }));
            validateSharedTree([...metadataEntries, { path: "socket.txt", size: 14 }]);
            yield* privateConnection.sql.withTransaction(
              Effect.gen(function* () {
                for (let offset = 0; offset < metadataEntries.length; offset += 100)
                  yield* privateConnection.sql`INSERT INTO team_files ${privateConnection.sql.insert(metadataEntries.slice(offset, offset + 100))}`;
              }),
            );
            const largeManifest = (yield* connection.repository({ action: "manifest" })).manifest!;
            expect(largeManifest.files).toHaveLength(10000);
            expect(() =>
              validateSharedTree(
                metadataEntries.map((entry) => ({ ...entry, path: `long${entry.path}` })),
              ),
            ).toThrow("4 MiB path-metadata");
            // A supported conflict carries two 1 MiB proposals. Several proposals require pages.
            const proposal = Buffer.alloc(1024 * 1024, "x").toString("base64");
            const conflictIds: string[] = [];
            for (let index = 0; index < 4; index++) {
              const mutation = {
                id: `${index + 1}`.repeat(32),
                changes: metadataEntries.slice(index * 2, index * 2 + 2).map((entry) => ({
                  path: entry.path,
                  expected: "0".repeat(64),
                  expectedExecutable: false,
                  content: proposal,
                  executable: false,
                })),
              };
              expect(
                (yield* connection.repository({ action: "mutate", mutation })).receipt?.status,
              ).toBe("conflict");
              conflictIds.push(mutation.id);
            }
            let after: string | undefined;
            const received: string[] = [];
            do {
              const page = yield* connection.repository({
                action: "conflicts",
                ...(after ? { after } : {}),
              });
              expect(page.conflicts).toHaveLength(1);
              expect(page.conflicts![0]!.mutation.changes.map((change) => change.content)).toEqual([
                proposal,
                proposal,
              ]);
              received.push(page.conflicts![0]!.receipt.id);
              after = page.nextConflict;
            } while (after);
            expect(received).toEqual(conflictIds);
            yield* connection.register(registration);
            return yield* connection.publish(batch);
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* transport.open(credential, spaceId);
            expect(yield* connection.publish(batch)).toEqual(ack);
            expect((yield* connection.snapshot(ack.threadId, { turnLimit: 10 })).thread.title).toBe(
              "Socket publication",
            );
            const shell = yield* connection.shell({}).pipe(Stream.take(1), Stream.runCollect);
            expect(shell[0]).toMatchObject({
              kind: "snapshot",
              snapshot: { threads: [{ id: ack.threadId }] },
            });
          }),
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, layers))),
);

for (const action of ["unlink", "delete"] as const) {
  it.effect(`cancels an idle peer project stream immediately on ${action}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        const ready = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const reader = yield* f.service.subscribeProject(f.projectId).pipe(
          Stream.tap((item) =>
            item.kind === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.runDrain,
          Effect.result,
          Effect.ensuring(Deferred.succeed(closed, undefined)),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        if (action === "unlink")
          yield* f.service.control({ action: "unlink", projectId: f.projectId });
        else
          yield* f.source.engine.dispatch({
            type: "project.delete",
            commandId: f.commandId(),
            projectId: f.projectId,
            force: true,
          });
        yield* Deferred.await(closed);
        expect(yield* Fiber.join(reader)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unlinked" },
        });
      }),
    ).pipe(Effect.provide(layers)),
  );
}

it.effect(
  "rejects an oversized escaped live event without advancing its cursor or claiming synchronization",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        yield* f.service.flush(f.projectId);
        const link = (yield* f.store.link(f.projectId))!;
        const before = (yield* f.store.publications(link.link_id))[0]!;
        yield* f.message("\u0000".repeat(100000));
        expect(yield* f.service.flush(f.projectId).pipe(Effect.flip)).toMatchObject({
          reason: "limit",
        });
        const after = (yield* f.store.publications(link.link_id))[0]!;
        expect(after.source_cursor).toBe(before.source_cursor);
        expect(after.status).toBe("reset-required");
        expect((yield* f.service.state)[0]?.link.status).toBe("reset-required");
        expect((yield* f.remote.query.getSnapshot()).threads[0]?.messages).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "continues beyond a full page of omitted local events before claiming the publication is synchronized",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        yield* f.service.flush(f.projectId);
        for (let i = 0; i < 70; i++)
          yield* f.source.engine.dispatch({
            type: "thread.meta.update",
            commandId: f.commandId(),
            threadId: f.threadId,
            branch: `local-${i}`,
          });
        yield* f.message("After omitted events");
        const link = (yield* f.store.link(f.projectId))!;
        const first = yield* f.store.next((yield* f.store.publications(link.link_id))[0]!);
        expect(first).not.toBeNull();
        expect(first?.changes).toEqual([]);
        expect((yield* f.store.publications(link.link_id))[0]?.status).toBe("syncing");
        yield* f.service.flush(f.projectId);
        expect((yield* f.remote.query.getSnapshot()).threads[0]?.messages[0]?.text).toBe(
          "After omitted events",
        );
        expect((yield* f.service.state)[0]?.link.status).toBe("synced");
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect("refuses a new peer subscription while unlink is waiting for durable detach", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.service.control({
        action: "link",
        projectId: f.projectId,
        sharedProjectId: f.remoteSpace.spaceId,
      });
      const barrier = yield* f.blockDetach;
      const unlink = yield* f.service
        .control({ action: "unlink", projectId: f.projectId })
        .pipe(Effect.forkScoped);
      yield* barrier.entered;
      expect(
        yield* f.service.subscribeProject(f.projectId).pipe(Stream.runDrain, Effect.flip),
      ).toMatchObject({ reason: "unlinked" });
      yield* barrier.release;
      yield* Fiber.join(unlink);
      expect(yield* f.service.state).toEqual([]);
    }),
  ).pipe(Effect.provide(layers)),
);

for (const unsupported of ["protected", "oversized"] as const) {
  it.effect(
    `rejects ${unsupported} selected history before creating cloud metadata or a local link`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          yield* fileIO(async (signal) => {
            await restrictedGit(
              f.root,
              ["init", "--template=", "--initial-branch", "main"],
              signal,
            );
            const name = unsupported === "protected" ? ".env.example" : "large.txt";
            await NodeFSP.writeFile(
              NodePath.join(f.root, name),
              unsupported === "protected"
                ? "SYNTHETIC_TEMPLATE=not-real"
                : Buffer.alloc(1024 * 1024 + 1, "x"),
            );
            await restrictedGit(f.root, ["add", name], signal);
            await restrictedGit(
              f.root,
              [
                "-c",
                "user.name=Synthetic",
                "-c",
                "user.email=synthetic@example.test",
                "commit",
                "-m",
                "unsupported history",
              ],
              signal,
            );
          });
          const identity = yield* fileIO((signal) => gitIdentity(f.root, signal, false));
          const secretCount = f.secrets.size;
          const failure = yield* f.service
            .filesControl({
              action: "share",
              projectId: f.projectId,
              name: "Synthetic unsupported project",
              expectedBranch: identity.branch,
              expectedCommit: identity.commit,
            })
            .pipe(Effect.result);
          expect(failure._tag).toBe("Failure");
          if (failure._tag === "Failure") {
            expect(failure.failure.reason).toBe(unsupported === "protected" ? "invalid" : "limit");
            if (unsupported === "protected")
              expect(failure.failure.message).toContain("retrying unchanged history will not help");
          }
          expect(f.createCalls()).toBe(0);
          expect(yield* f.store.link(f.projectId)).toBeUndefined();
          expect(yield* f.service.state).toEqual([]);
          expect(f.secrets.size).toBe(secretCount);
        }),
      ).pipe(Effect.provide(layers)),
  );
}

it.effect("cancels Share during local preflight when the account generation changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* fileIO((signal) =>
        restrictedGit(f.root, ["init", "--template=", "--initial-branch", "main"], signal),
      );
      const identity = yield* fileIO((signal) => gitIdentity(f.root, signal, false));
      const secretCount = f.secrets.size;
      const barrier = yield* f.blockPreflight;
      const share = yield* f.service
        .filesControl({
          action: "share",
          projectId: f.projectId,
          name: "Synthetic cancelled project",
          expectedBranch: identity.branch,
          expectedCommit: identity.commit,
        })
        .pipe(Effect.result, Effect.forkScoped);
      yield* barrier.entered;
      yield* f.changeAccount;
      const result = yield* Fiber.join(share);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("changed");
      yield* barrier.release;
      expect(f.createCalls()).toBe(0);
      expect(yield* f.store.link(f.projectId)).toBeUndefined();
      expect(yield* f.service.state).toEqual([]);
      expect(f.secrets.size).toBe(secretCount);
    }),
  ).pipe(Effect.provide(layers)),
);

for (const change of ["metadata", "replacement"] as const) {
  it.effect(`refuses Share after project root ${change} changes during preflight`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* fileIO((signal) =>
          restrictedGit(f.root, ["init", "--template=", "--initial-branch", "main"], signal),
        );
        const identity = yield* fileIO((signal) => gitIdentity(f.root, signal, false));
        const secretCount = f.secrets.size;
        const barrier = yield* f.blockPreflight;
        const share = yield* f.service
          .filesControl({
            action: "share",
            projectId: f.projectId,
            name: "Synthetic root change",
            expectedBranch: identity.branch,
            expectedCommit: identity.commit,
          })
          .pipe(Effect.result, Effect.forkScoped);
        yield* barrier.entered;
        if (change === "metadata")
          yield* f.source.engine.dispatch({
            type: "project.meta.update",
            commandId: f.commandId(),
            projectId: f.projectId,
            workspaceRoot: "/missing-root",
          });
        else
          yield* fileIO(async (signal) => {
            await NodeFSP.rename(f.root, `${f.root}-retained`);
            await NodeFSP.mkdir(f.root);
            await restrictedGit(
              f.root,
              ["init", "--template=", "--initial-branch", "main"],
              signal,
            );
          });
        yield* barrier.release;
        const result = yield* Fiber.join(share);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.reason).toBe("root_changed");
        expect(f.createCalls()).toBe(0);
        expect(yield* f.store.link(f.projectId)).toBeUndefined();
        expect(yield* f.service.state).toEqual([]);
        expect(f.secrets.size).toBe(secretCount);
        if (change === "replacement")
          yield* fileIO(async () => {
            // Only the synthetic empty replacement and owned retained fixture are removed.
            await NodeFSP.rm(f.root, { recursive: true, force: true });
            await NodeFSP.rename(`${f.root}-retained`, f.root);
          });
      }),
    ).pipe(Effect.provide(layers)),
  );
}

for (const change of ["metadata", "replacement", "account"] as const) {
  it.effect(
    `fences initial Share upload after ${change} changes while the first write is pending`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          yield* fileIO((signal) =>
            restrictedGit(f.root, ["init", "--template=", "--initial-branch", "main"], signal),
          );
          const identity = yield* fileIO((signal) => gitIdentity(f.root, signal, false));
          f.allowCreate();
          const barrier = yield* f.blockRepository;
          const share = yield* f.service
            .filesControl({
              action: "share",
              projectId: f.projectId,
              name: "Synthetic fenced upload",
              expectedBranch: identity.branch,
              expectedCommit: identity.commit,
            })
            .pipe(Effect.result, Effect.forkScoped);
          yield* barrier.entered;
          if (change === "account") yield* f.changeAccount;
          else if (change === "metadata")
            yield* f.source.engine.dispatch({
              type: "project.meta.update",
              commandId: f.commandId(),
              projectId: f.projectId,
              workspaceRoot: "/missing-root",
            });
          else
            yield* fileIO(async (signal) => {
              await NodeFSP.rename(f.root, `${f.root}-retained`);
              await NodeFSP.mkdir(f.root);
              await restrictedGit(
                f.root,
                ["init", "--template=", "--initial-branch", "main"],
                signal,
              );
            });
          yield* barrier.release;
          const result = yield* Fiber.join(share);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.reason).toBe(change === "account" ? "changed" : "root_changed");
          expect(f.createCalls()).toBe(1);
          expect(
            (yield* f.remote.repository.command({ action: "repository" })).repository,
          ).toBeUndefined();
          expect(
            (yield* f.remote.sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM team_git_uploads`)[0]?.count,
          ).toBe(0);
          if (change === "replacement")
            yield* fileIO(async () => {
              await NodeFSP.rm(f.root, { recursive: true, force: true });
              await NodeFSP.rename(`${f.root}-retained`, f.root);
            });
        }),
      ).pipe(Effect.provide(layers)),
  );
}

it.effect(
  "keeps accepted local turns separate from failed publication and recovers explicit intent after a creation receipt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        const threadId = ThreadId.make("new-shared-thread");
        const create = { ...f.createThread, commandId: f.commandId(), threadId };
        yield* f.service.control({
          action: "intent",
          commandId: create.commandId,
          projectId: f.projectId,
          threadId,
          generation: "generation-1",
          shared: true,
        });
        yield* f.service.afterReceipt(create);
        expect((yield* f.service.state)[0]?.publications).toHaveLength(0);
        expect((yield* f.service.state)[0]?.publicationIntents).toEqual([
          { threadId, status: "pending" },
        ]);
        // The real pure engine accepts the local creation/turn. No provider reactor is installed.
        yield* f.source.engine.dispatch(create);
        const turn = {
          type: "thread.turn.start" as const,
          commandId: f.commandId(),
          threadId,
          message: {
            messageId: MessageId.make("first-send"),
            role: "user" as const,
            text: "Local request accepted once",
            attachments: [],
          },
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
          createdAt: time,
        };
        const receipt = yield* f.source.engine.dispatch(turn);
        f.offline(true);
        yield* f.service.afterReceipt({ ...turn, bootstrap: { createThread: create } });
        expect(receipt.sequence).toBeGreaterThan(0);
        expect((yield* f.service.state)[0]?.publications).toHaveLength(1);
        expect((yield* f.service.flush(f.projectId).pipe(Effect.flip)).reason).toBe("network");
        const sequence = yield* f.source.engine.latestSequence;
        f.offline(false);
        const restarted = yield* f.bridge();
        yield* restarted.flush(f.projectId);
        yield* restarted.flush(f.projectId);
        expect(yield* f.source.engine.latestSequence).toBe(sequence);
        const accepted = yield* Stream.runCollect(f.source.engine.readEvents(0));
        expect(
          Array.from(accepted).filter((event) => event.type === "thread.turn-start-requested"),
        ).toHaveLength(1);
        const cloud = yield* f.remote.query.getSnapshot();
        expect(cloud.threads).toHaveLength(1);
        const detail = yield* f.remote.query.getThreadDetailSnapshot(cloud.threads[0]!.id);
        expect(
          Option.isSome(detail) &&
            detail.value.thread.messages
              .filter((message) => message.role === "user")
              .map((message) => message.text),
        ).toEqual(["Local request accepted once"]);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "stops future sharing without deleting published history and resumes only on explicit publication",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.message("Visible before stop");
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        yield* f.service.flush(f.projectId);
        yield* f.service.control({
          action: "stop-publication",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        yield* f.message("Local while stopped");
        yield* f.service.flush(f.projectId);
        const row = (yield* f.service.state)[0]!;
        expect(row.publications[0]?.paused).toBe(true);
        const sharedId = row.publications[0]!.sharedThreadId!;
        const before = yield* f.remote.query.getThreadDetailSnapshot(sharedId);
        expect(Option.isSome(before) && before.value.thread.messages[0]?.text).toBe(
          "Visible before stop",
        );
        yield* f.service.control({
          action: "publish",
          projectId: f.projectId,
          threadId: f.threadId,
        });
        yield* f.service.flush(f.projectId);
        const after = yield* f.remote.query.getThreadDetailSnapshot(sharedId);
        expect(Option.isSome(after) && after.value.thread.messages[0]?.text).toBe(
          "Local while stopped",
        );
        yield* f.service.control({ action: "unlink", projectId: f.projectId });
        expect(Option.isSome(yield* f.source.query.getThreadShellById(f.threadId))).toBe(true);
        expect(Option.isSome(yield* f.remote.query.getThreadDetailSnapshot(sharedId))).toBe(true);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "fences durable draft intent by account generation and keeps separate worktrees local",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        const threadId = ThreadId.make("worktree-thread");
        const create = {
          ...f.createThread,
          threadId,
          commandId: f.commandId(),
          worktreePath: "/outside-root",
        };
        expect(
          (yield* f.service
            .control({
              action: "intent",
              commandId: create.commandId,
              projectId: f.projectId,
              threadId,
              generation: "old-generation",
              shared: true,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("access");
        yield* f.service.control({
          action: "intent",
          commandId: create.commandId,
          projectId: f.projectId,
          threadId,
          generation: "generation-1",
          shared: true,
        });
        yield* f.source.engine.dispatch(create);
        yield* f.service.afterReceipt(create);
        expect((yield* f.service.state)[0]?.publicationIntents).toEqual([
          { threadId, status: "error" },
        ]);
        expect((yield* f.service.state)[0]?.publications).toHaveLength(0);
        expect(
          (yield* f.service
            .control({ action: "publish", projectId: f.projectId, threadId })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid");
        yield* f.changeAccount;
        yield* f.service.afterReceipt(create);
        expect((yield* f.remote.query.getSnapshot()).threads).toHaveLength(0);
        expect((yield* f.service.state)[0]?.link.status).toBe("account-changed");
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect(
  "reuses the authorized presence connection for heartbeats and fences it on account change",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        const ready = yield* Deferred.make<void>();
        const presence = yield* f.service.subscribePresence(f.projectId, "owner-a").pipe(
          Stream.runForEach(() => Deferred.succeed(ready, undefined)),
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        const count = f.openCalls();
        for (let i = 0; i < 3; i++)
          yield* f.service.heartbeat(f.projectId, { threadId: null, typing: false }, "owner-a");
        expect(f.openCalls()).toBe(count);
        expect(f.heartbeatConnections).toHaveLength(3);
        expect(new Set(f.heartbeatConnections).size).toBe(1);
        yield* f.changeAccount;
        yield* Fiber.join(presence);
        expect(
          (yield* f.service
            .heartbeat(f.projectId, { threadId: null, typing: true }, "owner-a")
            .pipe(Effect.flip)).reason,
        ).toBe("changed");
        expect(f.openCalls()).toBe(count);
      }),
    ).pipe(Effect.provide(layers)),
);

it.effect("routes each presence heartbeat to the subscription that owns it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.service.control({
        action: "link",
        projectId: f.projectId,
        sharedProjectId: f.remoteSpace.spaceId,
      });
      const readyA = yield* Deferred.make<void>();
      const readyB = yield* Deferred.make<void>();
      yield* f.service.subscribePresence(f.projectId, "owner-a").pipe(
        Stream.runForEach(() => Deferred.succeed(readyA, undefined)),
        Effect.forkScoped,
      );
      yield* f.service.subscribePresence(f.projectId, "owner-b").pipe(
        Stream.runForEach(() => Deferred.succeed(readyB, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(readyA);
      yield* Deferred.await(readyB);
      yield* f.service.heartbeat(f.projectId, { threadId: null, typing: false }, "owner-a");
      yield* f.service.heartbeat(f.projectId, { threadId: null, typing: true }, "owner-b");
      yield* f.service.heartbeat(f.projectId, { threadId: null, typing: false }, "owner-a");
      expect(f.heartbeatConnections).toHaveLength(3);
      expect(f.heartbeatConnections[0]).toBe(f.heartbeatConnections[2]);
      expect(f.heartbeatConnections[0]).not.toBe(f.heartbeatConnections[1]);
    }),
  ).pipe(Effect.provide(layers)),
);

it.effect(
  "streams offline and recovered status after publication receipts without requiring another mutation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.service.control({
          action: "link",
          projectId: f.projectId,
          sharedProjectId: f.remoteSpace.spaceId,
        });
        const ready = yield* Deferred.make<void>();
        const offline = yield* Deferred.make<void>();
        const recovered = yield* Deferred.make<void>();
        yield* f.service.subscribeState.pipe(
          Stream.runForEach((states) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(ready, undefined);
              if (states[0]?.link.status === "offline") yield* Deferred.succeed(offline, undefined);
              if (states[0]?.link.status === "synced")
                yield* Deferred.succeed(recovered, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        f.offline(true);
        yield* f.service.flush(f.projectId).pipe(Effect.flip);
        yield* Deferred.await(offline);
        f.offline(false);
        yield* f.service.flush(f.projectId);
        yield* Deferred.await(recovered);
      }),
    ).pipe(Effect.provide(layers)),
);

// Run the actual personal command handler; only its provider/bootstrap adapter is replaced by a pure engine adapter.
const personalWsSource = await NodeFSP.readFile(new URL("../ws.ts", import.meta.url), "utf8");
const commandHandlerStart = personalWsSource.indexOf(
  "        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>",
);
const commandHandlerEnd = personalWsSource.indexOf(
  "        [ORCHESTRATION_WS_METHODS.getWorkflowScript]:",
  commandHandlerStart,
);
if (commandHandlerStart < 0 || commandHandlerEnd < 0)
  throw new Error("Personal command handler was not found.");
const personalCommandHandlerSource = personalWsSource.slice(commandHandlerStart, commandHandlerEnd);

const personalRetryClient = Effect.fnUntraced(function* (
  f: Effect.Success<typeof setup>,
  options: {
    failure?: "before-dispatch" | "normalization" | "accepted";
    beforeAdapter?: Effect.Effect<void>;
  } = {},
) {
  let service = f.service;
  let calls = 0;
  let adapterCalls = 0;
  const commands: OrchestrationCommand[] = [];
  const localTeams = {
    withCreation: <A, E, R>(
      command: ClientOrchestrationCommand,
      operation: Effect.Effect<A, E, R>,
    ) => service.withCreation(command, operation),
    guard: (command: OrchestrationCommand) => service.guard(command),
    creationReceipt: (command: OrchestrationCommand) => service.creationReceipt(command),
    afterReceipt: (command: OrchestrationCommand) => service.afterReceipt(command),
  };
  const dispatchNormalizedCommand = Effect.fnUntraced(function* (command: OrchestrationCommand) {
    adapterCalls++;
    yield* options.beforeAdapter ?? Effect.void;
    if (command.type === "thread.turn.start" && command.bootstrap?.createThread) {
      yield* f.source.engine.dispatch({
        ...command.bootstrap.createThread,
        type: "thread.create",
        commandId: f.commandId(),
        threadId: command.threadId,
      });
      const { bootstrap: _bootstrap, ...turn } = command;
      return yield* f.source.engine.dispatch(turn);
    }
    return yield* f.source.engine.dispatch(command);
  });
  const handlers = new Function(
    "ORCHESTRATION_WS_METHODS",
    "Effect",
    "Option",
    "CommandId",
    "OrchestrationDispatchCommandError",
    "isOrchestrationDispatchCommandError",
    "observeRpcEffect",
    "normalizeDispatchCommand",
    "localTeams",
    "projectionSnapshotQuery",
    "dispatchNormalizedCommand",
    "cleanupFailedUploadedAttachments",
    "recordClientCommandAnalytics",
    "ProjectCloneTracker",
    "projectCloneTracker",
    `return {${personalCommandHandlerSource}}`,
  )(
    ORCHESTRATION_WS_METHODS,
    Effect,
    Option,
    CommandId,
    OrchestrationDispatchCommandError,
    Schema.is(OrchestrationDispatchCommandError),
    (_method: string, operation: Effect.Effect<unknown>) => operation,
    (command: OrchestrationCommand) =>
      calls === 1 && options.failure === "normalization"
        ? Effect.fail(new OrchestrationDispatchCommandError({ message: "Invalid draft input" }))
        : Effect.succeed(command),
    localTeams,
    f.source.query,
    dispatchNormalizedCommand,
    () => Effect.void,
    () => Effect.void,
    {
      rejectCommandsDuringClone: () => Effect.void,
      discardCloneForDeletedProject: () => Effect.void,
    },
    {},
  ) as Record<
    string,
    (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchCommandError>
  >;
  const client = {
    [LOCAL_TEAM_METHODS.state]: () => service.state,
    [LOCAL_TEAM_METHODS.control]: (input: LocalTeamProjectControl) => service.control(input),
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        calls++;
        commands.push(command);
        if (calls === 1 && options.failure === "before-dispatch")
          return yield* localTeamError("network");
        const receipt = yield* handlers[ORCHESTRATION_WS_METHODS.dispatchCommand]!(command);
        if (calls === 1 && (options.failure ?? "accepted") === "accepted")
          return yield* localTeamError("network");
        return receipt;
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("local"),
      label: "Local",
      httpBaseUrl: "https://local.test",
      wsBaseUrl: "wss://local.test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return {
    supervisor,
    calls: () => calls,
    adapterCalls: () => adapterCalls,
    commands,
    dispatch: (command: OrchestrationCommand) =>
      handlers[ORCHESTRATION_WS_METHODS.dispatchCommand]!(command),
    restart: Effect.gen(function* () {
      service = yield* f.bridge();
    }),
  };
});

for (const path of ["standalone", "first-turn"] as const) {
  for (const failure of ["before-dispatch", "normalization"] as const) {
    for (const shared of [false, true]) {
      for (const changeChoice of [false, true]) {
        it.effect(
          `retries an unaccepted ${path} ${shared ? "Shared" : "Local"} draft after ${failure} with a fresh Send command${changeChoice ? " and changed choice" : ""}`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* setup;
                yield* f.service.control({
                  action: "link",
                  projectId: f.projectId,
                  sharedProjectId: f.remoteSpace.spaceId,
                });
                const rpc = yield* personalRetryClient(f, { failure });
                const {
                  type: _type,
                  commandId: _commandId,
                  ...create
                } = {
                  ...f.createThread,
                  threadId: ThreadId.make("restored-draft"),
                };
                const execute = (choice: boolean) =>
                  (path === "standalone"
                    ? createPersonalThread({
                        ...create,
                        teamPublication: {
                          projectId: f.projectId,
                          generation: "generation-1",
                          shared: choice,
                        },
                      })
                    : startPersonalTurn({
                        threadId: create.threadId,
                        createdAt: time,
                        message: {
                          messageId: MessageId.make("restored-prompt"),
                          role: "user",
                          text: "Retry the restored prompt",
                          attachments: [],
                        },
                        runtimeMode: "approval-required",
                        interactionMode: "default",
                        bootstrap: { createThread: create },
                        teamPublication: {
                          projectId: f.projectId,
                          generation: "generation-1",
                          shared: choice,
                        },
                      })
                  ).pipe(
                    Effect.provideService(
                      EnvironmentSupervisor.EnvironmentSupervisor,
                      rpc.supervisor,
                    ),
                  );
                expect((yield* execute(shared).pipe(Effect.result))._tag).toBe("Failure");
                expect(yield* f.source.query.getThreadShellById(create.threadId)).toEqual(
                  Option.none(),
                );
                const sequence = yield* f.source.engine.latestSequence;
                yield* rpc.restart;
                const finalChoice = changeChoice ? !shared : shared;
                const receipt = yield* execute(finalChoice);
                expect(receipt.sequence).toBeGreaterThan(sequence);
                expect(rpc.commands[0]?.commandId).not.toBe(rpc.commands[1]?.commandId);
                expect(rpc.calls()).toBe(2);
                expect(rpc.adapterCalls()).toBe(1);
                // A delayed old request must not adopt the replacement choice or start work.
                expect((yield* rpc.dispatch(rpc.commands[0]!).pipe(Effect.result))._tag).toBe(
                  "Failure",
                );
                expect(yield* f.source.engine.latestSequence).toBe(receipt.sequence);
                const events = Array.from(yield* Stream.runCollect(f.source.engine.readEvents(0)));
                expect(
                  events.filter(
                    (event) =>
                      event.type === "thread.created" && event.aggregateId === create.threadId,
                  ),
                ).toHaveLength(1);
                expect(
                  events.filter(
                    (event) =>
                      event.type === "thread.turn-start-requested" &&
                      event.aggregateId === create.threadId,
                  ),
                ).toHaveLength(path === "first-turn" ? 1 : 0);
                expect((yield* f.service.state)[0]!.publications).toHaveLength(finalChoice ? 1 : 0);
              }),
            ).pipe(Effect.provide(layers)),
        );
      }
    }
  }

  for (const outcome of ["accepted", "interrupted", "account-changed"] as const) {
    const interrupt = outcome === "interrupted";
    it.effect(`keeps an in-flight ${path} creation decision immutable when ${outcome}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup;
          yield* f.service.control({
            action: "link",
            projectId: f.projectId,
            sharedProjectId: f.remoteSpace.spaceId,
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const rpc = yield* personalRetryClient(f, {
            beforeAdapter: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          });
          const { type: _type, ...create } = {
            ...f.createThread,
            commandId: f.commandId(),
            threadId: ThreadId.make("concurrent-draft"),
          };
          const teamPublication = {
            projectId: f.projectId,
            generation: "generation-1",
            shared: false,
          };
          const execute = (
            path === "standalone"
              ? createPersonalThread({ ...create, teamPublication })
              : startPersonalTurn({
                  commandId: create.commandId,
                  threadId: create.threadId,
                  createdAt: time,
                  message: {
                    messageId: MessageId.make("in-flight-prompt"),
                    role: "user",
                    text: "Accepted once",
                    attachments: [],
                  },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  bootstrap: { createThread: create },
                  teamPublication,
                })
          ).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, rpc.supervisor),
          );
          const first = yield* execute.pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const replacement = yield* f.service
            .control({
              action: "intent",
              commandId: f.commandId(),
              projectId: f.projectId,
              threadId: create.threadId,
              generation: "generation-1",
              shared: true,
            })
            .pipe(Effect.result, Effect.forkChild);
          const interrupted = interrupt
            ? yield* Fiber.interrupt(first).pipe(Effect.forkChild)
            : null;
          if (outcome === "account-changed") yield* f.changeAccount;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.await(first);
          if (interrupted) yield* Fiber.join(interrupted);
          expect((yield* Fiber.join(replacement))._tag).toBe("Failure");
          const sequence = yield* f.source.engine.latestSequence;
          yield* rpc.restart;
          if (outcome === "account-changed")
            expect((yield* execute.pipe(Effect.result))._tag).toBe("Failure");
          else expect((yield* execute).sequence).toBe(sequence);
          expect(rpc.adapterCalls()).toBe(1);
          expect((yield* f.service.state)[0]!.publications).toHaveLength(0);
          const events = Array.from(yield* Stream.runCollect(f.source.engine.readEvents(0)));
          expect(
            events.filter(
              (event) => event.type === "thread.created" && event.aggregateId === create.threadId,
            ),
          ).toHaveLength(1);
          expect(
            events.filter(
              (event) =>
                event.type === "thread.turn-start-requested" &&
                event.aggregateId === create.threadId,
            ),
          ).toHaveLength(path === "first-turn" ? 1 : 0);
        }),
      ).pipe(Effect.provide(layers)),
    );
  }

  for (const shared of [false, true]) {
    it.effect(
      `recovers a lost personal ACK for ${path} ${shared ? "Shared" : "Local"} without replay or paused-publication changes`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* setup;
            yield* f.service.control({
              action: "link",
              projectId: f.projectId,
              sharedProjectId: f.remoteSpace.spaceId,
            });
            const rpc = yield* personalRetryClient(f);
            const { type: _type, ...create } = {
              ...f.createThread,
              commandId: f.commandId(),
              threadId: ThreadId.make("lost-personal-ack"),
            };
            const teamPublication = { projectId: f.projectId, generation: "generation-1", shared };
            const turn = {
              commandId: create.commandId,
              threadId: create.threadId,
              createdAt: time,
              message: {
                messageId: MessageId.make("only-turn"),
                role: "user" as const,
                text: "Accepted once",
                attachments: [],
              },
              runtimeMode: "approval-required" as const,
              interactionMode: "default" as const,
              bootstrap: { createThread: create },
              teamPublication,
            };
            const execute = (choice = teamPublication, commandId = create.commandId) =>
              (path === "standalone"
                ? createPersonalThread({ ...create, commandId, teamPublication: choice })
                : startPersonalTurn({ ...turn, commandId, teamPublication: choice })
              ).pipe(
                Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, rpc.supervisor),
              );
            expect((yield* execute().pipe(Effect.result))._tag).toBe("Failure");
            const sequence = yield* f.source.engine.latestSequence;
            if (shared)
              yield* f.service.control({
                action: "stop-publication",
                projectId: f.projectId,
                threadId: create.threadId,
              });
            yield* rpc.restart;
            const retry = yield* execute();
            expect(retry.sequence).toBe(sequence);
            expect(yield* execute()).toEqual(retry);
            expect(rpc.calls()).toBe(3);
            expect(rpc.adapterCalls()).toBe(1);
            expect(yield* f.source.engine.latestSequence).toBe(sequence);
            expect(
              (yield* execute({ ...teamPublication, shared: !shared }).pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect((yield* execute(teamPublication, f.commandId()).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            expect(
              (yield* execute({ ...teamPublication, generation: "stale" }).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            expect(
              (yield* execute({
                ...teamPublication,
                projectId: ProjectId.make("another-project"),
              }).pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(rpc.calls()).toBe(3);
            expect(rpc.adapterCalls()).toBe(1);
            const events = Array.from(yield* Stream.runCollect(f.source.engine.readEvents(0)));
            expect(
              events.filter(
                (event) => event.type === "thread.created" && event.aggregateId === create.threadId,
              ),
            ).toHaveLength(1);
            expect(
              events.filter(
                (event) =>
                  event.type === "thread.turn-start-requested" &&
                  event.aggregateId === create.threadId,
              ),
            ).toHaveLength(path === "first-turn" ? 1 : 0);
            const state = (yield* f.service.state)[0]!;
            expect(state.publications).toHaveLength(shared ? 1 : 0);
            if (shared) expect(state.publications[0]?.paused).toBe(true);
            expect(state.publicationIntents).toEqual([]);
            // Already-existing private conversations have no creation metadata and still require explicit sharing.
            expect(
              (yield* f.service
                .control({
                  action: "intent",
                  commandId: f.createThread.commandId,
                  projectId: f.projectId,
                  threadId: f.threadId,
                  generation: "generation-1",
                  shared: true,
                })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
          }),
        ).pipe(Effect.provide(layers)),
    );
  }
}

for (const path of ["standalone", "first-turn"] as const) {
  for (const change of ["account", "root", "root-inode"] as const) {
    it.effect(
      `rejects an accepted ${path} receipt retry after ${change} changes with no new dispatch`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* setup;
            yield* f.service.control({
              action: "link",
              projectId: f.projectId,
              sharedProjectId: f.remoteSpace.spaceId,
            });
            const rpc = yield* personalRetryClient(f);
            const { type: _type, ...input } = {
              ...f.createThread,
              commandId: f.commandId(),
              threadId: ThreadId.make("fenced-retry"),
              teamPublication: {
                projectId: f.projectId,
                generation: "generation-1",
                shared: false,
              },
            };
            const execute = (
              path === "standalone"
                ? createPersonalThread(input)
                : startPersonalTurn({
                    commandId: input.commandId,
                    threadId: input.threadId,
                    createdAt: time,
                    message: {
                      messageId: MessageId.make("fenced-first-turn"),
                      role: "user",
                      text: "Accepted once",
                      attachments: [],
                    },
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    bootstrap: { createThread: input },
                    teamPublication: input.teamPublication,
                  })
            ).pipe(
              Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, rpc.supervisor),
            );
            expect((yield* execute.pipe(Effect.result))._tag).toBe("Failure");
            if (change === "account") yield* f.changeAccount;
            else if (change === "root")
              yield* f.source.engine.dispatch({
                type: "project.meta.update",
                commandId: f.commandId(),
                projectId: f.projectId,
                workspaceRoot: "/missing-root",
              });
            else
              yield* fileIO(async () => {
                await NodeFSP.rename(f.root, `${f.root}-retained`);
                await NodeFSP.mkdir(f.root);
              });
            const sequence = yield* f.source.engine.latestSequence;
            expect((yield* execute.pipe(Effect.result))._tag).toBe("Failure");
            expect(rpc.calls()).toBe(1);
            expect(rpc.adapterCalls()).toBe(1);
            expect(yield* f.source.engine.latestSequence).toBe(sequence);
            if (change === "root-inode")
              yield* fileIO(async () => {
                await NodeFSP.rmdir(f.root);
                await NodeFSP.rename(`${f.root}-retained`, f.root);
              });
          }),
        ).pipe(Effect.provide(layers)),
    );
  }
}

it.effect(
  "file creation intent retains selections and the original request across restart and account changes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const credential = {
          serviceUrl: "https://teams.example.test",
          issuer: "https://issuer.example.test",
          clientId: "fixture",
          subject: "owner",
          generation: "one",
          accessToken: "private",
        };
        const input = {
          action: "create" as const,
          name: "Recovered",
          destination: "/tmp/recovered-team",
          requestId: "a".repeat(32),
          members: [{ userId: "viewer", role: "viewer" as const }],
        };
        const first = yield* f.store.reserveFileCreation(credential, input);
        const restarted = yield* f.reloadStore;
        expect(
          yield* restarted.reserveFileCreation(credential, { ...input, requestId: "b".repeat(32) }),
        ).toBe(first);
        expect(
          (yield* Effect.flip(
            f.store.reserveFileCreation(credential, { ...input, name: "Changed" }),
          )).reason,
        ).toBe("changed");
        expect(
          yield* f.store.reserveFileCreation(
            { ...credential, generation: "two" },
            { ...input, requestId: "b".repeat(32) },
          ),
        ).toBe("b".repeat(32));
      }),
    ).pipe(Effect.provide(layers)),
);

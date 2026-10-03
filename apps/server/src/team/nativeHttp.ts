import { PRESENCE_WS_METHODS } from "@t3tools/contracts/teamPresence";
import { TEAM_DIRECTORY_METHOD } from "@t3tools/contracts/teamProjects";
import { TEAM_FILES_METHODS } from "@t3tools/contracts/teamFiles";
import * as NodeCrypto from "node:crypto";
import { TEAM_PUBLICATION_METHODS } from "@t3tools/contracts/teamPublication";
import {
  EnvironmentAuthorizationError,
  ORCHESTRATION_WS_METHODS,
  TeamNativeRpcGroup,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { projectThreadDetailSnapshot } from "../orchestration/ActivityPayloadProjection.ts";
import { TeamDenied, TeamSpaces } from "./TeamSpaces.ts";
import { TeamNativeProjects, type TeamNativeConnection } from "./TeamNativeProjects.ts";
import { nativeShellStream, nativeThreadStream } from "./nativeStreams.ts";
import type { TeamAuthentication, TeamPrincipal } from "./TeamAuthentication.ts";

interface NativeTicket {
  readonly authorization: string;
  readonly identity: TeamPrincipal;
  readonly spaceId: string;
  readonly expiresAt: number;
}

/** Separate map and endpoint from legacy tickets and personal-environment credentials. */
export const makeNativeTickets = Effect.sync(() => {
  const tickets = new Map<string, NativeTicket>();
  return {
    issue: Effect.fn("TeamNativeTickets.issue")(function* (grant: Omit<NativeTicket, "expiresAt">) {
      const now = yield* Clock.currentTimeMillis;
      for (const [key, value] of tickets) if (value.expiresAt <= now) tickets.delete(key);
      if (grant.identity.expiresAt <= now)
        return yield* new TeamDenied({ reason: "session_expired" });
      if (tickets.size >= 1000) return yield* new TeamDenied({ reason: "ticket_limit" });
      const ticket = NodeCrypto.randomBytes(32).toString("hex");
      tickets.set(ticket, { ...grant, expiresAt: Math.min(now + 30000, grant.identity.expiresAt) });
      return ticket;
    }),
    redeem: Effect.fn("TeamNativeTickets.redeem")(function* (ticket: string, spaceId: string) {
      const grant = tickets.get(ticket);
      tickets.delete(ticket);
      if (
        !grant ||
        grant.spaceId !== spaceId ||
        grant.expiresAt <= (yield* Clock.currentTimeMillis)
      )
        return yield* new TeamDenied({ reason: "ticket_invalid" });
      return grant;
    }),
  };
});

const rpcDenied = () =>
  new EnvironmentAuthorizationError({
    message: "This shared-project request is unavailable or access has changed.",
    requiredScope: "orchestration:read",
  });
export const nativeRpcLayer = (connection: TeamNativeConnection) => {
  const checked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      yield* connection.check();
      const value = yield* effect;
      yield* connection.check();
      return value;
    }).pipe(Effect.catchCause(() => Effect.fail(rpcDenied())));
  const checkedStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    stream.pipe(
      Stream.mapEffect((value) => checked(Effect.succeed(value))),
      Stream.catchCause(() => Stream.fail(rpcDenied())),
    );
  return TeamNativeRpcGroup.toLayer({
    [PRESENCE_WS_METHODS.heartbeat]: (input) => checked(connection.heartbeat(input)),
    [PRESENCE_WS_METHODS.subscribe]: () => checkedStream(connection.presence),
    [TEAM_DIRECTORY_METHOD]: () => checked(connection.directory),
    [TEAM_FILES_METHODS.command]: (input) => connection.repository.command(input),
    [TEAM_FILES_METHODS.subscribe]: () => connection.repository.subscribe,
    [TEAM_PUBLICATION_METHODS.register]: (input) => connection.publications.register(input),
    [TEAM_PUBLICATION_METHODS.publish]: (input) => connection.publications.publish(input),
    [WS_METHODS.serverProbe]: () => checked(Effect.succeed({})),
    [WS_METHODS.serverGetConfig]: () => checked(connection.wireConfig),
    [WS_METHODS.subscribeServerConfig]: () =>
      checkedStream(
        Stream.concat(
          Stream.fromEffect(
            connection.wireConfig.pipe(
              Effect.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
            ),
          ),
          Stream.never,
        ),
      ),
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (input) => checked(connection.dispatch(input)),
    [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
      checked(connection.query.searchThreads(input)),
    [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: () =>
      checked(connection.query.getArchivedShellSnapshot()),
    [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
      checkedStream(Stream.unwrap(nativeShellStream(connection, input))),
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
      checkedStream(Stream.unwrap(nativeThreadStream(connection, input))),
  });
};

const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const ticketRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      spaceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
    }),
  ),
);
const json = (value: unknown) =>
  HttpServerResponse.json(value, { headers: { "cache-control": "no-store" } });
const safe = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  effect.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(2048)),
    Effect.catchCause(() =>
      HttpServerResponse.json(
        { error: "project_access_denied" },
        {
          status: 403,
          headers: { "cache-control": "no-store" },
        },
      ),
    ),
  );

export const teamNativeRoutes = (auth: TeamAuthentication) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const projects = yield* TeamNativeProjects;
      const spaces = yield* TeamSpaces;
      const tickets = yield* makeNativeTickets;
      const ticket = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const identity = yield* auth.authenticate(request);
        const input = yield* request.text.pipe(Effect.flatMap(ticketRequest));
        yield* spaces.requireRole(identity.userId, input.spaceId);
        return yield* json({
          ticket: yield* tickets.issue({
            authorization: request.headers.authorization!,
            identity,
            spaceId: input.spaceId,
          }),
        });
      });
      const snapshot = (thread: boolean) =>
        Effect.scoped(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const identity = yield* auth.authenticate(request);
            const params = yield* HttpRouter.params;
            const connection = yield* projects.connect(
              identity,
              params.spaceId ?? "",
              auth.resolveUser,
            );
            yield* connection.check();
            const value = yield* thread
              ? Effect.gen(function* () {
                  const threadId = yield* decodeThreadId(params.threadId);
                  yield* connection.requireThread(connection.projectId, threadId);
                  const url = new URL(request.url, "http://team.invalid");
                  const limit = url.searchParams.get("turnLimit");
                  const beforeCursor = url.searchParams.get("beforeCursor");
                  if (
                    (limit !== null &&
                      (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) ||
                    (beforeCursor !== null && (limit === null || beforeCursor.length > 2048))
                  )
                    return yield* new TeamDenied({ reason: "invalid_window" });
                  const result = yield* connection.query.getThreadDetailSnapshot(
                    threadId,
                    limit === null
                      ? undefined
                      : {
                          turnLimit: Number(limit),
                          ...(beforeCursor === null ? {} : { beforeCursor }),
                        },
                  );
                  if (Option.isNone(result))
                    return yield* new TeamDenied({ reason: "project_access_denied" });
                  return projectThreadDetailSnapshot(result.value);
                })
              : connection.query.getShellSnapshot();
            yield* connection.check();
            return yield* json(value);
          }),
        );
      const websocket = Effect.scoped(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!request.headers.origin || !auth.origins.includes(request.headers.origin))
            return yield* new TeamDenied({ reason: "origin_denied" });
          const params = yield* HttpRouter.params;
          const spaceId = params.spaceId ?? "";
          const value =
            new URL(request.url, "http://team.invalid").searchParams.get("ticket") ?? "";
          const grant = yield* tickets.redeem(value, spaceId);
          const authenticatedRequest = request.modify({
            headers: { ...request.headers, authorization: grant.authorization },
          });
          const identity = yield* auth.authenticate(authenticatedRequest);
          if (identity.userId !== grant.identity.userId)
            return yield* new TeamDenied({ reason: "ticket_invalid" });
          // Install access invalidation before opening state or starting RPC, so a
          // revoke during migration/bootstrap cannot leave a live connection behind.
          const changes = yield* PubSub.subscribe(spaces.accessChanges);
          const connection = yield* projects.connect(identity, spaceId, auth.resolveUser);
          const revoked = Stream.fromSubscription(changes).pipe(
            Stream.filter(
              (change) => change.spaceId === spaceId && change.userId === identity.userId,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const sessionChecks = Stream.tick("15 seconds").pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                yield* auth.authenticate(authenticatedRequest);
                yield* connection.check();
              }),
            ),
          );
          const expires = Effect.sleep(
            Math.max(0, identity.expiresAt - (yield* Clock.currentTimeMillis)),
          );
          const rpc = yield* RpcServer.toHttpEffectWebsocket(TeamNativeRpcGroup, {
            disableTracing: true,
          }).pipe(
            Effect.provide(
              nativeRpcLayer(connection).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
            ),
          );
          return yield* Effect.raceFirst(
            rpc,
            Effect.raceFirst(revoked, Effect.raceFirst(sessionChecks, expires)).pipe(
              Effect.as(HttpServerResponse.empty()),
            ),
          );
        }),
      );
      return Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/api/team/projects/:spaceId/member-directory",
          safe(
            Effect.scoped(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const identity = yield* auth.authenticate(request);
                const params = yield* HttpRouter.params;
                const connection = yield* projects.connect(
                  identity,
                  params.spaceId ?? "",
                  auth.resolveUser,
                );
                return yield* json(yield* connection.directory);
              }),
            ),
          ),
        ),
        HttpRouter.add("POST", "/api/team/native/ticket", safe(ticket)),
        HttpRouter.add(
          "GET",
          "/api/team/projects/:spaceId/native/shell-snapshot",
          safe(snapshot(false)),
        ),
        HttpRouter.add(
          "GET",
          "/api/team/projects/:spaceId/native/threads/:threadId/snapshot",
          safe(snapshot(true)),
        ),
        HttpRouter.add("GET", "/api/team/projects/:spaceId/native/ws", safe(websocket)),
      );
    }),
  );

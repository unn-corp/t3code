import { PRESENCE_WS_METHODS, type PresenceHeartbeatInput } from "@t3tools/contracts/teamPresence";
import {
  TEAM_FILES_METHODS,
  TeamFileError,
  type TeamRepositoryCommand,
} from "@t3tools/contracts/teamFiles";
import { type TeamProjectMemberSelections, TeamCommandResult } from "@t3tools/contracts/teamSpaces";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  ORCHESTRATION_WS_METHODS,
  TeamNativeRpcGroup,
  WS_METHODS,
  OrchestrationThreadDetailSnapshot,
  type ClientOrchestrationCommand,
  type OrchestrationSubscribeShellInput,
  type OrchestrationSubscribeThreadInput,
  type OrchestrationThreadDetailWindow,
  type ThreadId,
} from "@t3tools/contracts";
import {
  TEAM_PUBLICATION_METHODS,
  type TeamPublicationRegister,
  type TeamPublicationBatch,
} from "@t3tools/contracts/teamPublication";
import { TEAM_DIRECTORY_METHOD } from "@t3tools/contracts/teamProjects";
import { LocalTeamProjectError } from "@t3tools/contracts/teamProjects";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const isLocalProjectError = Schema.is(LocalTeamProjectError);

export interface TeamProjectCredential {
  readonly serviceUrl: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly generation: string;
  readonly accessToken: string;
}
export const localTeamError = (reason: LocalTeamProjectError["reason"]) =>
  new LocalTeamProjectError({
    reason,
    message: "Shared project synchronization is unavailable. Check its connection or linkage.",
  });
const decodeTicket = Schema.decodeUnknownEffect(
  Schema.Struct({ ticket: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }),
);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const makeTeamProjectTransport = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const request = Effect.fnUntraced(
    function* (credential: TeamProjectCredential, path: string, body?: unknown) {
      let outgoing = HttpClientRequest.make(body === undefined ? "GET" : "POST")(
        `${credential.serviceUrl}${path}`,
      ).pipe(HttpClientRequest.bearerToken(credential.accessToken));
      if (body !== undefined) outgoing = yield* HttpClientRequest.bodyJson(outgoing, body);
      const response = yield* http.execute(outgoing);
      if (response.status === 401 || response.status === 403)
        return yield* localTeamError("access");
      if (response.status !== 200) return yield* localTeamError("network");
      let bytes = 0;
      const text = yield* response.stream.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;
          return bytes > MAX_RESPONSE_BYTES
            ? Effect.fail(localTeamError("limit"))
            : Effect.succeed(chunk);
        }),
        Stream.decodeText,
        Stream.mkString,
      );
      return yield* decodeJson(text);
    },
    Effect.withTracerEnabled(false),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", cache: "no-store" }),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(localTeamError("network")),
    }),
    Effect.mapError((error) => (isLocalProjectError(error) ? error : localTeamError("network"))),
  );
  const open = Effect.fnUntraced(function* (credential: TeamProjectCredential, spaceId: string) {
    const { ticket } = yield* request(credential, "/api/team/native/ticket", { spaceId }).pipe(
      Effect.flatMap(decodeTicket),
      Effect.mapError((error) => (isLocalProjectError(error) ? error : localTeamError("network"))),
    );
    const url = new URL(
      `/api/team/projects/${encodeURIComponent(spaceId)}/native/ws`,
      credential.serviceUrl,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    // Reconnection is owned by the bridge: each scope needs a fresh one-use ticket.
    const protocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }),
    ).pipe(
      Layer.provide(
        Socket.layerWebSocket(url.href, { openTimeout: "10 seconds" }).pipe(
          Layer.provide(
            Layer.succeed(
              Socket.WebSocketConstructor,
              (url, protocols) =>
                new NodeSocket.NodeWS.WebSocket(url, protocols, {
                  headers: { origin: credential.serviceUrl },
                  maxPayload: MAX_RESPONSE_BYTES,
                }) as unknown as globalThis.WebSocket,
            ),
          ),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    const protocolContext = yield* Layer.build(protocol);
    const client = yield* RpcClient.make(TeamNativeRpcGroup, { disableTracing: true }).pipe(
      Effect.provideContext(protocolContext),
    );
    const unary = <A, E>(operation: Effect.Effect<A, E>) =>
      operation.pipe(
        Effect.withTracerEnabled(false),
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(localTeamError("network")),
        }),
      );
    return {
      config: unary(client[WS_METHODS.serverGetConfig]({})),
      directory: unary(client[TEAM_DIRECTORY_METHOD]({})),
      presence: client[PRESENCE_WS_METHODS.subscribe]({}).pipe(
        Stream.mapError(() => localTeamError("network")),
      ),
      heartbeat: (focus: PresenceHeartbeatInput) =>
        unary(client[PRESENCE_WS_METHODS.heartbeat](focus)),
      repository: (input: TeamRepositoryCommand) =>
        client[TEAM_FILES_METHODS.command](input).pipe(
          Effect.withTracerEnabled(false),
          Effect.timeoutOrElse({
            duration: input.action === "finish" ? "5 minutes" : "15 seconds",
            orElse: () =>
              Effect.fail(
                new TeamFileError({
                  reason: "unavailable",
                  message: "Shared file transfer timed out. Retry the operation.",
                }),
              ),
          }),
        ),
      files: client[TEAM_FILES_METHODS.subscribe]({}),
      register: (input: TeamPublicationRegister) =>
        unary(client[TEAM_PUBLICATION_METHODS.register](input)),
      publish: (input: TeamPublicationBatch) =>
        unary(client[TEAM_PUBLICATION_METHODS.publish](input)),
      shell: (input: OrchestrationSubscribeShellInput) =>
        client[ORCHESTRATION_WS_METHODS.subscribeShell](input).pipe(
          Stream.mapError(() => localTeamError("network")),
        ),
      thread: (input: OrchestrationSubscribeThreadInput) =>
        client[ORCHESTRATION_WS_METHODS.subscribeThread](input).pipe(
          Stream.mapError(() => localTeamError("network")),
        ),
      discussion: (input: ClientOrchestrationCommand) =>
        unary(client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      snapshot: (threadId: ThreadId, window?: OrchestrationThreadDetailWindow) => {
        const params = new URLSearchParams();
        if (window?.turnLimit !== undefined) params.set("turnLimit", String(window.turnLimit));
        if (window?.beforeCursor !== undefined) params.set("beforeCursor", window.beforeCursor);
        return request(
          credential,
          `/api/team/projects/${encodeURIComponent(spaceId)}/native/threads/${encodeURIComponent(threadId)}/snapshot?${params}`,
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(OrchestrationThreadDetailSnapshot)),
          Effect.mapError((error) =>
            isLocalProjectError(error) ? error : localTeamError("network"),
          ),
        );
      },
    };
  }, Effect.withTracerEnabled(false));
  return {
    open,
    membership: (credential: TeamProjectCredential, command: unknown) =>
      request(credential, "/api/team/command", command).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(TeamCommandResult)),
        Effect.mapError(() => localTeamError("access")),
      ),
    create: (
      credential: TeamProjectCredential,
      name: string,
      members?: TeamProjectMemberSelections,
      requestId?: string,
    ) =>
      request(credential, "/api/team/command", {
        action: "create",
        name,
        ...(requestId ? { requestId } : {}),
        ...(members ? { members } : {}),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(TeamCommandResult)),
        Effect.mapError(() => localTeamError("network")),
      ),
  };
});
export class TeamProjectTransport extends Context.Service<
  TeamProjectTransport,
  Effect.Success<typeof makeTeamProjectTransport>
>()("t3/team/TeamProjectTransport") {
  static readonly layer = Layer.effect(this, makeTeamProjectTransport).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}
export type TeamProjectConnection = Effect.Success<
  ReturnType<TeamProjectTransport["Service"]["open"]>
>;

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off - Publisher body fixtures intentionally use JSON text at the HTTP boundary.
// @effect-diagnostics multipleEffectProvide:off - Test harness composes route, HTTP, and Node layers in one provide stack.
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Route boundary tests exercise HTTP auth against a minimal feed router.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  type HttpServerRequest,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { agentDashboardFeedRouteLayer } from "./AgentDashboardFeedRoutes.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";

const unusedAuthOperation = () => Effect.die("unused EnvironmentAuth operation in feed route test");

const makeAuthLayer = (mode: "reject" | "allow" | "no-read-scope") =>
  Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
    getDescriptor: unusedAuthOperation as never,
    getSessionState: unusedAuthOperation as never,
    createBrowserSession: unusedAuthOperation as never,
    exchangeBootstrapCredentialForAccessToken: unusedAuthOperation as never,
    createPairingLink: unusedAuthOperation as never,
    issuePairingCredential: unusedAuthOperation as never,
    issueStartupPairingCredential: unusedAuthOperation as never,
    listPairingLinks: unusedAuthOperation as never,
    revokePairingLink: unusedAuthOperation as never,
    issueSession: unusedAuthOperation as never,
    listSessions: unusedAuthOperation as never,
    revokeSession: unusedAuthOperation as never,
    revokeOtherSessionsExcept: unusedAuthOperation as never,
    listClientSessions: unusedAuthOperation as never,
    revokeClientSession: unusedAuthOperation as never,
    revokeOtherClientSessions: unusedAuthOperation as never,
    authenticateHttpRequest: (
      _request: HttpServerRequest.HttpServerRequest,
    ): Effect.Effect<
      EnvironmentAuth.AuthenticatedSession,
      EnvironmentAuth.ServerAuthInvalidCredentialError
    > => {
      if (mode === "reject") {
        return Effect.fail(
          new EnvironmentAuth.ServerAuthInvalidCredentialError({
            cause: new Error("missing session"),
          }),
        );
      }
      return Effect.succeed({
        sessionId: AuthSessionId.make("feed-route-session"),
        subject: "test-client",
        method: "browser-session-cookie",
        scopes:
          mode === "no-read-scope"
            ? [AuthOrchestrationOperateScope]
            : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      });
    },
    authenticateWebSocketUpgrade: unusedAuthOperation as never,
    issueWebSocketTicket: unusedAuthOperation as never,
    issueStartupPairingUrl: unusedAuthOperation as never,
  } satisfies EnvironmentAuth.EnvironmentAuth["Service"]);

const runWithFeedRoutes = <A, E>(
  stateDir: string,
  authMode: "reject" | "allow" | "no-read-scope",
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
) => {
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return {
        ...base,
        stateDir,
        baseDir: stateDir,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-feed-routes-" })));

  const routesLayer = HttpRouter.serve(agentDashboardFeedRouteLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.provide(makeAuthLayer(authMode)), Layer.provide(configLayer));

  // Sequential provide mirrors server.test harness: routes need ServerConfig/auth,
  // NodeHttpServer.layerTest supplies HttpServer + relative HttpClient base URL.
  return effect.pipe(
    Effect.provide(routesLayer),
    Effect.provide(NodeHttpServer.layerTest),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeServices.layer),
  );
};

describe("AgentDashboardFeedRoutes", () => {
  it.effect("rejects anonymous feed and image reads", () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-route-anon-")),
      );
      try {
        const store = AgentDashboardStore.getStore(stateDir);
        yield* store.appendFeed({
          agent: "codex",
          title: "Private",
          text: "requires environment auth",
        });

        yield* runWithFeedRoutes(
          stateDir,
          "reject",
          Effect.gen(function* () {
            const feedResponse = yield* HttpClient.get("/api/agent-feed");
            expect(feedResponse.status).toBe(401);

            const imageResponse = yield* HttpClient.get("/api/agent-feed/img/1");
            expect(imageResponse.status).toBe(401);
          }),
        );
      } finally {
        yield* Effect.tryPromise(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
      }
    }),
  );

  it.effect("serves feed and owned images to environment-authenticated clients", () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-route-auth-")),
      );
      const sourceDir = yield* Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-route-src-")),
      );
      const pngBytes = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
        0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      try {
        const sourceImage = NodePath.join(sourceDir, "shot.png");
        yield* Effect.tryPromise(() => NodeFSP.writeFile(sourceImage, pngBytes));
        const store = AgentDashboardStore.getStore(stateDir);
        const card = yield* store.appendFeed({
          agent: "codex",
          title: "Visible",
          text: "authorized",
          image_file: sourceImage,
        });

        yield* runWithFeedRoutes(
          stateDir,
          "allow",
          Effect.gen(function* () {
            const feedResponse = yield* HttpClient.get("/api/agent-feed");
            expect(feedResponse.status).toBe(200);
            const body = (yield* feedResponse.json) as {
              cards: Array<{ id: number; title: string | null }>;
            };
            expect(body.cards.some((entry) => entry.title === "Visible")).toBe(true);

            const imageResponse = yield* HttpClient.get(`/api/agent-feed/img/${card.id}`);
            expect(imageResponse.status).toBe(200);
            expect(imageResponse.headers["content-type"]).toBe("image/png");
            const bytes = yield* imageResponse.arrayBuffer;
            expect(new Uint8Array(bytes)).toEqual(pngBytes);
          }),
        );
      } finally {
        yield* Effect.tryPromise(() =>
          Promise.all([
            NodeFSP.rm(stateDir, { recursive: true, force: true }),
            NodeFSP.rm(sourceDir, { recursive: true, force: true }),
          ]),
        );
      }
    }),
  );

  it.effect("keeps publisher token auth distinct from environment read auth", () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-route-pub-")),
      );
      try {
        const store = AgentDashboardStore.getStore(stateDir);
        const token = yield* store.feedToken;

        // Anonymous environment auth fails for reads even when a valid publisher token is supplied.
        yield* runWithFeedRoutes(
          stateDir,
          "reject",
          Effect.gen(function* () {
            const feedResponse = yield* HttpClient.execute(
              HttpClientRequest.get("/api/agent-feed").pipe(
                HttpClientRequest.setHeader("x-t3-agent-feed-token", token),
              ),
            );
            expect(feedResponse.status).toBe(401);

            const publishResponse = yield* HttpClient.execute(
              HttpClientRequest.post("/api/agent-feed").pipe(
                HttpClientRequest.setHeader("x-t3-agent-feed-token", token),
                HttpClientRequest.setHeader("content-type", "application/json"),
                HttpClientRequest.bodyText(
                  JSON.stringify({
                    agent: "publisher",
                    title: "From token",
                    text: "publisher path still works without session",
                  }),
                ),
              ),
            );
            expect(publishResponse.status).toBe(200);
          }),
        );

        const cards = yield* store.readFeed;
        expect(cards.some((card) => card.title === "From token")).toBe(true);
      } finally {
        yield* Effect.tryPromise(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
      }
    }),
  );
});

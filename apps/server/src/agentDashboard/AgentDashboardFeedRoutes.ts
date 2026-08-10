import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";

const publisherUnauthorized = HttpServerResponse.jsonUnsafe(
  { error: "agent feed write authorization required" },
  { status: 401 },
);

const requestPath = (request: HttpServerRequest.HttpServerRequest): string | null => {
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.pathname : null;
};

const requestQuery = (request: HttpServerRequest.HttpServerRequest): URLSearchParams | null => {
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams : null;
};

/** Publisher auth — feed token only. Distinct from environment session auth used for reads. */
const isPublisherAuthorized = (
  request: HttpServerRequest.HttpServerRequest,
  token: string,
): boolean => {
  const supplied =
    request.headers["x-t3-agent-feed-token"] ?? request.headers["x-widget-token"] ?? "";
  return supplied.length > 0 && supplied === token;
};

/**
 * Environment access boundary for feed/image reads. Standard client sessions
 * carry orchestration:read; publisher feed tokens are not accepted here.
 */
const requireEnvironmentReadAccess = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
  return session;
});

const makeRoutes = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const store = AgentDashboardStore.getStore(config.stateDir);

  const feedCollection = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const method = request.method;
    if (method === "POST" || method === "DELETE") {
      const token = yield* store.feedToken;
      if (!isPublisherAuthorized(request, token)) return publisherUnauthorized;
      if (method === "DELETE") {
        yield* store.clearFeed;
        return HttpServerResponse.jsonUnsafe({ ok: true });
      }
      const body = yield* request.json;
      const card = yield* store.appendFeed(body);
      return HttpServerResponse.jsonUnsafe({ ok: true, id: card.id });
    }

    if (method === "GET") {
      yield* requireEnvironmentReadAccess;
      const query = requestQuery(request);
      const requestedLimit = Number(query?.get("limit") ?? 200);
      const cards = yield* store.readFeed;
      return HttpServerResponse.jsonUnsafe({
        cards: cards.slice(
          0,
          Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, requestedLimit)) : 200,
        ),
      });
    }

    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }).pipe(
    Effect.catchTag("AgentDashboardStoreError", (error) =>
      Effect.succeed(HttpServerResponse.text(error.message, { status: 500 })),
    ),
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  );

  const feedItem = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = requestPath(request);
    const suffix = path?.slice("/api/agent-feed/".length) ?? "";
    const idText = suffix.startsWith("img/") ? suffix.slice("img/".length) : suffix;
    const id = Number(idText);
    if (!Number.isSafeInteger(id) || id < 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (request.method === "DELETE") {
      const token = yield* store.feedToken;
      if (!isPublisherAuthorized(request, token)) return publisherUnauthorized;
      const removed = yield* store.dismissFeedCard(id);
      return removed
        ? HttpServerResponse.jsonUnsafe({ ok: true, id })
        : HttpServerResponse.jsonUnsafe({ error: "card not found" }, { status: 404 });
    }

    if (path?.startsWith("/api/agent-feed/img/")) {
      yield* requireEnvironmentReadAccess;
      const image = yield* store.readFeedImage(id);
      return image === null
        ? HttpServerResponse.jsonUnsafe({ error: "image not found" }, { status: 404 })
        : HttpServerResponse.uint8Array(image.bytes, {
            headers: {
              "Content-Type": image.contentType,
              "Cache-Control": "private, max-age=3600",
              "X-Content-Type-Options": "nosniff",
            },
          });
    }

    return HttpServerResponse.text("Not Found", { status: 404 });
  }).pipe(
    Effect.catchTag("AgentDashboardStoreError", (error) =>
      Effect.succeed(HttpServerResponse.text(error.message, { status: 500 })),
    ),
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  );

  return Layer.mergeAll(
    HttpRouter.add("GET", "/api/agent-feed", feedCollection),
    HttpRouter.add("POST", "/api/agent-feed", feedCollection),
    HttpRouter.add("DELETE", "/api/agent-feed", feedCollection),
    HttpRouter.add("DELETE", "/api/agent-feed/:id", feedItem),
    HttpRouter.add("GET", "/api/agent-feed/img/*", feedItem),
  );
});

export const agentDashboardFeedRouteLayer = Layer.unwrap(makeRoutes);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import * as ServerConfig from "../config.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
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

const authorized = (request: HttpServerRequest.HttpServerRequest, token: string): boolean => {
  const supplied =
    request.headers["x-t3-agent-feed-token"] ?? request.headers["x-widget-token"] ?? "";
  return supplied.length > 0 && supplied === token;
};

const makeRoutes = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const store = AgentDashboardStore.getStore(config.stateDir);

  const feedCollection = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const method = request.method;
    const token = yield* store.feedToken;
    if (method === "POST" || method === "DELETE") {
      if (!authorized(request, token)) return unauthorized;
      if (method === "DELETE") {
        yield* store.clearFeed;
        return HttpServerResponse.jsonUnsafe({ ok: true });
      }
      const body = yield* request.json;
      const card = yield* store.appendFeed(body);
      return HttpServerResponse.jsonUnsafe({ ok: true, id: card.id });
    }

    if (method === "GET") {
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
      if (!authorized(request, token)) return unauthorized;
      const removed = yield* store.dismissFeedCard(id);
      return removed
        ? HttpServerResponse.jsonUnsafe({ ok: true, id })
        : HttpServerResponse.jsonUnsafe({ error: "card not found" }, { status: 404 });
    }

    if (path?.startsWith("/api/agent-feed/img/")) {
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

// @effect-diagnostics nodeBuiltinImport:off -- Exercise real HTTP and upgraded TCP sockets at the proxy boundary.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { expect, it } from "@effect/vitest";
import { openTemporaryShareProxy } from "./TemporaryShareProxy.ts";

async function listen(server: NodeHttp.Server) {
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP listener");
  return address.port;
}
async function close(server: NodeHttp.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

it.effect("streams real requests and responses while recording a visit", () =>
  Effect.gen(function* () {
    const server = NodeHttp.createServer((request, response) => {
      response.writeHead(201, { "x-host": request.headers.host!, "x-path": request.url! });
      request.pipe(response);
    });
    let visits = 0;
    const localPort = yield* Effect.acquireRelease(
      Effect.promise(() => listen(server)),
      () => Effect.promise(() => close(server)),
    );
    const proxy = yield* Effect.acquireRelease(
      openTemporaryShareProxy({ localPort, onVisit: () => visits++ }),
      (proxy) => Effect.sync(proxy.close),
    );
    const body = "message ".repeat(20_000);
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`http://127.0.0.1:${proxy.port}/submit?x=1`).pipe(
        HttpClientRequest.bodyText(body),
        HttpClientRequest.setHeader("accept", "text/html"),
      ),
    );
    expect(response.status).toBe(201);
    expect(response.headers["x-host"]).toBe(`localhost:${localPort}`);
    expect(response.headers["x-path"]).toBe("/submit?x=1");
    expect(yield* response.text).toBe(body);
    expect(visits).toBe(1);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect("forwards WebSocket upgrades and closes established sockets on teardown", () =>
  Effect.gen(function* () {
    const server = NodeHttp.createServer();
    const upstreamSockets = new Set<NodeNet.Socket>();
    server.on("upgrade", (_request, socket, head) => {
      const upstream = socket as NodeNet.Socket;
      upstreamSockets.add(upstream);
      upstream.on("close", () => upstreamSockets.delete(upstream));
      upstream.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      if (head.length) upstream.write(head);
      upstream.on("data", (data) => upstream.write(data));
    });
    let visits = 0;
    const localPort = yield* Effect.acquireRelease(
      Effect.promise(() => listen(server)),
      () =>
        Effect.promise(() => {
          for (const upstream of upstreamSockets) upstream.destroy();
          return close(server);
        }),
    );
    const proxy = yield* Effect.acquireRelease(
      openTemporaryShareProxy({ localPort, onVisit: () => visits++ }),
      (proxy) => Effect.sync(proxy.close),
    );
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => NodeNet.connect(proxy.port, "127.0.0.1")),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    const received = yield* Effect.promise(
      () =>
        new Promise<string>((resolve, reject) => {
          let data = "";
          socket.on("error", reject);
          socket.on("data", (chunk) => {
            data += chunk.toString();
            if (data.endsWith("hello")) resolve(data);
          });
          socket.write(
            "GET /hmr HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello",
          );
        }),
    );
    expect(received).toContain("101 Switching Protocols");
    expect(visits).toBe(0);
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          socket.on("close", () => resolve());
          proxy.close();
        }),
    );
  }),
);

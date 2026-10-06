// @effect-diagnostics nodeBuiltinImport:off -- A streaming loopback proxy observes real visits without buffering browser responses.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class TemporaryShareProxyError extends Schema.TaggedError<TemporaryShareProxyError>()(
  "TemporaryShareProxyError",
  { cause: Schema.Defect() },
) {}

export interface TemporaryShareProxy {
  readonly port: number;
  readonly close: () => void;
}

/** Browser page visits renew the lease; local port probes and background traffic do not. */
export const openTemporaryShareProxy = (input: {
  readonly localPort: number;
  readonly onVisit: () => void;
}): Effect.Effect<TemporaryShareProxy, TemporaryShareProxyError> =>
  Effect.callback((resume) => {
    const sockets = new Set<NodeNet.Socket>();
    const upstreams = new Set<NodeHttp.ClientRequest>();
    let closed = false;
    const agent = new NodeHttp.Agent({ keepAlive: true });
    const server = NodeHttp.createServer((request, response) => {
      const headers = request.headers;
      if (
        headers["sec-fetch-mode"] === "navigate" ||
        headers["sec-fetch-dest"] === "document" ||
        headers["sec-fetch-dest"] === "iframe" ||
        headers.accept?.includes("text/html") ||
        headers.accept?.includes("application/xhtml+xml")
      )
        input.onVisit();
      const upstream = NodeHttp.request(
        {
          agent,
          hostname: "localhost",
          port: input.localPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: `localhost:${input.localPort}` },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
          incoming.on("error", () => response.destroy());
        },
      );
      upstreams.add(upstream);
      upstream.on("close", () => upstreams.delete(upstream));
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.on("aborted", () => upstream.destroy());
      request.on("error", () => upstream.destroy());
      response.on("error", () => upstream.destroy());
      response.on("close", () => {
        if (!response.writableFinished) upstream.destroy();
      });
      request.pipe(upstream);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      const upstream = NodeHttp.request({
        agent,
        hostname: "localhost",
        port: input.localPort,
        path: request.url,
        headers: { ...request.headers, host: `localhost:${input.localPort}` },
      });
      upstreams.add(upstream);
      upstream.on("close", () => upstreams.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("response", () => socket.destroy());
      upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
        if (closed || socket.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        sockets.add(upstreamSocket);
        upstreamSocket.on("close", () => sockets.delete(upstreamSocket));
        upstreamSocket.on("error", () => socket.destroy());
        socket.on("error", () => upstreamSocket.destroy());
        socket.on("close", () => upstreamSocket.destroy());
        socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
        socket.write("\r\n");
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
      });
      upstream.end();
    });
    const close = () => {
      closed = true;
      agent.destroy();
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
    };
    server.on("error", (error) =>
      resume(Effect.fail(new TemporaryShareProxyError({ cause: error }))),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        close();
        resume(
          Effect.fail(
            new TemporaryShareProxyError({
              cause: "Temporary preview proxy did not bind a TCP port.",
            }),
          ),
        );
        return;
      }
      resume(Effect.succeed({ port: address.port, close }));
    });
    return Effect.sync(close);
  });

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "./config.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";

export const HTTP_ROUTER_CONFIG = { maxParamLength: 512 } as const;
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
export const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return NodeHttpServer.layer(() => guardHttpResponseWriteErrors(NodeHttp.createServer()), {
      host: config.host ?? "127.0.0.1",
      port: config.port,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      websocket: { perMessageDeflate: true },
    });
  }),
);

export const PlatformServicesLive = NodeServices.layer;

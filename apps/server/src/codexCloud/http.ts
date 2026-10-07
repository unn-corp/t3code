import { CodexCloudError, ForkMaintenanceError, WS_METHODS } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Cloud from "./CodexCloudService.ts";
import { withRpcWorkAdmission } from "../auth/RpcAuthorization.ts";

const decodePoll = Schema.decodeUnknownEffect(Cloud.WorkerPollInput);
const decodeEvent = Schema.decodeUnknownEffect(Cloud.WorkerEventInput);
const isCloudError = Schema.is(CodexCloudError);
const isMaintenanceError = Schema.is(ForkMaintenanceError);

const poll = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const service = yield* Cloud.CodexCloudService;
  const input = yield* decodePoll(yield* request.json);
  return yield* withRpcWorkAdmission(
    WS_METHODS.codexCloudCommand,
    service.pollWorker((request.headers.authorization ?? "").replace(/^Bearer /, ""), input),
  );
});
const event = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const service = yield* Cloud.CodexCloudService;
  const input = yield* decodeEvent(yield* request.json);
  return yield* withRpcWorkAdmission(
    WS_METHODS.codexCloudCommand,
    service.workerEvent((request.headers.authorization ?? "").replace(/^Bearer /, ""), input),
  );
});
const respond = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(512_000)),
    Effect.flatMap((result) =>
      HttpServerResponse.json(result, { headers: { "cache-control": "no-store" } }),
    ),
    Effect.catch((error) =>
      HttpServerResponse.json(
        { error: isCloudError(error) ? error.code : "request" },
        {
          status: isCloudError(error)
            ? error.code === "unauthorized"
              ? 401
              : error.code === "worker"
                ? 409
                : 503
            : isMaintenanceError(error)
              ? 503
              : 400,
          headers: { "cache-control": "no-store" },
        },
      ),
    ),
  );
export const layer = Layer.mergeAll(
  HttpRouter.add("POST", "/api/codex-cloud/worker/poll", respond(poll)),
  HttpRouter.add("POST", "/api/codex-cloud/worker/event", respond(event)),
);

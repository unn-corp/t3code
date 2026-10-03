import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { requireEnvironmentScope } from "../auth/http.ts";
import { LocalTeamAccount, type LocalTeamAccountError } from "./LocalTeamAccount.ts";

export const localTeamAccountHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "teams",
  Effect.fnUntraced(function* (handlers) {
    const account = yield* LocalTeamAccount;
    const handle = <A>(
      scope: typeof AuthAccessWriteScope | typeof AuthOrchestrationReadScope,
      operation: Effect.Effect<A, LocalTeamAccountError>,
    ) =>
      Effect.gen(function* () {
        yield* requireEnvironmentScope(scope);
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
        );
        return yield* operation.pipe(
          Effect.mapError(
            (error) => new EnvironmentHttpBadRequestError({ message: error.message }),
          ),
        );
      });
    return handlers
      .handle("state", () => handle(AuthOrchestrationReadScope, account.refreshState))
      .handle("teamDirectory", () => handle(AuthOrchestrationReadScope, account.teamDirectory))
      .handle("teamCommand", ({ payload }) =>
        handle(AuthAccessWriteScope, account.teamCommand(payload.generation, payload.command)),
      )
      .handle("projects", () => handle(AuthOrchestrationReadScope, account.projects))
      .handle("start", ({ payload }) =>
        handle(AuthAccessWriteScope, account.start(payload.serviceUrl)),
      )
      .handle("cancel", ({ payload }) =>
        handle(AuthAccessWriteScope, account.cancel(payload.flowId)),
      )
      .handle("disconnect", () => handle(AuthAccessWriteScope, account.disconnect));
  }),
);

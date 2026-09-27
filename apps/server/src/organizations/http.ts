import { OrganizationIntakeEventInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { OrganizationIntakeStore, OrganizationIntakeStoreLive } from "./OrganizationIntakeStore.ts";
import {
  OrganizationCorrelationCoordinator,
  OrganizationCorrelationCoordinatorIntakeLive,
} from "./OrganizationCorrelationCoordinator.ts";
import { correlateRecordedIntake } from "./OrganizationIntakeCorrelation.ts";
import {
  OrganizationCorrelationRecovery,
  OrganizationCorrelationRecoveryLive,
} from "./OrganizationCorrelationRecovery.ts";
import { normalizeOrganizationRelayEvent } from "./OrganizationIntakeAdapters.ts";

const MAX_HTTP_EVENT_BYTES = 40 * 1024;

/** A narrow ingestion route: its bearer secret cannot authenticate to any other T3 API. */
const makeRoutes = Effect.gen(function* () {
  const store = yield* OrganizationIntakeStore;
  const correlation = yield* OrganizationCorrelationCoordinator;
  const recovery = yield* OrganizationCorrelationRecovery;
  const receive = <E>(
    decode: (raw: string) => Effect.Effect<OrganizationIntakeEventInput, E>,
    requireProjectBoundSource = false,
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const credential = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!credential) return HttpServerResponse.text("Unauthorized", { status: 401 });
      if (!request.headers["content-type"]?.startsWith("application/json"))
        return HttpServerResponse.text("JSON required", { status: 415 });
      const declaredLength = Number(request.headers["content-length"]);
      if (
        request.headers["content-length"] !== undefined &&
        (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_HTTP_EVENT_BYTES)
      )
        return HttpServerResponse.text("Event too large", { status: 413 });

      const boundedBody = yield* Stream.runFoldEffect(
        request.stream,
        () => ({ byteLength: 0, chunks: [] as Uint8Array[] }),
        (state, chunk) => {
          const byteLength = state.byteLength + chunk.byteLength;
          return byteLength > MAX_HTTP_EVENT_BYTES
            ? Effect.fail("too_large" as const)
            : Effect.succeed({ byteLength, chunks: [...state.chunks, chunk] });
        },
      ).pipe(Effect.result);
      if (Result.isFailure(boundedBody))
        return HttpServerResponse.text("Event too large", { status: 413 });
      const raw = Buffer.concat(boundedBody.success.chunks).toString("utf8");
      const event = yield* decode(raw).pipe(Effect.result);
      if (Result.isFailure(event)) return HttpServerResponse.text("Invalid event", { status: 400 });

      const outcome = yield* store
        .ingestWithCredential(event.success, credential, requireProjectBoundSource)
        .pipe(Effect.flatMap((result) => correlateRecordedIntake(correlation, result, recovery)))
        .pipe(Effect.result);
      if (Result.isFailure(outcome)) {
        const status =
          outcome.failure.code === "invalid"
            ? 400
            : outcome.failure.code === "conflict"
              ? 409
              : outcome.failure.code === "rate_limited"
                ? 429
                : outcome.failure.code === "unavailable"
                  ? 503
                  : 401;
        return HttpServerResponse.text(status === 401 ? "Unauthorized" : outcome.failure.message, {
          status,
          ...(status === 429 ? { headers: { "Retry-After": "3600" } } : {}),
        });
      }
      const receipt = {
        outcome: outcome.success.outcome,
        observationId: outcome.success.observation.id,
      };
      return HttpServerResponse.jsonUnsafe(receipt, {
        status: outcome.success.outcome === "recorded" ? 201 : 200,
      });
    });
  return Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/api/organizations/intake/events",
      receive((raw) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(OrganizationIntakeEventInput))(raw),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/api/organizations/intake/relay",
      receive(
        (raw) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(raw).pipe(
            Effect.flatMap(normalizeOrganizationRelayEvent),
          ),
        true,
      ),
    ),
  );
});

export const organizationIntakeHttpRouteLayer = Layer.unwrap(makeRoutes).pipe(
  Layer.provide(OrganizationIntakeStoreLive),
  Layer.provide(OrganizationCorrelationCoordinatorIntakeLive),
  Layer.provide(OrganizationCorrelationRecoveryLive),
);

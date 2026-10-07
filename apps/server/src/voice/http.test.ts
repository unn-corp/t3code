import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as OpenWhispr from "./OpenWhispr.ts";
import { voiceHttpApiLayer } from "./http.ts";

const testApi = HttpApi.make("environment").add(EnvironmentHttpApi.groups.voice);
const makeHandler = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  transcribe: OpenWhispr.OpenWhispr["Service"]["transcribe"],
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(testApi).pipe(
      Layer.provide(voiceHttpApiLayer),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(Layer.succeed(OpenWhispr.OpenWhispr, { transcribe })),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth)((effect) =>
          Effect.provideService(effect, EnvironmentAuthenticatedPrincipal, {
            sessionId: AuthSessionId.make("test-session"),
            subject: "test-client",
            method: "browser-session-cookie",
            scopes: new Set(scopes),
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );
const request = () =>
  new Request("https://host.example/api/voice/openwhispr", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: new Uint8Array(48),
  });

it.effect("decodes WAV bytes and transcribes for an authorized client", () =>
  Effect.gen(function* () {
    let called = false;
    const app = makeHandler([AuthOrchestrationOperateScope], (audio) =>
      Effect.sync(() => {
        called = true;
        expect(audio.byteLength).toBe(48);
        return { text: "hello" };
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(app.dispose));
    const response = yield* Effect.promise(() => app.handler(request()));
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe('{"text":"hello"}');
    expect(called).toBe(true);
  }),
);

it.effect("rejects a read-only client before contacting OpenWhispr", () =>
  Effect.gen(function* () {
    let called = false;
    const app = makeHandler([AuthOrchestrationReadScope], () =>
      Effect.sync(() => {
        called = true;
        return { text: "unexpected" };
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(app.dispose));
    const response = yield* Effect.promise(() => app.handler(request()));
    expect(response.status).toBe(403);
    expect(called).toBe(false);
  }),
);

import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import { OPENWHISPR_MAX_AUDIO_BYTES, OPENWHISPR_TIMEOUT_MS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as OpenWhispr from "./OpenWhispr.ts";

const audio = new Uint8Array(48);
const testLayer = (fetchFn: typeof fetch) =>
  OpenWhispr.layer.pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    ),
  );

describe("OpenWhispr", () => {
  it.effect("sends WAV multipart audio from the server and trims the transcript", () =>
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.transcribe(audio)).toEqual({ text: "hello" });
    }).pipe(
      Effect.provide(
        testLayer((url, options) => {
          expect(String(url)).toBe("http://127.0.0.1:8178/inference");
          expect(options?.method).toBe("POST");
          const form = options?.body;
          expect(form).toBeInstanceOf(FormData);
          if (form instanceof FormData) {
            expect(form.get("response_format")).toBe("json");
            const file = form.get("file");
            expect(file).toBeInstanceOf(Blob);
            if (file instanceof Blob) expect(file.size).toBe(audio.byteLength);
          }
          return Promise.resolve(Response.json({ text: "  hello  " }));
        }),
      ),
    ),
  );

  it.effect("ignores blank-audio markers", () =>
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.transcribe(audio)).toEqual({ text: "" });
    }).pipe(
      Effect.provide(testLayer(() => Promise.resolve(Response.json({ text: " [BLANK_AUDIO] " })))),
    ),
  );

  it.effect("rejects empty and oversized recordings before contacting OpenWhispr", () =>
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.transcribe(new Uint8Array(44)).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_audio",
      });
      expect(
        yield* service.transcribe(new Uint8Array(OPENWHISPR_MAX_AUDIO_BYTES + 1)).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid_audio" });
    }).pipe(
      Effect.provide(
        testLayer(() => {
          throw new Error("Unexpected transcription request");
        }),
      ),
    ),
  );

  it.effect("reports a stopped host service", () =>
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      const error = yield* service.transcribe(audio).pipe(Effect.flip);
      expect(error.reason).toBe("unavailable");
      expect(error.message).toContain("connected Arcwright Code server");
    }).pipe(Effect.provide(testLayer(() => Promise.resolve(new Response(null, { status: 503 }))))),
  );

  it.effect("rejects invalid transcription responses", () =>
    Effect.gen(function* () {
      const service = yield* OpenWhispr.OpenWhispr;
      expect(yield* service.transcribe(audio).pipe(Effect.flip)).toMatchObject({
        reason: "invalid_response",
      });
    }).pipe(Effect.provide(testLayer(() => Promise.resolve(Response.json({ text: 5 }))))),
  );

  it.effect("aborts a stalled host request at the deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let requestSignal: AbortSignal | null | undefined;
      const httpClient = HttpClient.make((_request, _url, signal) =>
        Effect.gen(function* () {
          requestSignal = signal;
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* OpenWhispr.OpenWhispr;
        return yield* service.transcribe(audio).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          OpenWhispr.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient))),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(OPENWHISPR_TIMEOUT_MS);
      expect(yield* Fiber.join(result)).toMatchObject({ reason: "timeout" });
      expect(requestSignal?.aborted).toBe(true);
    }),
  );
});

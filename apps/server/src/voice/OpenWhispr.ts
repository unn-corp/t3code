import {
  OPENWHISPR_MAX_AUDIO_BYTES,
  OPENWHISPR_TIMEOUT_MS,
  OpenWhisprTranscriptionError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export class OpenWhispr extends Context.Service<
  OpenWhispr,
  {
    readonly transcribe: (
      audio: Uint8Array,
    ) => Effect.Effect<{ readonly text: string }, OpenWhisprTranscriptionError>;
  }
>()("t3/voice/OpenWhispr") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return OpenWhispr.of({
    transcribe: Effect.fn("OpenWhispr.transcribe")(
      function* (audio) {
        if (audio.byteLength <= 44 || audio.byteLength > OPENWHISPR_MAX_AUDIO_BYTES) {
          return yield* new OpenWhisprTranscriptionError({ reason: "invalid_audio" });
        }
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
          "t3-voice.wav",
        );
        form.append("response_format", "json");
        const response = yield* httpClient
          .execute(
            HttpClientRequest.post("http://127.0.0.1:8178/inference").pipe(
              HttpClientRequest.bodyFormData(form),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.mapError(() => new OpenWhisprTranscriptionError({ reason: "unavailable" })),
          );
        const result = yield* HttpClientResponse.schemaBodyJson(
          Schema.Struct({ text: Schema.String }),
        )(response).pipe(
          Effect.mapError(() => new OpenWhisprTranscriptionError({ reason: "invalid_response" })),
        );
        const text = result.text.trim();
        return { text: text === "[BLANK_AUDIO]" ? "" : text };
      },
      Effect.timeoutOrElse({
        duration: OPENWHISPR_TIMEOUT_MS,
        orElse: () => Effect.fail(new OpenWhisprTranscriptionError({ reason: "timeout" })),
      }),
    ),
  });
});

export const layer = Layer.effect(OpenWhispr, make);

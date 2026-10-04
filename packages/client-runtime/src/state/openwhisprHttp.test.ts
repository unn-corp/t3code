import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentTranscription } from "./openwhisprHttp.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("server-1"),
  label: "Server",
  httpBaseUrl: "https://host.example",
  wsBaseUrl: "wss://host.example",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://host.example/ws",
  httpAuthorization: null,
};
const audio = new Uint8Array([1, 2, 3]);

describe("environment transcription", () => {
  it.effect("uploads binary audio to the selected host with cookie credentials", () =>
    fetchEnvironmentTranscription({ prepared, audio, signer: Option.none() }).pipe(
      Effect.tap((value) => Effect.sync(() => expect(value.text).toBe("hello"))),
      Effect.provide(
        remoteHttpClientLayer((url, init) => {
          expect(String(url)).toBe("https://host.example/api/voice/openwhispr");
          expect(init?.method).toBe("POST");
          expect(init?.credentials).toBe("include");
          expect(init?.body).toEqual(audio);
          expect(new Headers(init?.headers).get("content-type")).toBe("audio/wav");
          return Promise.resolve(Response.json({ text: "hello" }));
        }),
      ),
    ),
  );
  it.effect("uses the connected server's bearer authorization", () =>
    fetchEnvironmentTranscription({
      prepared: { ...prepared, httpAuthorization: { _tag: "Bearer", token: "test-token" } },
      audio,
      signer: Option.none(),
    }).pipe(
      Effect.provide(
        remoteHttpClientLayer((_url, init) => {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
          return Promise.resolve(Response.json({ text: "hello" }));
        }),
      ),
    ),
  );
  it.effect("keeps the server's useful transcription error", () =>
    fetchEnvironmentTranscription({ prepared, audio, signer: Option.none() }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error._tag).toBe("OpenWhisprTranscriptionError");
          expect(error.message).toContain("connected T3 server");
        }),
      ),
      Effect.provide(
        remoteHttpClientLayer(() =>
          Promise.resolve(
            Response.json(
              { _tag: "OpenWhisprTranscriptionError", reason: "unavailable" },
              { status: 502 },
            ),
          ),
        ),
      ),
    ),
  );
});

it.effect("refreshes relay credentials and signs the audio request on retry", () =>
  Effect.gen(function* () {
    let requests = 0;
    const proofs: string[] = [];
    const remoteAuthorization = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
      authorizeBearer: () => Effect.die("Unexpected bearer authorization"),
      authorizeDpop: () => Effect.die("Unexpected socket preparation"),
      authorizeDpopHttp: (input) =>
        Effect.succeed({
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: "https://relay.example",
          httpAuthorization: {
            _tag: "Dpop",
            accessToken: input.rejectedAccessToken ? "renewed" : "current",
            expiresAtEpochMs: 3_600_000,
          },
        }),
    });
    const signer = ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("thumbprint"),
      createProof: (input) =>
        Effect.sync(() => {
          expect(input.url).toBe("https://relay.example/api/voice/openwhispr");
          expect(input.method).toBe("POST");
          proofs.push(input.accessToken ?? "");
          return `proof-${input.accessToken}`;
        }),
    });
    const value = yield* fetchEnvironmentTranscription({
      prepared: {
        ...prepared,
        httpAuthorization: { _tag: "Dpop", accessToken: "expired", expiresAtEpochMs: 0 },
      },
      audio,
      signer: Option.some(signer),
      remoteAuthorization: Option.some(remoteAuthorization),
    }).pipe(
      Effect.provide(
        remoteHttpClientLayer((url, init) => {
          expect(String(url)).toBe("https://relay.example/api/voice/openwhispr");
          expect(init?.body).toEqual(audio);
          requests += 1;
          const token = requests === 1 ? "current" : "renewed";
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe(`DPoP ${token}`);
          expect(headers.get("dpop")).toBe(`proof-${token}`);
          return Promise.resolve(
            requests === 1
              ? Response.json(
                  {
                    _tag: "EnvironmentAuthInvalidError",
                    code: "auth_invalid",
                    reason: "invalid_credential",
                    traceId: "test-trace",
                  },
                  { status: 401 },
                )
              : Response.json({ text: "remote voice" }),
          );
        }),
      ),
    );
    expect(value.text).toBe("remote voice");
    expect(proofs).toEqual(["current", "renewed"]);
  }),
);

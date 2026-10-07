import { OPENWHISPR_TIMEOUT_MS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  makeEnvironmentHttpApiUrlBuilder,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export const fetchEnvironmentTranscription = Effect.fn("clientRuntime.voice.transcribe")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly audio: Uint8Array;
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
    >;
  }) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "voice",
      method: "POST",
      url: (base) => makeEnvironmentHttpApiUrlBuilder(base).voice.transcribe(),
      timeoutMs: OPENWHISPR_TIMEOUT_MS + 5_000,
      request: ({ client, headers }) => client.transcribe({ payload: input.audio, headers }),
    });
  },
);

export class OpenWhisprLoader extends Context.Service<
  OpenWhisprLoader,
  {
    readonly transcribe: (
      prepared: PreparedConnection,
      audio: Uint8Array,
    ) => Effect.Effect<{ readonly text: string }, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/openwhisprHttp/OpenWhisprLoader") {}

export const layer = Layer.effect(
  OpenWhisprLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return OpenWhisprLoader.of({
      transcribe: (prepared, audio) =>
        fetchEnvironmentTranscription({ prepared, audio, signer, remoteAuthorization }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);

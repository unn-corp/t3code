import {
  TeamDirectory,
  TeamRosterCommand,
  TeamRosterResult,
  TeamAccount,
  TeamOAuthConfiguration,
  TeamSpaceSchema,
  type LocalTeamAccountState,
} from "@t3tools/contracts/teamSpaces";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const SECRET = "teams-account-v1";
const SCOPES = "openid profile email offline_access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const BoundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384));
const Seconds = Schema.Finite.check(Schema.isGreaterThan(0));
const Configuration = Schema.Struct({
  serviceUrl: Schema.String,
  ...TeamOAuthConfiguration.fields,
});
const Grant = Schema.Struct({
  account: TeamAccount,
  accessToken: BoundedText,
  refreshToken: BoundedText,
  expiresAt: Schema.Finite,
});
const Stored = Schema.Struct({
  configuration: Schema.NullOr(Configuration),
  grant: Schema.NullOr(Grant),
  generation: Schema.String,
  revocationUncertain: Schema.optional(Schema.Boolean),
});
type Stored = typeof Stored.Type;
type Configuration = typeof Configuration.Type;
const StoredJson = Schema.fromJsonString(Stored);
const Discovery = Schema.Struct({
  issuer: Schema.String,
  device_authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  revocation_endpoint: Schema.String,
  grant_types_supported: Schema.Array(Schema.String),
});
const Device = Schema.Struct({
  device_code: BoundedText,
  user_code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Seconds,
  interval: Schema.optional(Seconds),
});
const Token = Schema.Struct({
  access_token: BoundedText,
  refresh_token: Schema.optional(BoundedText),
  expires_in: Seconds,
  token_type: Schema.String,
});
const OAuthError = Schema.Struct({ error: Schema.String });
const decodeOAuthError = Schema.decodeUnknownOption(OAuthError);
const decodeStored = Schema.decodeOption(StoredJson);
const encodeStored = Schema.encodeEffect(StoredJson);
const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const decodeIssuedTokens = Schema.decodeUnknownOption(
  Schema.Struct({
    access_token: Schema.optional(Schema.Unknown),
    refresh_token: Schema.optional(Schema.Unknown),
  }),
);
const decodeToken = Schema.decodeUnknownOption(BoundedText);

export class LocalTeamAccountError extends Schema.TaggedError<LocalTeamAccountError>()(
  "LocalTeamAccountError",
  {
    reason: Schema.Literals([
      "network",
      "invalid_response",
      "configuration",
      "authorization",
      "changed",
      "storage",
      "signed_out",
    ]),
    message: Schema.String,
  },
) {}
const fail = (reason: LocalTeamAccountError["reason"], message: string) =>
  new LocalTeamAccountError({ reason, message });

/** The only outgoing boundary for account credentials; errors never retain response bodies. */
export class TeamAccountHttp extends Context.Service<
  TeamAccountHttp,
  {
    readonly request: (
      url: string,
      options?: {
        readonly form?: Readonly<Record<string, string>>;
        readonly json?: TeamRosterCommand;
        readonly token?: string;
      },
    ) => Effect.Effect<{ readonly status: number; readonly body: unknown }, LocalTeamAccountError>;
  }
>()("t3/team/LocalTeamAccount/TeamAccountHttp") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return {
        request: (url, options) =>
          Effect.gen(function* () {
            let request = HttpClientRequest.make(options?.form || options?.json ? "POST" : "GET")(
              url,
            );
            if (options?.form)
              request = request.pipe(HttpClientRequest.bodyUrlParams(options.form));
            if (options?.json) request = yield* HttpClientRequest.bodyJson(request, options.json);
            if (options?.token)
              request = request.pipe(HttpClientRequest.bearerToken(options.token));
            const response = yield* client.execute(request);
            let received = 0;
            const body = yield* response.stream.pipe(
              Stream.mapEffect((chunk) => {
                received += chunk.byteLength;
                return received > 1048576
                  ? Effect.fail(fail("invalid_response", "The Teams response is too large."))
                  : Effect.succeed(chunk);
              }),
              Stream.decodeText,
              Stream.runFold(
                () => "",
                (text, chunk) => text + chunk,
              ),
              Effect.catch((error) =>
                error._tag === "HttpClientError" && error.reason._tag === "EmptyBodyError"
                  ? Effect.succeed("")
                  : Effect.fail(error),
              ),
            );
            return {
              status: response.status,
              body: Option.getOrNull(decodeJson(body)),
            };
          }).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {
              redirect: "error",
              cache: "no-store",
            }),
            Effect.withTracerEnabled(false),
            Effect.mapError(() => fail("network", "Could not reach the Teams account service.")),
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () => Effect.fail(fail("network", "The Teams account request timed out.")),
            }),
          ),
      } satisfies TeamAccountHttp["Service"];
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

export const teamServiceOrigin = (input: string): string => {
  const url = new URL(input);
  if (
    (input !== url.origin && input !== `${url.origin}/`) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Invalid Teams service origin");
  }
  return url.origin;
};
const issuerOrigin = (input: string): string => {
  const url = new URL(input);
  if (
    (input !== url.origin && input !== `${url.origin}/`) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid issuer");
  return url.origin;
};
const endpoint = (input: string, issuer: string): string => {
  const url = new URL(input);
  if (
    url.origin !== issuer ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error("Invalid credential endpoint");
  return url.href;
};
const validate = <A>(parse: () => A) =>
  Effect.try({
    try: parse,
    catch: () =>
      fail("configuration", "The Teams service returned an invalid OAuth configuration."),
  });
const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() =>
      fail("invalid_response", "The Teams account service returned an invalid response."),
    ),
  );

export const makeLocalTeamAccount = Effect.gen(function* () {
  const configuredServiceUrl = yield* Config.String("T3_TEAM_SERVICE_URL").pipe(
    Config.withDefault(""),
  );
  const defaultServiceUrl = configuredServiceUrl
    ? yield* validate(() => teamServiceOrigin(configuredServiceUrl)).pipe(Effect.option)
    : Option.none<string>();
  const secrets = yield* ServerSecretStore;
  const http = yield* TeamAccountHttp;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const writes = yield* Semaphore.make(1);
  const refreshes = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<string>();
  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(() => fail("storage", "Could not create a Teams account identifier.")),
  );
  let stored: Stored = { configuration: null, grant: null, generation: yield* uuid };
  let flow: LocalTeamAccountState["flow"] = null;
  let message: string | null = null;
  let epoch = 0;
  let poller: Fiber.Fiber<void, never> | undefined;
  const setFlowStatus = (status: NonNullable<LocalTeamAccountState["flow"]>["status"]) => {
    if (flow) flow = { ...flow, status };
  };
  const storageError = () => fail("storage", "Could not update private Teams account storage.");
  const saved = yield* secrets.get(SECRET).pipe(Effect.mapError(storageError));
  if (Option.isSome(saved)) {
    const parsed = decodeStored(new TextDecoder().decode(saved.value));
    if (Option.isSome(parsed)) {
      const valid = yield* validate(() => {
        const configuration = parsed.value.configuration;
        if (
          configuration &&
          (teamServiceOrigin(configuration.serviceUrl) !== configuration.serviceUrl ||
            issuerOrigin(configuration.issuer) !== configuration.issuer)
        )
          throw new Error("Invalid saved binding");
        if (parsed.value.grant && !configuration) throw new Error("Missing saved binding");
        return parsed.value;
      }).pipe(Effect.option);
      if (Option.isSome(valid)) stored = valid.value;
      else message = "Stored Teams credentials were invalid. Sign in again.";
    } else message = "Stored Teams credentials were invalid. Sign in again.";
  }
  let pendingRemoteWork = 0;
  // A lost exchange response cannot be resolved by revoking only the last saved pair.
  // Keep that uncertainty across restart, without retaining discarded credentials.
  let revocationUncertain = (stored.revocationUncertain ?? false) || message !== null;
  const state = Effect.sync((): LocalTeamAccountState => ({
    generation: stored.generation,
    serviceUrl: stored.configuration?.serviceUrl ?? Option.getOrNull(defaultServiceUrl),
    account: stored.grant?.account ?? null,
    flow,
    message:
      message ??
      (configuredServiceUrl && Option.isNone(defaultServiceUrl) && !stored.configuration
        ? "The configured Teams service URL is invalid. Use Advanced to choose a service."
        : null),
  }));
  const persist = Effect.fn("LocalTeamAccount.persist")(function* (next: Stored) {
    const value = { ...next, revocationUncertain: revocationUncertain || pendingRemoteWork > 0 };
    const encoded = yield* encodeStored(value).pipe(Effect.mapError(storageError));
    yield* secrets
      .set(SECRET, new TextEncoder().encode(encoded))
      .pipe(Effect.mapError(storageError));
    const changed = stored.generation !== next.generation;
    stored = value;
    if (changed) yield* PubSub.publish(changes, next.generation);
  });
  if (message) yield* persist(stored);
  const finishRemoteWork = (uncertain: boolean) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        pendingRemoteWork--;
        revocationUncertain ||= uncertain;
        // Cleanup may belong to a previous account. Only update the current envelope.
        yield* persist(stored);
      }),
    );
  const revokeTokens = Effect.fn("LocalTeamAccount.revokeTokens")(function* (
    configuration: Configuration,
    revokeUrl: string,
    tokens: ReadonlyArray<string>,
  ) {
    let confirmed = true;
    for (const token of new Set(tokens)) {
      const revoked = yield* http
        .request(revokeUrl, { form: { client_id: configuration.clientId, token } })
        .pipe(
          Effect.interruptible,
          Effect.map((response) => response.status === 200),
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.orElseSucceed(() => false),
        );
      confirmed = revoked && confirmed;
    }
    return confirmed;
  });
  const exchange = Effect.fn("LocalTeamAccount.exchange")(function* <A>(
    input: {
      epoch: number;
      configuration: Configuration;
      endpoints: { token: string; revoke: string };
      form: Readonly<Record<string, string>>;
      expiresAt?: number;
    },
    accept: (
      response: { status: number; body: unknown },
      adopted: () => void,
    ) => Effect.Effect<A, LocalTeamAccountError>,
  ) {
    let observed: Array<string> = [];
    let adopted = false;
    let ambiguous = false;
    const work = Effect.acquireUseRelease(
      writes.withPermits(1)(
        Effect.gen(function* () {
          if (epoch !== input.epoch)
            return yield* fail("changed", "The Teams account changed before the exchange.");
          pendingRemoteWork++;
          yield* persist(stored).pipe(
            Effect.tapError(() => Effect.sync(() => pendingRemoteWork--)),
          );
        }),
      ),
      () =>
        Effect.gen(function* () {
          const remaining = input.expiresAt
            ? input.expiresAt - (yield* Clock.currentTimeMillis)
            : 20000;
          if (remaining <= 0) return yield* fail("network", "Sign-in expired.");
          return yield* Effect.gen(function* () {
            ambiguous = true;
            const response = yield* http.request(input.endpoints.token, { form: input.form });
            const issued = decodeIssuedTokens(response.body);
            const access = Option.isSome(issued)
              ? Option.getOrUndefined(decodeToken(issued.value.access_token))
              : undefined;
            const refresh = Option.isSome(issued)
              ? (Option.getOrUndefined(decodeToken(issued.value.refresh_token)) ??
                (access && issued.value.refresh_token === undefined
                  ? input.form.refresh_token
                  : undefined))
              : undefined;
            observed = [refresh, access].filter((value): value is string => value !== undefined);
            ambiguous = !(access && refresh) && Option.isNone(decodeOAuthError(response.body));
            if (epoch !== input.epoch)
              return yield* fail("changed", "The Teams account changed during the exchange.");
            return yield* accept(response, () => {
              adopted = true;
            });
          }).pipe(
            Effect.timeoutOrElse({
              duration: remaining,
              orElse: () => Effect.fail(fail("network", "The Teams account exchange timed out.")),
            }),
          );
        }),
      () =>
        Effect.gen(function* () {
          const revoked =
            adopted || (yield* revokeTokens(input.configuration, input.endpoints.revoke, observed));
          yield* finishRemoteWork(ambiguous || !revoked);
        }),
    );
    // Poll cancellation and HTTP caller cancellation must not discard an observable grant.
    // The service owns this one bounded exchange, not another polling loop.
    const fiber = yield* work.pipe(Effect.forkIn(scope));
    return yield* Fiber.join(fiber);
  });
  const metadata = Effect.fn("LocalTeamAccount.metadata")(function* (configuration: Configuration) {
    const response = yield* http.request(
      `${configuration.issuer}/.well-known/openid-configuration`,
    );
    if (response.status !== 200)
      return yield* fail("configuration", "Could not discover the Teams issuer.");
    const data = yield* decode(Discovery, response.body);
    return yield* validate(() => {
      if (
        issuerOrigin(data.issuer) !== configuration.issuer ||
        !data.grant_types_supported.includes(DEVICE_GRANT) ||
        !data.grant_types_supported.includes("refresh_token")
      )
        throw new Error("Issuer mismatch");
      return {
        device: endpoint(data.device_authorization_endpoint, configuration.issuer),
        token: endpoint(data.token_endpoint, configuration.issuer),
        revoke: endpoint(data.revocation_endpoint, configuration.issuer),
      };
    });
  });
  const account = Effect.fn("LocalTeamAccount.account")(function* (
    configuration: Configuration,
    token: string,
  ) {
    const response = yield* http.request(`${configuration.serviceUrl}/api/team/account`, { token });
    if (response.status === 401 || response.status === 403)
      return yield* fail("authorization", "Teams authorization was rejected. Sign in again.");
    if (response.status !== 200) return yield* fail("network", "Could not load the Teams account.");
    return yield* decode(TeamAccount, response.body);
  });
  const tokenGrant = Effect.fn("LocalTeamAccount.tokenGrant")(function* (
    body: unknown,
    configuration: Configuration,
    refreshToken?: string,
  ) {
    const data = yield* decode(Token, body);
    if (data.token_type.toLowerCase() !== "bearer" || !(data.refresh_token ?? refreshToken))
      return yield* fail(
        "invalid_response",
        "Teams did not return a renewable account credential.",
      );
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = now + data.expires_in * 1000;
    if (!Number.isFinite(expiresAt))
      return yield* fail("invalid_response", "Teams returned an invalid credential expiry.");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken!,
      expiresAt,
      account: yield* account(configuration, data.access_token),
    };
  });
  const stopPoller = Effect.sync(() => {
    if (poller) {
      poller.interruptUnsafe();
      poller = undefined;
    }
  });
  const invalidate = Effect.fn("LocalTeamAccount.invalidate")(function* (
    expectedEpoch: number,
    detail: string,
  ) {
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        if (epoch !== expectedEpoch) return;
        // A local rejection does not establish that the issuer revoked this pair.
        revocationUncertain ||= stored.grant !== null;
        epoch++;
        const next = { configuration: stored.configuration, grant: null, generation: yield* uuid };
        stored = next;
        message = detail;
        yield* PubSub.publish(changes, next.generation);
        yield* persist(next).pipe(
          Effect.catch(() =>
            secrets
              .remove(SECRET)
              .pipe(Effect.mapError(storageError), Effect.andThen(Effect.fail(storageError()))),
          ),
        );
      }).pipe(Effect.uninterruptible),
    );
  });
  const runDevice = Effect.fn("LocalTeamAccount.runDevice")(function* (input: {
    epoch: number;
    configuration: Configuration;
    deviceCode: string;
    endpoints: { token: string; revoke: string };
    expiresAt: number;
    interval: number;
  }) {
    let interval = input.interval;
    let backoff = interval;
    while (true) {
      if (epoch !== input.epoch || flow?.status !== "pending") return;
      const remaining = input.expiresAt - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) {
        setFlowStatus("expired");
        message = "Sign-in expired. Try again.";
        return;
      }
      yield* Effect.sleep(Math.min(Math.max(interval, backoff), remaining));
      if (epoch !== input.epoch) return;
      if ((yield* Clock.currentTimeMillis) >= input.expiresAt) continue;
      const response = yield* exchange(
        {
          epoch: input.epoch,
          configuration: input.configuration,
          endpoints: input.endpoints,
          expiresAt: input.expiresAt,
          form: {
            client_id: input.configuration.clientId,
            grant_type: DEVICE_GRANT,
            device_code: input.deviceCode,
          },
        },
        (response, adopted) =>
          Effect.gen(function* () {
            if (response.status !== 200 || Option.isSome(decodeOAuthError(response.body)))
              return response;
            const grant = yield* tokenGrant(response.body, input.configuration);
            yield* writes.withPermits(1)(
              Effect.gen(function* () {
                if (epoch !== input.epoch)
                  return yield* fail("changed", "This sign-in was cancelled or replaced.");
                if ((yield* Clock.currentTimeMillis) >= input.expiresAt)
                  return yield* fail("network", "Sign-in expired.");
                yield* persist({
                  configuration: input.configuration,
                  grant,
                  generation: yield* uuid,
                });
                adopted();
                flow = null;
                message = null;
              }).pipe(Effect.uninterruptible),
            );
            return response;
          }),
      ).pipe(Effect.result);
      if (epoch !== input.epoch) return;
      if (response._tag === "Failure") {
        if (response.failure.reason !== "network") return yield* response.failure;
        backoff = Math.min(Math.max(backoff * 2, interval), 60000);
        continue;
      }
      const oauthError = decodeOAuthError(response.success.body);
      if (Option.isSome(oauthError)) {
        if (oauthError.value.error === "authorization_pending") {
          backoff = interval;
          continue;
        }
        if (oauthError.value.error === "slow_down") {
          interval += 5000;
          backoff = interval;
          continue;
        }
        setFlowStatus(
          oauthError.value.error === "access_denied"
            ? "denied"
            : oauthError.value.error === "expired_token"
              ? "expired"
              : "failed",
        );
        message =
          oauthError.value.error === "access_denied"
            ? "Sign-in was denied. Try again when ready."
            : "Sign-in ended. Check the service configuration and try again.";
        return;
      }
      if (response.success.status >= 500) {
        backoff = Math.min(Math.max(backoff * 2, interval), 60000);
        continue;
      }
      if (response.success.status !== 200)
        return yield* fail("authorization", "Teams rejected sign-in. Try again.");
      return;
    }
  });
  const start = Effect.fn("LocalTeamAccount.start")(function* (serviceUrl: string) {
    const origin = yield* validate(() => teamServiceOrigin(serviceUrl));
    const reservation = yield* writes.withPermits(1)(
      Effect.gen(function* () {
        if (stored.grant)
          return yield* fail(
            "configuration",
            "Disconnect the current Teams account before signing in again.",
          );
        yield* stopPoller;
        epoch++;
        flow = null;
        message = null;
        return {
          epoch,
          id: yield* uuid,
          configuration: stored.configuration?.serviceUrl === origin ? stored.configuration : null,
        };
      }),
    );
    let configuration = reservation.configuration;
    if (!configuration) {
      const response = yield* http.request(`${origin}/api/team/config`);
      if (response.status !== 200)
        return yield* fail("configuration", "Could not load the Teams service configuration.");
      const config = yield* decode(
        Schema.Struct({ enabled: Schema.Literal(true), oauth: TeamOAuthConfiguration }),
        response.body,
      );
      configuration = {
        serviceUrl: origin,
        issuer: yield* validate(() => issuerOrigin(config.oauth.issuer)),
        clientId: config.oauth.clientId,
      };
    }
    const pinned = configuration;
    const endpoints = yield* metadata(pinned);
    const response = yield* http.request(endpoints.device, {
      form: { client_id: pinned.clientId, scope: SCOPES },
    });
    if (response.status !== 200)
      return yield* fail(
        "authorization",
        "Could not start Teams sign-in. Check the OAuth client configuration.",
      );
    const device = yield* decode(Device, response.body);
    const links = yield* validate(() => {
      const base = new URL(device.verification_uri);
      if (base.protocol !== "https:" || base.username || base.password || base.hash || base.search)
        throw new Error("Invalid verification URL");
      const complete = device.verification_uri_complete
        ? new URL(device.verification_uri_complete)
        : null;
      if (
        complete &&
        (complete.origin !== base.origin ||
          complete.pathname !== base.pathname ||
          complete.username ||
          complete.password ||
          complete.hash ||
          [...complete.searchParams.keys()].some((key) => key !== "user_code") ||
          complete.searchParams.get("user_code") !== device.user_code)
      )
        throw new Error("Invalid verification URL");
      return { verificationUri: base.href, verificationUriComplete: complete?.href ?? null };
    });
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = now + device.expires_in * 1000;
    if (!Number.isFinite(expiresAt))
      return yield* fail("invalid_response", "Teams returned an invalid sign-in expiry.");
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        if (epoch !== reservation.epoch)
          return yield* fail("changed", "This sign-in was cancelled or replaced.");
        yield* persist({ configuration: pinned, grant: null, generation: yield* uuid });
        flow = {
          id: reservation.id,
          userCode: device.user_code,
          ...links,
          expiresAt,
          status: "pending",
        };
        poller = yield* runDevice({
          epoch,
          configuration: pinned,
          deviceCode: device.device_code,
          endpoints,
          expiresAt,
          interval: (device.interval ?? 5) * 1000,
        }).pipe(
          Effect.timeoutOrElse({
            duration: Math.max(1, expiresAt - (yield* Clock.currentTimeMillis)),
            orElse: () =>
              Effect.sync(() => {
                if (epoch === reservation.epoch && flow) {
                  setFlowStatus("expired");
                  message = "Sign-in expired. Try again.";
                }
              }),
          }),
          Effect.catch((error) =>
            Effect.sync(() => {
              if (epoch === reservation.epoch && flow) {
                setFlowStatus("failed");
                message = error.message;
              }
            }),
          ),
          Effect.interruptible,
          Effect.forkIn(scope),
        );
        return yield* state;
      }).pipe(Effect.uninterruptible),
    );
  });
  const cancel = (flowId: string) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        if (flow?.id !== flowId) return yield* state;
        epoch++;
        yield* stopPoller;
        setFlowStatus("cancelled");
        message = "Sign-in cancelled.";
        return yield* state;
      }),
    );
  const credential = refreshes
    .withPermits(1)(
      Effect.gen(function* () {
        const previous = stored;
        const expectedEpoch = epoch;
        if (!previous.grant || !previous.configuration)
          return yield* fail("signed_out", "Sign in to Teams first.");
        if (previous.grant.expiresAt > (yield* Clock.currentTimeMillis) + 60000) return previous;
        const configuration = previous.configuration;
        const refreshed = yield* Effect.gen(function* () {
          const endpoints = yield* metadata(configuration);
          return yield* exchange(
            {
              epoch: expectedEpoch,
              configuration,
              endpoints,
              form: {
                client_id: configuration.clientId,
                grant_type: "refresh_token",
                refresh_token: previous.grant!.refreshToken,
              },
            },
            (response, adopted) =>
              Effect.gen(function* () {
                if (response.status >= 500)
                  return yield* fail("network", "Could not refresh Teams sign-in. Try again.");
                if (response.status !== 200 || Option.isSome(decodeOAuthError(response.body)))
                  return yield* fail(
                    "authorization",
                    "Teams authorization was rejected. Sign in again.",
                  );
                const grant = yield* tokenGrant(
                  response.body,
                  configuration,
                  previous.grant!.refreshToken,
                );
                if (grant.account.subject !== previous.grant!.account.subject)
                  return yield* fail(
                    "authorization",
                    "Teams returned a different account. Sign in again.",
                  );
                return yield* writes.withPermits(1)(
                  Effect.gen(function* () {
                    if (epoch !== expectedEpoch)
                      return yield* fail("changed", "The Teams account changed during refresh.");
                    const next = {
                      configuration: previous.configuration,
                      generation: previous.generation,
                      grant,
                    };
                    yield* persist(next);
                    adopted();
                    return next;
                  }).pipe(Effect.uninterruptible),
                );
              }),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (error.reason === "authorization" || error.reason === "invalid_response")
                yield* invalidate(expectedEpoch, error.message);
              return yield* error;
            }),
          ),
        );
        return refreshed;
      }),
    )
    .pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));
  // Transport callback failures can contain credentials in nested causes. Keep
  // this whole private boundary untraced until the caller sanitizes the error.
  const withCredential = Effect.fnUntraced(function* <A, E, R>(
    operation: (connection: {
      readonly serviceUrl: string;
      readonly issuer: string;
      readonly clientId: string;
      readonly subject: string;
      readonly generation: string;
      readonly accessToken: string;
    }) => Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | LocalTeamAccountError, R> {
    const current = yield* credential;
    const expectedEpoch = epoch;
    if (!current.grant || !current.configuration || current.generation !== stored.generation)
      return yield* fail("changed", "The Teams account changed. Retry the request.");
    const result = yield* operation({
      ...current.configuration,
      subject: current.grant.account.subject,
      generation: current.generation,
      accessToken: current.grant.accessToken,
    });
    if (epoch !== expectedEpoch || current.generation !== stored.generation)
      return yield* fail("changed", "The Teams account changed. Discard the previous result.");
    return result;
  }, Effect.withTracerEnabled(false));
  const projects = withCredential((connection) =>
    Effect.gen(function* () {
      const expectedEpoch = epoch;
      const response = yield* http.request(`${connection.serviceUrl}/api/team/spaces`, {
        token: connection.accessToken,
      });
      if (epoch !== expectedEpoch || connection.generation !== stored.generation)
        return yield* fail("changed", "The Teams account changed. Refresh the project list.");
      if (response.status === 401 || response.status === 403) {
        yield* invalidate(expectedEpoch, "Teams authorization was rejected. Sign in again.");
        return yield* fail("authorization", "Teams authorization was rejected. Sign in again.");
      }
      if (response.status !== 200) return yield* fail("network", "Could not load team projects.");
      const result = yield* decode(
        Schema.Struct({ spaces: Schema.Array(TeamSpaceSchema) }),
        response.body,
      );
      return { generation: connection.generation, spaces: result.spaces };
    }),
  );
  const refreshAccount = withCredential((connection) =>
    Effect.gen(function* () {
      const configuration = stored.configuration!;
      const profile = yield* account(configuration, connection.accessToken);
      if (profile.subject !== connection.subject)
        return yield* fail("authorization", "Teams returned a different account.");
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          if (connection.generation !== stored.generation || !stored.grant)
            return yield* fail("changed", "The Teams account changed.");
          yield* persist({ ...stored, grant: { ...stored.grant, account: profile } });
        }),
      );
    }),
  );
  const teamDirectory = withCredential((connection) =>
    Effect.gen(function* () {
      const response = yield* http.request(`${connection.serviceUrl}/api/team/team-directory`, {
        token: connection.accessToken,
      });
      if (response.status !== 200)
        return yield* fail("authorization", "Could not load the team directory.");
      const directory = yield* decode(TeamDirectory, response.body);
      return { generation: connection.generation, directory };
    }),
  );
  const teamCommand = (generation: string, command: TeamRosterCommand) =>
    Effect.suspend(() =>
      generation !== stored.generation
        ? fail("changed", "The Teams account changed. Refresh before changing team membership.")
        : withCredential((connection) =>
            Effect.gen(function* () {
              const expectedEpoch = epoch;
              if (connection.generation !== generation)
                return yield* fail("changed", "The Teams account changed.");
              const configuration = {
                serviceUrl: connection.serviceUrl,
                issuer: connection.issuer,
                clientId: connection.clientId,
              };
              const response = yield* http.request(
                `${configuration.serviceUrl}/api/team/team-command`,
                {
                  token: connection.accessToken,
                  json: command,
                },
              );
              if (response.status !== 200)
                return yield* fail("authorization", "The team command was rejected.");
              if (epoch !== expectedEpoch || connection.generation !== stored.generation)
                return yield* fail("changed", "The Teams account changed during the team command.");
              const result = yield* decode(TeamRosterResult, response.body);
              const profile = yield* account(configuration, connection.accessToken);
              yield* writes.withPermits(1)(
                Effect.gen(function* () {
                  if (
                    connection.generation !== stored.generation ||
                    !stored.grant ||
                    profile.subject !== connection.subject
                  )
                    return yield* fail("changed", "The Teams account changed.");
                  yield* persist({ ...stored, grant: { ...stored.grant, account: profile } });
                }),
              );
              return { generation: connection.generation, result };
            }),
          ),
    );
  const disconnect = Effect.acquireUseRelease(
    writes.withPermits(1)(
      Effect.gen(function* () {
        const previous = stored;
        const uncertain = revocationUncertain || pendingRemoteWork > 0;
        const next = { configuration: stored.configuration, grant: null, generation: yield* uuid };
        epoch++;
        yield* stopPoller;
        pendingRemoteWork++;
        stored = next;
        flow = null;
        message = null;
        yield* PubSub.publish(changes, next.generation);
        yield* persist(next).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              pendingRemoteWork--;
              revocationUncertain = true;
              yield* secrets.remove(SECRET).pipe(Effect.mapError(storageError));
              return yield* storageError();
            }),
          ),
        );
        return { previous, uncertain, revoked: false };
      }),
    ),
    (snapshot) =>
      Effect.gen(function* () {
        const { previous } = snapshot;
        if (previous.grant && previous.configuration) {
          snapshot.revoked = yield* Effect.gen(function* () {
            const endpoints = yield* metadata(previous.configuration!);
            return yield* revokeTokens(previous.configuration!, endpoints.revoke, [
              previous.grant!.refreshToken,
              previous.grant!.accessToken,
            ]);
          }).pipe(Effect.orElseSucceed(() => false));
        } else {
          snapshot.revoked = true;
        }
        return {
          state: yield* state,
          remoteRevocationConfirmed: snapshot.revoked && !snapshot.uncertain,
        };
      }),
    (snapshot) => finishRemoteWork(!snapshot.revoked),
  ).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));
  return {
    state,
    refreshState: Effect.suspend(() =>
      stored.grant ? refreshAccount.pipe(Effect.andThen(state)) : state,
    ),
    teamDirectory,
    teamCommand,
    start,
    cancel,
    projects,
    disconnect,
    withCredential,
    identityChanges: Stream.fromPubSub(changes),
  };
});

export class LocalTeamAccount extends Context.Service<
  LocalTeamAccount,
  Effect.Success<typeof makeLocalTeamAccount>
>()("t3/team/LocalTeamAccount") {
  static readonly layer = Layer.effect(this, makeLocalTeamAccount).pipe(
    Layer.provide(TeamAccountHttp.layer),
  );
}

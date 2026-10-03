import * as Cause from "effect/Cause";
import * as Tracer from "effect/Tracer";
import { RpcClientError, RpcClientDefect } from "effect/unstable/rpc/RpcClientError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { SecretStorePersistError, ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  LocalTeamAccountError,
  makeLocalTeamAccount,
  TeamAccountHttp,
  teamServiceOrigin,
} from "./LocalTeamAccount.ts";

const service = "https://teams.example.test";
const issuer = "https://issuer.example.test";
const config = { serviceUrl: service, issuer, clientId: "public-client" };
const account = { subject: "member", displayName: "Trusted Member", canCreateProjects: true };
const discovery = {
  issuer,
  device_authorization_endpoint: `${issuer}/device`,
  token_endpoint: `${issuer}/token`,
  revocation_endpoint: `${issuer}/revoke`,
  grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
};
const device = {
  device_code: "PRIVATE_DEVICE",
  user_code: "ABCD-EFGH",
  verification_uri: "https://accounts.example.test/device",
  verification_uri_complete: "https://accounts.example.test/device?user_code=ABCD-EFGH",
  expires_in: 60,
  interval: 5,
};
const token = {
  access_token: "PRIVATE_ACCESS",
  refresh_token: "PRIVATE_REFRESH",
  expires_in: 3600,
  token_type: "Bearer",
};
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Saved = Schema.Struct({
  generation: Schema.String,
  grant: Schema.NullOr(Schema.Struct({ accessToken: Schema.String, refreshToken: Schema.String })),
  revocationUncertain: Schema.optional(Schema.Boolean),
});
const decodeSaved = Schema.decodeSync(Schema.fromJsonString(Saved));
type Reply = { status: number; body: unknown };
const setup = Effect.fn("setup")(function* (options?: {
  saved?: Map<string, Uint8Array>;
  defaultServiceUrl?: string;
  token?: () => Effect.Effect<Reply, LocalTeamAccountError>;
  discovery?: unknown;
  device?: unknown;
  profile?: () => Effect.Effect<Reply, LocalTeamAccountError>;
  projects?: () => Effect.Effect<Reply, LocalTeamAccountError>;
  teamDirectory?: () => Effect.Effect<Reply, LocalTeamAccountError>;
  teamCommand?: () => Effect.Effect<Reply, LocalTeamAccountError>;
  revokeFails?: boolean;
  revoke?: (token: string) => Effect.Effect<Reply, LocalTeamAccountError>;
  failWrites?: () => boolean;
}) {
  const values = options?.saved ?? new Map<string, Uint8Array>();
  const writes = yield* Queue.unbounded<typeof Saved.Type>();
  const revocations = yield* Queue.unbounded<string>();
  const calls: Array<{
    url: string;
    form?: Readonly<Record<string, string>>;
    token?: string;
    at: number;
  }> = [];
  const exchanges = yield* Queue.unbounded<void>();
  const secrets: ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, bytes) =>
      Effect.gen(function* () {
        if (options?.failWrites?.())
          return yield* new SecretStorePersistError({
            resource: "fixture",
            cause: "PRIVATE failure",
          });
        values.set(name, bytes);
        yield* Queue.offer(writes, decodeSaved(new TextDecoder().decode(bytes)));
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
  };
  const http: TeamAccountHttp["Service"] = {
    request: (url, input) =>
      Effect.gen(function* () {
        calls.push({ url, ...input, at: yield* Clock.currentTimeMillis });
        if (url.endsWith("/config"))
          return {
            status: 200,
            body: { enabled: true, oauth: { issuer, clientId: config.clientId } },
          };
        if (url.endsWith("/openid-configuration"))
          return { status: 200, body: options?.discovery ?? discovery };
        if (url.endsWith("/device")) return { status: 200, body: options?.device ?? device };
        if (url.endsWith("/token")) {
          yield* Queue.offer(exchanges, undefined);
          return yield* options?.token?.() ?? Effect.succeed({ status: 200, body: token });
        }
        if (url.endsWith("/team-directory"))
          return yield* options?.teamDirectory?.() ?? Effect.die("missing team directory route");
        if (url.endsWith("/team-command"))
          return yield* options?.teamCommand?.() ?? Effect.die("missing team command route");
        if (url.endsWith("/account"))
          return yield* options?.profile?.() ?? Effect.succeed({ status: 200, body: account });
        if (url.endsWith("/revoke")) {
          const credential = input?.form?.token ?? "";
          yield* Queue.offer(revocations, credential);
          return yield* (
            options?.revoke?.(credential) ??
              Effect.succeed({ status: options?.revokeFails ? 500 : 200, body: null })
          );
        }
        if (url.endsWith("/spaces"))
          return yield* (
            options?.projects?.() ??
              Effect.succeed({
                status: 200,
                body: { spaces: [{ id: "a".repeat(32), name: "Shared project", role: "owner" }] },
              })
          );
        return yield* new LocalTeamAccountError({
          reason: "network",
          message: "Fixture has no route",
        });
      }),
  };
  const manager = yield* makeLocalTeamAccount.pipe(
    Effect.provideService(ServerSecretStore, secrets),
    Effect.provideService(TeamAccountHttp, http),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(
        options?.defaultServiceUrl === undefined
          ? {}
          : { T3_TEAM_SERVICE_URL: options.defaultServiceUrl },
      ),
    ),
  );
  return { manager, calls, values, writes, exchanges, revocations };
});

const waitForSaved = Effect.fn("waitForSaved")(function* (
  writes: Queue.Dequeue<typeof Saved.Type>,
  match: (saved: typeof Saved.Type) => boolean,
) {
  while (true) {
    const saved = yield* Queue.take(writes);
    if (match(saved)) return saved;
  }
});

it.effect(
  "device grant honors the interval, exposes only public state, and pins renewable credentials across restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup();
        const started = yield* fixture.manager.start(service);
        expect(started.flow?.userCode).toBe(device.user_code);
        expect(json(started)).not.toContain("PRIVATE");
        yield* TestClock.adjust("4 seconds");
        expect(fixture.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(0);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(fixture.exchanges);
        const signedIn = yield* fixture.manager.state;
        expect(signedIn.account).toEqual(account);
        expect(signedIn.generation).not.toBe(started.generation);
        expect(json(signedIn)).not.toContain("PRIVATE");
        expect(new TextDecoder().decode(fixture.values.get("teams-account-v1"))).toContain(
          "PRIVATE_REFRESH",
        );
        const restarted = yield* setup({ saved: fixture.values });
        expect((yield* restarted.manager.state).account).toEqual(account);
        expect((yield* restarted.manager.projects).spaces[0]?.name).toBe("Shared project");
        expect(restarted.calls.some((call) => call.url.endsWith("/config"))).toBe(false);
        expect(fixture.calls.find((call) => call.url.endsWith("/device"))?.form).toEqual({
          client_id: "public-client",
          scope: "openid profile email offline_access",
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const [error, status] of [
  ["access_denied", "denied"],
  ["expired_token", "expired"],
  ["invalid_client", "failed"],
  ["unknown_error", "failed"],
]) {
  it.effect(`terminates device polling for ${error}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup({
          token: () =>
            Effect.succeed({ status: 400, body: { error, error_description: "PRIVATE_ERROR" } }),
        });
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        expect((yield* fixture.manager.state).flow?.status).toBe(status);
        yield* TestClock.adjust("2 minutes");
        expect(fixture.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
        expect(json(yield* fixture.manager.state)).not.toContain("PRIVATE_ERROR");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect("pending uses the issuer interval and slow_down adds five seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const replies = ["authorization_pending", "slow_down"];
      const fixture = yield* setup({
        token: () =>
          Effect.succeed(
            replies.length
              ? { status: 400, body: { error: replies.shift() } }
              : { status: 200, body: token },
          ),
      });
      yield* fixture.manager.start(service);
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("9 seconds");
      expect(fixture.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);
      yield* TestClock.adjust("1 second");
      expect((yield* fixture.manager.state).account).toEqual(account);
      expect(
        fixture.calls.filter((call) => call.url.endsWith("/token")).map((call) => call.at),
      ).toEqual([5000, 10000, 20000]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("network failures back off and end at device expiry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup({
        token: () =>
          Effect.fail(new LocalTeamAccountError({ reason: "network", message: "Unavailable" })),
      });
      yield* fixture.manager.start(service);
      yield* TestClock.adjust("1 minute");
      expect((yield* fixture.manager.state).flow?.status).toBe("expired");
      expect(
        fixture.calls.filter((call) => call.url.endsWith("/token")).map((call) => call.at),
      ).toEqual([5000, 15000, 35000]);
      yield* TestClock.adjust("1 minute");
      expect(fixture.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(3);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const action of ["cancel", "replace", "disconnect"] as const) {
  it.effect(`${action} prevents a late exchange from activating the old account`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* Deferred.make<Reply>();
        const fixture = yield* setup({
          token: () => Deferred.await(response),
        });
        const first = yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(fixture.exchanges);
        yield* Queue.takeAll(fixture.writes);
        if (action === "cancel") yield* fixture.manager.cancel(first.flow!.id);
        if (action === "disconnect")
          expect((yield* fixture.manager.disconnect).remoteRevocationConfirmed).toBe(false);
        if (action === "replace") yield* fixture.manager.start(service);
        yield* Deferred.succeed(response, { status: 200, body: token });
        expect(yield* Queue.take(fixture.revocations)).toBe("PRIVATE_REFRESH");
        expect(yield* Queue.take(fixture.revocations)).toBe("PRIVATE_ACCESS");
        yield* waitForSaved(fixture.writes, (saved) => saved.revocationUncertain === false);
        expect((yield* fixture.manager.state).account).toBeNull();
        expect(new TextDecoder().decode(fixture.values.get("teams-account-v1"))).not.toContain(
          "PRIVATE_ACCESS",
        );
        if (action === "replace") {
          yield* fixture.manager.cancel(first.flow!.id);
          expect((yield* fixture.manager.state).flow?.status).toBe("pending");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

const savedGrant = () =>
  new Map([
    [
      "teams-account-v1",
      new TextEncoder().encode(
        json({
          configuration: config,
          generation: "saved-generation",
          grant: { account, accessToken: "OLD_ACCESS", refreshToken: "OLD_REFRESH", expiresAt: 0 },
        }),
      ),
    ],
  ]);

it.effect("concurrent refresh is single-flight and atomically persists both rotated tokens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* Deferred.make<Reply>();
      const fixture = yield* setup({ saved: savedGrant(), token: () => Deferred.await(response) });
      const first = yield* fixture.manager.projects.pipe(Effect.forkChild);
      yield* Queue.take(fixture.exchanges);
      const second = yield* fixture.manager.projects.pipe(Effect.forkChild);
      yield* Deferred.succeed(response, { status: 200, body: token });
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(fixture.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
      for (const saved of yield* Queue.takeAll(fixture.writes)) {
        expect(saved.grant?.accessToken === "PRIVATE_ACCESS").toBe(
          saved.grant?.refreshToken === "PRIVATE_REFRESH",
        );
      }
      expect(new TextDecoder().decode(fixture.values.get("teams-account-v1"))).toContain(
        "PRIVATE_ACCESS",
      );
      expect((yield* fixture.manager.state).generation).toBe("saved-generation");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "logout during refresh clears storage immediately and revokes late rotated tokens without claiming confirmation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* Deferred.make<Reply>();
        const fixture = yield* setup({
          saved: savedGrant(),
          token: () => Deferred.await(response),
        });
        const refresh = yield* fixture.manager.projects.pipe(Effect.result, Effect.forkChild);
        yield* Queue.take(fixture.exchanges);
        const signedOut = yield* fixture.manager.disconnect;
        expect(signedOut.remoteRevocationConfirmed).toBe(false);
        expect(signedOut.state.account).toBeNull();
        expect(signedOut.state.generation).not.toBe("saved-generation");
        expect(new TextDecoder().decode(fixture.values.get("teams-account-v1"))).not.toContain(
          "ACCESS",
        );
        yield* Deferred.succeed(response, { status: 200, body: token });
        expect((yield* Fiber.join(refresh))._tag).toBe("Failure");
        expect(yield* Queue.takeAll(fixture.revocations)).toEqual([
          "OLD_REFRESH",
          "OLD_ACCESS",
          "PRIVATE_REFRESH",
          "PRIVATE_ACCESS",
        ]);
        expect(new TextDecoder().decode(fixture.values.get("teams-account-v1"))).not.toContain(
          "ACCESS",
        );
        expect((yield* fixture.manager.disconnect).remoteRevocationConfirmed).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const failure of ["subject", "revoked", "malformed"] as const) {
  it.effect(`invalidates a ${failure} refresh without leaking credentials`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup({
          saved: savedGrant(),
          token: () =>
            Effect.succeed(
              failure === "revoked"
                ? { status: 400, body: { error: "invalid_grant", detail: "PRIVATE" } }
                : {
                    status: 200,
                    body: failure === "malformed" ? { access_token: "PRIVATE" } : token,
                  },
            ),
          profile: () =>
            Effect.succeed({ status: 200, body: { ...account, subject: "someone-else" } }),
        });
        const error = yield* fixture.manager.projects.pipe(Effect.flip);
        expect(error.message).not.toContain("PRIVATE");
        expect((yield* fixture.manager.state).account).toBeNull();
        expect(new TextDecoder().decode(fixture.values.get("teams-account-v1"))).not.toContain(
          "ACCESS",
        );
        const restarted = yield* setup({ saved: fixture.values });
        expect((yield* restarted.manager.disconnect).remoteRevocationConfirmed).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const status of [401, 403]) {
  it.effect(
    `cloud ${status} invalidation retains unconfirmed issuer revocation across restart`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setup({
            projects: () => Effect.succeed({ status, body: { error: "sign_in_required" } }),
          });
          yield* fixture.manager.start(service);
          yield* TestClock.adjust("5 seconds");
          const signedIn = yield* fixture.manager.state;
          expect(signedIn.account).toEqual(account);
          expect((yield* fixture.manager.projects.pipe(Effect.flip)).reason).toBe("authorization");
          const invalidated = yield* fixture.manager.state;
          expect(invalidated.account).toBeNull();
          expect(invalidated.generation).not.toBe(signedIn.generation);
          expect(invalidated.message).not.toContain("revoked");
          const saved = new TextDecoder().decode(fixture.values.get("teams-account-v1"));
          expect(saved).not.toContain("PRIVATE");
          expect(decodeSaved(saved)).toMatchObject({ grant: null, revocationUncertain: true });
          const restarted = yield* setup({ saved: fixture.values });
          expect((yield* restarted.manager.disconnect).remoteRevocationConfirmed).toBe(false);
          expect(
            [...fixture.calls, ...restarted.calls].filter((call) => call.url.endsWith("/revoke")),
          ).toHaveLength(0);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect(
  "failed invalidation persistence surfaces storage failure and preserves in-memory uncertainty",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failWrites = false;
        const fixture = yield* setup({
          projects: () => Effect.succeed({ status: 403, body: null }),
          failWrites: () => failWrites,
        });
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        failWrites = true;
        const rejected = yield* fixture.manager.projects.pipe(Effect.flip);
        expect(rejected.reason).toBe("storage");
        expect(rejected.message).not.toContain("PRIVATE");
        expect((yield* fixture.manager.state).account).toBeNull();
        expect(fixture.values.has("teams-account-v1")).toBe(false);
        expect((yield* fixture.manager.disconnect.pipe(Effect.flip)).reason).toBe("storage");
        failWrites = false;
        expect((yield* fixture.manager.disconnect).remoteRevocationConfirmed).toBe(false);
        const restarted = yield* setup({ saved: fixture.values });
        expect((yield* restarted.manager.disconnect).remoteRevocationConfirmed).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "requires disconnect before replacing a signed-in account and revokes both credentials",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup();
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        expect(
          (yield* fixture.manager.start("https://another.example.test").pipe(Effect.flip)).reason,
        ).toBe("configuration");
        expect((yield* fixture.manager.disconnect).remoteRevocationConfirmed).toBe(true);
        expect(
          fixture.calls
            .filter((call) => call.url.endsWith("/revoke"))
            .map((call) => call.form?.token),
        ).toEqual(["PRIVATE_REFRESH", "PRIVATE_ACCESS"]);
        yield* fixture.manager.start("https://another.example.test");
        expect((yield* fixture.manager.state).serviceUrl).toBe("https://another.example.test");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects malformed issuer discovery before sending device credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const invalid of [
        { ...discovery, issuer: "https://other.example.test" },
        { ...discovery, token_endpoint: "https://other.example.test/token" },
        { ...discovery, revocation_endpoint: "http://issuer.example.test/revoke" },
        { ...discovery, device_authorization_endpoint: `${issuer}/device?secret=x` },
        { ...discovery, grant_types_supported: [] },
      ]) {
        const fixture = yield* setup({ discovery: invalid });
        expect((yield* fixture.manager.start(service).pipe(Effect.flip)).reason).toBe(
          "configuration",
        );
        expect(fixture.calls.some((call) => call.form)).toBe(false);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it("accepts explicit loopback HTTP only and rejects origin confusion", () => {
  for (const url of [
    service,
    "http://localhost:3910",
    "http://127.0.0.1:3910",
    "http://[::1]:3910",
  ])
    expect(teamServiceOrigin(url)).toBe(url);
  for (const url of [
    "http://teams.example.test",
    "https://user:password@teams.example.test",
    `${service}/nested`,
    `${service}?token=x`,
    `${service}#fragment`,
    "http://127.0.0.2",
  ])
    expect(() => teamServiceOrigin(url)).toThrow();
});

it.effect(
  "the internal credential lease binds the account and discards a result completed after logout",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup();
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        const begun = yield* Deferred.make<void>();
        const response = yield* Deferred.make<string>();
        const request = yield* fixture.manager
          .withCredential((connection) =>
            Effect.gen(function* () {
              expect(connection).toMatchObject({
                ...config,
                subject: account.subject,
                accessToken: "PRIVATE_ACCESS",
              });
              yield* Deferred.succeed(begun, undefined);
              return yield* Deferred.await(response);
            }),
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(begun);
        yield* fixture.manager.disconnect;
        yield* Deferred.succeed(response, "stale-project-result");
        const result = yield* Fiber.join(request);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.reason).toBe("changed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("malformed saved credentials become a private credential-free uncertainty record", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const saved = new Map([
        ["teams-account-v1", new TextEncoder().encode("PRIVATE malformed credential")],
      ]);
      const fixture = yield* setup({ saved });
      expect((yield* fixture.manager.state).account).toBeNull();
      expect(json(yield* fixture.manager.state)).not.toContain("PRIVATE");
      const replacement = new TextDecoder().decode(saved.get("teams-account-v1"));
      expect(replacement).not.toContain("PRIVATE");
      expect(decodeSaved(replacement)).toMatchObject({ grant: null, revocationUncertain: true });
      const restarted = yield* setup({ saved });
      expect((yield* restarted.manager.disconnect).remoteRevocationConfirmed).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("expiry while resolving the trusted account cannot activate a device grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const begun = yield* Deferred.make<void>();
      const profile = yield* Deferred.make<Reply>();
      const fixture = yield* setup({
        profile: () =>
          Deferred.succeed(begun, undefined).pipe(Effect.andThen(Deferred.await(profile))),
      });
      yield* fixture.manager.start(service);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(begun);
      yield* TestClock.adjust("55 seconds");
      yield* Deferred.succeed(profile, { status: 200, body: account });
      yield* TestClock.adjust("0 seconds");
      expect((yield* fixture.manager.state).account).toBeNull();
      expect((yield* fixture.manager.state).flow?.status).toBe("expired");
      expect(yield* Queue.takeAll(fixture.revocations)).toEqual([
        "PRIVATE_REFRESH",
        "PRIVATE_ACCESS",
      ]);
      yield* TestClock.adjust("1 minute");
      expect(fixture.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

for (const failure of ["http", "network"] as const) {
  it.effect(
    `revokes the access token even when refresh-token revocation has a ${failure} failure`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setup({
            revoke: (credential) =>
              credential !== "PRIVATE_REFRESH"
                ? Effect.succeed({ status: 200, body: null })
                : failure === "http"
                  ? Effect.succeed({ status: 500, body: null })
                  : Effect.fail(
                      new LocalTeamAccountError({ reason: "network", message: "Unavailable" }),
                    ),
          });
          yield* fixture.manager.start(service);
          yield* TestClock.adjust("5 seconds");
          expect((yield* fixture.manager.disconnect).remoteRevocationConfirmed).toBe(false);
          expect(yield* Queue.takeAll(fixture.revocations)).toEqual([
            "PRIVATE_REFRESH",
            "PRIVATE_ACCESS",
          ]);
          expect((yield* fixture.manager.state).account).toBeNull();
          const restarted = yield* setup({ saved: fixture.values });
          expect((yield* restarted.manager.disconnect).remoteRevocationConfirmed).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect(
  "a lost refresh response remains unconfirmed after restart and revocation of the saved pair",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup({
          saved: savedGrant(),
          token: () =>
            Effect.fail(new LocalTeamAccountError({ reason: "network", message: "Response lost" })),
        });
        expect((yield* fixture.manager.projects.pipe(Effect.flip)).reason).toBe("network");
        const restarted = yield* setup({ saved: fixture.values });
        expect((yield* restarted.manager.disconnect).remoteRevocationConfirmed).toBe(false);
        expect(yield* Queue.takeAll(restarted.revocations)).toEqual(["OLD_REFRESH", "OLD_ACCESS"]);
        expect((yield* restarted.manager.state).account).toBeNull();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cancelling a refresh caller retains single-flight ownership until token adoption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* Deferred.make<Reply>();
      const fixture = yield* setup({ saved: savedGrant(), token: () => Deferred.await(response) });
      const first = yield* fixture.manager.projects.pipe(Effect.forkChild);
      yield* Queue.take(fixture.exchanges);
      yield* Fiber.interrupt(first);
      const second = yield* fixture.manager.projects.pipe(Effect.forkChild);
      yield* Deferred.succeed(response, { status: 200, body: token });
      expect((yield* Fiber.join(second)).spaces).toHaveLength(1);
      expect(fixture.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
      expect(
        decodeSaved(new TextDecoder().decode(fixture.values.get("teams-account-v1"))),
      ).toMatchObject({
        grant: { accessToken: "PRIVATE_ACCESS", refreshToken: "PRIVATE_REFRESH" },
        revocationUncertain: false,
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "old exchange cleanup preserves a newer account, generation, and unresolved outcome",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldResponse = yield* Deferred.make<Reply>();
        let attempts = 0;
        const nextAccount = { ...account, subject: "next-member" };
        const fixture = yield* setup({
          token: () => {
            attempts++;
            return attempts === 1
              ? Deferred.await(oldResponse)
              : attempts === 2
                ? Effect.fail(
                    new LocalTeamAccountError({ reason: "network", message: "Response lost" }),
                  )
                : Effect.succeed({
                    status: 200,
                    body: { ...token, access_token: "NEXT_ACCESS", refresh_token: "NEXT_REFRESH" },
                  });
          },
          profile: () => Effect.succeed({ status: 200, body: nextAccount }),
        });
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(fixture.exchanges);
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("10 seconds");
        const next = yield* fixture.manager.state;
        expect(next.account).toEqual(nextAccount);
        yield* Queue.takeAll(fixture.writes);
        yield* Deferred.succeed(oldResponse, { status: 200, body: token });
        expect(yield* Queue.take(fixture.revocations)).toBe("PRIVATE_REFRESH");
        expect(yield* Queue.take(fixture.revocations)).toBe("PRIVATE_ACCESS");
        expect(yield* Queue.take(fixture.writes)).toMatchObject({
          generation: next.generation,
          grant: { accessToken: "NEXT_ACCESS", refreshToken: "NEXT_REFRESH" },
          revocationUncertain: true,
        });
        expect(yield* fixture.manager.state).toEqual(next);
        expect((yield* fixture.manager.disconnect).remoteRevocationConfirmed).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "service shutdown aborts a pending exchange and durably records its unknown outcome",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const interrupted = yield* Deferred.make<void>();
        const fixture = yield* setup({
          token: () =>
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        }).pipe(Effect.provideService(Scope.Scope, serviceScope));
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(fixture.exchanges);
        yield* Scope.close(serviceScope, Exit.void);
        yield* Deferred.await(interrupted);
        const restarted = yield* setup({ saved: fixture.values });
        expect((yield* restarted.manager.state).account).toBeNull();
        expect((yield* restarted.manager.disconnect).remoteRevocationConfirmed).toBe(false);
        yield* TestClock.adjust("2 minutes");
        expect(fixture.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "shutdown cleans up issued tokens before profile resolution and bounds each revocation attempt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const profileBegun = yield* Deferred.make<void>();
        const fixture = yield* setup({
          profile: () =>
            Deferred.succeed(profileBegun, undefined).pipe(Effect.andThen(Effect.never)),
          revoke: (credential) =>
            credential === "PRIVATE_REFRESH"
              ? Effect.never
              : Effect.succeed({ status: 200, body: null }),
        }).pipe(Effect.provideService(Scope.Scope, serviceScope));
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(profileBegun);
        const closing = yield* Scope.close(serviceScope, Exit.void).pipe(Effect.forkChild);
        expect(yield* Queue.take(fixture.revocations)).toBe("PRIVATE_REFRESH");
        yield* TestClock.adjust("10 seconds");
        expect(yield* Queue.take(fixture.revocations)).toBe("PRIVATE_ACCESS");
        yield* Fiber.join(closing);
        expect((yield* fixture.manager.state).account).toBeNull();
        const restarted = yield* setup({ saved: fixture.values });
        expect((yield* restarted.manager.disconnect).remoteRevocationConfirmed).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "does not record credential callback failures or defects in enclosing or nested spans",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup({ saved: savedGrant() });
        const records: Array<string> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              records.push(span.name);
              records.push(json([...span.attributes.entries()]));
              if (Exit.isFailure(exit))
                for (const error of Cause.prettyErrors(exit.cause))
                  records.push(error.message, error.stack ?? "");
            };
            return span;
          },
        });
        const ticket = "PRIVATE_TICKET_SENTINEL";
        const capability = "PRIVATE_CAPABILITY_SENTINEL";
        const nested = Effect.fn("private.socket.callback")(function* (
          accessToken: string,
          defect: boolean,
        ) {
          const failure = new RpcClientError({
            reason: new RpcClientDefect({
              message: `wss://teams.example.test/ws?ticket=${ticket}`,
              cause: new Error(`${accessToken}:${capability}`),
            }),
          });
          return yield* defect ? Effect.die(failure) : Effect.fail(failure);
        });
        yield* Effect.gen(function* () {
          yield* Effect.void.pipe(Effect.withSpan("public tracer canary"));
          for (const defect of [false, true]) {
            const result = yield* fixture.manager
              .withCredential((connection) => nested(connection.accessToken, defect))
              .pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(defect);
          }
        }).pipe(Effect.withTracer(tracer));
        expect(records).toContain("public tracer canary");
        expect(records).not.toContain("LocalTeamAccount.withCredential");
        expect(records).not.toContain("private.socket.callback");
        for (const sentinel of [token.access_token, token.refresh_token, ticket, capability])
          expect(records.join("\n")).not.toContain(sentinel);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "team commands keep credentials private and refresh roster capabilities without token expiry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let member = false;
        const fixture = yield* setup({
          profile: () =>
            Effect.succeed({
              status: 200,
              body: {
                ...account,
                canCreateProjects: member,
                teamRole: member ? "member" : null,
                canInviteMembers: false,
              },
            }),
          teamDirectory: () =>
            Effect.succeed({
              status: 200,
              body: {
                role: member ? "member" : null,
                canCreateProjects: member,
                canInviteMembers: false,
                members: [],
                invites: [],
              },
            }),
          teamCommand: () =>
            Effect.sync(() => {
              member = true;
              return { status: 200, body: {} };
            }),
        });
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        yield* waitForSaved(fixture.writes, (saved) => saved.grant !== null);
        expect((yield* fixture.manager.teamDirectory).directory.role).toBeNull();
        const result = yield* fixture.manager.teamCommand(
          (yield* fixture.manager.state).generation,
          {
            action: "accept",
            token: "a".repeat(64),
          },
        );
        expect(result.result).toEqual({});
        expect((yield* fixture.manager.state).account?.teamRole).toBe("member");
        member = false;
        expect((yield* fixture.manager.refreshState).account?.canCreateProjects).toBe(false);
        expect(json(result)).not.toContain("PRIVATE_ACCESS");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a suspended team command never forwards the old credential to a replacement service, and stale generation cannot submit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<Reply>();
        let replacement = false;
        const fixture = yield* setup({
          token: () =>
            Effect.succeed({
              status: 200,
              body: replacement
                ? { ...token, access_token: "SECOND_ACCESS", refresh_token: "SECOND_REFRESH" }
                : token,
            }),
          teamCommand: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        });
        yield* fixture.manager.start(service);
        yield* TestClock.adjust("5 seconds");
        yield* waitForSaved(fixture.writes, (saved) => saved.grant !== null);
        const original = yield* fixture.manager.state;
        const pending = yield* fixture.manager
          .teamCommand(original.generation, { action: "invite", email: "new@example.test" })
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(entered);
        yield* fixture.manager.disconnect;
        replacement = true;
        const nextOrigin = "https://replacement.example.test";
        yield* fixture.manager.start(nextOrigin);
        yield* TestClock.adjust("5 seconds");
        yield* waitForSaved(
          fixture.writes,
          (saved) => saved.grant?.accessToken === "SECOND_ACCESS",
        );
        yield* Deferred.succeed(release, { status: 200, body: {} });
        const result = yield* Fiber.join(pending);
        expect(result._tag).toBe("Failure");
        expect(
          fixture.calls
            .filter((call) => call.url.startsWith(nextOrigin))
            .map((call) => call.token)
            .filter(Boolean),
        ).toEqual(["SECOND_ACCESS"]);
        const before = fixture.calls.length;
        expect(
          (yield* Effect.flip(
            fixture.manager.teamCommand(original.generation, {
              action: "removeMember",
              userId: "member",
            }),
          )).reason,
        ).toBe("changed");
        expect(fixture.calls).toHaveLength(before);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("offers a validated host default without connecting until sign-in", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ defaultServiceUrl: `${service}/` });
    const state = yield* fixture.manager.state;
    expect(state.serviceUrl).toBe(service);
    expect(state.account).toBeNull();
    expect(fixture.calls).toEqual([]);
    yield* fixture.manager.start(state.serviceUrl!);
    expect(fixture.calls[0]?.url).toBe(`${service}/api/team/config`);
    expect((yield* fixture.manager.state).flow?.status).toBe("pending");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps saved account binding ahead of a changed host default", () =>
  Effect.gen(function* () {
    const saved = new Map([
      [
        "teams-account-v1",
        new TextEncoder().encode(
          json({
            configuration: config,
            grant: {
              account,
              accessToken: token.access_token,
              refreshToken: token.refresh_token,
              expiresAt: 3600000,
            },
            generation: "saved",
          }),
        ),
      ],
    ]);
    const fixture = yield* setup({ saved, defaultServiceUrl: "https://another.example.test" });
    expect((yield* fixture.manager.state).serviceUrl).toBe(service);
    yield* fixture.manager.refreshState;
    expect(fixture.calls).toContainEqual(
      expect.objectContaining({ url: `${service}/api/team/account`, token: token.access_token }),
    );
    expect(fixture.calls.every((call) => !call.url.includes("another.example.test"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects an unsafe host default without sending network requests or persisting credentials",
  () =>
    Effect.gen(function* () {
      for (const defaultServiceUrl of [
        "http://teams.example.test",
        "https://teams.example.test/path",
        "https://private:secret@teams.example.test",
      ]) {
        const fixture = yield* setup({ defaultServiceUrl });
        const state = yield* fixture.manager.state;
        expect(state.serviceUrl).toBeNull();
        expect(state.message).toContain("configured Teams service URL is invalid");
        expect(fixture.calls).toEqual([]);
        expect(fixture.values.size).toBe(0);
        expect(json(state)).not.toContain("private:secret");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("allows explicit custom sign-in instead of the host default", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ defaultServiceUrl: "https://default.example.test" });
    yield* fixture.manager.start(service);
    expect((yield* fixture.manager.state).serviceUrl).toBe(service);
    expect(fixture.calls[0]?.url).toBe(`${service}/api/team/config`);
    expect(fixture.calls.every((call) => !call.url.includes("default.example.test"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves fresh custom hosts unconfigured when no default is set", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const state = yield* fixture.manager.state;
    expect(state.serviceUrl).toBeNull();
    expect(state.message).toBeNull();
    expect(fixture.calls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

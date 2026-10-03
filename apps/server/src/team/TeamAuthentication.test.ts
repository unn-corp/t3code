import { expect, it } from "@effect/vitest";
import { createClerkClient } from "@clerk/backend";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerRequest } from "effect/unstable/http";
import { makeTeamAuthentication } from "./TeamAuthentication.ts";

const fixtures = vi.hoisted(() => ({
  grant: {} as Record<string, unknown>,
  session: { status: "active", userId: "member" },
  sessionToken: { sub: "member", sid: "session", exp: 1e12, azp: "https://teams.example.test" },
  oauthCalls: 0,
}));
vi.mock("@clerk/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/backend")>();
  return {
    createClerkClient: (options: Parameters<typeof actual.createClerkClient>[0]) => ({
      idPOAuthAccessToken: actual.createClerkClient({ ...options, telemetry: { disabled: true } })
        .idPOAuthAccessToken,
      sessions: { getSession: async () => fixtures.session },
      users: {
        getUser: async () => ({
          firstName: "Trusted",
          lastName: "Name",
          emailAddresses: [
            { emailAddress: "verified@example.test", verification: { status: "verified" } },
            { emailAddress: "unverified@example.test", verification: { status: "unverified" } },
          ],
        }),
      },
    }),
    verifyToken: async (token: string) => {
      if (token !== "session.jwt.fixture") throw new Error("PRIVATE jwt body");
      return fixtures.sessionToken;
    },
  };
});
const origin = "https://teams.example.test";
const now = 1790867221732;
const expirationSeconds = 1790953620;
const auth = () =>
  makeTeamAuthentication({
    secretKey: "sk_test_fixture",
    publishableKey: "pk_test_aXNzdWVyLmV4YW1wbGUudGVzdCQ=",
    origins: [origin],
    oauthClientId: "dedicated-client",
  });
const valid = () => ({
  object: "clerk_idp_oauth_access_token",
  id: "oat_fixture",
  client_id: "dedicated-client",
  subject: "member",
  scopes: ["openid", "profile", "email", "offline_access"],
  revoked: false,
  expired: false,
  expiration: expirationSeconds,
  revocation_reason: null,
  created_at: Math.floor(now / 1000),
  updated_at: Math.floor(now / 1000),
});
const decodeVerifyRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ access_token: Schema.String })),
);
beforeEach(() => {
  fixtures.grant = valid();
  fixtures.oauthCalls = 0;
  vi.stubGlobal("fetch", async (url: string, input: RequestInit) => {
    expect(url).toBe("https://api.clerk.com/oauth_applications/access_tokens/verify");
    expect(input.method).toBe("POST");
    expect(new Headers(input.headers).get("Clerk-API-Version")).toBe("2026-05-12");
    const request = decodeVerifyRequest(String(input.body));
    fixtures.oauthCalls++;
    return request.access_token === "opaque-oauth" || request.access_token === "oauth.jwt.fixture"
      ? Response.json(fixtures.grant)
      : Response.json(
          { errors: [{ code: "token_invalid", message: "PRIVATE verifier body" }] },
          { status: 404 },
        );
  });
});
afterEach(() => vi.unstubAllGlobals());
const request = (token: string, requestOrigin?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`${origin}/api/team/account`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(requestOrigin ? { origin: requestOrigin } : {}),
      },
    }),
  );

it("retains Unix seconds through Clerk's real OAuth resource deserializer", async () => {
  const clerk = createClerkClient({ secretKey: "sk_test_fixture" });
  const grant = await clerk.idPOAuthAccessToken.verify("opaque-oauth");
  expect(grant.clientId).toBe("dedicated-client");
  expect(grant.expiration).toBe(expirationSeconds);
});

it.effect(
  "normalizes actual Clerk SDK OAuth resource seconds into millisecond expiry for opaque and JWT tokens",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      fixtures.grant = valid();
      for (const token of ["opaque-oauth", "oauth.jwt.fixture"]) {
        const principal = yield* auth().authenticate(request(token));
        expect(principal).toEqual({
          userId: "member",
          displayName: "Trusted Name",
          verifiedEmails: ["verified@example.test"],
          expiresAt: expirationSeconds * 1000,
        });
      }
      expect(fixtures.oauthCalls).toBe(2);
      yield* TestClock.setTime(expirationSeconds * 1000);
      for (const token of ["opaque-oauth", "oauth.jwt.fixture"]) {
        expect((yield* auth().authenticate(request(token)).pipe(Effect.flip)).reason).toBe(
          "sign_in_required",
        );
      }
    }),
);

it.effect(
  "rejects wrong clients, missing identity scopes, revoked, expired, and malformed grants",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      for (const invalid of [
        { client_id: "other-client" },
        { scopes: ["openid", "profile"] },
        { revoked: true },
        { expired: true },
        { expiration: 0 },
        { expiration: null },
        { expiration: Number.NaN },
        { expiration: Infinity },
        { expiration: Number.MAX_VALUE },
        { expiration: Number.MAX_SAFE_INTEGER },
        { expiration: expirationSeconds + 0.5 },
        { expiration: String(expirationSeconds) },
        { expiration: Math.floor(now / 1000) },
        { expiration: -1 },
        { subject: "" },
        { subject: " " },
        { subject: "x".repeat(257) },
        { revoked: undefined },
      ]) {
        fixtures.grant = { ...valid(), ...invalid };
        const error = yield* auth().authenticate(request("oauth.jwt.fixture")).pipe(Effect.flip);
        expect(error.reason).toBe("sign_in_required");
      }
    }),
);

it.effect("checks live revocation on each OAuth authentication", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    fixtures.grant = valid();
    fixtures.oauthCalls = 0;
    const authentication = auth();
    yield* authentication.authenticate(request("opaque-oauth"));
    fixtures.grant.revoked = true;
    expect(
      (yield* authentication.authenticate(request("opaque-oauth")).pipe(Effect.flip)).reason,
    ).toBe("sign_in_required");
    expect(fixtures.oauthCalls).toBe(2);
  }),
);

it.effect("retains session JWT active-session, matching-user and authorized-party checks", () =>
  Effect.gen(function* () {
    fixtures.session = { status: "active", userId: "member" };
    fixtures.sessionToken = { sub: "member", sid: "session", exp: 1e12, azp: origin };
    expect(
      (yield* auth().authenticate(request("session.jwt.fixture", origin))).verifiedEmails,
    ).toEqual(["verified@example.test"]);
    for (const session of [
      { status: "revoked", userId: "member" },
      { status: "active", userId: "someone-else" },
    ]) {
      fixtures.session = session;
      expect(
        (yield* auth().authenticate(request("session.jwt.fixture")).pipe(Effect.flip)).reason,
      ).toBe("sign_in_required");
    }
    fixtures.session = { status: "active", userId: "member" };
    fixtures.sessionToken.azp = "https://wrong.example.test";
    expect(
      (yield* auth().authenticate(request("session.jwt.fixture")).pipe(Effect.flip)).reason,
    ).toBe("sign_in_required");
    expect(
      (yield* auth()
        .authenticate(request("opaque-oauth", "https://wrong.example.test"))
        .pipe(Effect.flip)).reason,
    ).toBe("origin_denied");
    expect(
      (yield* auth().authenticate(request("personal-environment-token")).pipe(Effect.flip)).reason,
    ).toBe("sign_in_required");
  }),
);

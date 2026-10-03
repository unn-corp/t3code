import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { executeLocalTeamAccountCommand, requestLocalTeamAccount } from "./localTeamAccount.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("selected-environment"),
  label: "Selected environment",
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: `${target.wsBaseUrl}/ws`,
  httpAuthorization: null,
  target,
};
const state = {
  generation: "fixture",
  serviceUrl: "https://teams.example.test",
  account: null,
  flow: null,
  message: null,
};

const unpreparedSupervisor = Effect.gen(function* () {
  return EnvironmentSupervisor.of({
    target,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      desired: true,
      network: "online" as const,
      phase: "connecting" as const,
      stage: "preparing" as const,
      attempt: 1,
      generation: 1,
      lastFailure: null,
      retryAt: null,
    }),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
});

it.effect("loads account state when initial environment preparation completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const supervisor = yield* unpreparedSupervisor;
      const calls: Array<string> = [];
      const fetchFn: typeof fetch = async (input) => {
        calls.push(String(input));
        return Response.json(state);
      };
      const read = yield* executeLocalTeamAccountCommand({ action: "state" }).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.provide(remoteHttpClientLayer(fetchFn)),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      expect(calls).toEqual([]);
      yield* SubscriptionRef.set(supervisor.prepared, Option.some(prepared));
      expect(yield* Fiber.join(read)).toEqual({ action: "state", state });
      expect(calls).toEqual(["https://remote.example.test/api/teams/account"]);
    }),
  ),
);

it.effect("cancels the passive readiness wait and fails unprepared mutations immediately", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const supervisor = yield* unpreparedSupervisor;
      // Tests cancellation by a component outside the Effect runtime.
      // @effect-diagnostics-next-line abortControllerInEffect:off
      const controller = new AbortController();
      let calls = 0;
      const fetchFn: typeof fetch = async () => {
        calls++;
        return Response.json(state);
      };
      const provide = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          EnvironmentSupervisor | import("effect/unstable/http/HttpClient").HttpClient
        >,
      ) =>
        effect.pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.provide(remoteHttpClientLayer(fetchFn)),
        );
      const read = yield* executeLocalTeamAccountCommand({
        action: "state",
        signal: controller.signal,
      }).pipe(provide, Effect.forkScoped);
      yield* Effect.yieldNow;
      controller.abort();
      expect(Exit.isFailure(yield* Fiber.await(read))).toBe(true);
      for (const command of [
        { action: "start", serviceUrl: "https://teams.example.test" },
        { action: "disconnect" },
        { action: "cancel", flowId: "fixture" },
      ] as const) {
        expect(
          yield* executeLocalTeamAccountCommand(command).pipe(provide, Effect.flip),
        ).toMatchObject({ _tag: "RemoteEnvironmentAuthFetchError" });
      }
      yield* SubscriptionRef.set(supervisor.prepared, Option.some(prepared));
      expect(calls).toBe(0);
    }),
  ),
);

it.effect("bounds the passive readiness wait", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const supervisor = yield* unpreparedSupervisor;
      const read = yield* executeLocalTeamAccountCommand({ action: "state" }).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.provide(remoteHttpClientLayer(async () => Response.json(state))),
        Effect.flip,
        Effect.forkScoped,
      );
      yield* TestClock.adjust("45 seconds");
      expect(yield* Fiber.join(read)).toMatchObject({ _tag: "RemoteEnvironmentAuthFetchError" });
    }),
  ),
);

it.effect("uses the selected environment's cookie or bearer authorization for Teams controls", () =>
  Effect.gen(function* () {
    for (const authorization of [
      null,
      { _tag: "Bearer" as const, token: "personal-environment-credential" },
    ]) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchFn: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Response.json(state);
      };
      const result = yield* requestLocalTeamAccount({
        prepared: { ...prepared, httpAuthorization: authorization },
        signer: Option.none(),
        command: { action: "start", serviceUrl: "https://teams.example.test" },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
      expect(result).toEqual({ action: "state", state });
      expect(calls[0]?.url).toBe("https://remote.example.test/api/teams/account/start");
      expect(calls[0]?.init.method).toBe("POST");
      const headers = new Headers(calls[0]?.init.headers);
      expect(headers.get("authorization")).toBe(
        authorization ? "Bearer personal-environment-credential" : null,
      );
      if (!authorization) expect(calls[0]?.init.credentials).toBe("include");
      expect(String(calls[0]?.init.body)).not.toContain("private-teams-token");
    }
  }),
);

it.effect(
  "renews relay personal auth once and binds the mutation proof to the selected request",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; headers: Headers }> = [];
      const proofs: Array<Parameters<ManagedRelayDpopSigner["Service"]["createProof"]>[0]> = [];
      const authorizations: Array<string | undefined> = [];
      const remote = RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("unexpected bearer"),
        authorizeDpop: () => Effect.die("unexpected socket"),
        authorizeDpopHttp: (input) =>
          Effect.sync(() => {
            expect(input.expectedEnvironmentId).toBe(target.environmentId);
            authorizations.push(input.rejectedAccessToken);
            return {
              environmentId: target.environmentId,
              label: "Remote",
              httpBaseUrl: "https://relay.example.test",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: input.rejectedAccessToken
                  ? "new-personal-token"
                  : "old-personal-token",
                expiresAtEpochMs: 1e12,
              },
            };
          }),
      });
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("fixture"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "proof";
          }),
      });
      const fetchFn: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return calls.length === 1
          ? Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "fixture",
              },
              { status: 401 },
            )
          : Response.json({ generation: "fixture", result: {} });
      };
      const result = yield* requestLocalTeamAccount({
        prepared: {
          ...prepared,
          httpAuthorization: {
            _tag: "Dpop",
            accessToken: "cached-personal-token",
            expiresAtEpochMs: 1e12,
          },
        },
        signer: Option.some(signer),
        remoteAuthorization: Option.some(remote),
        command: {
          action: "teamCommand",
          generation: "fixture",
          command: { action: "invite", email: "fixture@example.test" },
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
      expect(result).toEqual({ action: "teamCommand", generation: "fixture", result: {} });
      expect(authorizations).toEqual([undefined, "old-personal-token"]);
      expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
        "DPoP old-personal-token",
        "DPoP new-personal-token",
      ]);
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://relay.example.test/api/teams/team-command",
          accessToken: "old-personal-token",
        },
        {
          method: "POST",
          url: "https://relay.example.test/api/teams/team-command",
          accessToken: "new-personal-token",
        },
      ]);
    }),
);

it.effect(
  "loads the team roster from the selected environment and submits the loaded generation",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const directory = {
        role: "member",
        canCreateProjects: true,
        canInviteMembers: false,
        members: [],
        invites: [],
      };
      const fetchFn: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Response.json(
          calls.length === 1
            ? { generation: "loaded-generation", directory }
            : { generation: "loaded-generation", result: {} },
        );
      };
      const run = (command: Parameters<typeof requestLocalTeamAccount>[0]["command"]) =>
        requestLocalTeamAccount({
          prepared: { ...prepared, httpAuthorization: { _tag: "Bearer", token: "personal-token" } },
          signer: Option.none(),
          command,
        }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
      expect(yield* run({ action: "teamDirectory" })).toEqual({
        action: "teamDirectory",
        generation: "loaded-generation",
        directory,
      });
      expect(
        yield* run({
          action: "teamCommand",
          generation: "loaded-generation",
          command: { action: "accept", token: "a".repeat(64) },
        }),
      ).toEqual({ action: "teamCommand", generation: "loaded-generation", result: {} });
      expect(calls.map((call) => [call.url, call.init.method])).toEqual([
        ["https://remote.example.test/api/teams/team-directory", "GET"],
        ["https://remote.example.test/api/teams/team-command", "POST"],
      ]);
      expect(yield* Effect.promise(() => new Response(calls[1]?.init.body).json())).toEqual({
        generation: "loaded-generation",
        command: { action: "accept", token: "a".repeat(64) },
      });
      for (const call of calls)
        expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer personal-token");
    }),
);

it.effect("preserves a stale roster generation rejection without retrying the mutation", () =>
  Effect.gen(function* () {
    let calls = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      calls++;
      expect(await new Response(init?.body).json()).toMatchObject({
        generation: "stale-generation",
      });
      return Response.json(
        {
          _tag: "EnvironmentHttpBadRequestError",
          message: "Teams account changed. Reload team access.",
        },
        { status: 400 },
      );
    };
    const failure = yield* requestLocalTeamAccount({
      prepared,
      signer: Option.none(),
      command: {
        action: "teamCommand",
        generation: "stale-generation",
        command: { action: "removeMember", userId: "fixture" },
      },
    }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)), Effect.flip);
    expect(failure).toMatchObject({
      _tag: "RemoteEnvironmentAuthFetchError",
      cause: {
        _tag: "EnvironmentHttpBadRequestError",
        message: "Teams account changed. Reload team access.",
      },
    });
    expect(calls).toBe(1);
  }),
);

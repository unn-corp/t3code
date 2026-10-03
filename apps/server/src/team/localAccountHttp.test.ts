import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthAdministrativeScopes, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { HttpRouter } from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import { LocalTeamAccount } from "./LocalTeamAccount.ts";
import { localTeamAccountHttpApiLayer } from "./localAccountHttp.ts";

class TeamsTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.teams) {}
const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest("/workspace", { prefix: "t3-local-team-auth-" })),
);

it.live("personal auth protects Teams controls and only administrators can mutate them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const standard = yield* auth.issueSession({ scopes: ["orchestration:read"] });
      const admin = yield* auth.issueSession({ scopes: AuthAdministrativeScopes });
      let mutations = 0;
      const state = {
        generation: "fixture",
        serviceUrl: null,
        account: null,
        flow: null,
        message: null,
      };
      const operation = Effect.sync(() => {
        mutations++;
        return state;
      });
      const account: LocalTeamAccount["Service"] = {
        state: Effect.succeed(state),
        refreshState: Effect.succeed(state),
        teamDirectory: Effect.succeed({
          generation: "fixture",
          directory: {
            role: null,
            canCreateProjects: false,
            canInviteMembers: false,
            members: [],
            invites: [],
          },
        }),
        teamCommand: () => operation.pipe(Effect.as({ generation: "fixture", result: {} })),
        start: () => operation,
        cancel: () => operation,
        projects: Effect.succeed({ generation: "fixture", spaces: [] }),
        disconnect: operation.pipe(
          Effect.map((state) => ({ state, remoteRevocationConfirmed: true })),
        ),
        identityChanges: Stream.empty,
        withCredential: (operation) =>
          operation({
            serviceUrl: "https://teams.example.test",
            issuer: "https://issuer.example.test",
            clientId: "fixture",
            subject: "fixture",
            generation: "fixture",
            accessToken: "private",
          }),
      };
      const routes = HttpApiBuilder.layer(TeamsTestApi).pipe(
        Layer.provide(localTeamAccountHttpApiLayer),
        Layer.provide(environmentAuthenticatedAuthLayer),
        Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
        Layer.provide(Layer.succeed(LocalTeamAccount, account)),
        Layer.provide(NodeHttpPlatform.layer),
        Layer.provide(Etag.layer),
        Layer.provide(NodeServices.layer),
      );
      const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      const request = (path: string, token?: string, body?: unknown) =>
        Effect.promise(() =>
          app.handler(
            new Request(`http://localhost${path}`, {
              method: body === undefined ? "GET" : "POST",
              headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          ),
        );
      expect((yield* request("/api/teams/account")).status).toBe(401);
      expect((yield* request("/api/teams/account", "clerk-oauth-token")).status).toBe(401);
      expect((yield* request("/api/teams/account", standard.token)).status).toBe(200);
      expect((yield* request("/api/teams/projects", standard.token)).status).toBe(200);
      for (const [path, body] of [
        ["start", { serviceUrl: "https://teams.example.test" }],
        ["cancel", { flowId: "fixture" }],
        ["disconnect", {}],
      ] as const) {
        expect((yield* request(`/api/teams/account/${path}`, undefined, body)).status).toBe(401);
        expect((yield* request(`/api/teams/account/${path}`, standard.token, body)).status).toBe(
          403,
        );
        expect(
          (yield* request(`/api/teams/account/${path}`, "clerk-oauth-token", body)).status,
        ).toBe(401);
        expect(mutations).toBe(0);
      }
      expect(
        (yield* request("/api/teams/account/start", admin.token, {
          serviceUrl: "https://teams.example.test",
        })).status,
      ).toBe(200);
      expect(mutations).toBe(1);
      expect(
        (yield* request("/api/teams/team-command", admin.token, {
          action: "removeMember",
          userId: "member",
        })).status,
      ).toBe(400);
      expect(mutations).toBe(1);
      expect(
        (yield* request("/api/teams/team-command", standard.token, {
          generation: "fixture",
          command: { action: "removeMember", userId: "member" },
        })).status,
      ).toBe(403);
      expect(
        (yield* request("/api/teams/team-command", admin.token, {
          generation: "fixture",
          command: { action: "removeMember", userId: "member" },
        })).status,
      ).toBe(200);
      expect(mutations).toBe(2);
    }),
  ).pipe(Effect.provide(authLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

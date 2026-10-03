import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProviderDriverKind } from "@t3tools/contracts";
import { TeamCommandResult, TeamCommand, TeamRosterCommand } from "@t3tools/contracts/teamSpaces";
import { HttpRouter } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { teamSpacesRouteLayer } from "./http.ts";

const clerk = vi.hoisted(() => ({
  active: true,
  verified: true,
  subject: "member",
  sent: [] as string[],
}));
const encodeRosterBody = Schema.encodeSync(Schema.fromJsonString(TeamRosterCommand));
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(TeamCommand));
const decodeResult = Schema.decodeUnknownEffect(TeamCommandResult);
const ticketShape = Schema.Struct({ ticket: Schema.String });
const decodeGrant = Schema.decodeUnknownEffect(ticketShape);
const encodeTicketBody = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ spaceId: Schema.String })),
);
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    idPOAuthAccessToken: {
      verify: async () => {
        throw new Error("not an OAuth fixture");
      },
    },
    invitations: {
      createInvitation: async (input: { emailAddress: string }) => {
        clerk.sent.push(input.emailAddress);
        return { id: "clerk-invite" };
      },
      getInvitationList: async () => ({ data: [], totalCount: 0 }),
    },
    sessions: {
      getSession: async () => ({
        status: clerk.active ? "active" : "revoked",
        userId: clerk.subject,
      }),
    },
    users: {
      getUser: async () => ({
        emailAddresses: [
          {
            emailAddress: `${clerk.subject}@example.com`,
            verification: { status: clerk.verified ? "verified" : "unverified" },
          },
        ],
      }),
    },
  }),
  verifyToken: async (token: string) => {
    if (token !== "clerk-fixture") throw new Error("invalid token");
    return {
      sub: clerk.subject,
      sid: "session-fixture",
      exp: 1e12,
      azp: "https://team.example.test",
    };
  },
}));
const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    T3_TEAM_CLERK_SECRET_KEY: "fixture-not-a-secret",
    T3_TEAM_CLERK_PUBLISHABLE_KEY: "pk_test_fixture",
    T3_TEAM_ORIGINS: "https://team.example.test",
    T3_TEAM_CREATORS: "member",
    T3_TEAM_OAUTH_ISSUER: "https://issuer.example.test",
    T3_TEAM_OAUTH_CLIENT_ID: "public-client",
  }),
);
const routes = teamSpacesRouteLayer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest("/workspace", { prefix: "t3-team-http-" })),
  Layer.provide(NodeServices.layer),
  Layer.provide(config),
);

it.effect(
  "team HTTP requires active Clerk authentication and does not accept environment credentials",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        clerk.active = true;
        const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
        yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
        const request = (token: string, origin = "https://team.example.test") =>
          Effect.promise(() =>
            app.handler(
              new Request("https://team.example.test/api/team/spaces", {
                headers: { authorization: `Bearer ${token}`, origin },
              }),
            ),
          );
        expect((yield* request("personal-environment-token")).status).toBe(403);
        expect((yield* request("clerk-fixture", "https://evil.example.test")).status).toBe(403);
        expect((yield* request("clerk-fixture")).status).toBe(200);
        clerk.active = false;
        expect((yield* request("clerk-fixture")).status).toBe(403);
      }),
    ),
);

it.effect(
  "team API creates an owner project and rejects missing, revoked, and replayed websocket tickets",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        clerk.active = true;
        const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
        yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
        const create = yield* Effect.promise(() =>
          app.handler(
            new Request("https://team.example.test/api/team/command", {
              method: "POST",
              headers: {
                authorization: "Bearer clerk-fixture",
                origin: "https://team.example.test",
                "content-type": "application/json",
              },
              body: '{"action":"create","name":"Local test"}',
            }),
          ),
        );
        expect(create.status).toBe(200);
        const space = yield* Effect.promise(() => create.json()).pipe(Effect.flatMap(decodeResult));
        const ticketResponse = yield* Effect.promise(() =>
          app.handler(
            new Request("https://team.example.test/api/team/ticket", {
              method: "POST",
              headers: {
                authorization: "Bearer clerk-fixture",
                origin: "https://team.example.test",
                "content-type": "application/json",
              },
              body: encodeTicketBody({ spaceId: space.spaceId }),
            }),
          ),
        );
        expect(ticketResponse.status).toBe(200);
        const grant = yield* Effect.promise(() => ticketResponse.json()).pipe(
          Effect.flatMap(decodeGrant),
        );
        const redeem = () =>
          Effect.promise(() =>
            app.handler(
              new Request(`https://team.example.test/api/team/ws?ticket=${grant.ticket}`, {
                headers: { origin: "https://team.example.test" },
              }),
            ),
          );
        clerk.active = false;
        expect((yield* redeem()).status).toBe(403);
        clerk.active = true;
        expect((yield* redeem()).status).toBe(403);
        const denied = yield* Effect.promise(() =>
          app.handler(
            new Request("https://team.example.test/api/team/ws?ticket=missing", {
              headers: { origin: "https://team.example.test" },
            }),
          ),
        );
        expect(denied.status).toBe(403);
      }),
    ),
);

it.effect(
  "legacy cloud agent operations fail closed while project activity and native snapshots remain available",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        clerk.active = true;
        const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
        yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
        const send = Effect.fn(function* (input: TeamCommand) {
          const body = yield* encodeCommand(input);
          return yield* Effect.promise(() =>
            app.handler(
              new Request("https://team.example.test/api/team/command", {
                method: "POST",
                headers: {
                  authorization: "Bearer clerk-fixture",
                  origin: "https://team.example.test",
                  "content-type": "application/json",
                },
                body,
              }),
            ),
          );
        });
        const get = (path: string, token = "clerk-fixture") =>
          Effect.promise(() =>
            app.handler(
              new Request(`https://team.example.test${path}`, {
                headers: { authorization: `Bearer ${token}`, origin: "https://team.example.test" },
              }),
            ),
          );
        const created = yield* send({ action: "create", name: "Local providers" });
        const { spaceId } = yield* Effect.promise(() => created.json()).pipe(
          Effect.flatMap(decodeResult),
        );
        for (const command of [
          {
            action: "run",
            spaceId,
            provider: ProviderDriverKind.make("codex"),
            prompt: "Never execute",
          },
          { action: "loginProvider", spaceId, provider: ProviderDriverKind.make("codex") },
          { action: "logoutProvider", spaceId, provider: ProviderDriverKind.make("codex") },
          { action: "stopRun", spaceId, runId: "a".repeat(32) },
        ] as const) {
          const response = yield* send(command);
          expect(response.status).toBe(403);
          expect(yield* Effect.promise(() => response.json())).toEqual({
            error: "agents_run_locally",
          });
        }
        const status = yield* get(`/api/team/provider-status?spaceId=${spaceId}&provider=codex`);
        expect(status.status).toBe(403);
        expect(yield* Effect.promise(() => status.json())).toEqual({ error: "agents_run_locally" });
        expect(
          (yield* send({ action: "message", spaceId, text: "Still collaborating" })).status,
        ).toBe(200);
        const snapshot = yield* get(`/api/team/projects/${spaceId}/native/shell-snapshot`);
        expect(snapshot.status).toBe(200);
        expect(snapshot.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => snapshot.json())).toMatchObject({
          projects: [{ id: spaceId, workspaceRoot: "/workspace" }],
        });
        expect(
          (yield* get(`/api/team/projects/${spaceId}/native/shell-snapshot`, "personal-token"))
            .status,
        ).toBe(403);
        expect(
          (yield* get(`/api/team/projects/${"0".repeat(32)}/native/shell-snapshot`)).status,
        ).toBe(403);
        expect(
          (yield* get(`/api/team/projects/${spaceId}/native/threads/missing/snapshot`)).status,
        ).toBe(403);
        const configResponse = yield* get("/api/team/config");
        expect(yield* Effect.promise(() => configResponse.json())).toMatchObject({
          agentExecution: "local",
          oauth: { issuer: "https://issuer.example.test", clientId: "public-client" },
        });
        const accountResponse = yield* get("/api/team/account");
        expect(accountResponse.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => accountResponse.json())).toEqual({
          subject: "member",
          displayName: "member",
          canCreateProjects: true,
          teamRole: "owner",
          canInviteMembers: true,
        });
        const legacySnapshot = yield* get(`/api/team/snapshot?spaceId=${spaceId}`);
        expect(yield* Effect.promise(() => legacySnapshot.json())).toMatchObject({ runs: [] });
        const issue = (path: string) =>
          Effect.promise(() =>
            app.handler(
              new Request(`https://team.example.test${path}`, {
                method: "POST",
                headers: {
                  authorization: "Bearer clerk-fixture",
                  origin: "https://team.example.test",
                  "content-type": "application/json",
                },
                body: encodeTicketBody({ spaceId }),
              }),
            ),
          );
        const nativeTicketResponse = yield* issue("/api/team/native/ticket");
        const nativeGrant = yield* Effect.promise(() => nativeTicketResponse.json()).pipe(
          Effect.flatMap(decodeGrant),
        );
        const legacyTicketResponse = yield* issue("/api/team/ticket");
        const legacyGrant = yield* Effect.promise(() => legacyTicketResponse.json()).pipe(
          Effect.flatMap(decodeGrant),
        );
        expect((yield* get(`/api/team/ws?ticket=${nativeGrant.ticket}`)).status).toBe(403);
        expect(
          (yield* get(`/api/team/projects/${spaceId}/native/ws?ticket=${legacyGrant.ticket}`))
            .status,
        ).toBe(403);
        expect((yield* get(`/ws?ticket=${nativeGrant.ticket}`)).status).toBe(404);
      }),
    ),
);

it.effect("T3 sends owner invitations and admits the verified recipient without a code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      clerk.active = true;
      clerk.verified = true;
      clerk.subject = "member";
      clerk.sent = [];
      const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          clerk.subject = "member";
          await app.dispose();
        }),
      );
      const request = (
        path: string,
        body?: typeof TeamRosterCommand.Type,
        token = "clerk-fixture",
      ) =>
        Effect.promise(() =>
          app.handler(
            new Request(`https://team.example.test/api/team/${path}`, {
              method: body ? "POST" : "GET",
              headers: {
                authorization: `Bearer ${token}`,
                origin: "https://team.example.test",
                "content-type": "application/json",
              },
              ...(body ? { body: encodeRosterBody(body) } : {}),
            }),
          ),
        );
      expect(
        (yield* request(
          "team-command",
          { action: "invite", email: "guest@example.com" },
          "bad-token",
        )).status,
      ).toBe(403);
      clerk.subject = "stranger";
      expect(
        (yield* request("team-command", { action: "invite", email: "guest@example.com" })).status,
      ).toBe(403);
      expect(clerk.sent).toEqual([]);
      clerk.subject = "member";
      const response = yield* request("team-command", {
        action: "invite",
        email: "guest@example.com",
      });
      expect(response.status).toBe(200);
      const result = yield* Effect.promise(() => response.json());
      expect(result).not.toHaveProperty("token");
      expect(clerk.sent).toEqual(["guest@example.com"]);
      clerk.subject = "guest";
      const account = yield* request("account");
      expect(yield* Effect.promise(() => account.json())).toMatchObject({
        teamRole: "member",
        canInviteMembers: false,
      });
      expect(
        (yield* request("team-command", { action: "invite", email: "outsider@example.com" }))
          .status,
      ).toBe(403);
      const projects = yield* request("spaces");
      expect(yield* Effect.promise(() => projects.json())).toEqual({ spaces: [] });
    }),
  ),
);

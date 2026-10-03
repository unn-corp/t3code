import { TeamRosterCommand, TeamCommand, type TeamIdentity } from "@t3tools/contracts/teamSpaces";
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { TeamDenied, TeamSpaces } from "./TeamSpaces.ts";
import { makeTeamInvitationDelivery } from "./TeamInvitationDelivery.ts";
import { makeTeamAuthentication } from "./TeamAuthentication.ts";
import { teamNativeRoutes } from "./nativeHttp.ts";
import { TeamNativeProjects } from "./TeamNativeProjects.ts";

const decodeRosterCommand = Schema.decodeEffect(Schema.fromJsonString(TeamRosterCommand));
const decodeCommand = Schema.decodeEffect(Schema.fromJsonString(TeamCommand));
const decodeTicketRequest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ spaceId: Schema.String })),
);
const encodeChange = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("changed"), spaceId: Schema.String })),
);

/** Separate from environment pairing: these credentials never grant host RPC access. */
export const teamSpacesRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const secret = yield* Config.redacted("T3_TEAM_CLERK_SECRET_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const secretKey = Redacted.value(secret);
    const publishableKey = yield* Config.string("T3_TEAM_CLERK_PUBLISHABLE_KEY").pipe(
      Config.withDefault(""),
    );
    const origins = (yield* Config.string("T3_TEAM_ORIGINS").pipe(Config.withDefault("")))
      .split(",")
      .filter(Boolean);
    const oauthClientId = yield* Config.string("T3_TEAM_OAUTH_CLIENT_ID").pipe(
      Config.withDefault(""),
    );
    const oauthIssuer = yield* Config.string("T3_TEAM_OAUTH_ISSUER").pipe(Config.withDefault(""));
    const creators = new Set(
      (yield* Config.string("T3_TEAM_CREATORS").pipe(Config.withDefault("")))
        .split(",")
        .filter(Boolean),
    );
    if (!secretKey || !publishableKey || origins.length === 0) {
      return HttpRouter.add("GET", "/api/team/config", HttpServerResponse.json({ enabled: false }));
    }
    return Layer.unwrap(
      Effect.gen(function* () {
        const spaces = yield* TeamSpaces;
        yield* spaces.bootstrapOwners([...creators]);
        const changes = yield* PubSub.sliding<string>(128);
        const tickets = new Map<
          string,
          { authorization: string; identity: TeamIdentity; spaceId: string; expiresAt: number }
        >();
        const authentication = makeTeamAuthentication({
          secretKey,
          publishableKey,
          origins,
          ...(oauthClientId ? { oauthClientId } : {}),
        });
        const delivery = makeTeamInvitationDelivery(secretKey);
        const authenticate = authentication.authenticate;
        const safe = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
          effect.pipe(
            Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(16384)),
            Effect.catch((error) =>
              HttpServerResponse.json(
                { error: error instanceof TeamDenied ? error.reason : "team_request_failed" },
                {
                  status:
                    error instanceof TeamDenied ? 403 : Schema.isSchemaError(error) ? 400 : 500,
                },
              ),
            ),
          );
        const json = (value: unknown) =>
          HttpServerResponse.json(value, { headers: { "cache-control": "no-store" } });
        const list = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const identity = yield* authenticate(request);
          return yield* json({ spaces: yield* spaces.list(identity.userId) });
        });
        const command = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const identity = yield* authenticate(request);
          const body = yield* request.text;
          if (body.length > 16384) return HttpServerResponse.empty({ status: 413 });
          const input = yield* decodeCommand(body);
          const result = yield* spaces.execute(identity, input, creators.has(identity.userId));
          yield* PubSub.publish(changes, result.spaceId);
          return yield* json(result);
        });
        const snapshot = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const identity = yield* authenticate(request);
          const url = new URL(request.url, "http://team.invalid");
          const spaceId = url.searchParams.get("spaceId") ?? "";
          const after = Number(url.searchParams.get("after") ?? "0");
          if (!/^[a-f0-9]{32}$/.test(spaceId) || !Number.isSafeInteger(after) || after < 0)
            return HttpServerResponse.empty({ status: 400 });
          return yield* json(yield* spaces.snapshot(identity.userId, spaceId, after));
        });
        const ticket = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const identity = yield* authenticate(request);
          const body = yield* request.text;
          if (body.length > 1024) return HttpServerResponse.empty({ status: 413 });
          const input = yield* decodeTicketRequest(body);
          yield* spaces.requireRole(identity.userId, input.spaceId);
          const now = yield* Clock.currentTimeMillis;
          for (const [key, value] of tickets) if (value.expiresAt <= now) tickets.delete(key);
          if (tickets.size >= 1000) return HttpServerResponse.empty({ status: 429 });
          const value = NodeCrypto.randomBytes(32).toString("hex");
          tickets.set(value, {
            authorization: request.headers.authorization!,
            identity,
            spaceId: input.spaceId,
            expiresAt: Math.min(now + 30000, identity.expiresAt),
          });
          return yield* json({ ticket: value });
        });
        const websocket = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!request.headers.origin || !origins.includes(request.headers.origin))
            return yield* new TeamDenied({ reason: "origin_denied" });
          const value =
            new URL(request.url, "http://team.invalid").searchParams.get("ticket") ?? "";
          const grant = tickets.get(value);
          tickets.delete(value);
          const now = yield* Clock.currentTimeMillis;
          if (!grant || grant.expiresAt <= now)
            return yield* new TeamDenied({ reason: "ticket_invalid" });
          yield* authenticate(
            request.modify({ headers: { ...request.headers, authorization: grant.authorization } }),
          );
          yield* spaces.requireRole(grant.identity.userId, grant.spaceId);
          const socket = yield* request.upgrade;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const write = yield* socket.writer;
              const emit = Effect.gen(function* () {
                yield* authenticate(
                  request.modify({
                    headers: { ...request.headers, authorization: grant.authorization },
                  }),
                );
                yield* spaces.requireRole(grant.identity.userId, grant.spaceId);
                const data = yield* encodeChange({ type: "changed", spaceId: grant.spaceId });
                yield* write(data);
              });
              // Subscribe before the initial notification so writes cannot fall in a snapshot gap.
              const subscription = yield* PubSub.subscribe(changes);
              const events = Stream.fromSubscription(subscription).pipe(
                Stream.filter((id) => id === grant.spaceId),
              );
              const accessSubscription = yield* PubSub.subscribe(spaces.accessChanges);
              const accessEvents = Stream.fromSubscription(accessSubscription).pipe(
                Stream.filter(
                  (change) =>
                    change.spaceId === grant.spaceId && change.userId === grant.identity.userId,
                ),
                Stream.map(() => grant.spaceId),
              );
              const checks = Stream.merge(
                Stream.tick("15 seconds").pipe(Stream.map(() => grant.spaceId)),
                accessEvents,
              );
              const output = Effect.gen(function* () {
                yield* emit;
                yield* Stream.runForEach(Stream.merge(events, checks), () => emit);
              });
              const expiry = Effect.gen(function* () {
                yield* Effect.sleep(Math.max(0, grant.identity.expiresAt - now));
                yield* write(new Socket.CloseEvent(1008, "session_expired"));
              });
              yield* Effect.raceFirst(
                Effect.raceFirst(output, expiry),
                socket.runRaw(() => Effect.void),
              ).pipe(
                Effect.catch(() => write(new Socket.CloseEvent(1008, "project_access_denied"))),
              );
            }),
          );
          return HttpServerResponse.empty();
        });
        return Layer.mergeAll(
          teamNativeRoutes(authentication),
          HttpRouter.add(
            "GET",
            "/api/team/config",
            json({
              enabled: true,
              publishableKey,
              agentExecution: "local",
              ...(oauthClientId && oauthIssuer
                ? { oauth: { issuer: oauthIssuer, clientId: oauthClientId } }
                : {}),
            }),
          ),
          HttpRouter.add(
            "GET",
            "/api/team/account",
            safe(
              Effect.gen(function* () {
                const identity = yield* authenticate(yield* HttpServerRequest.HttpServerRequest);
                yield* spaces.acceptEmailInvitation(identity);
                return yield* json({
                  subject: identity.userId,
                  displayName: identity.displayName,
                  canCreateProjects: (yield* spaces.rosterRole(identity.userId)) !== null,
                  teamRole: yield* spaces.rosterRole(identity.userId),
                  canInviteMembers: (yield* spaces.rosterRole(identity.userId)) === "owner",
                });
              }),
            ),
          ),
          HttpRouter.add(
            "GET",
            "/api/team/team-directory",
            safe(
              Effect.gen(function* () {
                const identity = yield* authenticate(yield* HttpServerRequest.HttpServerRequest);
                yield* spaces.acceptEmailInvitation(identity);
                const directory = yield* spaces.directory(identity.userId);
                const members = yield* Effect.forEach(
                  directory.members,
                  (member) =>
                    authentication
                      .resolveUser(member.userId)
                      .pipe(Effect.map((user) => ({ user, role: member.role }))),
                  { concurrency: 4 },
                );
                const current = yield* spaces.directory(identity.userId);
                if (
                  current.role !== directory.role ||
                  current.members.map((member) => `${member.userId}:${member.role}`).join() !==
                    directory.members.map((member) => `${member.userId}:${member.role}`).join()
                )
                  return yield* new TeamDenied({ reason: "team_access_denied" });
                return yield* json({ ...current, members });
              }),
            ),
          ),
          HttpRouter.add(
            "POST",
            "/api/team/team-command",
            safe(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const identity = yield* authenticate(request);
                const body = yield* request.text;
                if (body.length > 16384) return HttpServerResponse.empty({ status: 413 });
                const input = yield* decodeRosterCommand(body);
                return yield* json(yield* spaces.emailRosterCommand(identity, input, delivery));
              }),
            ),
          ),
          HttpRouter.add("GET", "/api/team/spaces", safe(list)),
          HttpRouter.add("GET", "/api/team/snapshot", safe(snapshot)),
          HttpRouter.add(
            "GET",
            "/api/team/provider-status",
            safe(
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const identity = yield* authenticate(request);
                const spaceId =
                  new URL(request.url, "http://team.invalid").searchParams.get("spaceId") ?? "";
                yield* spaces.requireRole(identity.userId, spaceId);
                return yield* new TeamDenied({ reason: "agents_run_locally" });
              }),
            ),
          ),
          HttpRouter.add("POST", "/api/team/command", safe(command)),
          HttpRouter.add("POST", "/api/team/ticket", safe(ticket)),
          HttpRouter.add("GET", "/api/team/ws", safe(websocket)),
        );
      }),
    ).pipe(Layer.provide(TeamNativeProjects.layer), Layer.provide(TeamSpaces.layer));
  }),
);

import { createClerkClient, verifyToken } from "@clerk/backend";
import type { CollaborationUser } from "@t3tools/contracts";
import type { TeamIdentity } from "@t3tools/contracts/teamSpaces";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { HttpServerRequest } from "effect/unstable/http";
import { TeamDenied } from "./TeamSpaces.ts";

const decodeOAuthGrant = Schema.decodeUnknownEffect(
  Schema.Struct({
    clientId: Schema.String,
    subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    scopes: Schema.Array(Schema.String),
    revoked: Schema.Literal(false),
    expired: Schema.Literal(false),
    expiration: Schema.Finite,
  }),
);

export interface TeamPrincipal extends TeamIdentity {
  readonly displayName: string;
}

export interface TeamAuthentication {
  readonly origins: ReadonlyArray<string>;
  readonly authenticate: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<TeamPrincipal, TeamDenied>;
  readonly resolveUser: (subject: string) => Effect.Effect<CollaborationUser>;
}

/** Clerk identity is separate from personal-environment pairing and provider accounts. */
export function makeTeamAuthentication(config: {
  secretKey: string;
  publishableKey: string;
  origins: ReadonlyArray<string>;
  oauthClientId?: string;
}): TeamAuthentication {
  const { secretKey, publishableKey, origins } = config;
  const clerk = createClerkClient({ secretKey, publishableKey });
  const profile = Effect.fn("TeamAuthentication.profile")(function* (subject: string) {
    const user = yield* Effect.tryPromise({
      try: () => clerk.users.getUser(subject),
      catch: () => new TeamDenied({ reason: "sign_in_required" }),
    });
    const displayName =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user.username?.trim() ||
      subject;
    return { user, displayName: displayName.slice(0, 200) };
  });
  const resolveUser = (subject: string): Effect.Effect<CollaborationUser> =>
    profile(subject).pipe(
      Effect.map(({ displayName }) => ({ subject, displayName })),
      Effect.orElseSucceed(() => ({ subject, displayName: subject.slice(0, 200) })),
    );
  const authenticate = Effect.fn("TeamAuthentication.authenticate")(
    function* (request: HttpServerRequest.HttpServerRequest) {
      if (request.headers.origin && !origins.includes(request.headers.origin))
        return yield* new TeamDenied({ reason: "origin_denied" });
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ") || authorization.length > 8192)
        return yield* new TeamDenied({ reason: "sign_in_required" });
      const raw = authorization.slice(7);
      // Clerk accepts JWT and opaque OAuth tokens. Verify the OAuth resource first,
      // then use the session verifier only when it was not an OAuth resource.
      const oauth = config.oauthClientId
        ? yield* Effect.tryPromise({
            try: () => clerk.idPOAuthAccessToken.verify(raw),
            catch: () => new TeamDenied({ reason: "sign_in_required" }),
          }).pipe(Effect.option)
        : Option.none();
      const now = yield* Clock.currentTimeMillis;
      let subject: string;
      let expiresAt: number;
      if (Option.isSome(oauth)) {
        const grant = yield* decodeOAuthGrant(oauth.value).pipe(
          Effect.mapError(() => new TeamDenied({ reason: "sign_in_required" })),
        );
        // Clerk BAPI returns Unix seconds. Backend SDK 3.14.0 passes them through
        // despite declaring this resource field as milliseconds.
        const expirationMillis = grant.expiration * 1000;
        if (
          !Number.isSafeInteger(grant.expiration) ||
          !Number.isSafeInteger(expirationMillis) ||
          expirationMillis <= now ||
          !grant.subject.trim() ||
          grant.clientId !== config.oauthClientId ||
          !["openid", "profile", "email"].every((scope) => grant.scopes.includes(scope))
        )
          return yield* new TeamDenied({ reason: "sign_in_required" });
        subject = grant.subject;
        expiresAt = expirationMillis;
      } else {
        const token = yield* Effect.tryPromise({
          try: () => verifyToken(raw, { secretKey, authorizedParties: [...origins] }),
          catch: () => new TeamDenied({ reason: "sign_in_required" }),
        });
        if (
          !token.sub?.trim() ||
          token.sub.length > 256 ||
          !token.sid ||
          !Number.isFinite(token.exp) ||
          token.exp * 1000 <= now ||
          !token.azp ||
          !origins.includes(token.azp)
        )
          return yield* new TeamDenied({ reason: "sign_in_required" });
        const session = yield* Effect.tryPromise({
          try: () => clerk.sessions.getSession(token.sid),
          catch: () => new TeamDenied({ reason: "sign_in_required" }),
        });
        if (session.status !== "active" || session.userId !== token.sub)
          return yield* new TeamDenied({ reason: "sign_in_required" });
        subject = token.sub;
        expiresAt = token.exp * 1000;
      }
      const { user, displayName } = yield* profile(subject);
      if (expiresAt <= (yield* Clock.currentTimeMillis))
        return yield* new TeamDenied({ reason: "sign_in_required" });
      return {
        userId: subject,
        displayName,
        verifiedEmails: user.emailAddresses
          .filter((email) => email.verification?.status === "verified")
          .map((email) => email.emailAddress),
        expiresAt,
      } satisfies TeamPrincipal;
    },
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new TeamDenied({ reason: "sign_in_required" })),
    }),
  );
  return { origins, authenticate, resolveUser };
}

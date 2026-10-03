import { OrganizationError, type ServerAuthSessionMethod } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

interface GovernanceSession {
  readonly method: ServerAuthSessionMethod;
  readonly subject: string;
}

export const isInteractiveOrganizationSession = (session: GovernanceSession): boolean =>
  session.method === "browser-session-cookie" ||
  (session.method === "bearer-access-token" && session.subject === "desktop-bootstrap");

/** Client tool tokens carry operate scope, but cannot perform interactive governance changes. */
export const requireInteractiveOrganizationSession = <A, E, R>(
  session: GovernanceSession,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OrganizationError, R> =>
  isInteractiveOrganizationSession(session)
    ? effect
    : Effect.fail(
        new OrganizationError({
          code: "forbidden",
          message:
            "Organization changes require an interactive browser or trusted desktop session.",
        }),
      );

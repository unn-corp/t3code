import { createClerkClient } from "@clerk/backend";
import * as Effect from "effect/Effect";
import { TeamDenied } from "./TeamSpaces.ts";

export interface TeamInvitationDelivery {
  readonly send: (id: string, email: string) => Effect.Effect<void, TeamDenied>;
  readonly revoke: (id: string, email: string) => Effect.Effect<void, TeamDenied>;
}

const INVITATION_PAGE_SIZE = 100;
const MAX_INVITATION_PAGES = 20;
const INVITATION_TIMEOUT = "10 seconds";

const boundedDelivery = (effect: Effect.Effect<void, TeamDenied>, reason: string) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: INVITATION_TIMEOUT,
      orElse: () => Effect.fail(new TeamDenied({ reason })),
    }),
  );

/** Correlation metadata is not a credential. Clerk owns the email's single-use signup ticket. */
export function makeTeamInvitationDelivery(secretKey: string): TeamInvitationDelivery {
  const clerk = createClerkClient({ secretKey });
  return {
    send: (id, email) =>
      boundedDelivery(
        Effect.tryPromise({
          try: async () => {
            await clerk.invitations.createInvitation({
              emailAddress: email,
              expiresInDays: 7,
              ignoreExisting: true,
              notify: true,
              publicMetadata: { t3TeamInviteId: id },
            });
          },
          catch: () => new TeamDenied({ reason: "invitation_email_failed_cancel_or_retry" }),
        }),
        "invitation_email_failed_cancel_or_retry",
      ),
    revoke: (id, email) =>
      boundedDelivery(
        Effect.tryPromise({
          try: async () => {
            // Resolve by durable correlation ID, including a send whose response was lost.
            // Collect before revoking so pagination cannot skip entries as the list shrinks.
            const ids: string[] = [];
            let finished = false;
            for (let pageIndex = 0; pageIndex < MAX_INVITATION_PAGES; pageIndex++) {
              const offset = pageIndex * INVITATION_PAGE_SIZE;
              const page = await clerk.invitations.getInvitationList({
                query: email,
                status: "pending",
                limit: INVITATION_PAGE_SIZE,
                offset,
              });
              for (const invitation of page.data) {
                if (
                  invitation.emailAddress.toLowerCase() === email &&
                  invitation.publicMetadata?.t3TeamInviteId === id
                )
                  ids.push(invitation.id);
              }
              if (offset + page.data.length >= page.totalCount || page.data.length === 0) {
                finished = true;
                break;
              }
            }
            if (!finished) throw new Error("invitation page bound");
            for (const invitationId of ids) await clerk.invitations.revokeInvitation(invitationId);
          },
          catch: (error) =>
            error instanceof TeamDenied
              ? error
              : new TeamDenied({ reason: "invitation_cancel_failed_retry" }),
        }),
        "invitation_cancel_failed_retry",
      ),
  };
}

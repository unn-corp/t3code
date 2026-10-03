import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { TeamSpaces, TeamDenied } from "./TeamSpaces.ts";
import type { TeamIdentity } from "@t3tools/contracts/teamSpaces";

const identity = (userId: string): TeamIdentity => ({
  userId,
  verifiedEmails: [`${userId}@example.test`],
  expiresAt: 1e12,
});
const owner = identity("owner"),
  creator = identity("creator"),
  member = identity("member"),
  outsider = identity("outsider");
const layer = TeamSpaces.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const join = Effect.fn("join")(function* (spaces: TeamSpaces["Service"], person: TeamIdentity) {
  const invitation = yield* spaces.rosterCommand(owner, {
    action: "invite",
    email: person.verifiedEmails[0]!,
  });
  yield* spaces.rosterCommand(person, { action: "accept", token: invitation.token! });
});

it.effect(
  "team owners see all projects; members create and manage only their project memberships",
  () =>
    Effect.gen(function* () {
      const spaces = yield* TeamSpaces;
      yield* spaces.bootstrapOwners([owner.userId]);
      yield* join(spaces, creator);
      yield* join(spaces, member);
      const first = yield* spaces.execute(creator, {
        action: "create",
        name: "First",
        members: [{ userId: member.userId, role: "viewer" }],
      });
      const second = yield* spaces.execute(owner, { action: "create", name: "Second" });
      expect((yield* spaces.list(owner.userId)).map((project) => project.id).sort()).toEqual(
        [first.spaceId, second.spaceId].sort(),
      );
      expect((yield* spaces.list(member.userId)).map((project) => project.id)).toEqual([
        first.spaceId,
      ]);
      expect((yield* spaces.directory(creator.userId)).role).toBe("member");
      expect(yield* spaces.canManageMembers(creator.userId, first.spaceId)).toBe(true);
      yield* spaces.execute(creator, {
        action: "removeMember",
        spaceId: first.spaceId,
        userId: member.userId,
      });
      expect(yield* spaces.list(member.userId)).toEqual([]);
      yield* spaces.execute(creator, {
        action: "addMember",
        spaceId: first.spaceId,
        userId: member.userId,
        role: "contributor",
      });
      expect(yield* spaces.requireRole(member.userId, first.spaceId, true)).toBe("contributor");
      expect(
        (yield* Effect.flip(
          spaces.execute(creator, {
            action: "invite",
            spaceId: first.spaceId,
            email: "outside@example.test",
            role: "viewer",
          }),
        )).reason,
      ).toBe("team_access_denied");
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(creator, { action: "invite", email: "outside@example.test" }),
        )).reason,
      ).toBe("team_access_denied");
      expect(
        (yield* Effect.flip(
          spaces.execute(member, {
            action: "setRole",
            spaceId: first.spaceId,
            userId: creator.userId,
            role: "viewer",
          }),
        ))._tag,
      ).toBe("TeamDenied");
    }).pipe(Effect.provide(layer)),
);

it.effect("outsiders cannot enumerate or create, and invalid creation selections roll back", () =>
  Effect.gen(function* () {
    const spaces = yield* TeamSpaces;
    const sql = yield* SqlClient.SqlClient;
    yield* spaces.bootstrapOwners([owner.userId]);
    yield* join(spaces, creator);
    expect(yield* spaces.directory(outsider.userId)).toEqual({
      role: null,
      canCreateProjects: false,
      canInviteMembers: false,
      members: [],
      invites: [],
    });
    expect(yield* spaces.list(outsider.userId)).toEqual([]);
    expect(
      (yield* Effect.flip(spaces.execute(outsider, { action: "create", name: "Denied" }))).reason,
    ).toBe("team_access_denied");
    expect(
      (yield* Effect.flip(
        spaces.execute(creator, {
          action: "create",
          name: "Invalid",
          members: [{ userId: outsider.userId, role: "viewer" }],
        }),
      ))._tag,
    ).toBe("TeamDenied");
    expect(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM team_spaces`)[0]!.count,
    ).toBe(0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "team invitations verify email, are hashed, single use, expire, cancel and invalidate resends",
  () =>
    Effect.gen(function* () {
      const spaces = yield* TeamSpaces;
      const sql = yield* SqlClient.SqlClient;
      yield* spaces.bootstrapOwners([owner.userId]);
      const invitation = yield* spaces.rosterCommand(owner, {
        action: "invite",
        email: "MEMBER@example.test",
      });
      expect(
        (yield* sql<{ token_hash: string }>`SELECT token_hash FROM team_roster_invites`)[0]!
          .token_hash,
      ).not.toBe(invitation.token);
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(outsider, { action: "accept", token: invitation.token! }),
        )).reason,
      ).toBe("invitation_invalid");
      yield* spaces.rosterCommand(member, { action: "accept", token: invitation.token! });
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(member, { action: "accept", token: invitation.token! }),
        )).reason,
      ).toBe("invitation_invalid");
      const old = yield* spaces.rosterCommand(owner, {
        action: "invite",
        email: outsider.verifiedEmails[0]!,
      });
      const next = yield* spaces.rosterCommand(owner, {
        action: "invite",
        email: outsider.verifiedEmails[0]!,
      });
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(outsider, { action: "accept", token: old.token! }),
        )).reason,
      ).toBe("invitation_invalid");
      yield* spaces.rosterCommand(owner, { action: "cancelInvite", inviteId: next.inviteId! });
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(outsider, { action: "accept", token: next.token! }),
        )).reason,
      ).toBe("invitation_invalid");
      const expired = yield* spaces.rosterCommand(owner, {
        action: "invite",
        email: outsider.verifiedEmails[0]!,
      });
      yield* TestClock.adjust("8 days");
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(outsider, { action: "accept", token: expired.token! }),
        )).reason,
      ).toBe("invitation_invalid");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "team removal and owner demotion revoke implicit project access without rebootstrap",
  () =>
    Effect.gen(function* () {
      const spaces = yield* TeamSpaces;
      yield* spaces.bootstrapOwners([owner.userId]);
      yield* join(spaces, creator);
      yield* join(spaces, member);
      const project = yield* spaces.execute(creator, { action: "create", name: "Creator project" });
      yield* spaces.rosterCommand(owner, {
        action: "setRole",
        userId: member.userId,
        role: "owner",
      });
      expect(yield* spaces.requireRole(member.userId, project.spaceId)).toBe("owner");
      const before = spaces.accessVersion(project.spaceId, member.userId);
      yield* spaces.rosterCommand(owner, {
        action: "setRole",
        userId: member.userId,
        role: "member",
      });
      expect(spaces.accessVersion(project.spaceId, member.userId)).toBeGreaterThan(before);
      expect((yield* Effect.flip(spaces.requireRole(member.userId, project.spaceId)))._tag).toBe(
        "TeamDenied",
      );
      yield* spaces.rosterCommand(owner, { action: "removeMember", userId: creator.userId });
      expect((yield* Effect.flip(spaces.requireRole(creator.userId, project.spaceId)))._tag).toBe(
        "TeamDenied",
      );
      yield* spaces.bootstrapOwners([creator.userId]);
      expect(yield* spaces.rosterRole(creator.userId)).toBeNull();
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(owner, { action: "removeMember", userId: owner.userId }),
        )).reason,
      ).toBe("last_owner_required");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "durable creation receipts replay after membership changes without restoring access",
  () =>
    Effect.gen(function* () {
      const spaces = yield* TeamSpaces;
      yield* spaces.bootstrapOwners([owner.userId]);
      yield* join(spaces, creator);
      yield* join(spaces, member);
      const command = {
        action: "create" as const,
        name: "Replay",
        requestId: "c".repeat(32),
        members: [{ userId: member.userId, role: "viewer" as const }],
      };
      const project = yield* spaces.execute(creator, command);
      expect(yield* spaces.execute(creator, command)).toEqual(project);
      yield* spaces.execute(creator, {
        action: "removeMember",
        spaceId: project.spaceId,
        userId: member.userId,
      });
      expect(yield* spaces.execute(creator, command)).toEqual(project);
      expect(yield* spaces.list(member.userId)).toEqual([]);
      expect(
        (yield* Effect.flip(
          spaces.execute(creator, {
            ...command,
            members: [{ userId: member.userId, role: "contributor" }],
          }),
        )).reason,
      ).toBe("project_creation_changed");
      yield* spaces.rosterCommand(owner, { action: "removeMember", userId: creator.userId });
      expect((yield* Effect.flip(spaces.execute(creator, command))).reason).toBe(
        "team_access_denied",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "removal revokes outstanding invitations and a demoted issuer cannot admit outsiders",
  () =>
    Effect.gen(function* () {
      const spaces = yield* TeamSpaces;
      yield* spaces.bootstrapOwners([owner.userId]);
      yield* join(spaces, member);
      yield* join(spaces, creator);
      const pending = yield* spaces.rosterCommand(owner, {
        action: "invite",
        email: member.verifiedEmails[0]!,
      });
      yield* spaces.rosterCommand(owner, { action: "removeMember", userId: member.userId });
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(member, { action: "accept", token: pending.token! }),
        )).reason,
      ).toBe("invitation_invalid");
      yield* spaces.rosterCommand(owner, {
        action: "setRole",
        userId: creator.userId,
        role: "owner",
      });
      const teamInvite = yield* spaces.rosterCommand(creator, {
        action: "invite",
        email: outsider.verifiedEmails[0]!,
      });
      const project = yield* spaces.execute(creator, { action: "create", name: "Legacy" });
      const legacy = yield* spaces.execute(creator, {
        action: "invite",
        spaceId: project.spaceId,
        email: outsider.verifiedEmails[0]!,
        role: "viewer",
      });
      yield* spaces.rosterCommand(owner, {
        action: "setRole",
        userId: creator.userId,
        role: "member",
      });
      expect(
        (yield* Effect.flip(
          spaces.rosterCommand(outsider, { action: "accept", token: teamInvite.token! }),
        )).reason,
      ).toBe("invitation_invalid");
      expect(
        (yield* Effect.flip(spaces.execute(outsider, { action: "accept", token: legacy.token! })))
          .reason,
      ).toBe("invitation_invalid");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "removed creators regain project access only when explicitly re-added, and pre-removal legacy invitations remain revoked",
  () =>
    Effect.gen(function* () {
      const spaces = yield* TeamSpaces;
      yield* spaces.bootstrapOwners([owner.userId]);
      yield* join(spaces, creator);
      const project = yield* spaces.execute(creator, {
        action: "create",
        name: "Protected creator",
      });
      const other = yield* spaces.execute(owner, { action: "create", name: "Other" });
      const pending = yield* spaces.execute(owner, {
        action: "invite",
        spaceId: other.spaceId,
        email: creator.verifiedEmails[0]!,
        role: "viewer",
      });
      yield* spaces.rosterCommand(owner, { action: "removeMember", userId: creator.userId });
      expect(
        (yield* Effect.flip(spaces.execute(creator, { action: "accept", token: pending.token! })))
          .reason,
      ).toBe("invitation_invalid");
      yield* TestClock.adjust("1 millis");
      yield* join(spaces, creator);
      expect(yield* spaces.list(creator.userId)).toEqual([]);
      yield* spaces.execute(owner, {
        action: "addMember",
        spaceId: project.spaceId,
        userId: creator.userId,
        role: "contributor",
      });
      expect(yield* spaces.requireRole(creator.userId, project.spaceId)).toBe("owner");
      expect(yield* spaces.rosterRole(creator.userId)).toBe("member");
      expect(
        (yield* Effect.flip(
          spaces.execute(owner, {
            action: "setRole",
            spaceId: project.spaceId,
            userId: creator.userId,
            role: "viewer",
          }),
        )).reason,
      ).toBe("project_creator_required");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "historical creators keep project authority even with a stored viewer role, while other viewers cannot manage members",
  () =>
    Effect.gen(function* () {
      const spaces = yield* TeamSpaces;
      const sql = yield* SqlClient.SqlClient;
      yield* spaces.bootstrapOwners([owner.userId]);
      yield* join(spaces, creator);
      yield* join(spaces, member);
      const project = yield* spaces.execute(creator, {
        action: "create",
        name: "Historical",
        members: [{ userId: member.userId, role: "viewer" }],
      });
      yield* sql`UPDATE team_members SET role='viewer' WHERE space_id=${project.spaceId} AND user_id=${creator.userId}`;
      expect(yield* spaces.canManageMembers(creator.userId, project.spaceId)).toBe(true);
      expect(yield* spaces.requireRole(creator.userId, project.spaceId, true, true)).toBe("owner");
      expect((yield* spaces.list(creator.userId))[0]?.role).toBe("owner");
      expect(
        (yield* spaces.snapshot(creator.userId, project.spaceId)).members.find(
          (entry) => entry.userId === creator.userId,
        )?.role,
      ).toBe("owner");
      yield* spaces.execute(creator, {
        action: "removeMember",
        spaceId: project.spaceId,
        userId: member.userId,
      });
      yield* spaces.execute(creator, {
        action: "addMember",
        spaceId: project.spaceId,
        userId: member.userId,
        role: "viewer",
      });
      expect(
        (yield* Effect.flip(
          spaces.execute(member, {
            action: "removeMember",
            spaceId: project.spaceId,
            userId: creator.userId,
          }),
        ))._tag,
      ).toBe("TeamDenied");
      const invitation = yield* spaces.execute(owner, {
        action: "invite",
        spaceId: project.spaceId,
        email: "external@example.test",
        role: "viewer",
      });
      expect(
        (yield* Effect.flip(
          spaces.execute(creator, {
            action: "cancelInvite",
            spaceId: project.spaceId,
            inviteId: invitation.inviteId!,
          }),
        )).reason,
      ).toBe("team_access_denied");
      yield* spaces.execute(owner, {
        action: "cancelInvite",
        spaceId: project.spaceId,
        inviteId: invitation.inviteId!,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("email invitations require owners and admit only the verified recipient once", () =>
  Effect.gen(function* () {
    const spaces = yield* TeamSpaces;
    yield* spaces.bootstrapOwners([owner.userId]);
    const sent: string[] = [];
    const delivery = {
      send: (id: string, email: string) =>
        Effect.sync(() => {
          sent.push(`${id}:${email}`);
        }),
      revoke: () => Effect.void,
    };
    expect(
      (yield* Effect.flip(
        spaces.emailRosterCommand(
          outsider,
          { action: "invite", email: "member@example.test" },
          delivery,
        ),
      )).reason,
    ).toBe("team_access_denied");
    expect(sent).toEqual([]);
    const result = yield* spaces.emailRosterCommand(
      owner,
      { action: "invite", email: " MEMBER@example.test " },
      delivery,
    );
    expect(result).not.toHaveProperty("token");
    expect(sent).toEqual([`${result.inviteId}:member@example.test`]);
    yield* spaces.acceptEmailInvitation({ ...member, verifiedEmails: [] });
    yield* spaces.acceptEmailInvitation(outsider);
    expect(yield* spaces.rosterRole(member.userId)).toBeNull();
    expect(yield* spaces.rosterRole(outsider.userId)).toBeNull();
    yield* spaces.acceptEmailInvitation(member);
    expect(yield* spaces.rosterRole(member.userId)).toBe("member");
    expect(yield* spaces.list(member.userId)).toEqual([]);
    yield* spaces.acceptEmailInvitation({ ...member, userId: "another-account" });
    expect(yield* spaces.rosterRole("another-account")).toBeNull();
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "email delivery failures leave cancelable intent; failed cancellation remains retryable",
  () =>
    Effect.gen(function* () {
      const spaces = yield* TeamSpaces;
      yield* spaces.bootstrapOwners([owner.userId]);
      const failed = {
        send: () => Effect.fail(new TeamDenied({ reason: "delivery_failed" })),
        revoke: () => Effect.void,
      };
      yield* Effect.flip(
        spaces.emailRosterCommand(
          owner,
          { action: "invite", email: "member@example.test" },
          failed,
        ),
      );
      const invite = (yield* spaces.directory(owner.userId)).invites[0]!;
      expect(invite.email).toBe("member@example.test");
      yield* spaces.acceptEmailInvitation(member);
      expect(yield* spaces.rosterRole(member.userId)).toBeNull();
      yield* Effect.flip(
        spaces.emailRosterCommand(
          owner,
          { action: "cancelInvite", inviteId: invite.id },
          {
            ...failed,
            revoke: () => Effect.fail(new TeamDenied({ reason: "cancel_failed" })),
          },
        ),
      );
      expect((yield* spaces.directory(owner.userId)).invites).toHaveLength(1);
      yield* spaces.emailRosterCommand(
        owner,
        { action: "cancelInvite", inviteId: invite.id },
        failed,
      );
      yield* spaces.acceptEmailInvitation(member);
      expect(yield* spaces.rosterRole(member.userId)).toBeNull();
    }).pipe(Effect.provide(layer)),
);

it.effect("reissue and owner removal revoke email links; expired email invites cannot admit", () =>
  Effect.gen(function* () {
    const spaces = yield* TeamSpaces;
    yield* spaces.bootstrapOwners([owner.userId, creator.userId]);
    const revoked: string[] = [];
    const delivery = {
      send: () => Effect.void,
      revoke: (id: string) =>
        Effect.sync(() => {
          revoked.push(id);
        }),
    };
    const first = yield* spaces.emailRosterCommand(
      creator,
      { action: "invite", email: "member@example.test" },
      delivery,
    );
    const second = yield* spaces.emailRosterCommand(
      creator,
      { action: "invite", email: "member@example.test" },
      delivery,
    );
    expect(revoked).toEqual([first.inviteId]);
    yield* spaces.emailRosterCommand(
      owner,
      { action: "setRole", userId: creator.userId, role: "member" },
      delivery,
    );
    expect(revoked).toEqual([first.inviteId, second.inviteId]);
    yield* spaces.acceptEmailInvitation(member);
    expect(yield* spaces.rosterRole(member.userId)).toBeNull();
    yield* spaces.emailRosterCommand(
      owner,
      { action: "invite", email: "member@example.test" },
      delivery,
    );
    yield* TestClock.adjust("8 days");
    yield* spaces.acceptEmailInvitation(member);
    expect(yield* spaces.rosterRole(member.userId)).toBeNull();
  }).pipe(Effect.provide(layer)),
);

import * as NodeCrypto from "node:crypto";
import type { TeamInvitationDelivery } from "./TeamInvitationDelivery.ts";
import { TeamProjectMemberSelections } from "@t3tools/contracts/teamSpaces";
import * as Schema from "effect/Schema";
import type {
  TeamCommand,
  TeamIdentity,
  TeamRole,
  TeamSpace,
  TeamEvent,
  TeamRosterCommand,
} from "@t3tools/contracts/teamSpaces";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class TeamDenied extends Data.TaggedError("TeamDenied")<{ readonly reason: string }> {}
const id = () => NodeCrypto.randomBytes(16).toString("hex");
const hash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
const encodeCreation = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.String, members: TeamProjectMemberSelections }),
  ),
);
const emailKey = (email: string) => email.trim().toLowerCase();

export const makeTeamSpaces = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authority = yield* Semaphore.make(1);
  const accessChanges = yield* PubSub.unbounded<{ spaceId: string; userId: string }>();
  const versions = new Map<string, number>();
  const accessVersion = (spaceId: string, userId: string) =>
    versions.get(`${spaceId}:${userId}`) ?? 0;
  // Hold this permit through the native dispatch receipt. A queued native write
  // cannot outlive a concurrent membership removal or role change.
  const withAuthority = authority.withPermits(1);
  const project = Effect.fn("TeamSpaces.project")(function* (spaceId: string) {
    if (!/^[a-f0-9]{32}$/.test(spaceId))
      return yield* new TeamDenied({ reason: "project_access_denied" });
    const rows = yield* sql<{ id: string; name: string; creator: string; createdAt: number }>`
      SELECT s.id,s.name,e.actor AS creator,e.created_at AS "createdAt"
      FROM team_spaces s JOIN team_events e ON e.space_id=s.id AND e.kind='project.created'
      WHERE s.id=${spaceId} ORDER BY e.sequence LIMIT 1`;
    if (!rows[0]) return yield* new TeamDenied({ reason: "project_access_denied" });
    return rows[0];
  });
  const rosterRole = Effect.fn("TeamSpaces.rosterRole")(function* (userId: string) {
    return (
      (yield* sql<{
        role: "owner" | "member";
      }>`SELECT role FROM team_roster WHERE user_id=${userId}`)[0]?.role ?? null
    );
  });
  const requireTeam = Effect.fn("TeamSpaces.requireTeam")(function* (
    userId: string,
    owner = false,
  ) {
    const role = yield* rosterRole(userId);
    if (!role || (owner && role !== "owner"))
      return yield* new TeamDenied({ reason: "team_access_denied" });
    return role;
  });
  const bootstrapOwners = Effect.fn("TeamSpaces.bootstrapOwners")(
    function* (userIds: ReadonlyArray<string>) {
      const state = (yield* sql<{
        initialized: number;
      }>`SELECT initialized FROM team_roster_state WHERE singleton=1`)[0]!;
      if (state.initialized || !userIds.length) return;
      for (const userId of new Set(userIds))
        yield* sql`INSERT INTO team_roster(user_id,role) VALUES(${userId},'owner') ON CONFLICT(user_id) DO UPDATE SET role='owner'`;
      yield* sql`UPDATE team_roster_state SET initialized=1 WHERE singleton=1`;
    },
    sql.withTransaction,
    withAuthority,
  );
  const canManageMembers = Effect.fn("TeamSpaces.canManageMembers")(function* (
    userId: string,
    spaceId: string,
  ) {
    const role = yield* requireTeam(userId);
    const details = yield* project(spaceId);
    return role === "owner" || details.creator === userId;
  });
  const requireRole = Effect.fn("TeamSpaces.requireRole")(function* (
    userId: string,
    spaceId: string,
    write = false,
    owner = false,
  ) {
    const teamRole = yield* requireTeam(userId);
    const details = yield* project(spaceId);
    const storedRole = (yield* sql<{
      role: TeamRole;
    }>`SELECT role FROM team_members WHERE space_id=${spaceId} AND user_id=${userId}`)[0]?.role;
    const role =
      teamRole === "owner" || (details.creator === userId && storedRole) ? "owner" : storedRole;
    if (
      !role ||
      (write && role === "viewer") ||
      (owner && teamRole !== "owner" && details.creator !== userId)
    )
      return yield* new TeamDenied({ reason: "project_access_denied" });
    return role;
  });
  const roster = sql<{
    userId: string;
    role: "owner" | "member";
  }>`SELECT user_id AS "userId",role FROM team_roster ORDER BY user_id`;
  const directory = Effect.fn("TeamSpaces.directory")(function* (userId: string) {
    const role = yield* rosterRole(userId);
    return {
      role,
      canCreateProjects: role !== null,
      canInviteMembers: role === "owner",
      members: role ? yield* roster : [],
      invites:
        role === "owner"
          ? yield* sql<{
              id: string;
              email: string;
              expiresAt: number;
            }>`SELECT id,email,expires_at AS "expiresAt" FROM team_roster_invites WHERE consumed_at IS NULL AND expires_at>${yield* Clock.currentTimeMillis} ORDER BY expires_at DESC LIMIT 100`
          : [],
    };
  });
  const invalidateAccess = Effect.fn("TeamSpaces.invalidateAccess")(function* (userId: string) {
    const projects = yield* sql<{ id: string }>`SELECT id FROM team_spaces`;
    for (const { id: spaceId } of projects) {
      versions.set(`${spaceId}:${userId}`, accessVersion(spaceId, userId) + 1);
      yield* PubSub.publish(accessChanges, { spaceId, userId });
    }
  });
  const rosterExecute = Effect.fn("TeamSpaces.rosterExecute")(function* (
    identity: TeamIdentity,
    command: TeamRosterCommand,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (identity.expiresAt <= now) return yield* new TeamDenied({ reason: "session_expired" });
    if (command.action === "accept") {
      const invite = (yield* sql<{
        id: string;
        email: string;
        issuer: string;
        createdAt: number;
      }>`SELECT id,email,issuer,created_at AS "createdAt" FROM team_roster_invites WHERE token_hash=${hash(command.token)} AND consumed_at IS NULL AND expires_at>${now}`)[0];
      if (
        !invite ||
        (yield* rosterRole(invite.issuer)) !== "owner" ||
        !identity.verifiedEmails.some((email) => emailKey(email) === invite.email)
      )
        return yield* new TeamDenied({ reason: "invitation_invalid" });
      const revoked = (yield* sql<{
        removedAt: number;
      }>`SELECT removed_at AS "removedAt" FROM team_roster_revocations WHERE user_id=${identity.userId}`)[0];
      if (revoked && revoked.removedAt >= invite.createdAt)
        return yield* new TeamDenied({ reason: "invitation_invalid" });
      yield* sql`INSERT OR IGNORE INTO team_roster(user_id,role) VALUES(${identity.userId},'member')`;
      yield* sql`UPDATE team_roster_invites SET consumed_at=${now} WHERE id=${invite.id}`;
      return {};
    }
    yield* requireTeam(identity.userId, true);
    if (command.action === "invite") {
      const email = emailKey(command.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return yield* new TeamDenied({ reason: "email_invalid" });
      const inviteId = id();
      const token = NodeCrypto.randomBytes(32).toString("hex");
      yield* sql`UPDATE team_roster_invites SET consumed_at=${now} WHERE email=${email} AND consumed_at IS NULL`;
      yield* sql`INSERT INTO team_roster_invites(id,email,issuer,token_hash,expires_at,created_at) VALUES(${inviteId},${email},${identity.userId},${hash(token)},${now + 7 * 24 * 60 * 60 * 1000},${now})`;
      return { inviteId, token };
    }
    if (command.action === "cancelInvite") {
      yield* sql`UPDATE team_roster_invites SET consumed_at=${now} WHERE id=${command.inviteId}`;
      return {};
    }
    const target = yield* requireTeam(command.userId);
    if (target === "owner" && (command.action === "removeMember" || command.role !== "owner")) {
      const count = (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM team_roster WHERE role='owner'`)[0]!.count;
      if (count <= 1) return yield* new TeamDenied({ reason: "last_owner_required" });
    }
    if (command.action === "removeMember") {
      yield* sql`DELETE FROM team_roster WHERE user_id=${command.userId}`;
      yield* sql`INSERT INTO team_roster_revocations(user_id,removed_at) VALUES(${command.userId},${now}) ON CONFLICT(user_id) DO UPDATE SET removed_at=excluded.removed_at`;
      for (const member of yield* sql<{
        spaceId: string;
      }>`SELECT space_id AS "spaceId" FROM team_members WHERE user_id=${command.userId}`) {
        const sequence = yield* record(
          member.spaceId,
          identity.userId,
          "member.removed",
          command.userId,
        );
        yield* sql`INSERT INTO team_revocations(space_id,user_id,sequence) VALUES(${member.spaceId},${command.userId},${sequence}) ON CONFLICT(space_id,user_id) DO UPDATE SET sequence=excluded.sequence`;
      }
      yield* sql`DELETE FROM team_members WHERE user_id=${command.userId}`;
    } else yield* sql`UPDATE team_roster SET role=${command.role} WHERE user_id=${command.userId}`;
    yield* sql`UPDATE team_roster_invites SET consumed_at=${now} WHERE issuer=${command.userId} AND consumed_at IS NULL`;
    yield* sql`UPDATE team_invites SET consumed_at=${now} WHERE created_sequence IN (SELECT sequence FROM team_events WHERE actor=${command.userId} AND kind='invitation.created') AND consumed_at IS NULL`;
    return {};
  }, sql.withTransaction);
  const pendingEmailInvites = sql<{ id: string; email: string; issuer: string }>`
    SELECT id,email,issuer FROM team_roster_invites
    WHERE consumed_at IS NULL AND (token_hash LIKE 'email:%' OR token_hash LIKE 'email-pending:%')`;
  const emailRevocationTargets = (command: TeamRosterCommand, email: string) =>
    pendingEmailInvites.pipe(
      Effect.map((pending) =>
        pending.filter((invite) => {
          switch (command.action) {
            case "invite":
              return invite.email === email;
            case "cancelInvite":
              return invite.id === command.inviteId;
            case "setRole":
            case "removeMember":
              return invite.issuer === command.userId;
            case "accept":
              return false;
          }
        }),
      ),
    );
  // Clerk runs outside the team authority lock and can be interrupted. The local invite
  // row is committed first, so a lost or timed-out send stays visible and cancelable.
  const emailRosterCommand = Effect.fn("TeamSpaces.emailRosterCommand")(function* (
    identity: TeamIdentity,
    command: TeamRosterCommand,
    delivery: TeamInvitationDelivery,
  ) {
    if (identity.expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* new TeamDenied({ reason: "session_expired" });
    if (command.action === "accept")
      return yield* rosterExecute(identity, command).pipe(withAuthority, Effect.uninterruptible);
    const email = command.action === "invite" ? emailKey(command.email) : "";
    const revoked = new Set<string>();
    const commit = Effect.fn("TeamSpaces.emailRosterCommand.commit")(
      function* () {
        yield* requireTeam(identity.userId, true);
        const outstanding = (yield* emailRevocationTargets(command, email)).filter(
          (invite) => !revoked.has(invite.id),
        );
        if (outstanding.length > 0) return { kind: "revoke" as const, invites: outstanding };
        const result = yield* rosterExecute(identity, command);
        if (command.action === "invite" && result.inviteId) {
          yield* sql`UPDATE team_roster_invites SET token_hash=${"email-pending:" + result.inviteId} WHERE id=${result.inviteId}`;
          return {
            kind: "send" as const,
            inviteId: result.inviteId,
            email,
          };
        }
        if (command.action === "removeMember" || command.action === "setRole")
          yield* invalidateAccess(command.userId);
        return { kind: "done" as const, result };
      },
      withAuthority,
      Effect.uninterruptible,
    );
    for (;;) {
      const step = yield* commit();
      if (step.kind === "revoke") {
        for (const invite of step.invites) {
          yield* delivery.revoke(invite.id, invite.email);
          revoked.add(invite.id);
        }
        continue;
      }
      if (step.kind === "send") {
        yield* delivery.send(step.inviteId, step.email);
        yield* sql`UPDATE team_roster_invites SET token_hash=${"email:" + step.inviteId} WHERE id=${step.inviteId} AND token_hash=${"email-pending:" + step.inviteId}`.pipe(
          withAuthority,
          Effect.uninterruptible,
        );
        return { inviteId: step.inviteId };
      }
      return step.result;
    }
  });
  const acceptEmailInvitation = Effect.fn("TeamSpaces.acceptEmailInvitation")(
    function* (identity: TeamIdentity) {
      const now = yield* Clock.currentTimeMillis;
      if (identity.expiresAt <= now) return yield* new TeamDenied({ reason: "session_expired" });
      if (yield* rosterRole(identity.userId)) return;
      for (const verifiedEmail of identity.verifiedEmails) {
        const invite = (yield* sql<{ id: string; issuer: string; createdAt: number }>`
          SELECT id,issuer,created_at AS "createdAt" FROM team_roster_invites
          WHERE email=${emailKey(verifiedEmail)} AND token_hash LIKE 'email:%'
            AND consumed_at IS NULL AND expires_at>${now} ORDER BY created_at DESC LIMIT 1`)[0];
        if (!invite || (yield* rosterRole(invite.issuer)) !== "owner") continue;
        const revoked = (yield* sql<{ removedAt: number }>`
          SELECT removed_at AS "removedAt" FROM team_roster_revocations WHERE user_id=${identity.userId}`)[0];
        if (revoked && revoked.removedAt >= invite.createdAt) continue;
        yield* sql`INSERT INTO team_roster(user_id,role) VALUES(${identity.userId},'member')`;
        yield* sql`UPDATE team_roster_invites SET consumed_at=${now} WHERE id=${invite.id}`;
        return;
      }
    },
    sql.withTransaction,
    withAuthority,
  );
  const rosterCommand = (identity: TeamIdentity, command: TeamRosterCommand) =>
    rosterExecute(identity, command).pipe(
      Effect.tap(() =>
        command.action === "removeMember" || command.action === "setRole"
          ? invalidateAccess(command.userId)
          : Effect.void,
      ),
      withAuthority,
      Effect.uninterruptible,
    );
  const record = Effect.fn("TeamSpaces.record")(function* (
    spaceId: string,
    actor: string,
    kind: string,
    text: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{
      sequence: number;
    }>`INSERT INTO team_events(space_id,actor,kind,text,created_at) VALUES(${spaceId},${actor},${kind},${text},${now}) RETURNING sequence`;
    return rows[0]!.sequence;
  });
  const list = Effect.fn("TeamSpaces.list")(function* (userId: string) {
    const role = yield* rosterRole(userId);
    if (!role) return [];
    return role === "owner"
      ? yield* sql<TeamSpace>`SELECT id,name,'owner' AS role FROM team_spaces ORDER BY name,id`
      : yield* sql<TeamSpace>`SELECT s.id,s.name,CASE WHEN EXISTS(SELECT 1 FROM team_events e WHERE e.space_id=s.id AND e.kind='project.created' AND e.actor=${userId}) THEN 'owner' ELSE m.role END AS role FROM team_spaces s JOIN team_members m ON m.space_id=s.id WHERE m.user_id=${userId} ORDER BY s.name,s.id`;
  });
  const snapshot = Effect.fn("TeamSpaces.snapshot")(function* (
    userId: string,
    spaceId: string,
    after = 0,
  ) {
    const role = yield* requireRole(userId, spaceId);
    const events =
      after === 0
        ? (yield* sql<TeamEvent>`SELECT sequence,space_id AS "spaceId",actor,kind,text,created_at AS "createdAt" FROM team_events WHERE space_id=${spaceId} ORDER BY sequence DESC LIMIT 200`).toReversed()
        : yield* sql<TeamEvent>`SELECT sequence,space_id AS "spaceId",actor,kind,text,created_at AS "createdAt" FROM team_events WHERE space_id=${spaceId} AND sequence>${after} ORDER BY sequence LIMIT 200`;
    const creator = (yield* project(spaceId)).creator;
    const members = yield* sql<{
      userId: string;
      role: TeamRole;
    }>`SELECT user_id AS "userId",CASE WHEN user_id=${creator} THEN 'owner' ELSE role END AS role FROM team_members WHERE space_id=${spaceId} ORDER BY user_id`;
    const invites =
      (yield* rosterRole(userId)) === "owner"
        ? yield* sql<{
            id: string;
            email: string;
            role: TeamRole;
            expiresAt: number;
          }>`SELECT id,email,role,expires_at AS "expiresAt" FROM team_invites WHERE space_id=${spaceId} AND consumed_at IS NULL ORDER BY expires_at DESC LIMIT 100`
        : [];
    return { role, events, members, invites, runs: [] };
  }, sql.withTransaction);
  const execute = Effect.fn("TeamSpaces.execute")(function* (
    identity: TeamIdentity,
    command: TeamCommand,
    mayCreate = false,
  ) {
    const userId = identity.userId;
    const now = yield* Clock.currentTimeMillis;
    if (identity.expiresAt <= now) return yield* new TeamDenied({ reason: "session_expired" });
    if (command.action === "create") {
      // The legacy flag is only an explicit first-install bootstrap, never project ownership inference.
      if (mayCreate) {
        const state = (yield* sql<{
          initialized: number;
        }>`SELECT initialized FROM team_roster_state WHERE singleton=1`)[0]!;
        if (!state.initialized) {
          yield* sql`INSERT INTO team_roster(user_id,role) VALUES(${userId},'owner') ON CONFLICT(user_id) DO UPDATE SET role='owner'`;
          yield* sql`UPDATE team_roster_state SET initialized=1 WHERE singleton=1`;
        }
      }
      yield* requireTeam(userId);
      const selected = command.members ?? [];
      if (
        new Set(selected.map((member) => member.userId)).size !== selected.length ||
        selected.some((member) => member.userId === userId)
      )
        return yield* new TeamDenied({ reason: "project_members_invalid" });
      const digest = hash(
        encodeCreation({
          name: command.name.trim(),
          members: [...selected].sort((a, b) => a.userId.localeCompare(b.userId)),
        }),
      );
      if (command.requestId) {
        const previous = (yield* sql<{
          digest: string;
          spaceId: string;
        }>`SELECT digest,space_id AS "spaceId" FROM team_project_creation_requests WHERE actor=${userId} AND request_id=${command.requestId}`)[0];
        if (previous) {
          if (previous.digest !== digest)
            return yield* new TeamDenied({ reason: "project_creation_changed" });
          yield* requireRole(userId, previous.spaceId);
          return { spaceId: previous.spaceId };
        }
      }
      for (const member of selected) yield* requireTeam(member.userId);
      if (!command.name.trim() || command.name.trim().length > 120)
        return yield* new TeamDenied({ reason: "project_name_invalid" });
      const spaceId = id();
      yield* sql`INSERT INTO team_spaces(id,name) VALUES(${spaceId},${command.name.trim()})`;
      yield* sql`INSERT INTO team_members(space_id,user_id,role) VALUES(${spaceId},${userId},'owner')`;
      for (const member of selected)
        yield* sql`INSERT INTO team_members(space_id,user_id,role) VALUES(${spaceId},${member.userId},${member.role})`;
      yield* record(spaceId, userId, "project.created", command.name.trim());
      if (command.requestId)
        yield* sql`INSERT INTO team_project_creation_requests(actor,request_id,digest,space_id) VALUES(${userId},${command.requestId},${digest},${spaceId})`;
      return { spaceId };
    }
    if (command.action === "accept") {
      const invites = yield* sql<{
        id: string;
        spaceId: string;
        email: string;
        role: TeamRole;
        createdSequence: number;
        createdAt: number;
        issuer: string;
      }>`SELECT team_invites.id,team_invites.space_id AS "spaceId",email,role,created_sequence AS "createdSequence",team_events.actor AS issuer,team_events.created_at AS "createdAt" FROM team_invites JOIN team_events ON team_events.sequence=team_invites.created_sequence WHERE token_hash=${hash(command.token)} AND consumed_at IS NULL AND expires_at>${now}`;
      const invite = invites[0];
      if (
        !invite ||
        (yield* rosterRole(invite.issuer)) !== "owner" ||
        !identity.verifiedEmails.some((email) => emailKey(email) === invite.email)
      ) {
        return yield* new TeamDenied({ reason: "invitation_invalid" });
      }
      const teamRevocation = (yield* sql<{
        removedAt: number;
      }>`SELECT removed_at AS "removedAt" FROM team_roster_revocations WHERE user_id=${userId}`)[0];
      if (teamRevocation && teamRevocation.removedAt >= invite.createdAt)
        return yield* new TeamDenied({ reason: "invitation_invalid" });
      const revocations = yield* sql<{
        sequence: number;
      }>`SELECT sequence FROM team_revocations WHERE space_id=${invite.spaceId} AND user_id=${userId}`;
      if ((revocations[0]?.sequence ?? 0) >= invite.createdSequence)
        return yield* new TeamDenied({ reason: "invitation_invalid" });
      yield* sql`INSERT OR IGNORE INTO team_roster(user_id,role) VALUES(${userId},'member')`;
      // Existing members keep their current role: accepting an old invite cannot undo a downgrade.
      yield* sql`INSERT OR IGNORE INTO team_members(space_id,user_id,role) VALUES(${invite.spaceId},${userId},${invite.role})`;
      yield* sql`UPDATE team_invites SET consumed_at=${now} WHERE id=${invite.id}`;
      yield* record(invite.spaceId, userId, "member.joined", userId);
      return { spaceId: invite.spaceId };
    }
    if (
      command.action === "logoutProvider" ||
      command.action === "loginProvider" ||
      command.action === "run" ||
      command.action === "stopRun"
    )
      return yield* new TeamDenied({ reason: "agents_run_locally" });
    const spaceId = command.spaceId;
    yield* requireRole(
      userId,
      spaceId,
      command.action !== "removeMember" || command.userId !== userId,
      command.action !== "message" &&
        (command.action !== "removeMember" || command.userId !== userId),
    );
    if (command.action === "message") {
      yield* record(spaceId, userId, "message", command.text);
      return { spaceId };
    }
    if (command.action === "invite") {
      yield* requireTeam(userId, true);
      const email = emailKey(command.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return yield* new TeamDenied({ reason: "email_invalid" });
      const inviteId = id();
      const token = NodeCrypto.randomBytes(32).toString("hex");
      // Resending invalidates every older outstanding link for this address in this project.
      yield* sql`UPDATE team_invites SET consumed_at=${now} WHERE space_id=${spaceId} AND email=${email} AND consumed_at IS NULL`;
      const sequence = yield* record(spaceId, userId, "invitation.created", email);
      yield* sql`INSERT INTO team_invites(id,space_id,email,role,token_hash,created_sequence,expires_at) VALUES(${inviteId},${spaceId},${email},${command.role},${hash(token)},${sequence},${now + 7 * 24 * 60 * 60 * 1000})`;
      return { spaceId, inviteId, token };
    }
    if (command.action === "cancelInvite") {
      yield* requireTeam(userId, true);
      yield* sql`UPDATE team_invites SET consumed_at=${now} WHERE id=${command.inviteId} AND space_id=${spaceId}`;
      yield* record(spaceId, userId, "invitation.cancelled", command.inviteId);
      return { spaceId };
    }
    const creator = (yield* project(spaceId)).creator;
    if (command.action === "addMember") {
      yield* requireTeam(command.userId);
      const selectedRole = command.userId === creator ? "owner" : command.role;
      yield* sql`INSERT INTO team_members(space_id,user_id,role) VALUES(${spaceId},${command.userId},${selectedRole}) ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role`;
      yield* record(spaceId, userId, "member.joined", command.userId);
      return { spaceId };
    }
    if (command.userId === creator)
      return yield* new TeamDenied({ reason: "project_creator_required" });
    if (command.action === "setRole" && command.role === "owner")
      return yield* new TeamDenied({ reason: "project_role_invalid" });
    const target =
      yield* sql`SELECT user_id FROM team_members WHERE user_id=${command.userId} AND space_id=${spaceId}`;
    if (!target.length) return yield* new TeamDenied({ reason: "project_access_denied" });
    if (command.action === "removeMember") {
      yield* sql`DELETE FROM team_members WHERE space_id=${spaceId} AND user_id=${command.userId}`;
      const sequence = yield* record(spaceId, userId, "member.removed", command.userId);
      yield* sql`INSERT INTO team_revocations(space_id,user_id,sequence) VALUES(${spaceId},${command.userId},${sequence}) ON CONFLICT(space_id,user_id) DO UPDATE SET sequence=excluded.sequence`;
    } else {
      yield* sql`UPDATE team_members SET role=${command.role} WHERE space_id=${spaceId} AND user_id=${command.userId}`;
      yield* record(spaceId, userId, "member.role_changed", `${command.userId}: ${command.role}`);
    }
    return { spaceId };
  }, sql.withTransaction);
  const recordActivity = Effect.fn("TeamSpaces.recordActivity")(function* (
    spaceId: string,
    actor: string,
    kind: string,
    text: string,
  ) {
    yield* record(spaceId, actor, kind, text.slice(0, 4000));
  });
  const auditDenied = Effect.fn("TeamSpaces.auditDenied")(function* (
    spaceId: string,
    userId: string,
    action: string,
    reason: string,
  ) {
    const exists = yield* sql`SELECT id FROM team_spaces WHERE id=${spaceId}`;
    if (exists.length) yield* record(spaceId, userId, "access.denied", `${action}: ${reason}`);
  });
  const commandWithAudit = (identity: TeamIdentity, command: TeamCommand, mayCreate = false) =>
    execute(identity, command, mayCreate).pipe(
      Effect.tap(() => {
        if (
          command.action !== "removeMember" &&
          command.action !== "setRole" &&
          command.action !== "addMember"
        )
          return Effect.void;
        return Effect.gen(function* () {
          const key = `${command.spaceId}:${command.userId}`;
          versions.set(key, accessVersion(command.spaceId, command.userId) + 1);
          yield* PubSub.publish(accessChanges, {
            spaceId: command.spaceId,
            userId: command.userId,
          });
        });
      }),
      Effect.tapError((error) =>
        error instanceof TeamDenied && "spaceId" in command
          ? Effect.gen(function* () {
              const exists = yield* sql`SELECT id FROM team_spaces WHERE id=${command.spaceId}`;
              if (exists.length)
                yield* record(
                  command.spaceId,
                  identity.userId,
                  "access.denied",
                  `${command.action}: ${error.reason}`,
                );
            })
          : Effect.void,
      ),
      withAuthority,
      Effect.uninterruptible,
    );
  return {
    rosterRole,
    requireTeam,
    bootstrapOwners,
    directory,
    rosterCommand,
    emailRosterCommand,
    acceptEmailInvitation,
    canManageMembers,
    roster,
    requireRole,
    project,
    list,
    snapshot,
    execute: commandWithAudit,
    recordActivity,
    auditDenied,
    withAuthority,
    accessVersion,
    accessChanges,
  };
});
export class TeamSpaces extends Context.Service<
  TeamSpaces,
  Effect.Success<typeof makeTeamSpaces>
>()("t3/team/TeamSpaces") {
  static readonly layer = Layer.effect(this, makeTeamSpaces);
}

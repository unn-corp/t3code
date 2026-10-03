import * as Schema from "effect/Schema";
import { CollaborationUser } from "./orchestration.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const TeamRole = Schema.Literals(["owner", "contributor", "viewer"]);
export type TeamRole = typeof TeamRole.Type;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
export const TeamProjectMemberSelection = Schema.Struct({
  userId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  role: Schema.Literals(["contributor", "viewer"]),
});
export const TeamProjectMemberSelections = Schema.Array(TeamProjectMemberSelection).check(
  Schema.isMaxLength(100),
);
export type TeamProjectMemberSelections = typeof TeamProjectMemberSelections.Type;
export const TeamRosterRole = Schema.Literals(["owner", "member"]);
export const TeamRosterCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("invite"),
    email: Schema.String.check(Schema.isMaxLength(320)),
  }),
  Schema.Struct({
    action: Schema.Literal("accept"),
    token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({ action: Schema.Literal("cancelInvite"), inviteId: Id }),
  Schema.Struct({ action: Schema.Literal("setRole"), userId: Text, role: TeamRosterRole }),
  Schema.Struct({ action: Schema.Literal("removeMember"), userId: Text }),
]);
export type TeamRosterCommand = typeof TeamRosterCommand.Type;
export const TeamRosterResult = Schema.Struct({
  inviteId: Schema.optionalKey(Id),
  token: Schema.optionalKey(Schema.String),
});
export const TeamDirectory = Schema.Struct({
  role: Schema.NullOr(TeamRosterRole),
  canCreateProjects: Schema.Boolean,
  canInviteMembers: Schema.Boolean,
  members: Schema.Array(Schema.Struct({ user: CollaborationUser, role: TeamRosterRole })),
  invites: Schema.Array(Schema.Struct({ id: Id, email: Schema.String, expiresAt: Schema.Finite })),
});
export type TeamDirectory = typeof TeamDirectory.Type;
export const LocalTeamDirectory = Schema.Struct({
  generation: Schema.String,
  directory: TeamDirectory,
});
export const LocalTeamRosterCommand = Schema.Struct({
  generation: Schema.String,
  command: TeamRosterCommand,
});
export const LocalTeamRosterResult = Schema.Struct({
  generation: Schema.String,
  result: TeamRosterResult,
});
export const TeamCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    name: Text,
    requestId: Schema.optionalKey(Id),
    members: Schema.optionalKey(TeamProjectMemberSelections),
  }),
  Schema.Struct({
    action: Schema.Literal("accept"),
    token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({
    action: Schema.Literal("invite"),
    spaceId: Id,
    email: Text,
    role: Schema.Literals(["contributor", "viewer"]),
  }),
  Schema.Struct({ action: Schema.Literal("cancelInvite"), spaceId: Id, inviteId: Id }),
  Schema.Struct({
    action: Schema.Literal("addMember"),
    spaceId: Id,
    ...TeamProjectMemberSelection.fields,
  }),
  Schema.Struct({ action: Schema.Literal("setRole"), spaceId: Id, userId: Text, role: TeamRole }),
  Schema.Struct({ action: Schema.Literal("removeMember"), spaceId: Id, userId: Text }),
  Schema.Struct({
    action: Schema.Literal("logoutProvider"),
    spaceId: Id,
    provider: ProviderDriverKind,
  }),
  Schema.Struct({
    action: Schema.Literal("loginProvider"),
    spaceId: Id,
    provider: ProviderDriverKind,
  }),
  Schema.Struct({
    action: Schema.Literal("run"),
    spaceId: Id,
    provider: ProviderDriverKind,
    model: Schema.optionalKey(Text),
    prompt: Text,
  }),
  Schema.Struct({ action: Schema.Literal("stopRun"), spaceId: Id, runId: Id }),
  Schema.Struct({ action: Schema.Literal("message"), spaceId: Id, text: Text }),
]);
export type TeamCommand = typeof TeamCommand.Type;
export interface TeamIdentity {
  readonly userId: string;
  readonly verifiedEmails: ReadonlyArray<string>;
  readonly expiresAt: number;
}
export interface TeamSpace {
  readonly id: string;
  readonly name: string;
  readonly role: TeamRole;
}
export interface TeamEvent {
  readonly sequence: number;
  readonly spaceId: string;
  readonly actor: string;
  readonly kind: string;
  readonly text: string;
  readonly createdAt: number;
}
export const TeamSpaceSchema = Schema.Struct({ id: Id, name: Schema.String, role: TeamRole });
export const TeamEventSchema = Schema.Struct({
  sequence: Schema.Int,
  spaceId: Id,
  actor: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  createdAt: Schema.Finite,
});
export const TeamSnapshot = Schema.Struct({
  role: TeamRole,
  events: Schema.Array(TeamEventSchema),
  members: Schema.Array(Schema.Struct({ userId: Schema.String, role: TeamRole })),
  runs: Schema.Array(
    Schema.Struct({
      runId: Id,
      userId: Schema.String,
      provider: ProviderDriverKind,
      state: Schema.Literals(["running", "cleanup_pending"]),
    }),
  ),
  invites: Schema.Array(
    Schema.Struct({ id: Id, email: Schema.String, role: TeamRole, expiresAt: Schema.Finite }),
  ),
});
export type TeamSnapshot = typeof TeamSnapshot.Type;
export const TeamCommandResult = Schema.Struct({
  spaceId: Id,
  inviteId: Schema.optionalKey(Id),
  runId: Schema.optionalKey(Id),
  token: Schema.optionalKey(Schema.String),
});

/** Public account information resolved by the dedicated Teams service. */
export const TeamAccount = Schema.Struct({
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  canCreateProjects: Schema.Boolean,
  teamRole: Schema.optionalKey(Schema.NullOr(TeamRosterRole)),
  canInviteMembers: Schema.optionalKey(Schema.Boolean),
});
export type TeamAccount = typeof TeamAccount.Type;

export const TeamOAuthConfiguration = Schema.Struct({
  issuer: Schema.String.check(Schema.isMaxLength(2048)),
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export const LocalTeamAccountState = Schema.Struct({
  generation: Schema.String,
  serviceUrl: Schema.NullOr(Schema.String),
  account: Schema.NullOr(TeamAccount),
  flow: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      userCode: Schema.String,
      verificationUri: Schema.String,
      verificationUriComplete: Schema.NullOr(Schema.String),
      expiresAt: Schema.Finite,
      status: Schema.Literals(["pending", "denied", "expired", "failed", "cancelled"]),
    }),
  ),
  message: Schema.NullOr(Schema.String),
});
export type LocalTeamAccountState = typeof LocalTeamAccountState.Type;

export const LocalTeamAccountStart = Schema.Struct({
  serviceUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
});
export const LocalTeamAccountCancel = Schema.Struct({ flowId: Schema.String });
export const LocalTeamAccountDisconnect = Schema.Struct({
  state: LocalTeamAccountState,
  remoteRevocationConfirmed: Schema.Boolean,
});
export const LocalTeamAccountProjects = Schema.Struct({
  generation: Schema.String,
  spaces: Schema.Array(TeamSpaceSchema),
});

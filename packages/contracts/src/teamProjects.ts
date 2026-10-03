import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "./baseSchemas.ts";
import {
  CollaborationUser,
  OrchestrationThreadDetailPage,
  SideThread,
  SideThreadShellSummary,
} from "./orchestration.ts";
import { TeamOpaqueId, TeamPublicationDisplay } from "./teamPublication.ts";
import { TeamRole, TeamProjectMemberSelection } from "./teamSpaces.ts";

export const TeamSyncStatus = Schema.Literals([
  "not-synced",
  "syncing",
  "synced",
  "offline",
  "account-changed",
  "access-revoked",
  "root-changed",
  "reset-required",
]);
export type TeamSyncStatus = typeof TeamSyncStatus.Type;
export const LocalTeamProjectLink = Schema.Struct({
  id: TeamOpaqueId,
  projectId: ProjectId,
  sharedProjectId: TeamOpaqueId,
  serviceUrl: Schema.String,
  subject: Schema.String,
  generation: Schema.String,
  role: TeamRole,
  status: TeamSyncStatus,
  publicationPolicy: Schema.Literal("explicit-threads"),
  repositorySync: Schema.Literals(["available", "unavailable"]),
});
export type LocalTeamProjectLink = typeof LocalTeamProjectLink.Type;
export const TeamThreadSource = Schema.Struct({
  displayProjectRef: Schema.Struct({ projectId: ProjectId }),
  readSource: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("local"), threadId: ThreadId }),
    Schema.Struct({ kind: Schema.Literal("shared"), sourceId: Schema.String, threadId: ThreadId }),
  ]),
  executionRef: Schema.NullOr(Schema.Struct({ projectId: ProjectId, threadId: ThreadId })),
  discussionRef: Schema.NullOr(Schema.Struct({ linkId: TeamOpaqueId, threadId: ThreadId })),
  assetSource: Schema.Literals(["local", "unavailable"]),
  fileSource: Schema.Literals(["local", "unavailable"]),
  contentFormat: Schema.Literals(["native", "plain-text"]),
  access: Schema.Struct({
    execute: Schema.Boolean,
    publish: Schema.Boolean,
    discuss: Schema.Boolean,
    markRead: Schema.Boolean,
  }),
});
export type TeamThreadSource = typeof TeamThreadSource.Type;
export const LocalTeamPublicationState = Schema.Struct({
  publicationId: TeamOpaqueId,
  threadId: ThreadId,
  sharedThreadId: Schema.NullOr(ThreadId),
  status: TeamSyncStatus,
  revision: NonNegativeInt,
  paused: Schema.optional(Schema.Boolean),
});
export type LocalTeamPublicationState = typeof LocalTeamPublicationState.Type;
export const LocalTeamProjectState = Schema.Struct({
  link: LocalTeamProjectLink,
  publications: Schema.Array(LocalTeamPublicationState),
  publicationIntents: Schema.optional(
    Schema.Array(
      Schema.Struct({ threadId: ThreadId, status: Schema.Literals(["pending", "error"]) }),
    ),
  ),
});
export type LocalTeamProjectState = typeof LocalTeamProjectState.Type;
export const LocalTeamProjectControl = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("intent"),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: ThreadId,
    generation: Schema.String,
    shared: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("link"),
    projectId: ProjectId,
    sharedProjectId: TeamOpaqueId,
  }),
  Schema.Struct({ action: Schema.Literal("unlink"), projectId: ProjectId }),
  Schema.Struct({
    action: Schema.Literal("stop-publication"),
    projectId: ProjectId,
    threadId: ThreadId,
  }),
  Schema.Struct({ action: Schema.Literal("publish"), projectId: ProjectId, threadId: ThreadId }),
]);
export type LocalTeamProjectControl = typeof LocalTeamProjectControl.Type;
export const LocalTeamProjectControlResult = Schema.Struct({
  state: Schema.NullOr(LocalTeamProjectState),
});
export const TeamSharedThreadSummary = Schema.Struct({
  id: ThreadId,
  source: TeamThreadSource,
  title: Schema.String,
  display: TeamPublicationDisplay,
  discussion: Schema.optional(SideThreadShellSummary),
  createdBy: Schema.NullOr(CollaborationUser),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type TeamSharedThreadSummary = typeof TeamSharedThreadSummary.Type;
export const TeamSharedMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant", "system", "reasoning"]),
  text: Schema.String,
  streaming: Schema.Boolean,
  author: Schema.NullOr(CollaborationUser),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamSharedMessage = typeof TeamSharedMessage.Type;
/** Discussion attachments are omitted by the bridge; plain text is mandatory for all peer content. */
export const TeamMemberReportedStatus = Schema.Struct({
  status: Schema.Literals(["idle", "working", "waiting", "completed", "failed", "stopped"]),
  reportedBy: Schema.String,
  updatedAt: IsoDateTime,
});
export type TeamMemberReportedStatus = typeof TeamMemberReportedStatus.Type;
export const TeamSharedThreadSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: TeamSharedThreadSummary,
  memberStatus: Schema.NullOr(TeamMemberReportedStatus),
  messages: Schema.Array(TeamSharedMessage),
  discussions: Schema.Array(SideThread),
  page: Schema.optional(OrchestrationThreadDetailPage),
});
export type TeamSharedThreadSnapshot = typeof TeamSharedThreadSnapshot.Type;
export const TeamSharedProjectStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    sequence: NonNegativeInt,
    threads: Schema.Array(TeamSharedThreadSummary),
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: TeamSharedThreadSummary,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
]);
export type TeamSharedProjectStreamItem = typeof TeamSharedProjectStreamItem.Type;
export const TeamSharedThreadStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: TeamSharedThreadSnapshot }),
  Schema.Struct({
    kind: Schema.Literal("member-status"),
    sequence: NonNegativeInt,
    status: TeamMemberReportedStatus,
  }),
  Schema.Struct({
    kind: Schema.Literal("message"),
    sequence: NonNegativeInt,
    message: TeamSharedMessage,
    append: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("discussion-changed"), sequence: NonNegativeInt }),
  Schema.Struct({ kind: Schema.Literal("metadata-changed"), sequence: NonNegativeInt }),
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
]);
export type TeamSharedThreadStreamItem = typeof TeamSharedThreadStreamItem.Type;
export class LocalTeamProjectError extends Schema.TaggedError<LocalTeamProjectError>()(
  "LocalTeamProjectError",
  {
    reason: Schema.Literals([
      "network",
      "access",
      "changed",
      "unlinked",
      "root_changed",
      "reset_required",
      "storage",
      "invalid",
      "limit",
    ]),
    message: Schema.String,
  },
) {}
export const LOCAL_TEAM_METHODS = {
  state: "teams.project.state",
  subscribeState: "teams.project.links.subscribe",
  control: "teams.project.control",
  subscribeProject: "teams.project.subscribe",
  subscribeThread: "teams.thread.subscribe",
  snapshot: "teams.thread.snapshot",
  discuss: "teams.thread.discuss",
} as const;

export const TeamMemberDirectory = Schema.Struct({
  creatorId: Schema.optionalKey(Schema.String),
  canManageMembers: Schema.optionalKey(Schema.Boolean),
  canInviteMembers: Schema.optionalKey(Schema.Boolean),
  availableMembers: Schema.optionalKey(Schema.Array(CollaborationUser)),
  role: TeamRole,
  members: Schema.Array(Schema.Struct({ user: CollaborationUser, role: TeamRole })),
  invites: Schema.Array(
    Schema.Struct({
      id: TeamOpaqueId,
      email: Schema.String,
      role: TeamRole,
      expiresAt: Schema.Finite,
    }),
  ),
});
export type TeamMemberDirectory = typeof TeamMemberDirectory.Type;
export const TeamMembershipCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("addMember"), ...TeamProjectMemberSelection.fields }),
  Schema.Struct({
    action: Schema.Literal("invite"),
    email: Schema.String.check(Schema.isMaxLength(320)),
    role: Schema.Literals(["contributor", "viewer"]),
  }),
  Schema.Struct({ action: Schema.Literal("cancelInvite"), inviteId: TeamOpaqueId }),
  Schema.Struct({
    action: Schema.Literal("setRole"),
    userId: Schema.String.check(Schema.isMaxLength(256)),
    role: TeamRole,
  }),
  Schema.Struct({
    action: Schema.Literal("removeMember"),
    userId: Schema.String.check(Schema.isMaxLength(256)),
  }),
]);
export type TeamMembershipCommand = typeof TeamMembershipCommand.Type;
export const TEAM_DIRECTORY_METHOD = "team.members.directory";
export const LOCAL_TEAM_DIRECTORY_METHOD = "teams.members.directory";
export const LOCAL_TEAM_MEMBERS_METHOD = "teams.members.command";
export const LOCAL_TEAM_ACCEPT_METHOD = "teams.invitation.accept";

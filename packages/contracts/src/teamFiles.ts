import { TeamProjectMemberSelections } from "./teamSpaces.ts";
import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import { TeamOpaqueId } from "./teamPublication.ts";

export const TEAM_FILE_BYTES = 1024 * 1024;
export const TEAM_BUNDLE_BYTES = 512 * 1024 * 1024;
export const TEAM_TRANSFER_CHUNK = 256 * 1024;
export const TeamFilePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*[\\:\p{Cc}])[^/]+(?:\/[^/]+)*$/u),
);
export const TeamContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const TeamGitCommit = Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)));
export const TeamFileEntry = Schema.Struct({
  path: TeamFilePath,
  hash: TeamContentHash,
  size: NonNegativeInt,
  executable: Schema.Boolean,
});
export type TeamFileEntry = typeof TeamFileEntry.Type;
export const TeamFileChange = Schema.Struct({
  path: TeamFilePath,
  expected: Schema.NullOr(TeamContentHash),
  expectedExecutable: Schema.NullOr(Schema.Boolean),
  content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1400000))),
  executable: Schema.Boolean,
});
export type TeamFileChange = typeof TeamFileChange.Type;
export const TeamFileManifest = Schema.Struct({
  version: NonNegativeInt,
  reset: Schema.Boolean,
  removed: Schema.Array(TeamFilePath),
  branch: Schema.NullOr(Schema.String),
  commit: TeamGitCommit,
  files: Schema.Array(TeamFileEntry),
});
export type TeamFileManifest = typeof TeamFileManifest.Type;
export const TeamFileMutation = Schema.Struct({
  id: TeamOpaqueId,
  changes: Schema.Array(TeamFileChange).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  resolve: Schema.optional(TeamOpaqueId),
});
export type TeamFileMutation = typeof TeamFileMutation.Type;
export const TeamFileReceipt = Schema.Struct({
  id: TeamOpaqueId,
  status: Schema.Literals(["accepted", "conflict"]),
  version: NonNegativeInt,
  actor: Schema.String,
});
export type TeamFileReceipt = typeof TeamFileReceipt.Type;
export const TeamRepositoryCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("manifest"), since: Schema.optional(NonNegativeInt) }),
  Schema.Struct({ action: Schema.Literal("read"), hash: TeamContentHash }),
  Schema.Struct({ action: Schema.Literal("mutate"), mutation: TeamFileMutation }),
  Schema.Struct({ action: Schema.Literal("conflicts"), after: Schema.optional(TeamOpaqueId) }),
  Schema.Struct({
    action: Schema.Literal("begin"),
    id: TeamOpaqueId,
    branch: Schema.String.check(Schema.isMaxLength(200)),
    commit: TeamGitCommit,
    expected: TeamGitCommit,
    bytes: NonNegativeInt,
    hash: TeamContentHash,
  }),
  Schema.Struct({
    action: Schema.Literal("upload"),
    id: TeamOpaqueId,
    index: NonNegativeInt,
    data: Schema.String.check(Schema.isMaxLength(350000)),
  }),
  Schema.Struct({ action: Schema.Literal("finish"), id: TeamOpaqueId }),
  Schema.Struct({ action: Schema.Literal("abort"), id: TeamOpaqueId }),
  Schema.Struct({
    action: Schema.Literal("download"),
    hash: TeamContentHash,
    index: NonNegativeInt,
  }),
  Schema.Struct({ action: Schema.Literal("repository") }),
]);
export type TeamRepositoryCommand = typeof TeamRepositoryCommand.Type;
export const TeamRepositoryResult = Schema.Struct({
  manifest: Schema.optional(TeamFileManifest),
  content: Schema.optional(Schema.String),
  receipt: Schema.optional(TeamFileReceipt),
  conflicts: Schema.optional(
    Schema.Array(Schema.Struct({ receipt: TeamFileReceipt, mutation: TeamFileMutation })),
  ),
  nextConflict: Schema.optional(TeamOpaqueId),
  repository: Schema.optional(
    Schema.Struct({
      branch: Schema.String,
      commit: TeamGitCommit,
      hash: TeamContentHash,
      bytes: NonNegativeInt,
    }),
  ),
});
export type TeamRepositoryResult = typeof TeamRepositoryResult.Type;
export class TeamFileError extends Schema.TaggedError<TeamFileError>()("TeamFileError", {
  reason: Schema.Literals([
    "access",
    "unsupported_platform",
    "invalid",
    "conflict",
    "limit",
    "unavailable",
    "branch_changed",
    "root_changed",
    "destination",
    "initializing",
  ]),
  message: Schema.String,
  sharedProjectId: Schema.optional(TeamOpaqueId),
}) {}
export const TEAM_FILES_METHODS = {
  command: "team.repository.command",
  subscribe: "team.files.subscribe",
} as const;
export const LocalTeamFileStatus = Schema.Literals([
  "disabled",
  "syncing",
  "synchronized",
  "offline",
  "conflict",
  "access-lost",
  "branch-changed",
  "root-changed",
  "initializing",
]);
export const LocalTeamFilesControl = Schema.Union([
  Schema.Struct({ action: Schema.Literal("preview"), projectId: ProjectId }),
  Schema.Struct({
    action: Schema.Literal("share"),
    members: Schema.optionalKey(TeamProjectMemberSelections),
    requestId: Schema.optionalKey(TeamOpaqueId),
    projectId: ProjectId,
    name: Schema.String,
    expectedCommit: TeamGitCommit,
    expectedBranch: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("create"),
    members: Schema.optionalKey(TeamProjectMemberSelections),
    requestId: Schema.optionalKey(TeamOpaqueId),
    name: Schema.String,
    destination: Schema.String,
    sharedProjectId: Schema.optional(TeamOpaqueId),
  }),
  Schema.Struct({
    action: Schema.Literal("open"),
    sharedProjectId: TeamOpaqueId,
    destination: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literals([
      "state",
      "enable",
      "disable",
      "reconcile",
      "fetch",
      "publish",
      "initialize",
    ]),
    projectId: ProjectId,
  }),
  Schema.Struct({
    action: Schema.Literal("include"),
    projectId: ProjectId,
    paths: Schema.Array(TeamFilePath).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    action: Schema.Literal("resolve"),
    projectId: ProjectId,
    path: TeamFilePath,
    expectedLocal: Schema.NullOr(TeamContentHash),
    expectedRemote: Schema.NullOr(TeamContentHash),
    expectedLocalExecutable: Schema.NullOr(Schema.Boolean),
    expectedRemoteExecutable: Schema.NullOr(Schema.Boolean),
    choice: Schema.Literals(["local", "remote"]),
  }),
]);
export type LocalTeamFilesControl = typeof LocalTeamFilesControl.Type;
export const LocalTeamFilesResult = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  sharedProjectId: Schema.optional(TeamOpaqueId),
  status: LocalTeamFileStatus,
  branch: Schema.optional(Schema.String),
  commit: Schema.optional(TeamGitCommit),
  excludedChanges: Schema.optional(NonNegativeInt),
  conflicts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: TeamFilePath,
        localHash: Schema.NullOr(TeamContentHash),
        remoteHash: Schema.NullOr(TeamContentHash),
        localExecutable: Schema.NullOr(Schema.Boolean),
        remoteExecutable: Schema.NullOr(Schema.Boolean),
        reason: Schema.optional(Schema.Literal("directory")),
      }),
    ),
  ),
  policy: Schema.Literal("tracked-and-explicitly-included"),
});
export type LocalTeamFilesResult = typeof LocalTeamFilesResult.Type;
export const LOCAL_TEAM_FILES_METHOD = "teams.files.control";

export const LOCAL_TEAM_FILES_STATE_METHOD = "teams.files.state";

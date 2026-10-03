import * as Schema from "effect/Schema";
import { OrganizationId } from "./organizations.ts";
import { GitHubAccountId } from "./sourceControl.ts";

export const OrganizationRepositoryKind = Schema.Literals([
  "configuration",
  "configuration-version",
  "architect-request",
  "architect-message",
  "architect-proposal",
  "director-request",
  "director-message",
  "memory",
  "memory-revision",
  "source",
  "observation",
  "finding",
  "proposal",
  "proposal-decision",
  "work-intent",
  "work",
  "work-transition",
  "work-attempt",
  "work-artifact",
  "qa-receipt",
  "approval-receipt",
  "integration-receipt",
  "organization-audit",
  "source-audit",
]);
export type OrganizationRepositoryKind = typeof OrganizationRepositoryKind.Type;

export const OrganizationRepositoryRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  organizationId: OrganizationId,
  kind: OrganizationRepositoryKind,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  content: Schema.Record(Schema.String, Schema.Unknown),
});
export type OrganizationRepositoryRecord = typeof OrganizationRepositoryRecord.Type;

export const OrganizationRepositoryPreviewInput = Schema.Struct({ organizationId: OrganizationId });
export type OrganizationRepositoryPreviewInput = typeof OrganizationRepositoryPreviewInput.Type;
export const OrganizationRepositoryPreview = Schema.Struct({
  organizationId: OrganizationId,
  counts: Schema.Array(Schema.Struct({ kind: OrganizationRepositoryKind, count: Schema.Number })),
  totalRecords: Schema.Number,
  excluded: Schema.Array(Schema.String),
});
export type OrganizationRepositoryPreview = typeof OrganizationRepositoryPreview.Type;

export const OrganizationRepositoryLinkInput = Schema.Struct({
  organizationId: OrganizationId,
  repository: Schema.String.check(Schema.isMaxLength(200)),
  create: Schema.Boolean,
  visibility: Schema.Literals(["private", "public", "internal"]),
  publicExposureAcknowledged: Schema.optional(Schema.Boolean),
  autoSync: Schema.optional(Schema.Boolean),
  githubAccountId: Schema.optional(GitHubAccountId),
});
export type OrganizationRepositoryLinkInput = typeof OrganizationRepositoryLinkInput.Type;
export const OrganizationRepositoryLoadInput = Schema.Struct({
  repository: Schema.String.check(Schema.isMaxLength(200)),
  publicExposureAcknowledged: Schema.optional(Schema.Boolean),
  autoSync: Schema.optional(Schema.Boolean),
  githubAccountId: Schema.optional(GitHubAccountId),
});
export type OrganizationRepositoryLoadInput = typeof OrganizationRepositoryLoadInput.Type;
export const OrganizationRepositorySyncInput = Schema.Struct({ organizationId: OrganizationId });
export type OrganizationRepositorySyncInput = typeof OrganizationRepositorySyncInput.Type;
export const OrganizationRepositoryResolveInput = Schema.Struct({
  organizationId: OrganizationId,
  recordKey: Schema.String.check(Schema.isMaxLength(800)),
  choice: Schema.Literals(["local", "remote"]),
  expectedRemoteDigest: Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64)),
});
export type OrganizationRepositoryResolveInput = typeof OrganizationRepositoryResolveInput.Type;
export const OrganizationRepositoryListInput = Schema.Struct({
  organizationId: OrganizationId,
  kind: Schema.optional(OrganizationRepositoryKind),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});
export type OrganizationRepositoryListInput = typeof OrganizationRepositoryListInput.Type;
export const OrganizationRepositoryStatus = Schema.Struct({
  organizationId: OrganizationId,
  repository: Schema.NullOr(Schema.String),
  visibility: Schema.NullOr(Schema.Literals(["private", "public", "internal"])),
  autoSyncEnabled: Schema.Boolean,
  publicExposureAcknowledged: Schema.Boolean,
  lastAcceptedCommit: Schema.NullOr(Schema.String),
  lastSyncAt: Schema.NullOr(Schema.String),
  pendingCount: Schema.Number,
  incomingCount: Schema.Number,
  conflictCount: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
});
export type OrganizationRepositoryStatus = typeof OrganizationRepositoryStatus.Type;
export const OrganizationRepositoryRecordView = Schema.Struct({
  recordKey: Schema.String,
  record: OrganizationRepositoryRecord,
  state: Schema.Literals(["incoming", "shared", "conflict"]),
  remoteDigest: Schema.String,
});
export type OrganizationRepositoryRecordView = typeof OrganizationRepositoryRecordView.Type;
export const OrganizationRepositoryListResult = Schema.Struct({
  records: Schema.Array(OrganizationRepositoryRecordView),
  nextCursor: Schema.NullOr(Schema.String),
});
export type OrganizationRepositoryListResult = typeof OrganizationRepositoryListResult.Type;
export class OrganizationRepositoryError extends Schema.TaggedError<OrganizationRepositoryError>()(
  "OrganizationRepositoryError",
  {
    code: Schema.Literals(["invalid", "not_found", "conflict", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}

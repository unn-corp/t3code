import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";

export const OrganizationMemoryRecordId = TrimmedNonEmptyString.check(Schema.isMaxLength(160)).pipe(
  Schema.brand("OrganizationMemoryRecordId"),
);
export type OrganizationMemoryRecordId = typeof OrganizationMemoryRecordId.Type;
export const OrganizationMemoryMutationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
).pipe(Schema.brand("OrganizationMemoryMutationId"));
export type OrganizationMemoryMutationId = typeof OrganizationMemoryMutationId.Type;
export const OrganizationMemoryKind = Schema.Literals([
  "architecture",
  "standard",
  "decision",
  "finding",
  "incident",
  "rejected-approach",
  "question",
  "source-reference",
  "outcome",
  "other",
]);
export const OrganizationMemoryStatus = Schema.Literals(["active", "archived", "superseded"]);
export const OrganizationMemoryProvenance = Schema.Struct({
  kind: Schema.Literals(["user", "explicit-reference"]),
  reference: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  note: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_000))),
});
export type OrganizationMemoryProvenance = typeof OrganizationMemoryProvenance.Type;
export const OrganizationMemoryContent = Schema.Struct({
  kind: OrganizationMemoryKind,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  provenance: OrganizationMemoryProvenance,
  reviewedAt: Schema.NullOr(IsoDateTime),
  staleAt: Schema.NullOr(IsoDateTime),
  retainUntil: Schema.NullOr(IsoDateTime),
});
export type OrganizationMemoryContent = typeof OrganizationMemoryContent.Type;
export const OrganizationMemoryRecord = Schema.Struct({
  id: OrganizationMemoryRecordId,
  organizationId: OrganizationId,
  projectId: Schema.NullOr(ProjectId),
  version: PositiveInt,
  status: OrganizationMemoryStatus,
  supersededById: Schema.NullOr(OrganizationMemoryRecordId),
  content: OrganizationMemoryContent,
  createdBy: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrganizationMemoryRecord = typeof OrganizationMemoryRecord.Type;
export const OrganizationMemoryRevision = Schema.Struct({
  mutationId: OrganizationMemoryMutationId,
  organizationId: OrganizationId,
  recordId: OrganizationMemoryRecordId,
  version: PositiveInt,
  action: Schema.Literals(["create", "correct", "archive", "supersede"]),
  actorSubject: TrimmedNonEmptyString,
  snapshot: OrganizationMemoryRecord,
  createdAt: IsoDateTime,
});
export type OrganizationMemoryRevision = typeof OrganizationMemoryRevision.Type;
export const OrganizationMemoryCreateInput = Schema.Struct({
  mutationId: OrganizationMemoryMutationId,
  recordId: OrganizationMemoryRecordId,
  organizationId: OrganizationId,
  projectId: Schema.NullOr(ProjectId),
  content: OrganizationMemoryContent,
});
export type OrganizationMemoryCreateInput = typeof OrganizationMemoryCreateInput.Type;
export const OrganizationMemoryCorrectInput = Schema.Struct({
  mutationId: OrganizationMemoryMutationId,
  recordId: OrganizationMemoryRecordId,
  organizationId: OrganizationId,
  expectedVersion: PositiveInt,
  content: OrganizationMemoryContent,
});
export type OrganizationMemoryCorrectInput = typeof OrganizationMemoryCorrectInput.Type;
export const OrganizationMemorySupersedeInput = Schema.Struct({
  mutationId: OrganizationMemoryMutationId,
  recordId: OrganizationMemoryRecordId,
  organizationId: OrganizationId,
  expectedVersion: PositiveInt,
  replacementRecordId: OrganizationMemoryRecordId,
});
export type OrganizationMemorySupersedeInput = typeof OrganizationMemorySupersedeInput.Type;
export const OrganizationMemoryArchiveInput = Schema.Struct({
  mutationId: OrganizationMemoryMutationId,
  recordId: OrganizationMemoryRecordId,
  organizationId: OrganizationId,
  expectedVersion: PositiveInt,
});
export type OrganizationMemoryArchiveInput = typeof OrganizationMemoryArchiveInput.Type;
export const OrganizationMemoryListInput = Schema.Struct({
  organizationId: OrganizationId,
  projectId: Schema.NullOr(ProjectId),
  offset: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
  ),
});
export type OrganizationMemoryListInput = typeof OrganizationMemoryListInput.Type;
export const OrganizationMemoryHistoryInput = Schema.Struct({
  organizationId: OrganizationId,
  recordId: OrganizationMemoryRecordId,
  projectId: Schema.NullOr(ProjectId),
  offset: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
  ),
});
export type OrganizationMemoryHistoryInput = typeof OrganizationMemoryHistoryInput.Type;
export class OrganizationMemoryError extends Schema.TaggedError<OrganizationMemoryError>()(
  "OrganizationMemoryError",
  {
    code: Schema.Literals(["invalid", "forbidden", "not_found", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}

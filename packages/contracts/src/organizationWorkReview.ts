import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";
import { OrganizationWorkAttemptId, OrganizationWorkId } from "./organizationWork.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const BoundedPreview = Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_096)));

export const OrganizationWorkReviewInput = Schema.Struct({
  organizationId: OrganizationId,
  workId: OrganizationWorkId,
  attemptId: OrganizationWorkAttemptId,
});
export type OrganizationWorkReviewInput = typeof OrganizationWorkReviewInput.Type;

export const OrganizationWorkReviewResult = Schema.Struct({
  workId: OrganizationWorkId,
  attemptId: OrganizationWorkAttemptId,
  projectId: ProjectId,
  projectRootDigest: Digest,
  artifact: Schema.Struct({
    digest: Digest,
    ref: Schema.String,
    baseCodeRevision: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    replacementPreview: BoundedPreview,
    replacementBytes: Schema.Int,
    previewTruncated: Schema.Boolean,
    reviewComplete: Schema.Boolean,
    outcome: Schema.Struct({
      exitCode: Schema.NullOr(Schema.Int),
      signal: Schema.NullOr(Schema.String),
      timedOut: Schema.Boolean,
      outputLimitExceeded: Schema.Boolean,
      resourceLimitExceeded: Schema.Boolean,
    }),
  }),
  qa: Schema.NullOr(
    Schema.Struct({
      accepted: Schema.Boolean,
      receiptDigest: Digest,
      reviewerSubject: Schema.String,
      evidenceRef: Schema.String,
      evidencePreview: BoundedPreview,
      evidenceBytes: Schema.Int,
      previewTruncated: Schema.Boolean,
    }),
  ),
  approval: Schema.NullOr(
    Schema.Struct({
      approved: Schema.Boolean,
      receiptDigest: Digest,
      approvalSubject: Schema.String,
      evidenceRef: Schema.String,
      evidencePreview: BoundedPreview,
      evidenceBytes: Schema.Int,
      previewTruncated: Schema.Boolean,
    }),
  ),
});
export type OrganizationWorkReviewResult = typeof OrganizationWorkReviewResult.Type;

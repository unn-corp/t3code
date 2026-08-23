import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  PositiveInt,
  TrimmedNonEmptyString,
  type SourceControlProjectPullRequest,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

const GitHubProjectPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  headRefOid: TrimmedNonEmptyString,
  isDraft: Schema.optional(Schema.Boolean),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.Unknown),
  statusCheckRollup: Schema.optional(Schema.Array(Schema.Unknown)),
});

const decodeList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeEntry = Schema.decodeUnknownExit(GitHubProjectPullRequestSchema);

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMergeState(value: string | null | undefined) {
  switch (value?.trim().toUpperCase()) {
    case "CLEAN":
    case "HAS_HOOKS":
      return "ready" as const;
    case "BLOCKED":
    case "BEHIND":
    case "DRAFT":
    case "UNSTABLE":
      return "blocked" as const;
    case "DIRTY":
      return "conflicting" as const;
    default:
      return "unknown" as const;
  }
}

function normalizeReviewDecision(value: string | null | undefined) {
  switch (value?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved" as const;
    case "CHANGES_REQUESTED":
      return "changes-requested" as const;
    case "REVIEW_REQUIRED":
      return "review-required" as const;
    default:
      return "none" as const;
  }
}

function normalizeCheckStatus(values: ReadonlyArray<unknown> | undefined) {
  if (!values || values.length === 0) return "unknown" as const;
  let pending = false;
  for (const value of values) {
    const record = optionalRecord(value);
    const status = optionalString(record?.status)?.toUpperCase();
    const conclusion = optionalString(record?.conclusion)?.toUpperCase();
    if (
      conclusion === "FAILURE" ||
      conclusion === "CANCELLED" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "ACTION_REQUIRED" ||
      conclusion === "STARTUP_FAILURE"
    ) {
      return "failing" as const;
    }
    if (status !== "COMPLETED" || conclusion === null) pending = true;
  }
  return pending ? ("pending" as const) : ("passing" as const);
}

function blockedReason(input: {
  readonly isDraft: boolean;
  readonly mergeState: SourceControlProjectPullRequest["mergeState"];
  readonly reviewDecision: SourceControlProjectPullRequest["reviewDecision"];
  readonly checkStatus: SourceControlProjectPullRequest["checkStatus"];
}): string | null {
  if (input.isDraft) return "Draft pull requests cannot be merged.";
  if (input.mergeState === "conflicting") return "Resolve merge conflicts first.";
  if (input.reviewDecision === "changes-requested") return "Changes are still requested.";
  if (input.checkStatus === "failing") return "Required checks are failing.";
  if (input.mergeState === "blocked") return "GitHub reports this pull request as blocked.";
  return null;
}

function normalize(
  raw: Schema.Schema.Type<typeof GitHubProjectPullRequestSchema>,
): SourceControlProjectPullRequest {
  const author = optionalRecord(raw.author);
  const mergeState = normalizeMergeState(raw.mergeStateStatus);
  const reviewDecision = normalizeReviewDecision(raw.reviewDecision);
  const checkStatus = normalizeCheckStatus(raw.statusCheckRollup);
  const isDraft = raw.isDraft ?? false;
  const mergeBlockedReason = blockedReason({
    isDraft,
    mergeState,
    reviewDecision,
    checkStatus,
  });
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    authorLogin: optionalString(author?.login),
    isDraft,
    mergeState,
    reviewDecision,
    checkStatus,
    canMerge: mergeBlockedReason === null,
    mergeBlockedReason,
    updatedAt: optionalString(raw.updatedAt) ?? "1970-01-01T00:00:00.000Z",
  };
}

export function decodeGitHubProjectPullRequestListJson(
  raw: string,
): Result.Result<ReadonlyArray<SourceControlProjectPullRequest>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeList(raw);
  if (Result.isFailure(result)) return Result.fail(result.failure);
  const pullRequests: SourceControlProjectPullRequest[] = [];
  for (const value of result.success) {
    const decoded = decodeEntry(value);
    if (Exit.isSuccess(decoded)) pullRequests.push(normalize(decoded.value));
  }
  return Result.succeed(pullRequests);
}

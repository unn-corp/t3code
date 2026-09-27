import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";

export const OrganizationIntakeSourceId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrganizationIntakeSourceId"),
);
export type OrganizationIntakeSourceId = typeof OrganizationIntakeSourceId.Type;
export const OrganizationObservationId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrganizationObservationId"),
);
export type OrganizationObservationId = typeof OrganizationObservationId.Type;
export const OrganizationTentativeFindingId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrganizationTentativeFindingId"),
);
export type OrganizationTentativeFindingId = typeof OrganizationTentativeFindingId.Type;

export const OrganizationIntakeSourceKind = Schema.Literals(["manual", "generic-http"]);
export type OrganizationIntakeSourceKind = typeof OrganizationIntakeSourceKind.Type;
export const OrganizationIntakeSource = Schema.Struct({
  id: OrganizationIntakeSourceId,
  organizationId: OrganizationId,
  projectId: Schema.NullOr(ProjectId),
  kind: OrganizationIntakeSourceKind,
  name: TrimmedNonEmptyString,
  /** Interactive subject for manual intake only; never a secret. */
  ingestSubject: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrganizationIntakeSource = typeof OrganizationIntakeSource.Type;

export const OrganizationIntakeRegisterSourceInput = Schema.Struct({
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
  projectId: Schema.NullOr(ProjectId),
  kind: OrganizationIntakeSourceKind,
  name: TrimmedNonEmptyString,
  ingestSubject: TrimmedNonEmptyString,
});
export type OrganizationIntakeRegisterSourceInput =
  typeof OrganizationIntakeRegisterSourceInput.Type;
export const OrganizationIntakeSourceRegistration = Schema.Struct({
  source: OrganizationIntakeSource,
  /** Shown once for generic HTTP sources. Null for manual sources. */
  ingestSecret: Schema.NullOr(TrimmedNonEmptyString),
});
export type OrganizationIntakeSourceRegistration = typeof OrganizationIntakeSourceRegistration.Type;

/** Normalized event data. Adapters must not pass raw request headers or credentials. */
export const OrganizationIntakeEventInput = Schema.Struct({
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
  projectId: Schema.NullOr(ProjectId),
  externalEventId: TrimmedNonEmptyString,
  dedupKey: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
});
export type OrganizationIntakeEventInput = typeof OrganizationIntakeEventInput.Type;

export const OrganizationObservation = Schema.Struct({
  id: OrganizationObservationId,
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
  projectId: Schema.NullOr(ProjectId),
  externalEventId: TrimmedNonEmptyString,
  dedupKey: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
  receivedAt: IsoDateTime,
  title: Schema.String,
  body: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
  state: Schema.Literal("observed"),
});
export type OrganizationObservation = typeof OrganizationObservation.Type;

export const OrganizationIntakeCorrelationStatus = Schema.Struct({
  outcome: Schema.Literals([
    "created",
    "duplicate",
    "insufficient",
    "ambiguous",
    "skipped",
    "unavailable",
  ]),
  findingId: Schema.NullOr(OrganizationTentativeFindingId),
  reason: Schema.NullOr(
    Schema.Literals(["missing-project", "missing-correlation-key", "invalid-correlation-key"]),
  ),
});
export type OrganizationIntakeCorrelationStatus = typeof OrganizationIntakeCorrelationStatus.Type;
export const OrganizationCorrelationJobStatus = Schema.Struct({
  observationId: OrganizationObservationId,
  state: Schema.Literals(["pending", "leased", "complete", "terminal"]),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Schema.NullOr(Schema.String),
  lastErrorCode: Schema.NullOr(Schema.String),
  nextAttemptAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrganizationCorrelationJobStatus = typeof OrganizationCorrelationJobStatus.Type;
export const OrganizationIntakeResult = Schema.Struct({
  outcome: Schema.Literals(["recorded", "duplicate"]),
  observation: OrganizationObservation,
  /** Correlation is advisory and never authorizes work. Older intake records omit this. */
  correlation: Schema.optional(OrganizationIntakeCorrelationStatus),
});
export type OrganizationIntakeResult = typeof OrganizationIntakeResult.Type;

/** Source-secret HTTP callers receive no stored text or cross-source correlation state. */
export const OrganizationIntakeHttpReceipt = Schema.Struct({
  outcome: Schema.Literals(["recorded", "duplicate"]),
  observationId: OrganizationObservationId,
});
export type OrganizationIntakeHttpReceipt = typeof OrganizationIntakeHttpReceipt.Type;

export const OrganizationTentativeFindingInput = Schema.Struct({
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
  dedupKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  observationIds: Schema.Array(OrganizationObservationId),
});
export type OrganizationTentativeFindingInput = typeof OrganizationTentativeFindingInput.Type;
export const OrganizationTentativeFinding = Schema.Struct({
  id: OrganizationTentativeFindingId,
  organizationId: OrganizationId,
  /** Compatibility anchor. Per-observation provenance is authoritative. */
  sourceId: OrganizationIntakeSourceId,
  projectId: Schema.NullOr(ProjectId),
  dedupKey: TrimmedNonEmptyString,
  title: Schema.String,
  summary: Schema.String,
  observationIds: Schema.Array(OrganizationObservationId),
  evidence: Schema.Array(
    Schema.Struct({
      observationId: OrganizationObservationId,
      sourceId: OrganizationIntakeSourceId,
      projectId: Schema.NullOr(ProjectId),
    }),
  ),
  state: Schema.Literal("tentative"),
  createdAt: IsoDateTime,
});
export type OrganizationTentativeFinding = typeof OrganizationTentativeFinding.Type;

export const OrganizationIntakeAuditEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
  actorSubject: TrimmedNonEmptyString,
  action: Schema.Literals(["register", "enable", "disable", "rotate-secret"]),
  createdAt: IsoDateTime,
});
export type OrganizationIntakeAuditEntry = typeof OrganizationIntakeAuditEntry.Type;

export class OrganizationIntakeError extends Schema.TaggedError<OrganizationIntakeError>()(
  "OrganizationIntakeError",
  {
    code: Schema.Literals([
      "invalid",
      "not_found",
      "conflict",
      "forbidden",
      "rate_limited",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}

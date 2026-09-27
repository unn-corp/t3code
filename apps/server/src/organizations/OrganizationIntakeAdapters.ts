import * as NodeCrypto from "node:crypto";
import {
  OrganizationIntakeEventInput,
  OrganizationIntakeSourceId,
  type OrganizationIntakeEventInput as NormalizedEvent,
} from "../../../../packages/contracts/src/organizationIntake.ts";
import { OrganizationId } from "../../../../packages/contracts/src/organizations.ts";
import {
  ProjectId,
  TrimmedNonEmptyString,
} from "../../../../packages/contracts/src/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const TextBody = Schema.String.check(Schema.isMaxLength(12_000));
const OpaqueId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const CorrelationKey = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const Envelope = {
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
  projectId: ProjectId,
  occurredAt: Schema.String,
};

/** A relay posts selected issue fields after its own upstream authentication. */
export const GitHubIssueRelayInput = Schema.Struct({
  kind: Schema.Literal("github-issue-relay"),
  ...Envelope,
  deliveryId: OpaqueId,
  repositoryId: OpaqueId,
  issueId: OpaqueId,
  action: Schema.Literals(["opened", "edited", "reopened", "closed"]),
  title: ShortText,
  bodyText: TextBody,
});
export type GitHubIssueRelayInput = typeof GitHubIssueRelayInput.Type;

/** Only an explicitly selected plain-text message can enter this relay. */
export const PlainTextEmailRelayInput = Schema.Struct({
  kind: Schema.Literal("plain-text-email-relay"),
  ...Envelope,
  relayEventId: OpaqueId,
  messageId: OpaqueId,
  selectionReason: Schema.Literals(["bug-report", "incident-alert", "support-escalation"]),
  correlationKey: Schema.NullOr(CorrelationKey),
  subject: ShortText,
  plainText: TextBody,
});
export type PlainTextEmailRelayInput = typeof PlainTextEmailRelayInput.Type;
export const OrganizationRelayEventInput = Schema.Union([
  GitHubIssueRelayInput,
  PlainTextEmailRelayInput,
]);
export type OrganizationRelayEventInput = typeof OrganizationRelayEventInput.Type;

export class OrganizationIntakeAdapterError extends Schema.TaggedError<OrganizationIntakeAdapterError>()(
  "OrganizationIntakeAdapterError",
  { code: Schema.Literal("invalid"), message: Schema.String },
) {}
const invalid = (message: string) =>
  new OrganizationIntakeAdapterError({ code: "invalid", message });
const MAX_RELAY_BYTES = 32 * 1024;
const MAX_TITLE_BYTES = 512;
const MAX_BODY_BYTES = 12 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const RELAY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;
const HTML_TAG = /<\/?[a-z][^>]*>|<!doctype\b/i;
const INLINE_SECRET =
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+|\b(password|secret|token|api[_-]?key)\s*([:=])\s*([^\s,;]+)/gi;
const redact = (value: string) =>
  value.replace(
    INLINE_SECRET,
    (_match, bearer: string | undefined, key: string | undefined, separator: string | undefined) =>
      bearer ? `${bearer}[REDACTED]` : `${key}${separator}[REDACTED]`,
  );
const hash = (parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256")
    .update(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(parts))
    .digest("hex");
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const parseRfc3339 = (value: string): string | null => {
  const match = RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1] ?? 0);
  const month = Number(match[2] ?? 0);
  const day = Number(match[3] ?? 0);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  const expectedDay = `${match[1]}-${match[2]}-${match[3]}`;
  const midnight = Option.getOrNull(DateTime.make(`${expectedDay}T00:00:00.000Z`));
  if (midnight === null || DateTime.formatIso(midnight).slice(0, 10) !== expectedDay) return null;
  const parsed = Option.getOrNull(DateTime.make(value));
  return parsed === null ? null : DateTime.formatIso(parsed);
};
const GITHUB_KEYS = new Set(Object.keys(GitHubIssueRelayInput.fields));
const EMAIL_KEYS = new Set(Object.keys(PlainTextEmailRelayInput.fields));
const hasExactKeys = (value: unknown, expected: ReadonlySet<string>) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
};

/** Pure relay normalization. Callers must separately authenticate the source secret. */
export const normalizeOrganizationRelayEvent = (
  input: unknown,
): Effect.Effect<NormalizedEvent, OrganizationIntakeAdapterError> =>
  Effect.gen(function* () {
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      input,
    ).pipe(Effect.mapError(() => invalid("Relay event must be a JSON object.")));
    const size = bytes(serialized);
    if (size > MAX_RELAY_BYTES) return yield* invalid("Relay event exceeds 32 KiB.");
    const kind =
      input !== null && typeof input === "object" && "kind" in input ? input.kind : undefined;
    const keys =
      kind === "github-issue-relay"
        ? GITHUB_KEYS
        : kind === "plain-text-email-relay"
          ? EMAIL_KEYS
          : null;
    if (keys === null || !hasExactKeys(input, keys))
      return yield* invalid("Relay event has missing or unsupported fields.");
    const event = yield* Schema.decodeUnknownEffect(OrganizationRelayEventInput)(input).pipe(
      Effect.mapError(() => invalid("Relay event fields are invalid.")),
    );
    if (
      bytes(event.organizationId) > 160 ||
      bytes(event.sourceId) > 160 ||
      bytes(event.projectId) > 160
    )
      return yield* invalid("Relay scope identity exceeds its size limit.");
    const occurredAt = parseRfc3339(event.occurredAt);
    if (occurredAt === null) return yield* invalid("Relay event timestamp is invalid.");
    const title = redact(event.kind === "github-issue-relay" ? event.title : event.subject);
    const body = redact(event.kind === "github-issue-relay" ? event.bodyText : event.plainText);
    if (
      bytes(title) > MAX_TITLE_BYTES ||
      bytes(body) > MAX_BODY_BYTES ||
      HTML_TAG.test(title) ||
      HTML_TAG.test(body)
    )
      return yield* invalid("Relay text must be bounded plain text without HTML.");
    let externalEventId: string;
    let dedupKey: string;
    let attributes: Record<string, string>;
    if (event.kind === "github-issue-relay") {
      if (
        !UUID.test(event.deliveryId) ||
        !NUMERIC_ID.test(event.repositoryId) ||
        !NUMERIC_ID.test(event.issueId)
      )
        return yield* invalid("GitHub relay identities are invalid.");
      const deliveryHash = hash([event.deliveryId.toLowerCase()]);
      externalEventId = `github-delivery:${deliveryHash}`;
      dedupKey = externalEventId;
      attributes = {
        adapter: "github-issue-relay",
        repositoryId: event.repositoryId,
        issueId: event.issueId,
        action: event.action,
        correlationKey: `github-issue:${event.repositoryId}:${event.issueId}`,
      };
    } else {
      if (
        !RELAY_ID.test(event.relayEventId) ||
        !MESSAGE_ID.test(event.messageId) ||
        (event.correlationKey !== null &&
          (!CORRELATION.test(event.correlationKey) ||
            redact(event.correlationKey) !== event.correlationKey))
      )
        return yield* invalid("Email relay identities are invalid.");
      externalEventId = `email-relay:${hash([event.relayEventId])}`;
      dedupKey = `email-message:${hash([event.messageId])}`;
      attributes = {
        adapter: "plain-text-email-relay",
        selectionReason: event.selectionReason,
        ...(event.correlationKey === null ? {} : { correlationKey: event.correlationKey }),
      };
    }
    return yield* Schema.decodeUnknownEffect(OrganizationIntakeEventInput)({
      organizationId: event.organizationId,
      sourceId: event.sourceId,
      projectId: event.projectId,
      externalEventId,
      dedupKey,
      occurredAt,
      title,
      body,
      attributes,
    }).pipe(Effect.mapError(() => invalid("Normalized relay event is invalid.")));
  });

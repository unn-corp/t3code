import * as NodeCrypto from "node:crypto";
import {
  OrganizationIntakeError,
  OrganizationCorrelationJobStatus,
  OrganizationIntakeAuditEntry,
  OrganizationIntakeSource,
  type OrganizationIntakeSourceRegistration,
  OrganizationObservation,
  OrganizationTentativeFinding,
  OrganizationObservationId,
  OrganizationIntakeSourceId,
  OrganizationTentativeFindingId,
  type OrganizationIntakeEventInput,
  type OrganizationIntakeRegisterSourceInput,
  type OrganizationIntakeResult,
  type OrganizationTentativeFindingInput,
} from "../../../../packages/contracts/src/organizationIntake.ts";
import type { OrganizationId } from "../../../../packages/contracts/src/organizations.ts";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Construct only from authenticated server transport state, never from event JSON. */
export interface OrganizationIntakePrincipal {
  readonly subject: string;
}
export interface OrganizationIntakeGovernancePrincipal extends OrganizationIntakePrincipal {
  readonly canManageSources: boolean;
}
export type OrganizationIntakeAuthentication =
  | { readonly kind: "interactive-user"; readonly subject: string }
  | {
      readonly kind: "source-secret";
      readonly secret: string;
      readonly requireProjectBoundSource?: boolean;
    };

type SourceRow = {
  source_id: string;
  organization_id: string;
  project_id: string | null;
  kind: string;
  name: string;
  ingest_subject: string;
  enabled: number;
  secret_hash: string | null;
  credential_version: number;
  created_at: string;
  updated_at: string;
};
type ObservationRow = {
  observation_id: string;
  organization_id: string;
  source_id: string;
  project_id: string | null;
  external_event_id: string;
  dedup_key: string;
  occurred_at: string;
  received_at: string;
  title: string;
  body: string;
  attributes_json: string;
};
type FindingRow = {
  finding_id: string;
  organization_id: string;
  source_id: string;
  dedup_key: string;
  title: string;
  summary: string;
  observation_ids_json: string;
  project_id: string | null;
  evidence_json: string | null;
  created_at: string;
};
type AuditRow = {
  audit_id: string;
  organization_id: string;
  source_id: string;
  actor_subject: string;
  action: string;
  created_at: string;
};

const MAX_EVENT_BYTES = 32 * 1024;
const MAX_TITLE_BYTES = 512;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_KEY_BYTES = 80;
const MAX_ATTRIBUTE_VALUE_BYTES = 2 * 1024;
const MAX_ID_BYTES = 256;
/** Sliding server-receipt window; repeated deliveries of the same event do not consume capacity. */
const MAX_NEW_OBSERVATIONS_PER_SOURCE_PER_HOUR = 1000;
const INTAKE_WINDOW_MS = 60 * 60 * 1000;
const SECRET_KEY = /(?:authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key)/i;
const INLINE_SECRET =
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+|\b(password|secret|token|api[_-]?key)\s*([:=])\s*([^\s,;]+)/gi;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const redact = (value: string) =>
  value.replace(
    INLINE_SECRET,
    (_match, bearer: string | undefined, key: string | undefined, separator: string | undefined) =>
      bearer ? `${bearer}[REDACTED]` : `${key}${separator}[REDACTED]`,
  );
const invalid = (message: string) => new OrganizationIntakeError({ code: "invalid", message });
const forbidden = (message: string) => new OrganizationIntakeError({ code: "forbidden", message });
const notFound = (message: string) => new OrganizationIntakeError({ code: "not_found", message });
const conflict = (message: string) => new OrganizationIntakeError({ code: "conflict", message });
const rateLimited = () =>
  new OrganizationIntakeError({
    code: "rate_limited",
    message: "Intake source exceeded 1000 new observations in the past hour.",
  });
const unavailable = () =>
  new OrganizationIntakeError({
    code: "unavailable",
    message: "Organization intake storage is unavailable.",
  });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const stableId = (prefix: string, parts: ReadonlyArray<string>) =>
  `${prefix}:${NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
const newSecret = () => NodeCrypto.randomBytes(32).toString("base64url");
const hashSecret = (
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
  secret: string,
) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([organizationId, sourceId, secret]))
    .digest("hex");
const matchesSecret = (expected: string, actual: string) =>
  NodeCrypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
const AttributesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const EvidenceIdsJson = Schema.fromJsonString(Schema.Array(OrganizationObservationId));
const EvidenceRefsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      observationId: OrganizationObservationId,
      sourceId: OrganizationIntakeSourceId,
      projectId: Schema.NullOr(ProjectId),
    }),
  ),
);
const decodeSource = (row: SourceRow) =>
  Schema.decodeUnknownEffect(OrganizationIntakeSource)({
    id: row.source_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    ingestSubject: row.ingest_subject,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }).pipe(Effect.mapError(() => invalid("Stored intake source is invalid.")));
const decodeObservation = (row: ObservationRow) =>
  Effect.gen(function* () {
    const attributes = yield* Schema.decodeUnknownEffect(AttributesJson)(row.attributes_json);
    return yield* Schema.decodeUnknownEffect(OrganizationObservation)({
      id: row.observation_id,
      organizationId: row.organization_id,
      sourceId: row.source_id,
      projectId: row.project_id,
      externalEventId: row.external_event_id,
      dedupKey: row.dedup_key,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      title: row.title,
      body: row.body,
      attributes,
      state: "observed",
    });
  }).pipe(Effect.mapError(() => invalid("Stored intake observation is invalid.")));
const decodeFinding = (row: FindingRow) =>
  Effect.gen(function* () {
    const observationIds = yield* Schema.decodeUnknownEffect(EvidenceIdsJson)(
      row.observation_ids_json,
    );
    const evidence =
      row.evidence_json === null
        ? observationIds.map((observationId) => ({
            observationId,
            sourceId: OrganizationIntakeSourceId.make(row.source_id),
            projectId: null,
          }))
        : yield* Schema.decodeUnknownEffect(EvidenceRefsJson)(row.evidence_json);
    return yield* Schema.decodeUnknownEffect(OrganizationTentativeFinding)({
      id: row.finding_id,
      organizationId: row.organization_id,
      sourceId: row.source_id,
      projectId: row.project_id,
      dedupKey: row.dedup_key,
      title: row.title,
      summary: row.summary,
      observationIds,
      evidence,
      state: "tentative",
      createdAt: row.created_at,
    });
  }).pipe(Effect.mapError(() => invalid("Stored tentative finding is invalid.")));
const decodeAudit = (row: AuditRow) =>
  Schema.decodeUnknownEffect(OrganizationIntakeAuditEntry)({
    id: row.audit_id,
    organizationId: row.organization_id,
    sourceId: row.source_id,
    actorSubject: row.actor_subject,
    action: row.action,
    createdAt: row.created_at,
  }).pipe(Effect.mapError(() => invalid("Stored intake audit is invalid.")));

function validateEvent(input: OrganizationIntakeEventInput): OrganizationIntakeError | null {
  const serialized = JSON.stringify(input);
  if (bytes(serialized) > MAX_EVENT_BYTES) return invalid("Normalized event exceeds 32 KiB.");
  if (bytes(input.title) > MAX_TITLE_BYTES || bytes(input.body) > MAX_BODY_BYTES)
    return invalid("Event title or body exceeds its size limit.");
  if (bytes(input.externalEventId) > MAX_ID_BYTES || bytes(input.dedupKey) > MAX_ID_BYTES)
    return invalid("Event identity exceeds its size limit.");
  if (!Number.isFinite(Date.parse(input.occurredAt))) return invalid("Event timestamp is invalid.");
  const attributes = Object.entries(input.attributes);
  if (
    attributes.length > MAX_ATTRIBUTES ||
    attributes.some(
      ([key, value]) =>
        bytes(key) > MAX_ATTRIBUTE_KEY_BYTES || bytes(value) > MAX_ATTRIBUTE_VALUE_BYTES,
    )
  )
    return invalid("Event attributes exceed their size limit.");
  return null;
}

export interface OrganizationIntakeStoreShape {
  readonly registerSource: (
    input: OrganizationIntakeRegisterSourceInput,
    principal: OrganizationIntakeGovernancePrincipal,
  ) => Effect.Effect<OrganizationIntakeSourceRegistration, OrganizationIntakeError>;
  readonly rotateSourceSecret: (
    organizationId: OrganizationId,
    sourceId: OrganizationIntakeSourceId,
    principal: OrganizationIntakeGovernancePrincipal,
  ) => Effect.Effect<OrganizationIntakeSourceRegistration, OrganizationIntakeError>;
  readonly setSourceEnabled: (
    organizationId: OrganizationId,
    sourceId: OrganizationIntakeSourceId,
    enabled: boolean,
    principal: OrganizationIntakeGovernancePrincipal,
  ) => Effect.Effect<OrganizationIntakeSource, OrganizationIntakeError>;
  readonly listSources: (
    organizationId: OrganizationId,
  ) => Effect.Effect<ReadonlyArray<OrganizationIntakeSource>, OrganizationIntakeError>;
  readonly ingest: (
    input: OrganizationIntakeEventInput,
    authentication: OrganizationIntakeAuthentication,
  ) => Effect.Effect<OrganizationIntakeResult, OrganizationIntakeError>;
  /** HTTP adapter entry point: credential check and insert share one transaction. */
  readonly ingestWithCredential: (
    input: OrganizationIntakeEventInput,
    credential: string,
    requireProjectBoundSource?: boolean,
  ) => Effect.Effect<OrganizationIntakeResult, OrganizationIntakeError>;
  readonly listObservations: (
    organizationId: OrganizationId,
  ) => Effect.Effect<ReadonlyArray<OrganizationObservation>, OrganizationIntakeError>;
  readonly listCorrelationJobs: (
    organizationId: OrganizationId,
  ) => Effect.Effect<ReadonlyArray<OrganizationCorrelationJobStatus>, OrganizationIntakeError>;
  readonly getObservation: (
    organizationId: OrganizationId,
    observationId: OrganizationObservationId,
  ) => Effect.Effect<OrganizationObservation, OrganizationIntakeError>;
  readonly proposeFinding: (
    input: OrganizationTentativeFindingInput,
    principal: OrganizationIntakeGovernancePrincipal,
  ) => Effect.Effect<OrganizationTentativeFinding, OrganizationIntakeError>;
  readonly listTentativeFindings: (
    organizationId: OrganizationId,
  ) => Effect.Effect<ReadonlyArray<OrganizationTentativeFinding>, OrganizationIntakeError>;
  readonly listAudit: (
    organizationId: OrganizationId,
  ) => Effect.Effect<ReadonlyArray<OrganizationIntakeAuditEntry>, OrganizationIntakeError>;
}
export class OrganizationIntakeStore extends Context.Service<
  OrganizationIntakeStore,
  OrganizationIntakeStoreShape
>()("t3/organizations/OrganizationIntakeStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transaction = <A, E>(
    effect: Effect.Effect<A, E, never>,
  ): Effect.Effect<A, OrganizationIntakeError> =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          Schema.is(OrganizationIntakeError)(error) ? error : unavailable(),
        ),
      );
  const sourceRows = (organizationId: OrganizationId, sourceId: OrganizationIntakeSourceId) =>
    sql<SourceRow>`SELECT * FROM organization_intake_sources
      WHERE organization_id = ${organizationId} AND source_id = ${sourceId}`;
  const audit = (
    organizationId: OrganizationId,
    sourceId: OrganizationIntakeSourceId,
    actorSubject: string,
    action: OrganizationIntakeAuditEntry["action"],
    createdAt: string,
  ) =>
    sql`INSERT INTO organization_intake_audit
      (audit_id, organization_id, source_id, actor_subject, action, created_at)
      VALUES (${NodeCrypto.randomUUID()}, ${organizationId}, ${sourceId}, ${actorSubject},
        ${action}, ${createdAt})`;
  const requireUnarchivedOrganization = Effect.fnUntraced(function* (
    organizationId: OrganizationId,
  ) {
    const organization = (yield* sql<{ lifecycle: string }>`SELECT lifecycle FROM organizations
      WHERE organization_id = ${organizationId}`)[0];
    if (!organization || organization.lifecycle === "archived")
      return yield* forbidden(
        "Archived Organization cannot change intake sources or accept intake.",
      );
  });
  const requireSource = Effect.fnUntraced(function* (
    organizationId: OrganizationId,
    sourceId: OrganizationIntakeSourceId,
  ) {
    const row = (yield* sourceRows(organizationId, sourceId))[0];
    if (!row) return yield* notFound("Intake source not found in this Organization.");
    if (row.enabled !== 1) return yield* forbidden("Intake source is disabled.");
    yield* requireUnarchivedOrganization(organizationId);
    return row;
  });
  const requireActiveProjectBinding = Effect.fnUntraced(function* (
    organizationId: OrganizationId,
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{ binding_id: string }>`
      SELECT b.binding_id FROM organization_project_bindings b
      JOIN projection_projects p ON p.project_id = b.project_id
      WHERE b.organization_id = ${organizationId} AND b.project_id = ${projectId}
        AND b.detached_at IS NULL AND p.deleted_at IS NULL
    `;
    if (rows.length === 0)
      return yield* forbidden("Project is not currently bound to this Organization.");
  });
  const registerSource: OrganizationIntakeStoreShape["registerSource"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        if (!principal.canManageSources || !principal.subject.trim())
          return yield* forbidden(
            "Source configuration requires authenticated governance authority.",
          );
        if (
          bytes(input.name) > 160 ||
          bytes(input.ingestSubject) > 256 ||
          bytes(input.sourceId) > MAX_ID_BYTES
        )
          return yield* invalid("Source identity or name exceeds its size limit.");
        const organizations = yield* sql<{
          lifecycle: string;
        }>`SELECT lifecycle FROM organizations WHERE organization_id = ${input.organizationId}`;
        if (!organizations[0]) return yield* notFound("Organization not found.");
        if (organizations[0].lifecycle === "archived")
          return yield* forbidden("Archived Organization cannot register sources.");
        if (input.projectId !== null)
          yield* requireActiveProjectBinding(input.organizationId, input.projectId);
        const createdAt = yield* now;
        const ingestSecret = input.kind === "generic-http" ? newSecret() : null;
        const secretHash =
          ingestSecret === null
            ? null
            : hashSecret(input.organizationId, input.sourceId, ingestSecret);
        yield* sql`INSERT INTO organization_intake_sources
        (source_id, organization_id, project_id, kind, name, ingest_subject, enabled,
          secret_hash, credential_version, created_at, updated_at)
        VALUES (${input.sourceId}, ${input.organizationId}, ${input.projectId}, ${input.kind},
          ${input.name}, ${input.ingestSubject}, 1, ${secretHash}, 1, ${createdAt}, ${createdAt})`;
        yield* audit(
          input.organizationId,
          input.sourceId,
          principal.subject,
          "register",
          createdAt,
        );
        return {
          source: yield* decodeSource(
            (yield* sourceRows(input.organizationId, input.sourceId))[0]!,
          ),
          ingestSecret,
        };
      }),
    );
  const rotateSourceSecret: OrganizationIntakeStoreShape["rotateSourceSecret"] = (
    organizationId,
    sourceId,
    principal,
  ) =>
    transaction(
      Effect.gen(function* () {
        if (!principal.canManageSources || !principal.subject.trim())
          return yield* forbidden("Source rotation requires authenticated governance authority.");
        const row = (yield* sourceRows(organizationId, sourceId))[0];
        if (!row) return yield* notFound("Intake source not found in this Organization.");
        yield* requireUnarchivedOrganization(organizationId);
        if (row.kind !== "generic-http")
          return yield* invalid("Manual sources do not have an intake secret.");
        const ingestSecret = newSecret();
        const secretHash = hashSecret(organizationId, sourceId, ingestSecret);
        const updatedAt = yield* now;
        yield* sql`UPDATE organization_intake_sources
        SET secret_hash = ${secretHash}, credential_version = credential_version + 1,
          updated_at = ${updatedAt}
        WHERE organization_id = ${organizationId} AND source_id = ${sourceId}`;
        yield* audit(organizationId, sourceId, principal.subject, "rotate-secret", updatedAt);
        return {
          source: yield* decodeSource((yield* sourceRows(organizationId, sourceId))[0]!),
          ingestSecret,
        };
      }),
    );
  const setSourceEnabled: OrganizationIntakeStoreShape["setSourceEnabled"] = (
    organizationId,
    sourceId,
    enabled,
    principal,
  ) =>
    transaction(
      Effect.gen(function* () {
        if (!principal.canManageSources || !principal.subject.trim())
          return yield* forbidden(
            "Source configuration requires authenticated governance authority.",
          );
        const row = (yield* sourceRows(organizationId, sourceId))[0];
        if (!row) return yield* notFound("Intake source not found in this Organization.");
        yield* requireUnarchivedOrganization(organizationId);
        const updatedAt = yield* now;
        yield* sql`UPDATE organization_intake_sources SET enabled = ${enabled ? 1 : 0}, updated_at = ${updatedAt}
        WHERE organization_id = ${organizationId} AND source_id = ${sourceId}`;
        yield* audit(
          organizationId,
          sourceId,
          principal.subject,
          enabled ? "enable" : "disable",
          updatedAt,
        );
        return yield* decodeSource((yield* sourceRows(organizationId, sourceId))[0]!);
      }),
    );
  const listSources: OrganizationIntakeStoreShape["listSources"] = (organizationId) =>
    Effect.gen(function* () {
      const rows = yield* sql<SourceRow>`SELECT * FROM organization_intake_sources
        WHERE organization_id = ${organizationId} ORDER BY created_at, source_id`;
      const sources: OrganizationIntakeSource[] = [];
      for (const row of rows) sources.push(yield* decodeSource(row));
      return sources;
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(OrganizationIntakeError)(error) ? error : unavailable(),
      ),
    );
  const ingest: OrganizationIntakeStoreShape["ingest"] = (input, authentication) =>
    transaction(
      Effect.gen(function* () {
        const issue = validateEvent(input);
        if (issue) return yield* issue;
        const source = yield* requireSource(input.organizationId, input.sourceId);
        if (source.kind === "manual") {
          if (
            authentication.kind !== "interactive-user" ||
            authentication.subject !== source.ingest_subject
          )
            return yield* forbidden(
              "Interactive intake subject is not authorized for this source.",
            );
        } else {
          if (
            authentication.kind !== "source-secret" ||
            !source.secret_hash ||
            bytes(authentication.secret) > 128 ||
            !matchesSecret(
              source.secret_hash,
              hashSecret(input.organizationId, input.sourceId, authentication.secret),
            )
          )
            return yield* forbidden("Source intake credential is invalid.");
        }
        if (source.project_id !== null && source.project_id !== input.projectId)
          return yield* forbidden("Event Project is outside the source scope.");
        if (
          authentication.kind === "source-secret" &&
          authentication.requireProjectBoundSource &&
          source.project_id === null
        )
          return yield* forbidden("Relay intake requires a Project-scoped source.");
        if (input.projectId !== null)
          yield* requireActiveProjectBinding(input.organizationId, input.projectId);
        const existing = yield* sql<ObservationRow>`SELECT * FROM organization_intake_observations
        WHERE organization_id = ${input.organizationId} AND source_id = ${input.sourceId}
          AND (external_event_id = ${input.externalEventId} OR dedup_key = ${input.dedupKey})`;
        const sameEvent = existing.find((row) => row.external_event_id === input.externalEventId);
        if (sameEvent && sameEvent.dedup_key !== input.dedupKey)
          return yield* conflict("Source event ID was reused with a different dedup key.");
        const duplicate = sameEvent ?? existing[0];
        if (duplicate && duplicate.project_id !== input.projectId)
          return yield* conflict("Source event identity was reused across Project scopes.");
        if (duplicate)
          return { outcome: "duplicate", observation: yield* decodeObservation(duplicate) };
        const receivedDateTime = yield* DateTime.now;
        const receivedAt = DateTime.formatIso(receivedDateTime);
        const windowStart = DateTime.formatIso(
          DateTime.add(receivedDateTime, {
            milliseconds: -INTAKE_WINDOW_MS,
          }),
        );
        const observationId = OrganizationObservationId.make(
          stableId("observation", [input.organizationId, input.sourceId, input.dedupKey]),
        );
        const attributes = Object.fromEntries(
          Object.entries(input.attributes).map(([key, value]) => [
            key,
            SECRET_KEY.test(key) ? "[REDACTED]" : redact(value),
          ]),
        );
        const attributesJson = yield* Schema.encodeEffect(AttributesJson)(attributes);
        const inserted = yield* sql<{
          observation_id: string;
        }>`INSERT INTO organization_intake_observations
        (observation_id, organization_id, source_id, project_id, external_event_id,
          dedup_key, occurred_at, received_at, title, body, attributes_json)
        SELECT ${observationId}, ${input.organizationId}, ${input.sourceId}, ${input.projectId},
          ${input.externalEventId}, ${input.dedupKey}, ${input.occurredAt}, ${receivedAt},
          ${redact(input.title)}, ${redact(input.body)}, ${attributesJson}
        WHERE (SELECT COUNT(*) FROM organization_intake_observations
          WHERE organization_id = ${input.organizationId} AND source_id = ${input.sourceId}
            AND received_at >= ${windowStart}) < ${MAX_NEW_OBSERVATIONS_PER_SOURCE_PER_HOUR}
        RETURNING observation_id`;
        if (inserted.length === 0) return yield* rateLimited();
        const row =
          (yield* sql<ObservationRow>`SELECT * FROM organization_intake_observations WHERE observation_id = ${observationId}`)[0]!;
        yield* sql`INSERT INTO organization_intake_correlation_jobs
        (observation_id, state, attempts, next_attempt_at, updated_at)
        VALUES (${observationId}, 'pending', 0, ${receivedAt}, ${receivedAt})`;
        return { outcome: "recorded", observation: yield* decodeObservation(row) };
      }),
    );
  const listObservations: OrganizationIntakeStoreShape["listObservations"] = (organizationId) =>
    Effect.gen(function* () {
      const rows = yield* sql<ObservationRow>`SELECT * FROM organization_intake_observations
        WHERE organization_id = ${organizationId} ORDER BY received_at, observation_id`;
      const observations: OrganizationObservation[] = [];
      for (const row of rows) observations.push(yield* decodeObservation(row));
      return observations;
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(OrganizationIntakeError)(error) ? error : unavailable(),
      ),
    );
  const listCorrelationJobs: OrganizationIntakeStoreShape["listCorrelationJobs"] = (
    organizationId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        observation_id: string;
        state: string;
        attempts: number;
        outcome: string | null;
        last_error_code: string | null;
        next_attempt_at: string;
        updated_at: string;
      }>`SELECT j.observation_id, j.state, j.attempts, j.outcome, j.last_error_code,
          j.next_attempt_at, j.updated_at
        FROM organization_intake_correlation_jobs j
        JOIN organization_intake_observations o ON o.observation_id = j.observation_id
        WHERE o.organization_id = ${organizationId}
        ORDER BY j.updated_at DESC, j.observation_id`;
      const jobs: OrganizationCorrelationJobStatus[] = [];
      for (const row of rows)
        jobs.push(
          yield* Schema.decodeUnknownEffect(OrganizationCorrelationJobStatus)({
            observationId: row.observation_id,
            state: row.state,
            attempts: row.attempts,
            outcome: row.outcome,
            lastErrorCode: row.last_error_code,
            nextAttemptAt: row.next_attempt_at,
            updatedAt: row.updated_at,
          }).pipe(Effect.mapError(() => unavailable())),
        );
      return jobs;
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(OrganizationIntakeError)(error) ? error : unavailable(),
      ),
    );
  const getObservation: OrganizationIntakeStoreShape["getObservation"] = (
    organizationId,
    observationId,
  ) =>
    Effect.gen(function* () {
      const row = (yield* sql<ObservationRow>`SELECT * FROM organization_intake_observations
        WHERE organization_id = ${organizationId} AND observation_id = ${observationId}`)[0];
      if (!row)
        return yield* new OrganizationIntakeError({
          code: "not_found",
          message: "Observation not found in this Organization.",
        });
      return yield* decodeObservation(row);
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(OrganizationIntakeError)(error) ? error : unavailable(),
      ),
    );
  const proposeFinding: OrganizationIntakeStoreShape["proposeFinding"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        if (!principal.canManageSources || !principal.subject.trim())
          return yield* forbidden("Finding proposal requires authenticated governance authority.");
        yield* requireSource(input.organizationId, input.sourceId);
        if (
          input.observationIds.length === 0 ||
          new Set(input.observationIds).size !== input.observationIds.length
        )
          return yield* invalid("A tentative finding needs distinct evidence observations.");
        if (
          bytes(input.title) > MAX_TITLE_BYTES ||
          bytes(input.summary) > MAX_BODY_BYTES ||
          bytes(input.dedupKey) > MAX_ID_BYTES ||
          input.observationIds.length > 32
        )
          return yield* invalid("Tentative finding exceeds its size limit.");
        const evidence: Array<{
          observationId: OrganizationObservationId;
          sourceId: OrganizationIntakeSourceId;
          projectId: ProjectId | null;
        }> = [];
        for (const observationId of input.observationIds) {
          const observed = yield* sql<{
            observation_id: string;
            project_id: string | null;
          }>`SELECT observation_id, project_id
          FROM organization_intake_observations WHERE observation_id = ${observationId}
            AND organization_id = ${input.organizationId} AND source_id = ${input.sourceId}`;
          if (observed.length === 0)
            return yield* forbidden("Finding evidence is outside this source.");
          evidence.push({
            observationId,
            sourceId: input.sourceId,
            projectId:
              observed[0]!.project_id === null ? null : ProjectId.make(observed[0]!.project_id),
          });
        }
        const findingId = OrganizationTentativeFindingId.make(
          stableId("tentative-finding", [input.organizationId, input.sourceId, input.dedupKey]),
        );
        const existing =
          yield* sql<FindingRow>`SELECT * FROM organization_intake_findings WHERE finding_id = ${findingId}`;
        if (existing[0]) return yield* decodeFinding(existing[0]);
        const createdAt = yield* now;
        const observationIdsJson = yield* Schema.encodeEffect(EvidenceIdsJson)(
          input.observationIds,
        );
        const evidenceJson = yield* Schema.encodeEffect(EvidenceRefsJson)(evidence);
        const projectId =
          evidence[0]?.projectId !== null &&
          evidence.every((item) => item.projectId === evidence[0]?.projectId)
            ? evidence[0]!.projectId
            : null;
        yield* sql`INSERT INTO organization_intake_findings
        (finding_id, organization_id, source_id, dedup_key, title, summary,
          observation_ids_json, project_id, evidence_json, state, created_at)
        VALUES (${findingId}, ${input.organizationId}, ${input.sourceId}, ${input.dedupKey},
          ${redact(input.title)}, ${redact(input.summary)}, ${observationIdsJson},
          ${projectId}, ${evidenceJson},
          'tentative', ${createdAt})`;
        return yield* decodeFinding(
          (yield* sql<FindingRow>`SELECT * FROM organization_intake_findings WHERE finding_id = ${findingId}`)[0]!,
        );
      }),
    );
  const listTentativeFindings: OrganizationIntakeStoreShape["listTentativeFindings"] = (
    organizationId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<FindingRow>`SELECT * FROM organization_intake_findings
        WHERE organization_id = ${organizationId} ORDER BY created_at, finding_id`;
      const findings: OrganizationTentativeFinding[] = [];
      for (const row of rows) findings.push(yield* decodeFinding(row));
      return findings;
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(OrganizationIntakeError)(error) ? error : unavailable(),
      ),
    );
  const listAudit: OrganizationIntakeStoreShape["listAudit"] = (organizationId) =>
    Effect.gen(function* () {
      const rows = yield* sql<AuditRow>`SELECT * FROM organization_intake_audit
        WHERE organization_id = ${organizationId} ORDER BY sequence`;
      const entries: OrganizationIntakeAuditEntry[] = [];
      for (const row of rows) entries.push(yield* decodeAudit(row));
      return entries;
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(OrganizationIntakeError)(error) ? error : unavailable(),
      ),
    );
  const ingestWithCredential: OrganizationIntakeStoreShape["ingestWithCredential"] = (
    input,
    credential,
    requireProjectBoundSource = false,
  ) =>
    ingest(input, {
      kind: "source-secret",
      secret: credential,
      requireProjectBoundSource,
    });
  return {
    registerSource,
    rotateSourceSecret,
    setSourceEnabled,
    listSources,
    ingest,
    ingestWithCredential,
    listObservations,
    listCorrelationJobs,
    getObservation,
    proposeFinding,
    listTentativeFindings,
    listAudit,
  } satisfies OrganizationIntakeStoreShape;
});

export const OrganizationIntakeStoreLive = Layer.effect(OrganizationIntakeStore, make);

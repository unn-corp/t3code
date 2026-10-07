// @effect-diagnostics nodeBuiltinImport:off - This Node-only server module uses synchronous host crypto for persistent IDs or hashes; replacing it would add Crypto service requirements through the persistence API.
import * as NodeCrypto from "node:crypto";
import {
  OrganizationMemoryArchiveInput,
  OrganizationMemoryContent,
  OrganizationMemoryCorrectInput,
  OrganizationMemoryCreateInput,
  OrganizationMemoryError,
  OrganizationMemoryHistoryInput,
  OrganizationMemoryListInput,
  OrganizationMemoryMutationId,
  OrganizationMemoryRecord,
  OrganizationMemoryRecordId,
  OrganizationMemoryRevision,
  OrganizationMemorySupersedeInput,
} from "../../../../packages/contracts/src/organizationMemory.ts";
import type { OrganizationId } from "../../../../packages/contracts/src/organizations.ts";
import type { ProjectId } from "../../../../packages/contracts/src/baseSchemas.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { redactKnownCredentials } from "./CredentialRedaction.ts";

/** The transport supplies this principal from an authenticated interactive session. */
export interface OrganizationMemoryPrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}
export interface OrganizationMemoryStoreShape {
  readonly create: (
    input: OrganizationMemoryCreateInput,
    principal: OrganizationMemoryPrincipal,
  ) => Effect.Effect<OrganizationMemoryRecord, OrganizationMemoryError>;
  readonly correct: (
    input: OrganizationMemoryCorrectInput,
    principal: OrganizationMemoryPrincipal,
  ) => Effect.Effect<OrganizationMemoryRecord, OrganizationMemoryError>;
  readonly supersede: (
    input: OrganizationMemorySupersedeInput,
    principal: OrganizationMemoryPrincipal,
  ) => Effect.Effect<OrganizationMemoryRecord, OrganizationMemoryError>;
  readonly archive: (
    input: OrganizationMemoryArchiveInput,
    principal: OrganizationMemoryPrincipal,
  ) => Effect.Effect<OrganizationMemoryRecord, OrganizationMemoryError>;
  readonly list: (
    input: OrganizationMemoryListInput,
  ) => Effect.Effect<ReadonlyArray<OrganizationMemoryRecord>, OrganizationMemoryError>;
  readonly history: (
    input: OrganizationMemoryHistoryInput,
  ) => Effect.Effect<ReadonlyArray<OrganizationMemoryRevision>, OrganizationMemoryError>;
}
export class OrganizationMemoryStore extends Context.Service<
  OrganizationMemoryStore,
  OrganizationMemoryStoreShape
>()("t3/organizations/OrganizationMemoryStore") {}

type RecordRow = {
  record_id: string;
  organization_id: string;
  project_id: string | null;
  version: number;
  status: "active" | "archived" | "superseded";
  superseded_by_id: string | null;
  content_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type RevisionRow = {
  mutation_id: string;
  organization_id: string;
  record_id: string;
  version: number;
  action: "create" | "correct" | "archive" | "supersede";
  actor_subject: string;
  request_digest: string;
  snapshot_json: string;
  created_at: string;
};
const MAX_CONTENT_BYTES = 12 * 1024;
const MAX_SUBJECT_BYTES = 256;
const redact = redactKnownCredentials;
const sanitizeContent = (content: OrganizationMemoryContent): OrganizationMemoryContent => ({
  ...content,
  title: redact(content.title),
  body: redact(content.body),
  provenance: {
    ...content.provenance,
    reference: content.provenance.reference === null ? null : redact(content.provenance.reference),
    note: content.provenance.note === null ? null : redact(content.provenance.note),
  },
});
const json = (value: unknown) => JSON.stringify(value);
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(json(value)).digest("hex");
const issue = (code: OrganizationMemoryError["code"], message: string) =>
  new OrganizationMemoryError({ code, message });
const unavailable = () => issue("unavailable", "Organization memory storage is unavailable.");
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const ContentJson = Schema.fromJsonString(OrganizationMemoryContent);
const SnapshotJson = Schema.fromJsonString(OrganizationMemoryRecord);
const decodeRecord = (row: RecordRow) =>
  Effect.gen(function* () {
    const content = yield* Schema.decodeUnknownEffect(ContentJson)(row.content_json);
    return yield* Schema.decodeUnknownEffect(OrganizationMemoryRecord)({
      id: row.record_id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      version: row.version,
      status: row.status,
      supersededById: row.superseded_by_id,
      content,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }).pipe(Effect.mapError(() => unavailable()));
const decodeRevision = (row: RevisionRow) =>
  Effect.gen(function* () {
    const snapshot = yield* Schema.decodeUnknownEffect(SnapshotJson)(row.snapshot_json);
    return yield* Schema.decodeUnknownEffect(OrganizationMemoryRevision)({
      mutationId: row.mutation_id,
      organizationId: row.organization_id,
      recordId: row.record_id,
      version: row.version,
      action: row.action,
      actorSubject: row.actor_subject,
      snapshot,
      createdAt: row.created_at,
    });
  }).pipe(Effect.mapError(() => unavailable()));
const validDate = (value: string | null) =>
  value === null ||
  (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrganizationMemoryError)(cause) ? cause : unavailable(),
        ),
      );
  const requirePrincipal = (principal: OrganizationMemoryPrincipal) =>
    Effect.gen(function* () {
      if (
        principal.interactive !== true ||
        typeof principal.subject !== "string" ||
        !principal.subject.trim() ||
        Buffer.byteLength(principal.subject, "utf8") > MAX_SUBJECT_BYTES
      )
        return yield* issue("forbidden", "An authenticated interactive user is required.");
    });
  const requireOrganization = (organizationId: OrganizationId, write: boolean) =>
    Effect.gen(function* () {
      const org = (yield* sql<{ lifecycle: string }>`SELECT lifecycle FROM organizations
        WHERE organization_id = ${organizationId}`)[0];
      if (!org) return yield* issue("not_found", "Organization not found.");
      if (write && org.lifecycle === "archived")
        return yield* issue("forbidden", "Archived Organization memory cannot be changed.");
    });
  const requireScope = (organizationId: OrganizationId, projectId: ProjectId | null) =>
    Effect.gen(function* () {
      if (projectId === null) return;
      const rows = yield* sql<{ project_id: string }>`
        SELECT p.project_id FROM organization_project_bindings b
        JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
        WHERE b.organization_id = ${organizationId} AND b.project_id = ${projectId}
          AND b.detached_at IS NULL LIMIT 1`;
      if (rows.length === 0)
        return yield* issue("forbidden", "Project is not currently bound to this Organization.");
    });
  const requireHistoricalScope = (organizationId: OrganizationId, projectId: ProjectId | null) =>
    Effect.gen(function* () {
      if (projectId === null) return;
      const rows = yield* sql<{ binding_id: string }>`
        SELECT binding_id FROM organization_project_bindings
        WHERE organization_id = ${organizationId} AND project_id = ${projectId} LIMIT 1`;
      if (rows.length === 0)
        return yield* issue("forbidden", "Project was never bound to this Organization.");
    });
  const requireContent = (content: unknown) =>
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeUnknownEffect(OrganizationMemoryContent)(content).pipe(
        Effect.mapError(() => issue("invalid", "Memory content is invalid.")),
      );
      if (
        !validDate(parsed.reviewedAt) ||
        !validDate(parsed.staleAt) ||
        !validDate(parsed.retainUntil)
      )
        return yield* issue("invalid", "Memory timestamps must be ISO UTC timestamps.");
      if (parsed.provenance.kind === "explicit-reference" && parsed.provenance.reference === null)
        return yield* issue("invalid", "Explicit provenance requires a reference.");
      const sanitized = sanitizeContent(parsed);
      if (Buffer.byteLength(json(sanitized), "utf8") > MAX_CONTENT_BYTES)
        return yield* issue("invalid", "Memory content exceeds its size limit.");
      return sanitized;
    });
  const rowFor = (recordId: OrganizationMemoryRecordId) =>
    sql<RecordRow>`SELECT * FROM organization_memory_records WHERE record_id = ${recordId}`;
  const checkedRow = Effect.fnUntraced(function* (
    organizationId: OrganizationId,
    recordId: OrganizationMemoryRecordId,
    write = true,
  ) {
    const row = (yield* rowFor(recordId))[0];
    if (!row || row.organization_id !== organizationId)
      return yield* issue("not_found", "Memory record not found in this Organization.");
    yield* (write ? requireScope : requireHistoricalScope)(
      organizationId,
      row.project_id as ProjectId | null,
    );
    return row;
  });
  const duplicate = Effect.fnUntraced(function* (
    mutationId: OrganizationMemoryMutationId,
    organizationId: OrganizationId,
    actor: string,
    requestDigest: string,
  ) {
    const row = (yield* sql<RevisionRow>`SELECT * FROM organization_memory_revisions
      WHERE mutation_id = ${mutationId}`)[0];
    if (!row) return null;
    if (
      row.organization_id !== organizationId ||
      row.actor_subject !== actor ||
      row.request_digest !== requestDigest
    )
      return yield* issue("conflict", "Memory mutation ID was reused for a different request.");
    const target = yield* checkedRow(
      organizationId,
      OrganizationMemoryRecordId.make(row.record_id),
      false,
    );
    // Return the applied snapshot even if the record was edited again later.
    yield* decodeRecord(target);
    const revision = yield* decodeRevision(row);
    return revision.snapshot;
  });
  const appendRevision = (
    mutationId: OrganizationMemoryMutationId,
    action: RevisionRow["action"],
    actor: string,
    requestDigest: string,
    record: OrganizationMemoryRecord,
  ) => sql`INSERT INTO organization_memory_revisions
      (mutation_id, organization_id, record_id, version, action, actor_subject,
        request_digest, snapshot_json, created_at)
      VALUES (${mutationId}, ${record.organizationId}, ${record.id}, ${record.version},
        ${action}, ${actor}, ${requestDigest}, ${json(record)}, ${record.updatedAt})`;
  const create: OrganizationMemoryStoreShape["create"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        yield* requirePrincipal(principal);
        const parsed = yield* Schema.decodeUnknownEffect(OrganizationMemoryCreateInput)(input).pipe(
          Effect.mapError(() => issue("invalid", "Memory creation is invalid.")),
        );
        const content = yield* requireContent(parsed.content);
        const requestDigest = digest(parsed);
        yield* requireOrganization(parsed.organizationId, false);
        const prior = yield* duplicate(
          parsed.mutationId,
          parsed.organizationId,
          principal.subject,
          requestDigest,
        );
        if (prior) return prior;
        yield* requireOrganization(parsed.organizationId, true);
        yield* requireScope(parsed.organizationId, parsed.projectId);
        if ((yield* rowFor(parsed.recordId)).length !== 0)
          return yield* issue("conflict", "Memory record ID already exists.");
        const time = yield* now;
        yield* sql`INSERT INTO organization_memory_records
        (record_id, organization_id, project_id, version, status, superseded_by_id,
          content_json, created_by, created_at, updated_at)
        VALUES (${parsed.recordId}, ${parsed.organizationId}, ${parsed.projectId}, 1,
          'active', NULL, ${json(content)}, ${principal.subject}, ${time}, ${time})`;
        const record = yield* decodeRecord((yield* rowFor(parsed.recordId))[0]!);
        yield* appendRevision(
          parsed.mutationId,
          "create",
          principal.subject,
          requestDigest,
          record,
        );
        return record;
      }),
    );
  const revise = <
    I extends
      | OrganizationMemoryCorrectInput
      | OrganizationMemoryArchiveInput
      | OrganizationMemorySupersedeInput,
  >(
    input: I,
    principal: OrganizationMemoryPrincipal,
    action: RevisionRow["action"],
  ) =>
    transaction(
      Effect.gen(function* () {
        yield* requirePrincipal(principal);
        const schema =
          action === "correct"
            ? OrganizationMemoryCorrectInput
            : action === "archive"
              ? OrganizationMemoryArchiveInput
              : OrganizationMemorySupersedeInput;
        const parsed = yield* Schema.decodeUnknownEffect(schema)(input).pipe(
          Effect.mapError(() => issue("invalid", "Memory change is invalid.")),
        );
        const requestDigest = digest(parsed);
        yield* requireOrganization(parsed.organizationId, false);
        const prior = yield* duplicate(
          parsed.mutationId,
          parsed.organizationId,
          principal.subject,
          requestDigest,
        );
        if (prior) return prior;
        yield* requireOrganization(parsed.organizationId, true);
        const row = yield* checkedRow(parsed.organizationId, parsed.recordId);
        if (row.version !== parsed.expectedVersion)
          return yield* issue("conflict", "Memory record version changed.");
        if (row.status !== "active")
          return yield* issue("conflict", "Only active memory records can be changed.");
        let contentJson = row.content_json;
        let nextStatus: RecordRow["status"] = row.status;
        let replacement: string | null = null;
        if (action === "correct") {
          contentJson = json(
            yield* requireContent((parsed as OrganizationMemoryCorrectInput).content),
          );
        } else if (action === "archive") {
          nextStatus = "archived";
        } else {
          const replacementId = (parsed as OrganizationMemorySupersedeInput).replacementRecordId;
          if (replacementId === parsed.recordId)
            return yield* issue("invalid", "A record cannot supersede itself.");
          const next = yield* checkedRow(parsed.organizationId, replacementId);
          if (next.project_id !== row.project_id || next.status !== "active")
            return yield* issue("conflict", "Replacement must be active in the same scope.");
          nextStatus = "superseded";
          replacement = replacementId;
        }
        const time = yield* now;
        yield* sql`UPDATE organization_memory_records
        SET version = ${row.version + 1}, status = ${nextStatus},
          superseded_by_id = ${replacement}, content_json = ${contentJson}, updated_at = ${time}
        WHERE record_id = ${row.record_id} AND version = ${row.version}`;
        const record = yield* decodeRecord((yield* rowFor(parsed.recordId))[0]!);
        yield* appendRevision(parsed.mutationId, action, principal.subject, requestDigest, record);
        return record;
      }),
    );
  const correct: OrganizationMemoryStoreShape["correct"] = (input, principal) =>
    revise(input, principal, "correct");
  const archive: OrganizationMemoryStoreShape["archive"] = (input, principal) =>
    revise(input, principal, "archive");
  const supersede: OrganizationMemoryStoreShape["supersede"] = (input, principal) =>
    revise(input, principal, "supersede");
  const list: OrganizationMemoryStoreShape["list"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeUnknownEffect(OrganizationMemoryListInput)(input).pipe(
          Effect.mapError(() => issue("invalid", "Memory list scope is invalid.")),
        );
        yield* requireOrganization(parsed.organizationId, false);
        yield* requireHistoricalScope(parsed.organizationId, parsed.projectId);
        const rows = yield* sql<RecordRow>`SELECT * FROM organization_memory_records
        WHERE organization_id = ${parsed.organizationId} AND project_id IS ${parsed.projectId}
        ORDER BY updated_at DESC, record_id LIMIT 100 OFFSET ${parsed.offset ?? 0}`;
        const result: OrganizationMemoryRecord[] = [];
        for (const row of rows) result.push(yield* decodeRecord(row));
        return result;
      }),
    );
  const history: OrganizationMemoryStoreShape["history"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeUnknownEffect(OrganizationMemoryHistoryInput)(
          input,
        ).pipe(Effect.mapError(() => issue("invalid", "Memory history scope is invalid.")));
        yield* requireOrganization(parsed.organizationId, false);
        const row = yield* checkedRow(parsed.organizationId, parsed.recordId, false);
        if (row.project_id !== parsed.projectId)
          return yield* issue("not_found", "Memory record not found in this scope.");
        const rows = yield* sql<RevisionRow>`SELECT * FROM organization_memory_revisions
        WHERE organization_id = ${parsed.organizationId} AND record_id = ${parsed.recordId}
        ORDER BY version DESC LIMIT 100 OFFSET ${parsed.offset ?? 0}`;
        const result: OrganizationMemoryRevision[] = [];
        for (const revision of rows) result.push(yield* decodeRevision(revision));
        return result;
      }),
    );
  return {
    create,
    correct,
    supersede,
    archive,
    list,
    history,
  } satisfies OrganizationMemoryStoreShape;
});
export const OrganizationMemoryStoreLive = Layer.effect(OrganizationMemoryStore, make);

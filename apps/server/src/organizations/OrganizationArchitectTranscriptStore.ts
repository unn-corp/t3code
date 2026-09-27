import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  OrganizationArchitectAllowedChange,
  OrganizationArchitectMessage,
  OrganizationArchitectMessageId,
  OrganizationArchitectProposal,
  OrganizationArchitectProposalId,
  OrganizationArchitectRequestStatus,
  OrganizationArchitectSendInput,
  OrganizationArchitectTurnOutput,
  OrganizationArchitectError,
  type OrganizationArchitectBeginResult,
  type OrganizationArchitectListInput,
  type OrganizationArchitectListResult,
  type OrganizationArchitectSendResult,
} from "../../../../packages/contracts/src/organizationArchitect.ts";
import { ModelSelection } from "../../../../packages/contracts/src/orchestration.ts";
import type { OrganizationId } from "../../../../packages/contracts/src/organizations.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { redactOrganizationArchitectText } from "./OrganizationArchitectRedaction.ts";

/** The server transport supplies this subject. It is never taken from message JSON. */
export interface OrganizationArchitectPrincipal {
  readonly subject: string;
}
export interface OrganizationArchitectCompletionInput {
  readonly organizationId: OrganizationId;
  readonly messageId: OrganizationArchitectMessageId;
  readonly output: OrganizationArchitectTurnOutput;
}
export interface OrganizationArchitectFailureInput {
  readonly organizationId: OrganizationId;
  readonly messageId: OrganizationArchitectMessageId;
  /** A server-authored, credential-free explanation for the failed request. */
  readonly failureMessage?: string;
}

type RequestRow = {
  request_id: string;
  organization_id: string;
  actor_subject: string;
  base_revision: number;
  input_digest: string;
  status: "pending" | "completed" | "failed";
  failure_message: string | null;
  completion_digest: string | null;
  created_at: string;
  updated_at: string;
};
type MessageRow = {
  message_id: string;
  organization_id: string;
  request_id: string;
  role: "user" | "architect";
  text: string;
  base_revision: number;
  model_selection_json: string | null;
  created_at: string;
};
type ProposalRow = {
  proposal_id: string;
  organization_id: string;
  request_id: string;
  response_message_id: string;
  position: number;
  base_revision: number;
  change_json: string;
  created_at: string;
};

const MAX_TEXT_BYTES = 16 * 1024;
const MAX_USER_TEXT_BYTES = 4_000;
const MAX_MODEL_BYTES = 8 * 1024;
const MAX_CHANGE_BYTES = 16 * 1024;
const TRANSCRIPT_REQUEST_LIMIT = 50;
const PENDING_EXPIRY_SECONDS = 120;
const FAILURE_MESSAGE =
  "The Architect could not complete this request. Send a new message to retry.";
const EXPIRED_MESSAGE =
  "The Architect request expired before completion. Send a new message to retry.";
const redact = redactOrganizationArchitectText;
const redactStrings = (value: unknown): unknown => {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redact(key), redactStrings(entry)]),
    );
  return value;
};
const error = (code: OrganizationArchitectError["code"], message: string) =>
  new OrganizationArchitectError({ code, message });
const invalid = (message: string) => error("invalid", message);
const conflict = (message: string) => error("conflict", message);
const forbidden = (message: string) => error("forbidden", message);
const unavailable = () => error("unavailable", "Architect transcript storage is unavailable.");
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const stableId = (kind: string, requestId: string, position = 0) =>
  `${kind}:${hash(`${requestId}:${position}`)}`;
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const JsonUnknown = Schema.fromJsonString(Schema.Unknown);
const ModelSelectionJson = Schema.fromJsonString(ModelSelection);
const ChangeJson = Schema.fromJsonString(OrganizationArchitectAllowedChange);
const json = (value: unknown) => Schema.encodeSync(JsonUnknown)(value);

const decodeMessage = (row: MessageRow) =>
  Effect.gen(function* () {
    const modelSelection =
      row.model_selection_json === null
        ? null
        : yield* Schema.decodeUnknownEffect(ModelSelectionJson)(row.model_selection_json);
    return yield* Schema.decodeUnknownEffect(OrganizationArchitectMessage)({
      id: row.message_id,
      organizationId: row.organization_id,
      requestId: row.request_id,
      role: row.role,
      text: row.text,
      baseRevision: row.base_revision,
      modelSelection,
      createdAt: row.created_at,
    });
  }).pipe(Effect.mapError(() => unavailable()));
const decodeProposal = (row: ProposalRow) =>
  Effect.gen(function* () {
    const change = yield* Schema.decodeUnknownEffect(ChangeJson)(row.change_json);
    return yield* Schema.decodeUnknownEffect(OrganizationArchitectProposal)({
      id: row.proposal_id,
      organizationId: row.organization_id,
      responseMessageId: row.response_message_id,
      baseRevision: row.base_revision,
      change,
      createdAt: row.created_at,
    });
  }).pipe(Effect.mapError(() => unavailable()));
const decodeRequestStatus = (row: RequestRow) =>
  Schema.decodeUnknownEffect(OrganizationArchitectRequestStatus)({
    requestId: row.request_id,
    organizationId: row.organization_id,
    baseRevision: row.base_revision,
    status: row.status,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }).pipe(Effect.mapError(() => unavailable()));

export interface OrganizationArchitectTranscriptStoreShape {
  readonly begin: (
    input: OrganizationArchitectSendInput,
    principal: OrganizationArchitectPrincipal,
  ) => Effect.Effect<OrganizationArchitectBeginResult, OrganizationArchitectError>;
  readonly complete: (
    input: OrganizationArchitectCompletionInput,
    principal: OrganizationArchitectPrincipal,
  ) => Effect.Effect<OrganizationArchitectSendResult, OrganizationArchitectError>;
  readonly fail: (
    input: OrganizationArchitectFailureInput,
    principal: OrganizationArchitectPrincipal,
  ) => Effect.Effect<void, OrganizationArchitectError>;
  readonly list: (
    input: OrganizationArchitectListInput,
  ) => Effect.Effect<OrganizationArchitectListResult, OrganizationArchitectError>;
}
export class OrganizationArchitectTranscriptStore extends Context.Service<
  OrganizationArchitectTranscriptStore,
  OrganizationArchitectTranscriptStoreShape
>()("t3/organizations/OrganizationArchitectTranscriptStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrganizationArchitectError)(cause) ? cause : unavailable(),
        ),
      );
  const requestRows = (requestId: OrganizationArchitectMessageId) =>
    sql<RequestRow>`SELECT * FROM organization_architect_requests WHERE request_id = ${requestId}`;
  const messagesForRequest = (requestId: OrganizationArchitectMessageId) =>
    sql<MessageRow>`SELECT * FROM organization_architect_messages
      WHERE request_id = ${requestId} ORDER BY CASE role WHEN 'user' THEN 0 ELSE 1 END`;
  const proposalsForRequest = (requestId: OrganizationArchitectMessageId) =>
    sql<ProposalRow>`SELECT * FROM organization_architect_proposals
      WHERE request_id = ${requestId} ORDER BY position`;
  const resultForRequest = Effect.fnUntraced(function* (requestId: OrganizationArchitectMessageId) {
    const messages = yield* messagesForRequest(requestId);
    const user = messages.find((row) => row.role === "user");
    const response = messages.find((row) => row.role === "architect");
    if (!user || !response) return yield* unavailable();
    const proposals: OrganizationArchitectProposal[] = [];
    for (const row of yield* proposalsForRequest(requestId))
      proposals.push(yield* decodeProposal(row));
    return {
      userMessage: yield* decodeMessage(user),
      responseMessage: yield* decodeMessage(response),
      proposals,
    } satisfies OrganizationArchitectSendResult;
  });
  const checkedRequest = Effect.fnUntraced(function* (
    input: OrganizationArchitectFailureInput,
    principal: OrganizationArchitectPrincipal,
  ) {
    const row = (yield* requestRows(input.messageId))[0];
    if (!row || row.organization_id !== input.organizationId)
      return yield* error("not_found", "Architect request not found in this Organization.");
    if (!principal.subject.trim() || row.actor_subject !== principal.subject)
      return yield* forbidden("Architect request belongs to a different authenticated actor.");
    return row;
  });
  const expireStalePending = Effect.fnUntraced(function* (organizationId: OrganizationId) {
    const currentTime = yield* DateTime.now;
    const time = DateTime.formatIso(currentTime);
    const cutoff = DateTime.formatIso(
      DateTime.add(currentTime, { seconds: -PENDING_EXPIRY_SECONDS }),
    );
    const stale = yield* sql<RequestRow>`SELECT * FROM organization_architect_requests
      WHERE organization_id = ${organizationId} AND status = 'pending'
        AND created_at < ${cutoff}`;
    for (const row of stale) {
      const updated = yield* sql<{ request_id: string }>`UPDATE organization_architect_requests
        SET status = 'failed', failure_message = ${EXPIRED_MESSAGE}, updated_at = ${time}
        WHERE request_id = ${row.request_id} AND status = 'pending'
        RETURNING request_id`;
      if (updated.length === 0) continue;
      const responseMessageId = OrganizationArchitectMessageId.make(
        stableId("architect-response", row.request_id),
      );
      yield* sql`INSERT INTO organization_architect_messages
        (message_id, organization_id, request_id, role, text, base_revision, created_at)
        VALUES (${responseMessageId}, ${organizationId}, ${row.request_id},
          'architect', ${EXPIRED_MESSAGE}, ${row.base_revision}, ${time})`;
    }
  });
  const begin: OrganizationArchitectTranscriptStoreShape["begin"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        if (!principal.subject.trim())
          return yield* forbidden("An authenticated actor is required.");
        const parsed = yield* Schema.decodeUnknownEffect(OrganizationArchitectSendInput)(
          input,
        ).pipe(Effect.mapError(() => invalid("Architect message is invalid.")));
        if (Buffer.byteLength(parsed.text, "utf8") > MAX_USER_TEXT_BYTES)
          return yield* invalid("Architect message exceeds its size limit.");
        const modelJson = yield* Schema.encodeEffect(ModelSelectionJson)(
          parsed.modelSelection,
        ).pipe(Effect.mapError(() => invalid("Model selection is invalid.")));
        if (Buffer.byteLength(modelJson, "utf8") > MAX_MODEL_BYTES)
          return yield* invalid("Model selection exceeds its size limit.");
        const inputDigest = hash(
          json([
            parsed.organizationId,
            parsed.messageId,
            parsed.baseRevision,
            parsed.text,
            modelJson,
            principal.subject,
          ]),
        );
        yield* expireStalePending(parsed.organizationId);
        const previous = (yield* requestRows(parsed.messageId))[0];
        if (previous) {
          if (
            previous.organization_id !== parsed.organizationId ||
            previous.actor_subject !== principal.subject ||
            previous.input_digest !== inputDigest
          )
            return yield* conflict("Architect request ID was reused for a different request.");
          return {
            shouldGenerate: false,
            status: previous.status,
            result:
              previous.status === "completed" ? yield* resultForRequest(parsed.messageId) : null,
          };
        }
        const organization = (yield* sql<{ lifecycle: string; draft_revision: number }>`
        SELECT lifecycle, draft_revision FROM organizations
        WHERE organization_id = ${parsed.organizationId}`)[0];
        if (!organization) return yield* error("not_found", "Organization not found.");
        if (organization.lifecycle === "archived")
          return yield* forbidden("Archived Organization cannot start Architect generation.");
        if (organization.draft_revision !== parsed.baseRevision)
          return yield* conflict(
            "Organization draft revision changed before Architect generation.",
          );
        const pending = yield* sql<{ request_id: string }>`SELECT request_id
        FROM organization_architect_requests WHERE organization_id = ${parsed.organizationId}
          AND status = 'pending'`;
        if (pending.length > 0)
          return yield* conflict(
            "Another Architect request is already pending for this Organization.",
          );
        const time = yield* now;
        const inserted = yield* sql<{
          request_id: string;
        }>`INSERT OR IGNORE INTO organization_architect_requests
        (request_id, organization_id, actor_subject, base_revision, input_digest,
          status, created_at, updated_at)
        VALUES (${parsed.messageId}, ${parsed.organizationId}, ${principal.subject},
          ${parsed.baseRevision}, ${inputDigest}, 'pending', ${time}, ${time})
        RETURNING request_id`;
        if (inserted.length === 0)
          return yield* conflict(
            "Another Architect request is already pending for this Organization.",
          );
        yield* sql`INSERT INTO organization_architect_messages
        (message_id, organization_id, request_id, role, text, base_revision,
          model_selection_json, created_at)
        VALUES (${parsed.messageId}, ${parsed.organizationId}, ${parsed.messageId},
          'user', ${redact(parsed.text)}, ${parsed.baseRevision}, ${modelJson}, ${time})`;
        return { shouldGenerate: true, status: "pending", result: null };
      }),
    );
  const complete: OrganizationArchitectTranscriptStoreShape["complete"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        const request = yield* checkedRequest(input, principal);
        const output = yield* Schema.decodeUnknownEffect(OrganizationArchitectTurnOutput)(
          input.output,
        ).pipe(Effect.mapError(() => invalid("Architect output is invalid.")));
        if (Buffer.byteLength(output.reply, "utf8") > MAX_TEXT_BYTES)
          return yield* invalid("Architect reply exceeds its size limit.");
        if (output.proposals.some((proposal) => proposal.baseRevision !== request.base_revision))
          return yield* conflict("Architect proposal revision differs from its request.");
        const changes: string[] = [];
        for (const proposal of output.proposals) {
          const sanitized = yield* Schema.decodeUnknownEffect(OrganizationArchitectAllowedChange)(
            redactStrings(proposal.change),
          ).pipe(
            Effect.mapError(() => invalid("Architect proposal became invalid after redaction.")),
          );
          const encoded = yield* Schema.encodeEffect(ChangeJson)(sanitized).pipe(
            Effect.mapError(() => invalid("Architect proposal is invalid.")),
          );
          if (Buffer.byteLength(encoded, "utf8") > MAX_CHANGE_BYTES)
            return yield* invalid("Architect proposal exceeds its size limit.");
          changes.push(encoded);
        }
        const completionDigest = hash(json([output.reply, output.proposals]));
        if (request.status === "completed") {
          if (request.completion_digest !== completionDigest)
            return yield* conflict("Architect request already completed with different output.");
          return yield* resultForRequest(input.messageId);
        }
        if (request.status !== "pending")
          return yield* conflict("Architect request has already failed.");
        const time = yield* now;
        const responseMessageId = OrganizationArchitectMessageId.make(
          stableId("architect-response", input.messageId),
        );
        const user = (yield* messagesForRequest(input.messageId)).find(
          (row) => row.role === "user",
        );
        if (!user) return yield* unavailable();
        yield* sql`INSERT INTO organization_architect_messages
        (message_id, organization_id, request_id, role, text, base_revision,
          model_selection_json, created_at)
        VALUES (${responseMessageId}, ${input.organizationId}, ${input.messageId},
          'architect', ${redact(output.reply)}, ${request.base_revision},
          ${user.model_selection_json}, ${time})`;
        for (const [position, proposal] of output.proposals.entries()) {
          const proposalId = OrganizationArchitectProposalId.make(
            stableId("architect-proposal", input.messageId, position),
          );
          yield* sql`INSERT INTO organization_architect_proposals
          (proposal_id, organization_id, request_id, response_message_id,
            position, base_revision, change_json, created_at)
          VALUES (${proposalId}, ${input.organizationId}, ${input.messageId},
            ${responseMessageId}, ${position}, ${proposal.baseRevision}, ${changes[position]!},
            ${time})`;
        }
        yield* sql`UPDATE organization_architect_requests
        SET status = 'completed', completion_digest = ${completionDigest}, updated_at = ${time}
        WHERE request_id = ${input.messageId}`;
        return yield* resultForRequest(input.messageId);
      }),
    );
  const fail: OrganizationArchitectTranscriptStoreShape["fail"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        const request = yield* checkedRequest(input, principal);
        if (request.status === "failed") return;
        if (request.status === "completed")
          return yield* conflict("Completed Architect request cannot be failed.");
        const failureMessage = input.failureMessage ?? FAILURE_MESSAGE;
        const time = yield* now;
        const responseMessageId = OrganizationArchitectMessageId.make(
          stableId("architect-response", input.messageId),
        );
        yield* sql`INSERT INTO organization_architect_messages
        (message_id, organization_id, request_id, role, text, base_revision, created_at)
        VALUES (${responseMessageId}, ${input.organizationId}, ${input.messageId},
          'architect', ${failureMessage}, ${request.base_revision}, ${time})`;
        yield* sql`UPDATE organization_architect_requests SET status = 'failed',
        failure_message = ${failureMessage}, updated_at = ${time}
        WHERE request_id = ${input.messageId}`;
      }),
    );
  const list: OrganizationArchitectTranscriptStoreShape["list"] = (input) =>
    transaction(
      Effect.gen(function* () {
        yield* expireStalePending(input.organizationId);
        const requestRows = yield* sql<RequestRow>`SELECT * FROM organization_architect_requests
        WHERE organization_id = ${input.organizationId}
        ORDER BY created_at DESC, request_id DESC LIMIT ${TRANSCRIPT_REQUEST_LIMIT}`;
        const requests = [];
        for (const row of [...requestRows].reverse())
          requests.push(yield* decodeRequestStatus(row));
        const messages: OrganizationArchitectMessage[] = [];
        for (const row of yield* sql<MessageRow>`SELECT * FROM organization_architect_messages
        WHERE organization_id = ${input.organizationId} AND request_id IN (
          SELECT request_id FROM organization_architect_requests
          WHERE organization_id = ${input.organizationId}
          ORDER BY created_at DESC, request_id DESC LIMIT ${TRANSCRIPT_REQUEST_LIMIT}
        ) ORDER BY created_at, request_id, CASE role WHEN 'user' THEN 0 ELSE 1 END`)
          messages.push(yield* decodeMessage(row));
        const proposals: OrganizationArchitectProposal[] = [];
        for (const row of yield* sql<ProposalRow>`SELECT * FROM organization_architect_proposals
        WHERE organization_id = ${input.organizationId} AND request_id IN (
          SELECT request_id FROM organization_architect_requests
          WHERE organization_id = ${input.organizationId}
          ORDER BY created_at DESC, request_id DESC LIMIT ${TRANSCRIPT_REQUEST_LIMIT}
        ) ORDER BY created_at, request_id, position`)
          proposals.push(yield* decodeProposal(row));
        const applied = yield* sql<{
          mutation_id: string;
          payload_json: string;
          change_json: string;
        }>`SELECT a.mutation_id, a.payload_json, p.change_json
        FROM organization_audit a
        JOIN organization_architect_proposals p ON p.proposal_id = a.mutation_id
        WHERE a.organization_id = ${input.organizationId}
          AND p.organization_id = ${input.organizationId}
          AND a.action = json_extract(p.change_json, '$.type') AND a.actor = 'user'
          AND a.base_revision = p.base_revision
          AND p.request_id IN (
            SELECT request_id FROM organization_architect_requests
            WHERE organization_id = ${input.organizationId}
            ORDER BY created_at DESC, request_id DESC LIMIT ${TRANSCRIPT_REQUEST_LIMIT}
          )`;
        const appliedProposalIds = applied
          .filter((row) => {
            try {
              return NodeUtil.isDeepStrictEqual(
                JSON.parse(row.payload_json),
                JSON.parse(row.change_json),
              );
            } catch {
              return false;
            }
          })
          .map((row) => OrganizationArchitectProposalId.make(row.mutation_id));
        const batchAudits = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM organization_audit
        WHERE organization_id = ${input.organizationId}
          AND action = 'architect-batch' AND actor = 'user'
          AND base_revision IN (
            SELECT DISTINCT base_revision FROM organization_architect_proposals
            WHERE organization_id = ${input.organizationId}
              AND request_id IN (
                SELECT request_id FROM organization_architect_requests
                WHERE organization_id = ${input.organizationId}
                ORDER BY created_at DESC, request_id DESC LIMIT ${TRANSCRIPT_REQUEST_LIMIT}
              )
          )`;
        const visibleProposalIds = new Set(proposals.map((proposal) => proposal.id));
        for (const row of batchAudits) {
          const decoded = yield* Schema.decodeUnknownEffect(JsonUnknown)(row.payload_json).pipe(
            Effect.result,
          );
          if (decoded._tag === "Failure") continue;
          const payload = decoded.success;
          if (!payload || typeof payload !== "object") continue;
          const ids = Reflect.get(payload, "proposalIds");
          if (!Array.isArray(ids)) continue;
          for (const id of ids) {
            if (
              typeof id === "string" &&
              visibleProposalIds.has(OrganizationArchitectProposalId.make(id))
            )
              appliedProposalIds.push(OrganizationArchitectProposalId.make(id));
          }
        }
        return {
          messages,
          proposals,
          requests,
          appliedProposalIds,
        } satisfies OrganizationArchitectListResult;
      }),
    );
  return { begin, complete, fail, list } satisfies OrganizationArchitectTranscriptStoreShape;
});

export const OrganizationArchitectTranscriptStoreLive = Layer.effect(
  OrganizationArchitectTranscriptStore,
  make,
);

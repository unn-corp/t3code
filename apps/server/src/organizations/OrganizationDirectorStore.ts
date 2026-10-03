import * as NodeCrypto from "node:crypto";
import {
  OrganizationDirectorAskInput,
  OrganizationDirectorError,
  OrganizationDirectorEvidence,
  OrganizationDirectorListInput,
  OrganizationDirectorMessage,
  type OrganizationDirectorAskResult,
  type OrganizationDirectorListResult,
} from "../../../../packages/contracts/src/organizationDirector.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { redactOrganizationArchitectText } from "./OrganizationArchitectRedaction.ts";

export interface OrganizationDirectorPrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}
type RequestRow = {
  request_id: string;
  organization_id: string;
  project_id: string | null;
  actor_subject: string;
  request_digest: string;
};
type MessageRow = {
  sequence: number;
  message_id: string;
  organization_id: string;
  project_id: string | null;
  request_id: string;
  role: string;
  text: string;
  evidence_json: string;
  created_at: string;
};
type EvidenceRow = { id: string; project_id: string | null };
type OrgRow = { lifecycle: string; published_revision: number | null };
type ModeRow = { observation_mode_enabled: number };

const Json = Schema.fromJsonString(Schema.Unknown);
const EvidenceJson = Schema.fromJsonString(
  Schema.Array(OrganizationDirectorEvidence).check(Schema.isMaxLength(32)),
);
const fail = (code: OrganizationDirectorError["code"], message: string) =>
  new OrganizationDirectorError({ code, message });
const unavailable = () => fail("unavailable", "Director conversation storage is unavailable.");
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => Schema.encodeSync(Json)(value);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const safeText = (value: string, limit: number) =>
  redactOrganizationArchitectText(value).slice(0, limit);
const decodeMessage = (row: MessageRow) =>
  Effect.gen(function* () {
    const evidence = yield* Schema.decodeUnknownEffect(EvidenceJson)(row.evidence_json);
    return yield* Schema.decodeUnknownEffect(OrganizationDirectorMessage)({
      sequence: row.sequence,
      id: row.message_id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      requestId: row.request_id,
      role: row.role,
      text: row.text,
      evidence,
      createdAt: row.created_at,
    });
  }).pipe(Effect.mapError(() => unavailable()));

export interface OrganizationDirectorStoreShape {
  readonly ask: (
    input: typeof OrganizationDirectorAskInput.Type,
    principal: OrganizationDirectorPrincipal,
  ) => Effect.Effect<OrganizationDirectorAskResult, OrganizationDirectorError>;
  readonly list: (
    input: typeof OrganizationDirectorListInput.Type,
  ) => Effect.Effect<OrganizationDirectorListResult, OrganizationDirectorError>;
}
export class OrganizationDirectorStore extends Context.Service<
  OrganizationDirectorStore,
  OrganizationDirectorStoreShape
>()("t3/organizations/OrganizationDirectorStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrganizationDirectorError)(cause) ? cause : unavailable(),
        ),
      );
  const requireOrg = (organizationId: string) =>
    Effect.gen(function* () {
      const org = (yield* sql<OrgRow>`SELECT lifecycle, published_revision FROM organizations
      WHERE organization_id = ${organizationId}`)[0];
      if (!org) return yield* fail("not_found", "Organization not found.");
      return org;
    });
  const messagesForRequest = (requestId: string) =>
    sql<MessageRow>`SELECT * FROM organization_director_messages
      WHERE request_id = ${requestId} ORDER BY sequence LIMIT 2`;
  const resultForRequest = (requestId: string) =>
    Effect.gen(function* () {
      const rows = yield* messagesForRequest(requestId);
      const user = rows.find((row) => row.role === "user");
      const director = rows.find((row) => row.role === "director");
      if (!user || !director) return yield* unavailable();
      return {
        userMessage: yield* decodeMessage(user),
        directorMessage: yield* decodeMessage(director),
      };
    });
  const answer = (organizationId: string, projectId: string | null, org: OrgRow) =>
    Effect.gen(function* () {
      const observations = yield* sql<EvidenceRow>`SELECT o.observation_id AS id, o.project_id
        FROM organization_intake_observations o
        WHERE o.organization_id = ${organizationId} AND (
          (${projectId} IS NOT NULL AND o.project_id = ${projectId}) OR
          (${projectId} IS NULL AND (o.project_id IS NULL OR EXISTS (
            SELECT 1 FROM organization_project_bindings b
            JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
            WHERE b.organization_id = ${organizationId} AND b.project_id = o.project_id
              AND b.detached_at IS NULL))))
        ORDER BY o.received_at DESC, o.observation_id DESC LIMIT 6`;
      const findings = yield* sql<EvidenceRow>`SELECT f.finding_id AS id, f.project_id
        FROM organization_intake_findings f
        WHERE f.organization_id = ${organizationId} AND f.state = 'tentative' AND (
          (${projectId} IS NOT NULL AND f.project_id = ${projectId}) OR
          (${projectId} IS NULL AND (f.project_id IS NULL OR EXISTS (
            SELECT 1 FROM organization_project_bindings b
            JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
            WHERE b.organization_id = ${organizationId} AND b.project_id = f.project_id
              AND b.detached_at IS NULL))))
        ORDER BY f.created_at DESC, f.finding_id DESC LIMIT 6`;
      const proposals = yield* sql<EvidenceRow>`
        SELECT p.proposal_id AS id, p.project_id FROM organization_work_proposals p
        WHERE p.organization_id = ${organizationId} AND p.state = 'proposed' AND (
          (${projectId} IS NOT NULL AND p.project_id = ${projectId}) OR
          (${projectId} IS NULL AND EXISTS (
            SELECT 1 FROM organization_project_bindings b
            JOIN projection_projects target ON target.project_id = b.project_id
              AND target.deleted_at IS NULL
            WHERE b.organization_id = ${organizationId} AND b.project_id = p.project_id
              AND b.detached_at IS NULL)))
        ORDER BY p.created_at DESC, p.proposal_id DESC LIMIT 6`;
      const unfinished = yield* sql<{ status: string }>`
        SELECT w.status FROM organization_work_items w
        WHERE w.organization_id = ${organizationId}
          AND w.status IN ('pending','running','blocked','waiting-approval','retrying','recovering')
          AND ((${projectId} IS NOT NULL AND w.project_id = ${projectId}) OR
            (${projectId} IS NULL AND EXISTS (
              SELECT 1 FROM organization_project_bindings b
              JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
              WHERE b.organization_id = ${organizationId} AND b.project_id = w.project_id
                AND b.detached_at IS NULL)))
        ORDER BY w.created_at DESC, w.work_id DESC LIMIT 6`;
      const work = yield* sql<EvidenceRow>`
        SELECT w.work_id AS id, w.project_id FROM organization_work_items w
        WHERE w.organization_id = ${organizationId}
          AND w.status = 'succeeded' AND w.integration_receipt_ref IS NOT NULL
          AND w.approval_subject IS NOT NULL AND w.integration_subject IS NOT NULL
          AND ((${projectId} IS NOT NULL AND w.project_id = ${projectId}) OR
            (${projectId} IS NULL AND EXISTS (
              SELECT 1 FROM organization_project_bindings b
              JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
              WHERE b.organization_id = ${organizationId} AND b.project_id = w.project_id
                AND b.detached_at IS NULL)))
        ORDER BY w.created_at DESC, w.work_id DESC LIMIT 6`;
      const mode = (yield* sql<ModeRow>`SELECT observation_mode_enabled
        FROM organization_proposal_settings WHERE organization_id = ${organizationId}`)[0];
      const effectiveMode =
        mode?.observation_mode_enabled === 1 &&
        (org.lifecycle === "draft" || org.lifecycle === "active") &&
        org.published_revision !== null;
      const evidence = [
        ...observations.map((row) => ({
          kind: "observation" as const,
          label: "observed" as const,
          id: row.id,
          projectId: row.project_id,
        })),
        ...findings.map((row) => ({
          kind: "finding" as const,
          label: "tentative" as const,
          id: row.id,
          projectId: row.project_id,
        })),
        ...proposals.map((row) => ({
          kind: "proposal" as const,
          label: "proposed" as const,
          id: row.id,
          projectId: row.project_id,
        })),
        ...work.map((row) => ({
          kind: "work" as const,
          label: "verified-work" as const,
          id: row.id,
          projectId: row.project_id,
        })),
      ];
      const lines = [
        `Recorded Organization state: ${org.lifecycle}; published revision: ${org.published_revision ?? "none"}; observation mode: ${effectiveMode ? "effective" : "inactive"}.`,
        `Evidence in ${projectId === null ? "the Organization and currently bound Projects" : "this Project"} (latest up to 6 per category): ${observations.length} observed, ${findings.length} tentative findings, ${proposals.length} proposals, ${work.length} verified work records.`,
        `Unfinished work records shown (up to 6): ${unfinished.length}; these are not verified outcomes.`,
        "Organization inference and worker cost: unknown; no Organization-level metering record was read for this report.",
        "These are stored records, not a new investigation. Tentative findings and proposals are not completed work. Execution is unavailable from this conversation.",
      ];
      return {
        text: lines.join("\n"),
        evidence: yield* Schema.decodeUnknownEffect(EvidenceJson)(json(evidence)),
      };
    });
  const ask: OrganizationDirectorStoreShape["ask"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        if (
          principal.interactive !== true ||
          !principal.subject.trim() ||
          Buffer.byteLength(principal.subject, "utf8") > 256
        )
          return yield* fail("forbidden", "An authenticated interactive user is required.");
        const parsed = yield* Schema.decodeUnknownEffect(OrganizationDirectorAskInput)(input).pipe(
          Effect.mapError(() => fail("invalid", "Director question is invalid.")),
        );
        if (Buffer.byteLength(parsed.prompt, "utf8") > 4_000)
          return yield* fail("invalid", "Director question exceeds its size limit.");
        const requestDigest = hash(
          json([parsed.organizationId, parsed.projectId, parsed.prompt, principal.subject]),
        );
        const prior = (yield* sql<RequestRow>`SELECT * FROM organization_director_requests
        WHERE request_id = ${parsed.requestId}`)[0];
        if (prior) {
          if (
            prior.organization_id !== parsed.organizationId ||
            prior.project_id !== parsed.projectId ||
            prior.actor_subject !== principal.subject ||
            prior.request_digest !== requestDigest
          )
            return yield* fail(
              "conflict",
              "Director request ID was reused for a different question.",
            );
          return yield* resultForRequest(parsed.requestId);
        }
        const org = yield* requireOrg(parsed.organizationId);
        if (parsed.projectId !== null) {
          const binding = yield* sql<{ binding_id: string }>`SELECT b.binding_id
          FROM organization_project_bindings b
          JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
          WHERE b.organization_id = ${parsed.organizationId} AND b.project_id = ${parsed.projectId}
            AND b.detached_at IS NULL LIMIT 1`;
          if (binding.length === 0)
            return yield* fail("forbidden", "Project is not currently bound to this Organization.");
        }
        const response = yield* answer(parsed.organizationId, parsed.projectId, org);
        const createdAt = yield* now;
        yield* sql`INSERT INTO organization_director_requests
        (request_id, organization_id, project_id, actor_subject, request_digest, created_at)
        VALUES (${parsed.requestId}, ${parsed.organizationId}, ${parsed.projectId},
          ${principal.subject}, ${requestDigest}, ${createdAt})`;
        yield* sql`INSERT INTO organization_director_messages
        (message_id, organization_id, project_id, request_id, role, text, evidence_json, created_at)
        VALUES (${`director-user:${hash(parsed.requestId)}`}, ${parsed.organizationId},
          ${parsed.projectId}, ${parsed.requestId}, 'user', ${safeText(parsed.prompt, 4_000)}, '[]', ${createdAt})`;
        yield* sql`INSERT INTO organization_director_messages
        (message_id, organization_id, project_id, request_id, role, text, evidence_json, created_at)
        VALUES (${`director-answer:${hash(parsed.requestId)}`}, ${parsed.organizationId},
          ${parsed.projectId}, ${parsed.requestId}, 'director', ${response.text},
          ${json(response.evidence)}, ${createdAt})`;
        return yield* resultForRequest(parsed.requestId);
      }),
    );
  const list: OrganizationDirectorStoreShape["list"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeUnknownEffect(OrganizationDirectorListInput)(input).pipe(
        Effect.mapError(() => fail("invalid", "Director list input is invalid.")),
      );
      yield* requireOrg(parsed.organizationId);
      const rows = yield* sql<MessageRow>`SELECT * FROM organization_director_messages
        WHERE organization_id = ${parsed.organizationId} AND project_id IS ${parsed.projectId}
          AND sequence > ${parsed.afterSequence ?? 0}
        ORDER BY sequence LIMIT ${parsed.limit + 1}`;
      const page = rows.slice(0, parsed.limit);
      const messages = [];
      for (const row of page) messages.push(yield* decodeMessage(row));
      return { messages, nextCursor: rows.length > parsed.limit ? page.at(-1)!.sequence : null };
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(OrganizationDirectorError)(cause) ? cause : unavailable(),
      ),
    );
  return { ask, list } satisfies OrganizationDirectorStoreShape;
});

export const OrganizationDirectorStoreLive = Layer.effect(OrganizationDirectorStore, make);

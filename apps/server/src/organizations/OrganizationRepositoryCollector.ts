import type { SqlClient } from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import type { OrganizationRepositoryKind, OrganizationRepositoryRecord } from "@t3tools/contracts";
import { redactKnownCredentials } from "./CredentialRedaction.ts";
import {
  MAX_RECORD_BYTES,
  MAX_RECORDS,
  recordJson,
  recordKey,
} from "./OrganizationRepositoryGit.ts";

type PortableTable = {
  kind: OrganizationRepositoryKind;
  table: string;
  id: string;
  columns: string;
  join?: string;
};

// Every column is deliberately listed. Execution credentials, local bindings, budgets,
// leases, permits, machine paths, and live process state have no repository representation.
const tables: ReadonlyArray<PortableTable> = [
  {
    kind: "organization-audit",
    table: "organization_audit",
    id: "mutation_id",
    columns: "mutation_id,actor,action,base_revision,applied_revision,payload_json,created_at",
  },
  {
    kind: "architect-request",
    table: "organization_architect_requests",
    id: "request_id",
    columns: "request_id,actor_subject,base_revision,status,failure_message,created_at,updated_at",
  },
  {
    kind: "architect-message",
    table: "organization_architect_messages",
    id: "message_id",
    columns: "message_id,request_id,role,text,base_revision,created_at",
  },
  {
    kind: "architect-proposal",
    table: "organization_architect_proposals",
    id: "proposal_id",
    columns:
      "proposal_id,request_id,response_message_id,position,base_revision,change_json,created_at",
  },
  {
    kind: "director-request",
    table: "organization_director_requests",
    id: "request_id",
    columns: "request_id,project_id,actor_subject,created_at",
  },
  {
    kind: "director-message",
    table: "organization_director_messages",
    id: "message_id",
    columns: "message_id,project_id,request_id,role,text,evidence_json,created_at",
  },
  {
    kind: "memory",
    table: "organization_memory_records",
    id: "record_id",
    columns:
      "record_id,project_id,version,status,superseded_by_id,content_json,created_by,created_at,updated_at",
  },
  {
    kind: "memory-revision",
    table: "organization_memory_revisions",
    id: "mutation_id",
    columns: "mutation_id,record_id,version,action,actor_subject,snapshot_json,created_at",
  },
  {
    kind: "source",
    table: "organization_intake_sources",
    id: "source_id",
    columns: "source_id,project_id,kind,name,enabled,created_at,updated_at",
  },
  {
    kind: "source-audit",
    table: "organization_intake_audit",
    id: "audit_id",
    columns: "audit_id,source_id,actor_subject,action,created_at",
  },
  {
    kind: "observation",
    table: "organization_intake_observations",
    id: "observation_id",
    columns:
      "observation_id,source_id,project_id,external_event_id,dedup_key,occurred_at,received_at,title,body,attributes_json",
  },
  {
    kind: "finding",
    table: "organization_intake_findings",
    id: "finding_id",
    columns:
      "finding_id,source_id,project_id,dedup_key,title,summary,observation_ids_json,evidence_json,state,created_at",
  },
  {
    kind: "proposal",
    table: "organization_work_proposals",
    id: "proposal_id",
    columns:
      "proposal_id,finding_id,project_id,published_revision,evidence_json,title,summary,state,version,decided_by,decision_reason,reconsider_after,created_at,updated_at",
  },
  {
    kind: "proposal-decision",
    table: "organization_proposal_mutations",
    id: "mutation_id",
    columns: "mutation_id,proposal_id,action,actor_subject,snapshot_json,created_at",
  },
  {
    kind: "work-intent",
    table: "organization_work_intents",
    id: "intent_id",
    columns:
      "intent_id,proposal_id,proposal_version,finding_id,project_id,published_revision,evidence_json,requested_by,status,created_at",
  },
  {
    kind: "work",
    table: "organization_work_items",
    id: "work_id",
    columns:
      "work_id,finding_id,project_id,published_revision,workflow_id,workflow_version,code_revision,status,attempt_limit,attempt_count,creator_subject,approval_subject,approval_evidence_ref,integration_subject,integration_receipt_ref,result_code_revision,created_at,updated_at",
  },
  {
    kind: "work-transition",
    table: "organization_work_transitions",
    id: "transition_id",
    columns: "transition_id,work_id,action,actor_subject,request_json,created_at",
    join: "JOIN organization_work_items w ON w.work_id = t.work_id",
  },
  {
    kind: "work-attempt",
    table: "organization_work_attempts",
    id: "attempt_id",
    columns:
      "attempt_id,work_id,number,status,worker_subject,artifact_digest,artifact_ref,qa_subject,qa_evidence_ref,started_at,updated_at",
    join: "JOIN organization_work_items w ON w.work_id = t.work_id",
  },
  {
    kind: "work-artifact",
    table: "organization_work_artifacts",
    id: "attempt_id",
    columns:
      "attempt_id,work_id,project_id,base_code_revision,artifact_ref,artifact_digest,patch_bytes,evidence_bytes,captured_at",
    join: "JOIN organization_work_items w ON w.work_id = t.work_id",
  },
  {
    kind: "qa-receipt",
    table: "organization_work_qa_receipts",
    id: "attempt_id",
    columns:
      "attempt_id,work_id,project_id,artifact_ref,artifact_digest,worker_subject,reviewer_subject,accepted,evidence_ref,evidence_bytes,recorded_at,receipt_digest",
    join: "JOIN organization_work_items w ON w.work_id = t.work_id",
  },
  {
    kind: "approval-receipt",
    table: "organization_work_approval_receipts",
    id: "attempt_id",
    columns:
      "attempt_id,work_id,project_id,base_code_revision,artifact_ref,artifact_digest,qa_receipt_digest,worker_subject,qa_subject,approver_subject,approved,evidence_ref,evidence_bytes,recorded_at,receipt_digest",
    join: "JOIN organization_work_items w ON w.work_id = t.work_id",
  },
  {
    kind: "integration-receipt",
    table: "organization_work_integration_receipts",
    id: "attempt_id",
    columns:
      "attempt_id,work_id,project_id,base_code_revision,result_code_revision,artifact_ref,artifact_digest,qa_receipt_digest,approval_receipt_digest,worker_subject,qa_subject,approver_subject,integrator_subject,receipt_ref,evidence_bytes,recorded_at,receipt_digest",
    join: "JOIN organization_work_items w ON w.work_id = t.work_id",
  },
];

const pathPattern = /(?:\/home\/[^\s"']+|\/Users\/[^\s"']+|[A-Za-z]:\\Users\\[^\s"']+)/g;
const credentialAssignment =
  /\b(?:sessionid|session_id|cookie|authorization|x-api-key)\s*[:=]\s*[^\s;,"']+/gi;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const sanitizePortableContent = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    const digest = NodeCrypto.createHash("sha256").update(value).digest("hex");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
      return { encoding: "utf8", text: sanitizePortableContent(text), sha256: digest };
    } catch {
      return { encoding: "non-text-omitted", sha256: digest };
    }
  }
  if (typeof value === "string")
    return redactKnownCredentials(value)
      .replace(credentialAssignment, "[credential removed]")
      .replace(pathPattern, "[local path]");
  if (Array.isArray(value)) return value.map(sanitizePortableContent);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/(?:secret|token|credential|private_key|password|absolute_path|scope_unit|lease_until|binding|capabilit|access|cookie|session|authorization|auth[_-]?header|api[_-]?key)/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, sanitizePortableContent(item)]),
    );
  return value;
};
const portable = (
  organizationId: string,
  kind: OrganizationRepositoryKind,
  id: string,
  content: Record<string, unknown>,
): OrganizationRepositoryRecord => ({
  schemaVersion: 1,
  organizationId: organizationId as OrganizationRepositoryRecord["organizationId"],
  kind,
  id,
  content: sanitizePortableContent(content) as Record<string, unknown>,
});
const parseJsonColumns = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.endsWith("_json") && typeof value === "string" ? key.slice(0, -5) : key,
      key.endsWith("_json") && typeof value === "string" ? decodeJson(value) : value,
    ]),
  );
export const portableObservationAttributes = (attributes: Record<string, unknown>) => {
  const allowed = new Set([
    "adapter",
    "repositoryId",
    "issueId",
    "action",
    "correlationKey",
    "selectionReason",
    "channel",
  ]);
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => allowed.has(key)));
};

export const collectOrganizationRepositoryRecords = Effect.fnUntraced(function* (
  sql: SqlClient,
  organizationId: string,
) {
  const result = new Map<string, OrganizationRepositoryRecord>();
  const add = (record: OrganizationRepositoryRecord) => {
    if (Buffer.byteLength(recordJson(record), "utf8") > MAX_RECORD_BYTES)
      throw new Error(`Portable ${record.kind} record exceeds the repository size limit.`);
    if (result.size >= MAX_RECORDS) throw new Error("Organization has too many portable records.");
    result.set(recordKey(record), record);
  };
  const orgRows = yield* sql.unsafe("SELECT * FROM organizations WHERE organization_id = ?", [
    organizationId,
  ]);
  const org = (orgRows as ReadonlyArray<Record<string, unknown>>)[0];
  if (!org) throw new Error("Organization not found.");
  add(
    portable(organizationId, "configuration", "current", {
      title: org.title,
      mission: org.mission,
      draftRevision: org.draft_revision,
      architectRoleId: org.architect_role_id,
      directorRoleId: org.director_role_id,
      graph: decodeJson(String(org.graph_json)),
      workflows: decodeJson(String(org.workflows_json)),
      layout: decodeJson(String(org.layout_json)),
      createdAt: org.created_at,
      updatedAt: org.updated_at,
    }),
  );
  const versionRows = yield* sql.unsafe(
    "SELECT revision,config_json,published_at FROM organization_config_versions WHERE organization_id = ?",
    [organizationId],
  );
  const versions = versionRows as ReadonlyArray<Record<string, unknown>>;
  for (const row of versions) {
    const config = decodeJson(String(row.config_json)) as Record<string, unknown>;
    const { bindings: _bindings, ...portableConfig } = config;
    add(
      portable(organizationId, "configuration-version", String(row.revision), {
        ...portableConfig,
        publishedAt: row.published_at,
      }),
    );
  }
  for (const table of tables) {
    const columns = table.columns
      .split(",")
      .map((column) => `t.${column}`)
      .join(",");
    const query = `SELECT ${columns} FROM ${table.table} t ${table.join ?? ""} WHERE ${table.join ? "w" : "t"}.organization_id = ?`;
    const rawRows = yield* sql.unsafe(query, [organizationId]);
    const rows = rawRows as ReadonlyArray<Record<string, unknown>>;
    for (const row of rows) {
      const content = parseJsonColumns(row);
      if (
        table.kind === "observation" &&
        content.attributes &&
        typeof content.attributes === "object" &&
        !Array.isArray(content.attributes)
      ) {
        content.attributes = portableObservationAttributes(
          content.attributes as Record<string, unknown>,
        );
      }
      add(portable(organizationId, table.kind, String(row[table.id]), content));
    }
  }
  return result;
});

export const organizationRepositoryExclusions = [
  "Project bindings and capabilities",
  "source credentials and account tokens",
  "provider settings and budgets",
  "leases, permits, and process identities",
  "absolute machine paths",
  "non-text artifact and evidence bytes (digest retained)",
  "unrecognized observation attributes and credential-shaped fields",
] as const;

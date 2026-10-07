// @effect-diagnostics nodeBuiltinImport:off - This Node-only server module uses synchronous host crypto for persistent IDs or hashes; replacing it would add Crypto service requirements through the persistence API.
import * as NodeCrypto from "node:crypto";
import {
  OrganizationObservationMode,
  OrganizationObservationModeSetInput,
  OrganizationProposalDecisionInput,
  OrganizationProposalError,
  OrganizationProposalId,
  OrganizationProposalListInput,
  OrganizationProposalEvidence,
  OrganizationWorkProposal,
  type OrganizationProposalMutationId,
  type OrganizationObservationModeSetInput as ModeInput,
  type OrganizationProposalDecisionInput as DecisionInput,
  type OrganizationProposalListInput as ListInput,
  type OrganizationProposalListResult as ListResult,
} from "../../../../packages/contracts/src/organizationProposals.ts";
import {
  OrganizationPublishedConfig,
  type OrganizationId,
} from "../../../../packages/contracts/src/organizations.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { withAutomationWork } from "../maintenance/WorkAdmission.ts";

export interface OrganizationProposalPrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}
type OrganizationRow = { lifecycle: string; published_revision: number | null };
type SettingRow = {
  observation_mode_enabled: number;
  version: number;
  enabled_at: string | null;
  updated_by: string;
  updated_at: string;
};
type FindingRow = {
  finding_id: string;
  organization_id: string;
  project_id: string | null;
  title: string;
  summary: string;
  evidence_json: string | null;
  state: string;
  created_at: string;
};
type EvidenceRow = {
  observation_id: string;
  source_id: string;
  project_id: string | null;
  source_enabled: number | null;
  source_project_id: string | null;
};
type BindingRow = {
  binding_id: string;
  organization_id: string;
  project_id: string;
  access: string;
  capabilities_json: string;
  scope: string | null;
  detached_at: string | null;
  updated_at: string;
};
type ProposalRow = {
  proposal_id: string;
  organization_id: string;
  finding_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  published_revision: number;
  evidence_json: string;
  title: string;
  summary: string;
  state: string;
  version: number;
  decided_by: string | null;
  decision_reason: string | null;
  reconsider_after: string | null;
  created_at: string;
  updated_at: string;
};
type CandidateRow = { finding_id: string; attempts: number };
type MutationRow = {
  organization_id: string;
  proposal_id: string | null;
  action: string;
  actor_subject: string;
  request_digest: string;
  snapshot_json: string;
};
const Json = Schema.fromJsonString(Schema.Unknown);
const EvidenceJson = Schema.fromJsonString(
  Schema.Array(OrganizationProposalEvidence).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
);
const PublishedJson = Schema.fromJsonString(OrganizationPublishedConfig);
const MAX_BATCH = 32;
const MAX_PER_ORGANIZATION = 8;
const BEARER_SECRET = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const NAMED_SECRET =
  /\b(authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key)\s*([:=])\s*([^\s,;]+)/gi;
const boundedText = (value: string, limit: number) =>
  value
    .replace(BEARER_SECRET, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(
      NAMED_SECRET,
      (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`,
    )
    .slice(0, limit);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const issue = (code: OrganizationProposalError["code"], message: string) =>
  new OrganizationProposalError({ code, message });
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(Schema.encodeSync(Json)(value)).digest("hex");
const json = (value: unknown) => Schema.encodeSync(Json)(value);
const proposalId = (findingId: string) =>
  `proposal:${NodeCrypto.createHash("sha256").update(findingId).digest("hex")}`;
const backoffSeconds = (attempts: number) => Math.min(300, 5 * 2 ** Math.min(6, attempts));
const decodeProposal = (row: ProposalRow, staleReason: string | null) =>
  Effect.gen(function* () {
    const evidence = yield* Schema.decodeUnknownEffect(EvidenceJson)(row.evidence_json);
    return yield* Schema.decodeUnknownEffect(OrganizationWorkProposal)({
      id: row.proposal_id,
      organizationId: row.organization_id,
      findingId: row.finding_id,
      projectId: row.project_id,
      bindingId: row.binding_id,
      bindingVersion: row.binding_version,
      publishedRevision: row.published_revision,
      evidence,
      title: row.title,
      summary: row.summary,
      state: row.state,
      version: row.version,
      currentlyEligible: staleReason === null,
      staleReason,
      decidedBy: row.decided_by,
      decisionReason: row.decision_reason,
      reconsiderAfter: row.reconsider_after,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });

export interface OrganizationProposalStoreShape {
  readonly hasReconciliationWork: Effect.Effect<boolean, SqlError>;
  readonly getObservationMode: (
    organizationId: OrganizationId,
  ) => Effect.Effect<OrganizationObservationMode, OrganizationProposalError>;
  readonly setObservationMode: (
    input: ModeInput,
    principal: OrganizationProposalPrincipal,
  ) => Effect.Effect<OrganizationObservationMode, OrganizationProposalError>;
  readonly list: (input: ListInput) => Effect.Effect<ListResult, OrganizationProposalError>;
  readonly decide: (
    input: DecisionInput,
    principal: OrganizationProposalPrincipal,
  ) => Effect.Effect<OrganizationWorkProposal, OrganizationProposalError>;
  /** Scans and reconsiders at most 32 persisted candidates per call. */
  readonly reconcileOnce: () => Effect.Effect<
    {
      seeded: number;
      examined: number;
      proposed: number;
      reconsidered: number;
      deferred: number;
      terminal: number;
    },
    OrganizationProposalError
  >;
}
export class OrganizationProposalStore extends Context.Service<
  OrganizationProposalStore,
  OrganizationProposalStoreShape
>()("t3/organizations/OrganizationProposalStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transaction = <A, E>(
    effect: Effect.Effect<A, E, never>,
  ): Effect.Effect<A, OrganizationProposalError> =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrganizationProposalError)(cause)
            ? cause
            : issue("unavailable", "Organization proposal storage is unavailable."),
        ),
      );
  const requirePrincipal = (principal: OrganizationProposalPrincipal) =>
    Effect.gen(function* () {
      if (
        principal.interactive !== true ||
        !principal.subject.trim() ||
        Buffer.byteLength(principal.subject, "utf8") > 256
      )
        return yield* issue("forbidden", "An authenticated interactive user is required.");
    });
  const organization = (organizationId: OrganizationId) =>
    Effect.gen(function* () {
      const row = (yield* sql<OrganizationRow>`SELECT lifecycle, published_revision
      FROM organizations WHERE organization_id = ${organizationId}`)[0];
      if (!row) return yield* issue("not_found", "Organization not found.");
      return row;
    });
  const mode = (organizationId: OrganizationId) =>
    Effect.gen(function* () {
      const org = yield* organization(organizationId);
      const setting = (yield* sql<SettingRow>`SELECT * FROM organization_proposal_settings
      WHERE organization_id = ${organizationId}`)[0];
      return yield* Schema.decodeUnknownEffect(OrganizationObservationMode)({
        organizationId,
        enabled: setting?.observation_mode_enabled === 1,
        effective:
          setting?.observation_mode_enabled === 1 &&
          (org.lifecycle === "draft" || org.lifecycle === "active") &&
          org.published_revision !== null,
        version: setting?.version ?? 0,
        enabledAt: setting?.enabled_at ?? null,
        updatedBy: setting?.updated_by ?? null,
        updatedAt: setting?.updated_at ?? null,
      });
    });
  const staleReason = (proposal: ProposalRow) =>
    Effect.gen(function* () {
      const org =
        (yield* sql<OrganizationRow>`SELECT lifecycle, published_revision FROM organizations
      WHERE organization_id = ${proposal.organization_id}`)[0];
      const setting = (yield* sql<SettingRow>`SELECT * FROM organization_proposal_settings
      WHERE organization_id = ${proposal.organization_id}`)[0];
      if (
        !org ||
        (org.lifecycle !== "draft" && org.lifecycle !== "active") ||
        setting?.observation_mode_enabled !== 1
      )
        return "observation-mode-inactive";
      if (setting.enabled_at === null || proposal.created_at < setting.enabled_at)
        return "prior-opt-in-epoch";
      if (org.published_revision !== proposal.published_revision) return "published-config-changed";
      const finding = (yield* sql<FindingRow>`SELECT * FROM organization_intake_findings
      WHERE finding_id = ${proposal.finding_id}`)[0];
      if (
        !finding ||
        finding.organization_id !== proposal.organization_id ||
        finding.state !== "tentative" ||
        finding.project_id !== proposal.project_id ||
        finding.evidence_json !== proposal.evidence_json
      )
        return "finding-evidence-changed";
      const binding = (yield* sql<BindingRow>`SELECT b.* FROM organization_project_bindings b
      JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
      WHERE b.binding_id = ${proposal.binding_id}`)[0];
      if (
        !binding ||
        binding.organization_id !== proposal.organization_id ||
        binding.project_id !== proposal.project_id ||
        binding.detached_at !== null ||
        binding.updated_at !== proposal.binding_version ||
        (binding.access !== "proposal" && binding.access !== "write")
      )
        return "binding-changed";
      const capabilities = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(Schema.String)),
      )(binding.capabilities_json).pipe(Effect.result);
      if (capabilities._tag === "Failure" || !capabilities.success.includes("propose-work"))
        return "binding-changed";
      const evidence = yield* Schema.decodeUnknownEffect(EvidenceJson)(proposal.evidence_json).pipe(
        Effect.result,
      );
      if (evidence._tag === "Failure") return "evidence-invalid";
      for (const ref of evidence.success) {
        if (ref.projectId !== proposal.project_id) return "evidence-scope-changed";
        const observed = (yield* sql<EvidenceRow>`SELECT o.observation_id, o.source_id,
        o.project_id, s.enabled AS source_enabled, s.project_id AS source_project_id
        FROM organization_intake_observations o
        LEFT JOIN organization_intake_sources s ON s.source_id = o.source_id
        WHERE o.observation_id = ${ref.observationId}
          AND o.organization_id = ${proposal.organization_id}`)[0];
        if (
          !observed ||
          observed.source_id !== ref.sourceId ||
          observed.project_id !== proposal.project_id ||
          observed.source_enabled !== 1 ||
          (observed.source_project_id !== null &&
            observed.source_project_id !== proposal.project_id)
        )
          return "source-or-evidence-revoked";
      }
      return null;
    });
  const readProposal = (row: ProposalRow) =>
    Effect.gen(function* () {
      return yield* decodeProposal(row, yield* staleReason(row));
    });
  const duplicate = (
    mutationId: OrganizationProposalMutationId,
    organizationId: OrganizationId,
    proposalId: OrganizationProposalId | null,
    action: string,
    principal: OrganizationProposalPrincipal,
    requestDigest: string,
  ) =>
    Effect.gen(function* () {
      const row = (yield* sql<MutationRow>`SELECT * FROM organization_proposal_mutations
      WHERE mutation_id = ${mutationId}`)[0];
      if (!row) return null;
      if (
        row.organization_id !== organizationId ||
        row.proposal_id !== proposalId ||
        row.action !== action ||
        row.actor_subject !== principal.subject ||
        row.request_digest !== requestDigest
      )
        return yield* issue("conflict", "Proposal mutation ID was reused for a different request.");
      return yield* Schema.decodeUnknownEffect(Json)(row.snapshot_json);
    });
  const audit = (
    mutationId: OrganizationProposalMutationId,
    organizationId: OrganizationId,
    proposalId: OrganizationProposalId | null,
    action: string,
    principal: OrganizationProposalPrincipal,
    requestDigest: string,
    snapshot: unknown,
    createdAt: string,
  ) => sql`INSERT INTO organization_proposal_mutations
      (mutation_id, organization_id, proposal_id, action, actor_subject, request_digest,
        snapshot_json, created_at)
      VALUES (${mutationId}, ${organizationId}, ${proposalId}, ${action},
        ${principal.subject}, ${requestDigest}, ${json(snapshot)}, ${createdAt})`;
  const getObservationMode: OrganizationProposalStoreShape["getObservationMode"] = (
    organizationId,
  ) => transaction(mode(organizationId));
  const setObservationMode: OrganizationProposalStoreShape["setObservationMode"] = (
    input,
    principal,
  ) =>
    transaction(
      Effect.gen(function* () {
        yield* requirePrincipal(principal);
        const parsed = yield* Schema.decodeUnknownEffect(OrganizationObservationModeSetInput)(
          input,
        ).pipe(Effect.mapError(() => issue("invalid", "Observation mode change is invalid.")));
        const requestDigest = digest(parsed);
        const prior = yield* duplicate(
          parsed.mutationId,
          parsed.organizationId,
          null,
          "observation-mode",
          principal,
          requestDigest,
        );
        if (prior !== null) return yield* mode(parsed.organizationId);
        const org = yield* organization(parsed.organizationId);
        if (parsed.enabled && (org.lifecycle === "paused" || org.lifecycle === "archived"))
          return yield* issue(
            "forbidden",
            "Paused or archived Organization cannot enable observation mode.",
          );
        const current = yield* mode(parsed.organizationId);
        if (current.version !== parsed.expectedVersion)
          return yield* issue("conflict", "Observation mode version changed.");
        if (current.enabled === parsed.enabled)
          return yield* issue("conflict", "Observation mode is already in that state.");
        const time = yield* now;
        yield* sql`INSERT INTO organization_proposal_settings
        (organization_id, observation_mode_enabled, enabled_at, version, updated_by, updated_at)
        VALUES (${parsed.organizationId}, ${parsed.enabled ? 1 : 0},
          ${parsed.enabled ? time : null},
          ${current.version + 1}, ${principal.subject}, ${time})
        ON CONFLICT(organization_id) DO UPDATE SET
          observation_mode_enabled = excluded.observation_mode_enabled,
          enabled_at = CASE WHEN excluded.observation_mode_enabled = 1
            THEN excluded.enabled_at ELSE organization_proposal_settings.enabled_at END,
          version = excluded.version, updated_by = excluded.updated_by,
          updated_at = excluded.updated_at`;
        if (parsed.enabled)
          yield* sql`UPDATE organization_proposal_candidates
        SET state = 'pending', next_attempt_at = ${time}, updated_at = ${time}
        WHERE finding_id IN (SELECT finding_id FROM organization_intake_findings
          WHERE organization_id = ${parsed.organizationId}) AND state = 'pending'`;
        else
          yield* sql`UPDATE organization_proposal_candidates
        SET state = 'terminal', last_reason = 'mode-disabled', updated_at = ${time}
        WHERE finding_id IN (SELECT finding_id FROM organization_intake_findings
          WHERE organization_id = ${parsed.organizationId}) AND state = 'pending'`;
        const result = yield* mode(parsed.organizationId);
        yield* audit(
          parsed.mutationId,
          parsed.organizationId,
          null,
          "observation-mode",
          principal,
          requestDigest,
          result,
          time,
        );
        return result;
      }),
    );
  const list: OrganizationProposalStoreShape["list"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const parsed = yield* Schema.decodeUnknownEffect(OrganizationProposalListInput)(input).pipe(
          Effect.mapError(() => issue("invalid", "Proposal list request is invalid.")),
        );
        yield* organization(parsed.organizationId);
        const rows = yield* sql<ProposalRow>`SELECT * FROM organization_work_proposals
        WHERE organization_id = ${parsed.organizationId}
          AND (${parsed.afterProposalId} IS NULL OR proposal_id > ${parsed.afterProposalId})
        ORDER BY proposal_id LIMIT ${parsed.limit + 1}`;
        const results: OrganizationWorkProposal[] = [];
        for (const row of rows.slice(0, parsed.limit)) results.push(yield* readProposal(row));
        return {
          proposals: results,
          nextCursor:
            rows.length > parsed.limit && results.length > 0
              ? OrganizationProposalId.make(results[results.length - 1]!.id)
              : null,
        };
      }),
    );
  const decide: OrganizationProposalStoreShape["decide"] = (input, principal) =>
    transaction(
      Effect.gen(function* () {
        yield* requirePrincipal(principal);
        const parsed = yield* Schema.decodeUnknownEffect(OrganizationProposalDecisionInput)(
          input,
        ).pipe(Effect.mapError(() => issue("invalid", "Proposal decision is invalid.")));
        const requestDigest = digest(parsed);
        const prior = yield* duplicate(
          parsed.mutationId,
          parsed.organizationId,
          parsed.proposalId,
          parsed.decision,
          principal,
          requestDigest,
        );
        if (prior !== null) {
          const current = (yield* sql<ProposalRow>`SELECT * FROM organization_work_proposals
          WHERE proposal_id = ${parsed.proposalId} AND organization_id = ${parsed.organizationId}`)[0];
          if (!current)
            return yield* issue("not_found", "Proposal not found in this Organization.");
          return yield* readProposal(current);
        }
        const row = (yield* sql<ProposalRow>`SELECT * FROM organization_work_proposals
        WHERE proposal_id = ${parsed.proposalId} AND organization_id = ${parsed.organizationId}`)[0];
        if (!row) return yield* issue("not_found", "Proposal not found in this Organization.");
        if ((yield* organization(parsed.organizationId)).lifecycle === "archived")
          return yield* issue("forbidden", "Archived Organization proposals cannot be changed.");
        if (row.version !== parsed.expectedVersion)
          return yield* issue("conflict", "Proposal version changed.");
        if (parsed.decision === "acknowledge" && (yield* staleReason(row)) !== null)
          return yield* issue("forbidden", "Proposal is no longer eligible for acknowledgement.");
        if (parsed.decision === "defer" && parsed.reconsiderAt === null)
          return yield* issue("invalid", "Deferral requires a reconsideration time.");
        if (parsed.decision === "acknowledge" && parsed.reconsiderAt !== null)
          return yield* issue("invalid", "Acknowledgement cannot schedule reconsideration.");
        const time = yield* now;
        const reconsiderAt =
          parsed.reconsiderAt === null
            ? null
            : Number.isFinite(Date.parse(parsed.reconsiderAt))
              ? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(parsed.reconsiderAt)))
              : null;
        if (parsed.reconsiderAt !== null && reconsiderAt === null)
          return yield* issue("invalid", "Reconsideration must be a valid timestamp.");
        if (reconsiderAt !== null && reconsiderAt <= time)
          return yield* issue("invalid", "Reconsideration must be in the future.");
        const nextState =
          parsed.decision === "acknowledge"
            ? "acknowledged"
            : parsed.decision === "reject"
              ? "rejected"
              : "deferred";
        const decisionReason = parsed.reason === null ? null : boundedText(parsed.reason, 2_000);
        const changed = yield* sql<ProposalRow>`UPDATE organization_work_proposals
        SET state = ${nextState}, version = version + 1, decided_by = ${principal.subject},
          decision_reason = ${decisionReason}, reconsider_after = ${reconsiderAt},
          updated_at = ${time}
        WHERE proposal_id = ${parsed.proposalId} AND organization_id = ${parsed.organizationId}
          AND version = ${parsed.expectedVersion} RETURNING *`;
        if (!changed[0]) return yield* issue("conflict", "Proposal version changed.");
        yield* sql`UPDATE organization_proposal_candidates
        SET state = ${reconsiderAt === null ? "terminal" : "pending"},
          next_attempt_at = ${reconsiderAt ?? time}, updated_at = ${time}
        WHERE finding_id = ${row.finding_id}`;
        const result = yield* readProposal(changed[0]);
        yield* audit(
          parsed.mutationId,
          parsed.organizationId,
          parsed.proposalId,
          parsed.decision,
          principal,
          requestDigest,
          result,
          time,
        );
        return result;
      }),
    );
  const deferCandidate = (
    findingId: string,
    attempts: number,
    time: string,
    reason: string,
    terminal: boolean,
  ) =>
    Effect.gen(function* () {
      const next = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { seconds: backoffSeconds(attempts) }),
      );
      yield* sql`UPDATE organization_proposal_candidates
      SET state = ${terminal ? "terminal" : "pending"}, attempts = ${Math.min(8, attempts + 1)},
        next_attempt_at = ${next}, last_reason = ${reason}, updated_at = ${time}
      WHERE finding_id = ${findingId}`;
      return terminal ? ("terminal" as const) : ("deferred" as const);
    });
  const evaluate = (candidate: CandidateRow) =>
    transaction(
      Effect.gen(function* () {
        const time = yield* now;
        const finding = (yield* sql<FindingRow>`SELECT * FROM organization_intake_findings
      WHERE finding_id = ${candidate.finding_id}`)[0];
        if (
          !finding ||
          finding.state !== "tentative" ||
          finding.project_id === null ||
          finding.evidence_json === null
        )
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "unscoped-or-legacy-evidence",
            true,
          );
        const org = (yield* sql<OrganizationRow>`SELECT lifecycle, published_revision
      FROM organizations WHERE organization_id = ${finding.organization_id}`)[0];
        const setting = (yield* sql<SettingRow>`SELECT * FROM organization_proposal_settings
      WHERE organization_id = ${finding.organization_id}`)[0];
        if (
          !org ||
          (org.lifecycle !== "draft" && org.lifecycle !== "active") ||
          setting?.observation_mode_enabled !== 1 ||
          org.published_revision === null
        )
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "observation-mode-inactive",
            false,
          );
        if (setting.enabled_at === null || finding.created_at < setting.enabled_at)
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "before-observation-mode",
            true,
          );
        const configRow = (yield* sql<{ config_json: string }>`
      SELECT config_json FROM organization_config_versions
      WHERE organization_id = ${finding.organization_id} AND revision = ${org.published_revision}`)[0];
        if (!configRow)
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "published-config-missing",
            false,
          );
        const configResult = yield* Schema.decodeUnknownEffect(PublishedJson)(
          configRow.config_json,
        ).pipe(Effect.result);
        if (configResult._tag === "Failure")
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "published-config-invalid",
            true,
          );
        const config = configResult.success;
        if (
          config.organizationId !== finding.organization_id ||
          config.revision !== org.published_revision
        )
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "published-config-mismatch",
            true,
          );
        const evidenceResult = yield* Schema.decodeUnknownEffect(EvidenceJson)(
          finding.evidence_json,
        ).pipe(Effect.result);
        if (evidenceResult._tag === "Failure")
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "evidence-invalid",
            true,
          );
        const evidence = evidenceResult.success;
        const seen = new Set<string>();
        for (const ref of evidence) {
          if (ref.projectId !== finding.project_id || seen.has(ref.observationId))
            return yield* deferCandidate(
              candidate.finding_id,
              candidate.attempts,
              time,
              "evidence-scope-mismatch",
              true,
            );
          seen.add(ref.observationId);
          const observed = (yield* sql<EvidenceRow>`SELECT o.observation_id, o.source_id,
        o.project_id, s.enabled AS source_enabled, s.project_id AS source_project_id
        FROM organization_intake_observations o
        LEFT JOIN organization_intake_sources s ON s.source_id = o.source_id
        WHERE o.observation_id = ${ref.observationId}
          AND o.organization_id = ${finding.organization_id}`)[0];
          if (
            !observed ||
            observed.source_id !== ref.sourceId ||
            observed.project_id !== finding.project_id ||
            observed.source_enabled !== 1 ||
            (observed.source_project_id !== null &&
              observed.source_project_id !== finding.project_id)
          )
            return yield* deferCandidate(
              candidate.finding_id,
              candidate.attempts,
              time,
              "evidence-source-unavailable",
              false,
            );
        }
        const binding = (yield* sql<BindingRow>`SELECT b.* FROM organization_project_bindings b
      JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
      WHERE b.organization_id = ${finding.organization_id}
        AND b.project_id = ${finding.project_id} AND b.detached_at IS NULL`)[0];
        if (!binding || (binding.access !== "proposal" && binding.access !== "write"))
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "proposal-binding-unavailable",
            false,
          );
        const capabilitiesResult = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Array(Schema.String)),
        )(binding.capabilities_json).pipe(Effect.result);
        if (capabilitiesResult._tag === "Failure")
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "binding-capabilities-invalid",
            true,
          );
        const capabilities = capabilitiesResult.success;
        const publishedBinding = config.bindings.find((item) => item.id === binding.binding_id);
        if (
          !capabilities.includes("propose-work") ||
          !publishedBinding ||
          publishedBinding.projectId !== finding.project_id ||
          publishedBinding.detachedAt !== null ||
          publishedBinding.access !== binding.access ||
          publishedBinding.updatedAt !== binding.updated_at ||
          publishedBinding.scope !== binding.scope ||
          !publishedBinding.capabilities.includes("propose-work")
        )
          return yield* deferCandidate(
            candidate.finding_id,
            candidate.attempts,
            time,
            "binding-not-published",
            false,
          );
        const title = boundedText(finding.title, 160).trim() || "Finding requires review";
        const summary = boundedText(finding.summary, 2_000);
        const existing = (yield* sql<ProposalRow>`SELECT * FROM organization_work_proposals
      WHERE finding_id = ${candidate.finding_id}`)[0];
        if (existing) {
          if (
            (existing.state === "rejected" || existing.state === "deferred") &&
            existing.reconsider_after !== null &&
            existing.reconsider_after <= time
          ) {
            yield* sql`UPDATE organization_work_proposals SET state = 'proposed',
          version = version + 1, decided_by = NULL, decision_reason = NULL,
          reconsider_after = NULL, binding_id = ${binding.binding_id},
          binding_version = ${binding.updated_at}, published_revision = ${config.revision},
          evidence_json = ${finding.evidence_json}, title = ${title},
          summary = ${summary}, updated_at = ${time}
          WHERE proposal_id = ${existing.proposal_id} AND version = ${existing.version}`;
            yield* sql`UPDATE organization_proposal_candidates SET state = 'terminal',
          last_reason = NULL, updated_at = ${time} WHERE finding_id = ${candidate.finding_id}`;
            return "reconsidered" as const;
          }
          yield* sql`UPDATE organization_proposal_candidates SET state = 'terminal',
        last_reason = NULL, updated_at = ${time} WHERE finding_id = ${candidate.finding_id}`;
          return "terminal" as const;
        }
        yield* sql`INSERT INTO organization_work_proposals
      (proposal_id, organization_id, finding_id, project_id, binding_id,
        binding_version, published_revision, evidence_json, title, summary,
        state, version, decided_by, decision_reason, reconsider_after, created_at, updated_at)
      VALUES (${proposalId(finding.finding_id)}, ${finding.organization_id},
        ${finding.finding_id}, ${finding.project_id}, ${binding.binding_id},
        ${binding.updated_at}, ${config.revision}, ${finding.evidence_json},
        ${title}, ${summary},
        'proposed', 1, NULL, NULL, NULL,
        ${time}, ${time})`;
        yield* sql`UPDATE organization_proposal_candidates SET state = 'terminal',
      last_reason = NULL, updated_at = ${time} WHERE finding_id = ${candidate.finding_id}`;
        return "proposed" as const;
      }),
    );
  const reconcileOnce: OrganizationProposalStoreShape["reconcileOnce"] = () =>
    transaction(
      Effect.gen(function* () {
        const time = yield* now;
        const seeded = yield* sql<{
          finding_id: string;
        }>`INSERT INTO organization_proposal_candidates
        (finding_id, next_attempt_at, attempts, state, updated_at)
        SELECT f.finding_id, ${time}, 0, 'pending', ${time}
        FROM organization_intake_findings f
        JOIN organizations o ON o.organization_id = f.organization_id
        JOIN organization_proposal_settings s ON s.organization_id = f.organization_id
        WHERE NOT EXISTS (SELECT 1 FROM organization_proposal_candidates c
          WHERE c.finding_id = f.finding_id)
          AND s.observation_mode_enabled = 1 AND f.created_at >= s.enabled_at
          AND o.lifecycle IN ('draft', 'active') AND o.published_revision IS NOT NULL
        ORDER BY f.created_at, f.finding_id LIMIT ${MAX_BATCH} RETURNING finding_id`;
        return seeded.length;
      }),
    ).pipe(
      Effect.flatMap((seeded) =>
        Effect.gen(function* () {
          const time = yield* now;
          const candidates = yield* transaction(sql<CandidateRow>`
        SELECT finding_id, attempts FROM (
          SELECT c.finding_id, c.attempts, c.next_attempt_at,
            row_number() OVER (PARTITION BY f.organization_id
              ORDER BY c.next_attempt_at, c.finding_id) AS org_rank
          FROM organization_proposal_candidates c
          JOIN organization_intake_findings f ON f.finding_id = c.finding_id
          JOIN organizations o ON o.organization_id = f.organization_id
          JOIN organization_proposal_settings s ON s.organization_id = f.organization_id
          WHERE c.state = 'pending' AND c.next_attempt_at <= ${time}
            AND s.observation_mode_enabled = 1 AND f.created_at >= s.enabled_at
            AND o.lifecycle IN ('draft', 'active') AND o.published_revision IS NOT NULL
        ) WHERE org_rank <= ${MAX_PER_ORGANIZATION}
        ORDER BY next_attempt_at, finding_id LIMIT ${MAX_BATCH}`);
          const counts = {
            seeded,
            examined: 0,
            proposed: 0,
            reconsidered: 0,
            deferred: 0,
            terminal: 0,
          };
          for (const candidate of candidates) {
            const result = yield* evaluate(candidate);
            counts.examined++;
            counts[result]++;
          }
          return counts;
        }),
      ),
    );
  const hasReconciliationWork = Effect.gen(function* () {
    const time = yield* now;
    const pending = yield* sql<{ finding_id: string }>`SELECT f.finding_id
      FROM organization_intake_findings f
      JOIN organizations o ON o.organization_id = f.organization_id
      JOIN organization_proposal_settings s ON s.organization_id = f.organization_id
      WHERE s.observation_mode_enabled = 1 AND f.created_at >= s.enabled_at
        AND o.lifecycle IN ('draft', 'active') AND o.published_revision IS NOT NULL
        AND (NOT EXISTS (SELECT 1 FROM organization_proposal_candidates c
          WHERE c.finding_id = f.finding_id)
          OR EXISTS (SELECT 1 FROM organization_proposal_candidates c
            WHERE c.finding_id = f.finding_id AND c.state = 'pending'
              AND c.next_attempt_at <= ${time}))
      LIMIT 1`;
    return pending.length > 0;
  });
  return {
    hasReconciliationWork,
    getObservationMode,
    setObservationMode,
    list,
    decide,
    reconcileOnce,
  } satisfies OrganizationProposalStoreShape;
});

export const OrganizationProposalStoreLive = Layer.effect(OrganizationProposalStore, make);
/** Mount after migrations; its scoped fiber stops with the owning server layer. */
export const OrganizationProposalReconciliationLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* OrganizationProposalStore;
    yield* Effect.forever(
      Effect.gen(function* () {
        const due = yield* store.hasReconciliationWork.pipe(Effect.orElseSucceed(() => false));
        if (due)
          yield* withAutomationWork(store.reconcileOnce()).pipe(Effect.ignoreCause({ log: true }));
        yield* Effect.sleep("5 seconds");
      }),
    ).pipe(Effect.forkScoped);
  }),
);

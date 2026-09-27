import * as NodeCrypto from "node:crypto";
import {
  OrganizationPublishedConfig,
  type OrganizationId,
} from "../../../../packages/contracts/src/organizations.ts";
import {
  OrganizationProposalEvidence,
  type OrganizationProposalId,
} from "../../../../packages/contracts/src/organizationProposals.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const EvidenceJson = Schema.fromJsonString(
  Schema.Array(OrganizationProposalEvidence).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
);
const PublishedJson = Schema.fromJsonString(OrganizationPublishedConfig);
const CapabilitiesJson = Schema.fromJsonString(Schema.Array(Schema.String));
const ErrorCode = Schema.Literals(["invalid", "forbidden", "not_found", "conflict", "unavailable"]);
export class OrganizationWorkIntentError extends Schema.TaggedError<OrganizationWorkIntentError>()(
  "OrganizationWorkIntentError",
  { code: ErrorCode, message: Schema.String },
) {}
const isIntentError = Schema.is(OrganizationWorkIntentError);
const decodeCapabilities = Schema.decodeUnknownEffect(CapabilitiesJson);
const decodePublished = Schema.decodeUnknownEffect(PublishedJson);
const decodeEvidence = Schema.decodeUnknownEffect(EvidenceJson);
const fail = (code: OrganizationWorkIntentError["code"], message: string) =>
  new OrganizationWorkIntentError({ code, message });

type ProposalRow = {
  proposal_id: string;
  organization_id: string;
  finding_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  published_revision: number;
  evidence_json: string;
  state: string;
  version: number;
  created_at: string;
};
type IntentRow = {
  intent_id: string;
  organization_id: string;
  proposal_id: string;
  proposal_version: number;
  finding_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  published_revision: number;
  evidence_json: string;
  requested_by: string;
  status: "awaiting-activation";
  created_at: string;
};
type OrganizationRow = { lifecycle: string; published_revision: number | null };
type FindingRow = {
  organization_id: string;
  project_id: string | null;
  evidence_json: string | null;
  state: string;
};
type BindingRow = {
  organization_id: string;
  project_id: string;
  access: string;
  capabilities_json: string;
  scope: string | null;
  detached_at: string | null;
  updated_at: string;
};
type EvidenceRow = {
  source_id: string;
  project_id: string | null;
  source_enabled: number | null;
  source_project_id: string | null;
};

export interface OrganizationWorkIntent {
  readonly id: string;
  readonly organizationId: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly findingId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly publishedRevision: number;
  readonly evidence: ReadonlyArray<typeof OrganizationProposalEvidence.Type>;
  readonly requestedBy: string;
  /** Persistence state only. No work item, activation, approval, or execution is implied. */
  readonly status: "awaiting-activation";
  /** Workflow, mandate, code revision, and human approval remain unresolved. */
  readonly freshness: "current" | "stale";
  readonly staleReason: string | null;
  readonly createdAt: string;
}
export interface OrganizationWorkIntentStoreShape {
  /** Scans at most 32 saved proposals. It creates only inert, waiting intents. */
  readonly reconcileOnce: () => Effect.Effect<
    { examined: number; created: number; skipped: number },
    OrganizationWorkIntentError
  >;
  readonly createFromProposal: (
    input: {
      organizationId: OrganizationId;
      proposalId: OrganizationProposalId;
      expectedVersion: number;
    },
    principal: { subject: string; interactive: boolean },
  ) => Effect.Effect<OrganizationWorkIntent, OrganizationWorkIntentError>;
  readonly get: (
    organizationId: OrganizationId,
    intentId: string,
  ) => Effect.Effect<OrganizationWorkIntent, OrganizationWorkIntentError>;
  readonly list: (
    organizationId: OrganizationId,
    afterIntentId?: string | null,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<OrganizationWorkIntent>, OrganizationWorkIntentError>;
}
export class OrganizationWorkIntentStore extends Context.Service<
  OrganizationWorkIntentStore,
  OrganizationWorkIntentStoreShape
>()("t3/organizations/OrganizationWorkIntentStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let scanAfter: string | null = null;
  const transaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          isIntentError(error)
            ? error
            : fail("unavailable", "Organization work intent storage is unavailable."),
        ),
      );
  const freshness = (intent: IntentRow) =>
    Effect.gen(function* () {
      const org =
        (yield* sql<OrganizationRow>`SELECT lifecycle, published_revision FROM organizations
      WHERE organization_id = ${intent.organization_id}`)[0];
      if (!org || (org.lifecycle !== "draft" && org.lifecycle !== "active"))
        return "organization-inactive";
      if (org.published_revision !== intent.published_revision) return "published-config-changed";
      const proposal = (yield* sql<ProposalRow>`SELECT * FROM organization_work_proposals
      WHERE proposal_id = ${intent.proposal_id} AND organization_id = ${intent.organization_id}`)[0];
      if (
        !proposal ||
        proposal.version !== intent.proposal_version ||
        proposal.state !== "proposed"
      )
        return "proposal-changed";
      if (
        proposal.finding_id !== intent.finding_id ||
        proposal.project_id !== intent.project_id ||
        proposal.binding_id !== intent.binding_id ||
        proposal.binding_version !== intent.binding_version ||
        proposal.published_revision !== intent.published_revision ||
        proposal.evidence_json !== intent.evidence_json
      )
        return "proposal-changed";
      const setting = (yield* sql<{ observation_mode_enabled: number; enabled_at: string | null }>`
      SELECT observation_mode_enabled, enabled_at FROM organization_proposal_settings
      WHERE organization_id = ${intent.organization_id}`)[0];
      if (
        setting?.observation_mode_enabled !== 1 ||
        setting.enabled_at === null ||
        proposal.created_at < setting.enabled_at
      )
        return "observation-mode-inactive";
      const finding =
        (yield* sql<FindingRow>`SELECT organization_id, project_id, evidence_json, state
      FROM organization_intake_findings WHERE finding_id = ${intent.finding_id}`)[0];
      if (
        !finding ||
        finding.organization_id !== intent.organization_id ||
        finding.project_id !== intent.project_id ||
        finding.state !== "tentative" ||
        finding.evidence_json !== intent.evidence_json
      )
        return "finding-evidence-changed";
      const project = (yield* sql<{
        deleted_at: string | null;
      }>`SELECT deleted_at FROM projection_projects
      WHERE project_id = ${intent.project_id}`)[0];
      if (!project || project.deleted_at !== null) return "project-unavailable";
      const binding = (yield* sql<BindingRow>`SELECT * FROM organization_project_bindings
      WHERE binding_id = ${intent.binding_id}`)[0];
      if (
        !binding ||
        binding.organization_id !== intent.organization_id ||
        binding.project_id !== intent.project_id ||
        binding.detached_at !== null ||
        binding.updated_at !== intent.binding_version ||
        (binding.access !== "proposal" && binding.access !== "write")
      )
        return "binding-changed";
      const capabilities = yield* decodeCapabilities(binding.capabilities_json).pipe(Effect.result);
      if (capabilities._tag === "Failure" || !capabilities.success.includes("propose-work"))
        return "binding-changed";
      const published = (yield* sql<{ config_json: string }>`SELECT config_json
      FROM organization_config_versions WHERE organization_id = ${intent.organization_id}
        AND revision = ${intent.published_revision}`)[0];
      if (!published) return "published-config-missing";
      const decoded = yield* decodePublished(published.config_json).pipe(Effect.result);
      if (
        decoded._tag === "Failure" ||
        decoded.success.organizationId !== intent.organization_id ||
        decoded.success.revision !== intent.published_revision
      )
        return "published-config-invalid";
      const publishedBinding = decoded.success.bindings.find(
        (item) => item.id === intent.binding_id,
      );
      if (
        !publishedBinding ||
        publishedBinding.projectId !== intent.project_id ||
        publishedBinding.detachedAt !== null ||
        publishedBinding.access !== binding.access ||
        publishedBinding.updatedAt !== binding.updated_at ||
        publishedBinding.scope !== binding.scope ||
        !publishedBinding.capabilities.includes("propose-work")
      )
        return "binding-not-published";
      const evidence = yield* decodeEvidence(intent.evidence_json).pipe(Effect.result);
      if (evidence._tag === "Failure") return "evidence-invalid";
      const seen = new Set<string>();
      for (const ref of evidence.success) {
        if (ref.projectId !== intent.project_id || seen.has(ref.observationId))
          return "evidence-scope-changed";
        seen.add(ref.observationId);
        const observed = (yield* sql<EvidenceRow>`SELECT o.source_id, o.project_id,
        s.enabled AS source_enabled, s.project_id AS source_project_id
        FROM organization_intake_observations o
        LEFT JOIN organization_intake_sources s ON s.source_id = o.source_id
        WHERE o.observation_id = ${ref.observationId}
          AND o.organization_id = ${intent.organization_id}`)[0];
        if (
          !observed ||
          observed.source_id !== ref.sourceId ||
          observed.project_id !== intent.project_id ||
          observed.source_enabled !== 1 ||
          (observed.source_project_id !== null && observed.source_project_id !== intent.project_id)
        )
          return "source-or-evidence-revoked";
      }
      return null;
    });
  const decode = (row: IntentRow) =>
    Effect.gen(function* () {
      const reason = yield* freshness(row);
      const evidence = yield* decodeEvidence(row.evidence_json).pipe(
        Effect.mapError(() => fail("unavailable", "Saved intent evidence is invalid.")),
      );
      return {
        id: row.intent_id,
        organizationId: row.organization_id,
        proposalId: row.proposal_id,
        proposalVersion: row.proposal_version,
        findingId: row.finding_id,
        projectId: row.project_id,
        bindingId: row.binding_id,
        bindingVersion: row.binding_version,
        publishedRevision: row.published_revision,
        evidence,
        requestedBy: row.requested_by,
        status: "awaiting-activation" as const,
        freshness: reason === null ? ("current" as const) : ("stale" as const),
        staleReason: reason,
        createdAt: row.created_at,
      } satisfies OrganizationWorkIntent;
    });
  const createValidated = (
    input: {
      organizationId: OrganizationId;
      proposalId: OrganizationProposalId;
      expectedVersion: number;
    },
    requestedBy: string,
  ) =>
    transaction(
      Effect.gen(function* () {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0)
          return yield* fail("invalid", "Expected proposal version is invalid.");
        // Acquire SQLite's writer lock before duplicate and eligibility reads.
        // Separate clients then see the committed intent after waiting.
        yield* sql`UPDATE organizations SET updated_at = updated_at
          WHERE organization_id = ${input.organizationId}`;
        const proposal = (yield* sql<ProposalRow>`SELECT * FROM organization_work_proposals
        WHERE proposal_id = ${input.proposalId} AND organization_id = ${input.organizationId}`)[0];
        if (!proposal) return yield* fail("not_found", "Proposal not found in this Organization.");
        if (proposal.version !== input.expectedVersion)
          return yield* fail("conflict", "Proposal version changed.");
        if (proposal.state !== "proposed")
          return yield* fail("forbidden", "Only a proposed proposal can seed a work intent.");
        const id = `work-intent:${NodeCrypto.createHash("sha256")
          .update(`${proposal.proposal_id}\0${proposal.version}`)
          .digest("hex")}`;
        const existing = (yield* sql<IntentRow>`SELECT * FROM organization_work_intents
        WHERE intent_id = ${id}`)[0];
        if (existing) return yield* decode(existing);
        const row: IntentRow = {
          intent_id: id,
          organization_id: proposal.organization_id,
          proposal_id: proposal.proposal_id,
          proposal_version: proposal.version,
          finding_id: proposal.finding_id,
          project_id: proposal.project_id,
          binding_id: proposal.binding_id,
          binding_version: proposal.binding_version,
          published_revision: proposal.published_revision,
          evidence_json: proposal.evidence_json,
          requested_by: requestedBy,
          status: "awaiting-activation",
          created_at: DateTime.formatIso(yield* DateTime.now),
        };
        const reason = yield* freshness(row);
        if (reason !== null)
          return yield* fail("forbidden", `Proposal is no longer eligible: ${reason}.`);
        yield* sql`INSERT INTO organization_work_intents
        (intent_id, organization_id, proposal_id, proposal_version, finding_id, project_id,
          binding_id, binding_version, published_revision, evidence_json, requested_by,
          status, created_at)
        VALUES (${row.intent_id}, ${row.organization_id}, ${row.proposal_id},
          ${row.proposal_version}, ${row.finding_id}, ${row.project_id}, ${row.binding_id},
          ${row.binding_version}, ${row.published_revision}, ${row.evidence_json},
          ${row.requested_by}, ${row.status}, ${row.created_at})`;
        return yield* decode(row);
      }),
    );
  const createFromProposal: OrganizationWorkIntentStoreShape["createFromProposal"] = (
    input,
    principal,
  ) => {
    if (
      !principal.interactive ||
      !principal.subject.trim() ||
      Buffer.byteLength(principal.subject, "utf8") > 256
    )
      return Effect.fail(fail("forbidden", "An authenticated interactive user is required."));
    return createValidated(input, principal.subject);
  };
  const get: OrganizationWorkIntentStoreShape["get"] = (organizationId, intentId) =>
    transaction(
      Effect.gen(function* () {
        const row = (yield* sql<IntentRow>`SELECT * FROM organization_work_intents
        WHERE intent_id = ${intentId} AND organization_id = ${organizationId}`)[0];
        if (!row) return yield* fail("not_found", "Work intent not found in this Organization.");
        return yield* decode(row);
      }),
    );
  const list: OrganizationWorkIntentStoreShape["list"] = (
    organizationId,
    afterIntentId = null,
    limit = 100,
  ) =>
    transaction(
      Effect.gen(function* () {
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (afterIntentId !== null && (afterIntentId.length === 0 || afterIntentId.length > 160))
        )
          return yield* fail("invalid", "Work intent page is invalid.");
        const rows = yield* sql<IntentRow>`SELECT * FROM organization_work_intents
        WHERE organization_id = ${organizationId}
          AND (${afterIntentId} IS NULL OR intent_id > ${afterIntentId})
          AND NOT EXISTS (SELECT 1 FROM organization_work_intent_activations activation
            WHERE activation.intent_id = organization_work_intents.intent_id)
        ORDER BY intent_id LIMIT ${limit}`;
        const items: OrganizationWorkIntent[] = [];
        for (const row of rows) items.push(yield* decode(row));
        return items;
      }),
    );
  const reconcileOnce: OrganizationWorkIntentStoreShape["reconcileOnce"] = () =>
    Effect.gen(function* () {
      // New proposals get prompt attention; the cursor lane makes progress
      // through older missing intents. Both queries are bounded independently.
      const newest = yield* sql<ProposalRow>`SELECT p.* FROM organization_work_proposals p
        WHERE p.state = 'proposed' AND NOT EXISTS (
          SELECT 1 FROM organization_work_intents i
          WHERE i.proposal_id = p.proposal_id AND i.proposal_version = p.version)
        ORDER BY p.created_at DESC, p.proposal_id DESC LIMIT 16`;
      let fair = yield* sql<ProposalRow>`SELECT p.* FROM organization_work_proposals p
        WHERE p.state = 'proposed' AND (${scanAfter} IS NULL OR p.proposal_id > ${scanAfter})
          AND NOT EXISTS (SELECT 1 FROM organization_work_intents i
            WHERE i.proposal_id = p.proposal_id AND i.proposal_version = p.version)
        ORDER BY p.proposal_id LIMIT 16`;
      if (fair.length === 0 && scanAfter !== null) {
        scanAfter = null;
        fair = yield* sql<ProposalRow>`SELECT p.* FROM organization_work_proposals p
          WHERE p.state = 'proposed' AND NOT EXISTS (
            SELECT 1 FROM organization_work_intents i
            WHERE i.proposal_id = p.proposal_id AND i.proposal_version = p.version)
          ORDER BY p.proposal_id LIMIT 16`;
      }
      if (fair.length > 0) scanAfter = fair[fair.length - 1]!.proposal_id;
      const rows = [...new Map([...newest, ...fair].map((row) => [row.proposal_id, row])).values()];
      let created = 0;
      let skipped = 0;
      for (const row of rows) {
        const result = yield* createValidated(
          {
            organizationId: row.organization_id as OrganizationId,
            proposalId: row.proposal_id as OrganizationProposalId,
            expectedVersion: row.version,
          },
          "system:organization-proposal-reconciler",
        ).pipe(Effect.result);
        if (result._tag === "Success") created++;
        else if (
          result.failure.code === "forbidden" ||
          result.failure.code === "conflict" ||
          result.failure.code === "not_found"
        )
          skipped++;
        else return yield* result.failure;
      }
      return { examined: rows.length, created, skipped };
    }).pipe(
      Effect.mapError((error) =>
        isIntentError(error)
          ? error
          : fail("unavailable", "Organization work intent reconciliation is unavailable."),
      ),
    );
  return {
    createFromProposal,
    get,
    list,
    reconcileOnce,
  } satisfies OrganizationWorkIntentStoreShape;
});

export const OrganizationWorkIntentStoreLive = Layer.effect(OrganizationWorkIntentStore, make);
/** Mount after migrations; its scoped fiber stops with the owning server layer. */
export const OrganizationWorkIntentReconciliationLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* OrganizationWorkIntentStore;
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* store.reconcileOnce().pipe(Effect.ignoreCause({ log: true }));
        yield* Effect.sleep("5 seconds");
      }),
    ).pipe(Effect.forkScoped);
  }),
);

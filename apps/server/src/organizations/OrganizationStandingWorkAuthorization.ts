// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off - Bounded persisted human selection and UTC grant expiry.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationIntakeSourceId,
  OrganizationPublishedConfig,
  OrganizationStandingWorkAuthorizationError,
  OrganizationStandingWorkAuthorizationId,
  ProjectId,
  type OrganizationStandingWorkAuthorizationCreateInput,
  type OrganizationStandingWorkAuthorizationRevokeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MaintenanceWorkHeld, withAutomationWork } from "../maintenance/WorkAdmission.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { OrganizationGitTargetPreflight } from "./OrganizationGitTargetPreflight.ts";
import { OrganizationLiveWorkRuntimeReadiness } from "./OrganizationLiveWorkExecutor.ts";
import {
  activateOrganizationWorkIntentFromStandingAuthorization,
  selectionSnapshot,
} from "./OrganizationWorkIntentActivation.ts";

const isMaintenanceWorkHeld = Schema.is(MaintenanceWorkHeld);

type GrantRow = {
  authorization_id: string;
  request_id: string;
  organization_id: string;
  project_id: string;
  source_id: string;
  binding_id: string;
  binding_version: string;
  published_revision: number;
  selection_json: string;
  max_activations: number;
  used_activations: number;
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revocation_reason: "manual" | "expired" | "exhausted" | null;
};
type CandidateRow = {
  intent_id: string;
  organization_id: string;
  authorization_id: string;
  selection_json: string;
};
export interface OrganizationStandingWorkPrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}
const fail = (code: OrganizationStandingWorkAuthorizationError["code"], message: string) =>
  new OrganizationStandingWorkAuthorizationError({ code, message });
const isGrantError = Schema.is(OrganizationStandingWorkAuthorizationError);
const decodePublished = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrganizationPublishedConfig),
);
const MAX_GRANT_MS = 30 * 24 * 60 * 60 * 1_000;
const PROVIDER_ESTIMATE = 140_000;
const requiredCapabilities = ["propose-work", "read-files", "write-files", "run-tests"] as const;
const fullCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const human = (principal: OrganizationStandingWorkPrincipal) =>
  principal.interactive &&
  principal.subject.trim().length > 0 &&
  Buffer.byteLength(principal.subject, "utf8") <= 160;
const decode = (row: GrantRow) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(row.selection_json) as unknown,
      catch: () => fail("unavailable", "Saved standing work selection is unreadable."),
    });
    const selection = yield* selectionSnapshot(parsed).pipe(
      Effect.mapError(() => fail("unavailable", "Saved standing work selection is invalid.")),
    );
    return {
      id: OrganizationStandingWorkAuthorizationId.make(row.authorization_id),
      organizationId: OrganizationId.make(row.organization_id),
      projectId: ProjectId.make(row.project_id),
      sourceId: OrganizationIntakeSourceId.make(row.source_id),
      bindingId: OrganizationBindingId.make(row.binding_id),
      bindingVersion: row.binding_version,
      publishedRevision: row.published_revision,
      selection: selection.selected,
      maxActivations: row.max_activations,
      usedActivations: row.used_activations,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revocationReason: row.revocation_reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  });

/** The database write lock makes a retried human request compare with one saved payload. */
export const createOrganizationStandingWorkAuthorization = (
  input: OrganizationStandingWorkAuthorizationCreateInput,
  principal: OrganizationStandingWorkPrincipal,
) =>
  Effect.gen(function* () {
    if (!human(principal))
      return yield* fail("forbidden", "Standing Project work requires an interactive user.");
    if (
      !input.requestId.trim() ||
      Buffer.byteLength(input.requestId, "utf8") > 160 ||
      !Number.isSafeInteger(input.maxActivations) ||
      input.maxActivations < 1 ||
      input.maxActivations > 32
    )
      return yield* fail("invalid", "Standing work request is invalid.");
    const { snapshot } = yield* selectionSnapshot(input.selection).pipe(
      Effect.mapError((error) => fail(error.code, error.message)),
    );
    const readiness = yield* OrganizationLiveWorkRuntimeReadiness;
    const sql = yield* SqlClient.SqlClient;
    const git = yield* GitVcsDriver;
    const targetPreflight = yield* OrganizationGitTargetPreflight;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const org = (yield* sql<{ lifecycle: string; published_revision: number | null }>`
        UPDATE organizations SET updated_at = updated_at
        WHERE organization_id = ${input.organizationId}
        RETURNING lifecycle, published_revision`)[0];
          if (!org) return yield* fail("not_found", "Organization is unavailable.");
          const prior =
            (yield* sql<GrantRow>`SELECT * FROM organization_standing_work_authorizations
        WHERE request_id = ${input.requestId}`)[0];
          if (prior) {
            if (
              prior.organization_id !== input.organizationId ||
              prior.project_id !== input.projectId ||
              prior.source_id !== input.sourceId ||
              prior.binding_id !== input.bindingId ||
              prior.selection_json !== snapshot ||
              prior.max_activations !== input.maxActivations ||
              prior.expires_at !== input.expiresAt ||
              prior.created_by !== principal.subject
            )
              return yield* fail("conflict", "Standing work request ID was reused.");
            return yield* decode(prior);
          }
          const expiry = Date.parse(input.expiresAt);
          const nowMs = Date.now();
          if (
            !Number.isFinite(expiry) ||
            new Date(expiry).toISOString() !== input.expiresAt ||
            expiry <= nowMs ||
            expiry > nowMs + MAX_GRANT_MS
          )
            return yield* fail("invalid", "Standing work expiry must be within 30 days.");
          if (!readiness.status().ready)
            return yield* fail("unavailable", "Project work runtime is not ready.");
          const retiredAt = new Date(nowMs).toISOString();
          yield* sql`UPDATE organization_standing_work_authorizations
            SET revoked_at = ${retiredAt},
              revocation_reason = CASE WHEN expires_at <= ${retiredAt}
                THEN 'expired' ELSE 'exhausted' END
            WHERE organization_id = ${input.organizationId}
              AND project_id = ${input.projectId} AND source_id = ${input.sourceId}
              AND revoked_at IS NULL
              AND (expires_at <= ${retiredAt} OR used_activations >= max_activations)`;
          const active = yield* sql<{ authorization_id: string }>`SELECT authorization_id
        FROM organization_standing_work_authorizations
        WHERE organization_id = ${input.organizationId} AND project_id = ${input.projectId}
          AND source_id = ${input.sourceId} AND revoked_at IS NULL LIMIT 1`;
          if (active.length > 0)
            return yield* fail(
              "conflict",
              "An active standing grant already covers this Project source.",
            );
          if (
            !readiness.status().ready ||
            !["draft", "active"].includes(org.lifecycle) ||
            org.published_revision === null
          )
            return yield* fail("conflict", "Organization is not ready for standing Project work.");
          const stopped = yield* sql<{ present: number }>`SELECT EXISTS (
        SELECT 1 FROM organization_emergency_stops WHERE organization_id = ${input.organizationId}
      ) AS present`;
          const draining = yield* sql<{ present: number }>`SELECT EXISTS (
        SELECT 1 FROM organization_live_work_drains WHERE organization_id = ${input.organizationId}
      ) AS present`;
          if (stopped[0]?.present === 1 || draining[0]?.present === 1)
            return yield* fail("conflict", "Organization work is stopped or draining.");
          const source = (yield* sql<{ kind: string; enabled: number; project_id: string | null }>`
        SELECT kind, enabled, project_id FROM organization_intake_sources
        WHERE source_id = ${input.sourceId} AND organization_id = ${input.organizationId}`)[0];
          if (
            source?.kind !== "generic-http" ||
            source.enabled !== 1 ||
            source.project_id !== input.projectId
          )
            return yield* fail(
              "forbidden",
              "Standing work requires an enabled Project-scoped HTTP source.",
            );
          const binding = (yield* sql<{
            project_id: string;
            access: string;
            scope: string | null;
            detached_at: string | null;
            updated_at: string;
            capabilities_json: string;
          }>`
        SELECT project_id, access, scope, detached_at, updated_at, capabilities_json
        FROM organization_project_bindings
        WHERE binding_id = ${input.bindingId} AND organization_id = ${input.organizationId}`)[0];
          const capabilities = binding
            ? yield* Effect.try({
                try: () => JSON.parse(binding.capabilities_json) as unknown,
                catch: () => null,
              }).pipe(Effect.orElseSucceed(() => null))
            : null;
          if (
            !binding ||
            binding.project_id !== input.projectId ||
            binding.access !== "write" ||
            binding.scope !== null ||
            binding.detached_at !== null ||
            !Array.isArray(capabilities) ||
            !requiredCapabilities.every((capability) => capabilities.includes(capability))
          )
            return yield* fail("forbidden", "Project binding lacks standing work authority.");
          const configRow = (yield* sql<{ config_json: string }>`SELECT config_json
        FROM organization_config_versions WHERE organization_id = ${input.organizationId}
          AND revision = ${org.published_revision}`)[0];
          if (!configRow) return yield* fail("conflict", "Published configuration is unavailable.");
          const config = yield* decodePublished(configRow.config_json).pipe(
            Effect.mapError(() => fail("unavailable", "Published configuration is invalid.")),
          );
          const publishedBinding = config.bindings.find((item) => item.id === input.bindingId);
          const workflow = config.workflows.find((item) => item.id === input.selection.workflowId);
          if (
            !publishedBinding ||
            publishedBinding.projectId !== input.projectId ||
            publishedBinding.updatedAt !== binding.updated_at ||
            publishedBinding.detachedAt !== null ||
            publishedBinding.access !== "write" ||
            publishedBinding.scope !== null ||
            !requiredCapabilities.every((capability) =>
              publishedBinding.capabilities.includes(capability),
            ) ||
            !workflow ||
            !["work", "qa", "approval", "integrate"].every((kind) =>
              workflow.steps.some((step) => step.kind === kind),
            )
          )
            return yield* fail(
              "forbidden",
              "Selected published binding or workflow is unavailable.",
            );
          const project = (yield* sql<{ workspace_root: string; deleted_at: string | null }>`
        SELECT workspace_root, deleted_at FROM projection_projects WHERE project_id = ${input.projectId}`)[0];
          if (
            !project ||
            project.deleted_at !== null ||
            !NodePath.isAbsolute(project.workspace_root)
          )
            return yield* fail("forbidden", "Project checkout is unavailable.");
          const head = yield* git
            .resolveCommit({ cwd: project.workspace_root, revision: "HEAD" })
            .pipe(Effect.mapError(() => fail("conflict", "Project HEAD cannot be resolved.")));
          const target = yield* git
            .resolveCommit({ cwd: project.workspace_root, revision: input.selection.targetRef })
            .pipe(
              Effect.mapError(() => fail("conflict", "Selected Project branch is unavailable.")),
            );
          if (!fullCommit.test(head.commitSha) || target.commitSha !== head.commitSha)
            return yield* fail("conflict", "Selected Project branch differs from HEAD.");
          yield* targetPreflight
            .verify({
              projectRoot: project.workspace_root,
              targetRef: input.selection.targetRef,
              baseCommit: head.commitSha,
            })
            .pipe(Effect.mapError((error) => fail(error.code, error.message)));
          const budgets = yield* sql<{
            max_concurrent: number;
            max_daily_calls: number;
            max_daily_estimated_tokens: number;
          }>`SELECT max_concurrent, max_daily_calls,
        max_daily_estimated_tokens FROM organization_provider_budget_limits
        WHERE (scope_kind = 'global' AND scope_id = '*')
          OR (scope_kind = 'organization' AND scope_id = ${input.organizationId})
          OR (scope_kind = 'project' AND scope_id = ${input.projectId})`;
          if (
            budgets.length !== 3 ||
            budgets.some(
              (budget) =>
                budget.max_concurrent < 1 ||
                budget.max_daily_calls < 1 ||
                budget.max_daily_estimated_tokens < PROVIDER_ESTIMATE,
            )
          )
            return yield* fail("unavailable", "Standing work provider budget is not configured.");
          const createdAt = new Date().toISOString();
          const id = OrganizationStandingWorkAuthorizationId.make(
            `org-standing:${NodeCrypto.randomUUID()}`,
          );
          yield* sql`INSERT INTO organization_standing_work_authorizations
        (authorization_id, request_id, organization_id, project_id, source_id,
          binding_id, binding_version, published_revision, selection_json,
          max_activations, expires_at, created_by, created_at)
        VALUES (${id}, ${input.requestId}, ${input.organizationId}, ${input.projectId},
          ${input.sourceId}, ${input.bindingId}, ${binding.updated_at},
          ${org.published_revision}, ${snapshot}, ${input.maxActivations},
          ${input.expiresAt}, ${principal.subject}, ${createdAt})`;
          return yield* decode(
            (yield* sql<GrantRow>`SELECT * FROM organization_standing_work_authorizations
        WHERE authorization_id = ${id}`)[0]!,
          );
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isGrantError(error)
            ? error
            : fail("unavailable", "Standing work authorization is unavailable."),
        ),
      );
  });

export const revokeOrganizationStandingWorkAuthorization = (
  input: OrganizationStandingWorkAuthorizationRevokeInput,
  principal: OrganizationStandingWorkPrincipal,
) =>
  Effect.gen(function* () {
    if (!human(principal))
      return yield* fail("forbidden", "Revoking standing work requires an interactive user.");
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const locked = yield* sql<{ organization_id: string }>`UPDATE organizations
      SET updated_at = updated_at WHERE organization_id = ${input.organizationId}
      RETURNING organization_id`;
          if (locked.length === 0) return yield* fail("not_found", "Organization is unavailable.");
          const row = (yield* sql<GrantRow>`SELECT * FROM organization_standing_work_authorizations
      WHERE authorization_id = ${input.authorizationId} AND organization_id = ${input.organizationId}`)[0];
          if (!row) return yield* fail("not_found", "Standing work authorization is unavailable.");
          if (row.revoked_at === null) {
            const now = new Date().toISOString();
            yield* sql`UPDATE organization_standing_work_authorizations
              SET revoked_at = ${now}, revocation_reason = 'manual'
        WHERE authorization_id = ${input.authorizationId} AND revoked_at IS NULL`;
          }
          return yield* decode(
            (yield* sql<GrantRow>`SELECT * FROM organization_standing_work_authorizations
      WHERE authorization_id = ${input.authorizationId}`)[0]!,
          );
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isGrantError(error)
            ? error
            : fail("unavailable", "Standing work revocation is unavailable."),
        ),
      );
  });

export const listOrganizationStandingWorkAuthorizations = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const exists = yield* sql<{ organization_id: string }>`SELECT organization_id
      FROM organizations WHERE organization_id = ${organizationId}`;
    if (exists.length === 0) return yield* fail("not_found", "Organization is unavailable.");
    const rows = yield* sql<GrantRow>`SELECT * FROM organization_standing_work_authorizations
      WHERE organization_id = ${organizationId}
      ORDER BY created_at DESC, authorization_id DESC LIMIT 100`;
    const authorizations = [];
    for (const row of rows) authorizations.push(yield* decode(row));
    return { authorizations };
  }).pipe(
    Effect.mapError((error) =>
      isGrantError(error)
        ? error
        : fail("unavailable", "Standing work authorizations are unavailable."),
    ),
  );

let scanAfter: string | null = null;
/** Bounded source-specific handoff. Activation itself rechecks the grant under the Organization lock. */
export const reconcileOrganizationStandingWorkAuthorizationsOnce = Effect.gen(function* () {
  const readiness = yield* OrganizationLiveWorkRuntimeReadiness;
  if (!readiness.status().ready) return { examined: 0, activated: 0, skipped: 0 };
  const sql = yield* SqlClient.SqlClient;
  const now = new Date().toISOString();
  const select = (cursor: string | null) => sql<CandidateRow>`SELECT i.intent_id,
    i.organization_id, grant.authorization_id, grant.selection_json
    FROM organization_work_intents i
    JOIN organization_standing_work_authorizations grant
      ON grant.organization_id = i.organization_id AND grant.project_id = i.project_id
        AND grant.binding_id = i.binding_id AND grant.binding_version = i.binding_version
        AND grant.published_revision = i.published_revision
    JOIN organizations org ON org.organization_id = i.organization_id
    JOIN organization_intake_sources source ON source.source_id = grant.source_id
      AND source.organization_id = grant.organization_id
    WHERE i.intent_id > ${cursor ?? ""} AND grant.revoked_at IS NULL
      AND grant.expires_at > ${now} AND grant.used_activations < grant.max_activations
      AND org.lifecycle IN ('draft', 'active') AND source.kind = 'generic-http'
      AND source.enabled = 1 AND source.project_id = i.project_id
      AND EXISTS (SELECT 1 FROM json_each(
        CASE WHEN json_valid(i.evidence_json) THEN i.evidence_json ELSE '[]' END
      ) evidence WHERE json_extract(evidence.value, '$.sourceId') = grant.source_id
        AND json_extract(evidence.value, '$.projectId') = i.project_id)
      AND NOT EXISTS (SELECT 1 FROM organization_work_intent_activations activation
        WHERE activation.intent_id = i.intent_id)
      AND NOT EXISTS (SELECT 1 FROM organization_live_work_drains drain
        WHERE drain.organization_id = i.organization_id)
      AND NOT EXISTS (SELECT 1 FROM organization_emergency_stops stop
        WHERE stop.organization_id = i.organization_id)
    ORDER BY i.intent_id LIMIT 16`;
  let candidates = yield* select(scanAfter);
  if (candidates.length === 0 && scanAfter !== null) {
    scanAfter = null;
    candidates = yield* select(null);
  }
  if (candidates.length > 0) scanAfter = candidates[candidates.length - 1]!.intent_id;
  let activated = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(candidate.selection_json) as unknown,
      catch: () => fail("unavailable", "Saved standing work selection is unreadable."),
    }).pipe(Effect.result);
    if (parsed._tag === "Failure") {
      skipped++;
      continue;
    }
    const selection = yield* selectionSnapshot(parsed.success).pipe(Effect.result);
    if (selection._tag === "Failure") {
      skipped++;
      continue;
    }
    const result = yield* withAutomationWork(
      activateOrganizationWorkIntentFromStandingAuthorization(
        {
          organizationId: candidate.organization_id as OrganizationId,
          intentId: candidate.intent_id,
          selection: selection.success.selected,
        },
        candidate.authorization_id,
      ),
    ).pipe(Effect.result);
    if (result._tag === "Success") activated++;
    else if (isMaintenanceWorkHeld(result.failure)) return yield* result.failure;
    else if (
      ["invalid", "forbidden", "conflict", "not_found", "unavailable"].includes(result.failure.code)
    )
      skipped++;
    else return yield* result.failure;
  }
  return { examined: candidates.length, activated, skipped };
});

export const OrganizationStandingWorkAuthorizationLoopLive = Layer.effectDiscard(
  Effect.forever(
    Effect.gen(function* () {
      yield* reconcileOrganizationStandingWorkAuthorizationsOnce.pipe(
        Effect.ignoreCause({ log: true }),
      );
      yield* Effect.sleep("5 seconds");
    }),
  ).pipe(Effect.forkScoped),
);

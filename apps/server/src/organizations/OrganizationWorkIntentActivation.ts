// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off - The selected QA oracle is bounded, immutable JSON; host paths need Node semantics.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  OrganizationBindingId,
  OrganizationId,
  OrganizationPublishedConfig,
  ProjectId,
  type OrganizationWorkId,
} from "@t3tools/contracts";
import { OrganizationTentativeFindingId } from "../../../../packages/contracts/src/organizationIntake.ts";
import {
  OrganizationWorkIntentActivationError,
  OrganizationWorkIntentActivationSelection as Selection,
  type OrganizationWorkIntentActivationInput,
  type OrganizationWorkIntentActivationResult,
} from "../../../../packages/contracts/src/organizationWorkIntents.ts";
import { OrganizationWorkId as WorkIdSchema } from "../../../../packages/contracts/src/organizationWork.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { OrganizationGitTargetPreflight } from "./OrganizationGitTargetPreflight.ts";
import {
  OrganizationLifecycleActivationAuthority,
  OrganizationStore,
  OrganizationStoreLayer,
} from "./OrganizationStore.ts";
import { OrganizationWorkIntentStore } from "./OrganizationWorkIntentStore.ts";
import {
  OrganizationWorkApprovalVerifierDisabled,
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

export interface OrganizationWorkIntentActivationPrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}
export type OrganizationWorkIntentActivationRecord = OrganizationWorkIntentActivationResult;
const fail = (code: OrganizationWorkIntentActivationError["code"], message: string) =>
  new OrganizationWorkIntentActivationError({ code, message });
const isActivationError = Schema.is(OrganizationWorkIntentActivationError);
const decodeSelection = Schema.decodeUnknownEffect(Selection);
const decodePublished = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrganizationPublishedConfig),
);
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** The runtime owner supplies this only after dispatch and recovery gates are mounted. */
export class OrganizationWorkIntentActivationReadiness extends Context.Service<
  OrganizationWorkIntentActivationReadiness,
  { readonly permits: (organizationId: string, intentId: string) => boolean }
>()(
  "t3/organizations/OrganizationWorkIntentActivation/OrganizationWorkIntentActivationReadiness",
) {}
export const OrganizationWorkIntentActivationReadinessDisabled = Layer.succeed(
  OrganizationWorkIntentActivationReadiness,
  { permits: () => false },
);

type ActivationRow = {
  intent_id: string;
  organization_id: string;
  work_id: string;
  selection_json: string;
  activated_by: string;
  activated_at: string;
};

const jsonValue = (value: unknown, depth = 0): string => {
  if (depth > 16) throw fail("invalid", "QA case JSON exceeds its depth limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => jsonValue(item, depth + 1)).join(",")}]`;
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw fail("invalid", "QA cases must contain plain finite JSON values.");
  const object = value as Record<string, unknown>;
  const members = Object.keys(object)
    .sort()
    .map((key) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        throw fail("invalid", "QA case JSON contains a reserved key.");
      return `${JSON.stringify(key)}:${jsonValue(object[key], depth + 1)}`;
    });
  return `{${members.join(",")}}`;
};

export const selectionSnapshot = (input: unknown) =>
  Effect.gen(function* () {
    const selected = yield* decodeSelection(input).pipe(
      Effect.mapError(() => fail("invalid", "Work activation selection is invalid.")),
    );
    if (
      !selected.taskText.trim() ||
      selected.taskText.includes("\0") ||
      Buffer.byteLength(selected.taskText, "utf8") > 4_000
    )
      return yield* fail("invalid", "Selected task must be nonempty and at most 4 KB.");
    const snapshot = yield* Effect.try({
      try: () => {
        const cases = selected.qaPlan.cases.map((item) => {
          const inputJson = jsonValue(item.input);
          const expectedJson = jsonValue(item.expected);
          if (
            Buffer.byteLength(inputJson, "utf8") > 4_096 ||
            Buffer.byteLength(expectedJson, "utf8") > 4_096
          )
            throw fail("invalid", "QA case exceeds its byte limit.");
          return { input: JSON.parse(inputJson), expected: JSON.parse(expectedJson) };
        });
        return JSON.stringify({
          workflowId: selected.workflowId,
          targetRef: selected.targetRef,
          fileName: selected.fileName,
          taskText: selected.taskText,
          modelSelection: selected.modelSelection,
          qaPlan: { version: 1, exportName: selected.qaPlan.exportName, cases },
        });
      },
      catch: (error) =>
        isActivationError(error)
          ? error
          : fail("invalid", "Work activation selection must be finite JSON."),
    });
    if (Buffer.byteLength(snapshot, "utf8") > 24 * 1024)
      return yield* fail("invalid", "Work activation selection exceeds its byte limit.");
    const canonical = yield* decodeSelection(JSON.parse(snapshot)).pipe(
      Effect.mapError(() => fail("invalid", "Canonical work selection is invalid.")),
    );
    return { selected: canonical, snapshot };
  });

const decodeRow = (row: ActivationRow) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(row.selection_json) as unknown,
      catch: () => fail("unavailable", "Saved work selection is unreadable."),
    });
    const { selected } = yield* selectionSnapshot(parsed).pipe(
      Effect.mapError(() => fail("unavailable", "Saved work selection is invalid.")),
    );
    return {
      intentId: row.intent_id,
      organizationId: OrganizationId.make(row.organization_id),
      workId: WorkIdSchema.make(row.work_id),
      selection: selected,
      activatedBy: row.activated_by,
      activatedAt: row.activated_at,
    } satisfies OrganizationWorkIntentActivationRecord;
  });

const workStoreFor = (input: {
  organizationId: string;
  projectId: string;
  bindingId: string;
  workId: string;
  subject: string;
}) =>
  OrganizationWorkStoreLayer.pipe(
    Layer.provide(
      Layer.succeed(OrganizationWorkExecutionAuthority, {
        permits: (action, principal, target) =>
          action === "create" &&
          principal.subject === input.subject &&
          target.organizationId === input.organizationId &&
          target.projectId === input.projectId &&
          target.bindingId === input.bindingId &&
          target.workId === input.workId &&
          target.scope === null,
      }),
    ),
    Layer.provide(OrganizationWorkArtifactVerifierDisabled),
    Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
    Layer.provide(OrganizationWorkApprovalVerifierDisabled),
    Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
  );

const standingSubject = (authorizationId: string) =>
  `system:organization-standing:${sha256(authorizationId)}`;

/** One transaction for a human click or an exact persisted standing grant. */
const activateOrganizationWorkIntentInternal = (
  input: OrganizationWorkIntentActivationInput,
  principal: OrganizationWorkIntentActivationPrincipal,
  standingAuthorizationId: string | null,
) =>
  Effect.gen(function* () {
    if (
      (!principal.interactive &&
        (standingAuthorizationId === null ||
          principal.subject !== standingSubject(standingAuthorizationId))) ||
      !principal.subject.trim() ||
      Buffer.byteLength(principal.subject, "utf8") > 160
    )
      return yield* fail(
        "forbidden",
        "Work activation requires an authenticated interactive user.",
      );
    if (!input.intentId || input.intentId.length > 160)
      return yield* fail("invalid", "Selected work intent ID is invalid.");
    const { selected, snapshot } = yield* selectionSnapshot(input.selection);
    const readiness = yield* OrganizationWorkIntentActivationReadiness;
    if (!readiness.permits(input.organizationId, input.intentId))
      return yield* fail("unavailable", "Organization work execution is not ready.");
    const sql = yield* SqlClient.SqlClient;
    const intents = yield* OrganizationWorkIntentStore;
    const git = yield* GitVcsDriver;
    const targetPreflight = yield* OrganizationGitTargetPreflight;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Serialize concurrent activation requests before checking the immutable link.
          const locked = yield* sql<{ organization_id: string }>`UPDATE organizations
      SET updated_at = updated_at WHERE organization_id = ${input.organizationId}
      RETURNING organization_id`;
          if (locked.length !== 1) return yield* fail("not_found", "Organization is unavailable.");
          const prior =
            (yield* sql<ActivationRow>`SELECT * FROM organization_work_intent_activations
      WHERE intent_id = ${input.intentId} AND organization_id = ${input.organizationId}`)[0];
          if (prior) {
            if (prior.selection_json !== snapshot)
              return yield* fail("conflict", "Work intent was activated with another selection.");
            if (standingAuthorizationId !== null) {
              const use = (yield* sql<{ authorization_id: string }>`
                SELECT authorization_id FROM organization_standing_work_activation_uses
                WHERE intent_id = ${input.intentId}`)[0];
              if (use?.authorization_id !== standingAuthorizationId)
                return yield* fail("conflict", "Work intent was activated by another actor.");
            }
            return yield* decodeRow(prior);
          }
          const emergencyStop = yield* sql<{ organization_id: string }>`
            SELECT organization_id FROM organization_emergency_stops
            WHERE organization_id = ${input.organizationId} LIMIT 1`;
          if (emergencyStop.length > 0)
            return yield* fail(
              "conflict",
              "Organization emergency stop holds new work activation.",
            );
          const draining = yield* sql<{ organization_id: string }>`
            SELECT organization_id FROM organization_live_work_drains
            WHERE organization_id = ${input.organizationId} LIMIT 1`;
          if (draining.length > 0)
            return yield* fail(
              "conflict",
              "Finish the Organization drain before activating more work.",
            );
          const intent = yield* intents
            .get(input.organizationId, input.intentId)
            .pipe(Effect.mapError((error) => fail(error.code, error.message)));
          if (intent.freshness !== "current")
            return yield* fail("conflict", `Selected work intent is stale: ${intent.staleReason}.`);
          if (standingAuthorizationId !== null) {
            const grant = (yield* sql<{
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
              revoked_at: string | null;
            }>`SELECT * FROM organization_standing_work_authorizations
              WHERE authorization_id = ${standingAuthorizationId}`)[0];
            const now = DateTime.formatIso(yield* DateTime.now);
            if (
              !grant ||
              grant.revoked_at !== null ||
              grant.expires_at <= now ||
              grant.used_activations >= grant.max_activations ||
              grant.organization_id !== input.organizationId ||
              grant.project_id !== intent.projectId ||
              grant.binding_id !== intent.bindingId ||
              grant.binding_version !== intent.bindingVersion ||
              grant.published_revision !== intent.publishedRevision ||
              grant.selection_json !== snapshot ||
              !intent.evidence.some(
                (item) => item.sourceId === grant.source_id && item.projectId === intent.projectId,
              )
            )
              return yield* fail(
                "conflict",
                "Standing work authorization no longer matches this intent.",
              );
            const source = (yield* sql<{
              kind: string;
              enabled: number;
              project_id: string | null;
            }>`
              SELECT kind, enabled, project_id FROM organization_intake_sources
              WHERE source_id = ${grant.source_id} AND organization_id = ${input.organizationId}`)[0];
            if (
              source?.kind !== "generic-http" ||
              source.enabled !== 1 ||
              source.project_id !== intent.projectId
            )
              return yield* fail("conflict", "Standing work intake source is unavailable.");
            const budgets = yield* sql<{
              scope_kind: string;
              max_concurrent: number;
              max_daily_calls: number;
              max_daily_estimated_tokens: number;
            }>`
              SELECT scope_kind, max_concurrent, max_daily_calls, max_daily_estimated_tokens
              FROM organization_provider_budget_limits
              WHERE (scope_kind = 'global' AND scope_id = '*')
                OR (scope_kind = 'organization' AND scope_id = ${input.organizationId})
                OR (scope_kind = 'project' AND scope_id = ${intent.projectId})`;
            if (
              budgets.length !== 3 ||
              budgets.some(
                (row) =>
                  row.max_concurrent < 1 ||
                  row.max_daily_calls < 1 ||
                  row.max_daily_estimated_tokens < 140_000,
              )
            )
              return yield* fail("unavailable", "Standing work provider budget is not configured.");
          }
          const org = (yield* sql<{
            lifecycle: string;
            draft_revision: number;
            published_revision: number | null;
          }>`
      SELECT lifecycle, draft_revision, published_revision FROM organizations
      WHERE organization_id = ${input.organizationId}`)[0];
          if (
            !org ||
            !["draft", "active"].includes(org.lifecycle) ||
            org.published_revision !== intent.publishedRevision
          )
            return yield* fail("conflict", "Organization publication changed before activation.");
          const configRow = (yield* sql<{ config_json: string }>`SELECT config_json
      FROM organization_config_versions WHERE organization_id = ${input.organizationId}
        AND revision = ${intent.publishedRevision}`)[0];
          if (!configRow) return yield* fail("conflict", "Published configuration is unavailable.");
          const config = yield* decodePublished(configRow.config_json).pipe(
            Effect.mapError(() => fail("unavailable", "Published configuration is invalid.")),
          );
          const workflow = config.workflows.find((item) => item.id === selected.workflowId);
          if (
            !workflow ||
            !["work", "qa", "approval", "integrate"].every((kind) =>
              workflow.steps.some((step) => step.kind === kind),
            )
          )
            return yield* fail(
              "forbidden",
              "Selected published workflow cannot run reviewed work.",
            );
          const binding = config.bindings.find((item) => item.id === intent.bindingId);
          if (
            !binding ||
            binding.projectId !== intent.projectId ||
            binding.scope !== null ||
            binding.access !== "write" ||
            binding.detachedAt !== null ||
            binding.updatedAt !== intent.bindingVersion ||
            !(["propose-work", "read-files", "write-files", "run-tests"] as const).every(
              (capability) => binding.capabilities.includes(capability),
            )
          )
            return yield* fail(
              "forbidden",
              "Published Project binding lacks single-file execution authority.",
            );
          const project = (yield* sql<{ workspace_root: string; deleted_at: string | null }>`
      SELECT workspace_root, deleted_at FROM projection_projects
      WHERE project_id = ${intent.projectId}`)[0];
          if (
            !project ||
            project.deleted_at !== null ||
            !NodePath.isAbsolute(project.workspace_root)
          )
            return yield* fail("forbidden", "Project checkout is unavailable.");
          const head = yield* git
            .resolveCommit({ cwd: project.workspace_root, revision: "HEAD" })
            .pipe(Effect.mapError(() => fail("conflict", "Project Git HEAD cannot be resolved.")));
          if (!FULL_COMMIT.test(head.commitSha))
            return yield* fail("conflict", "Project Git HEAD is not a full commit.");
          const target = yield* git
            .resolveCommit({
              cwd: project.workspace_root,
              revision: selected.targetRef,
            })
            .pipe(
              Effect.mapError(() => fail("conflict", "Selected Project branch is unavailable.")),
            );
          if (target.commitSha !== head.commitSha)
            return yield* fail("conflict", "Selected Project branch does not match current HEAD.");
          yield* targetPreflight
            .verify({
              projectRoot: project.workspace_root,
              targetRef: selected.targetRef,
              baseCommit: head.commitSha,
            })
            .pipe(Effect.mapError((error) => fail(error.code, error.message)));
          if (!readiness.permits(input.organizationId, input.intentId))
            return yield* fail("unavailable", "Organization work execution is no longer ready.");
          const idHash = sha256(input.intentId);
          const workId = WorkIdSchema.make(`org-work:${idHash}`);
          if (org.lifecycle === "draft") {
            const lifecycleInput = {
              organizationId: input.organizationId,
              mutationId: `org-activate:${idHash}`,
              baseRevision: org.draft_revision,
              actor: "user" as const,
              lifecycle: "active" as const,
            };
            yield* OrganizationStore.pipe(
              Effect.flatMap((store) => store.setLifecycle(lifecycleInput)),
              Effect.provide(
                Layer.fresh(
                  OrganizationStoreLayer.pipe(
                    Layer.provide(
                      Layer.succeed(OrganizationLifecycleActivationAuthority, {
                        permits: (request) => request === lifecycleInput,
                      }),
                    ),
                  ),
                ),
              ),
              Effect.mapError((error) =>
                fail(error.code === "unavailable" ? "unavailable" : "conflict", error.message),
              ),
            );
          }
          yield* OrganizationWorkStore.pipe(
            Effect.flatMap((store) =>
              store.createWork(
                {
                  workId,
                  requestId: `org-work-create:${idHash}`,
                  organizationId: input.organizationId,
                  findingId: OrganizationTentativeFindingId.make(intent.findingId),
                  projectId: ProjectId.make(intent.projectId),
                  bindingId: OrganizationBindingId.make(intent.bindingId),
                  workflowId: selected.workflowId,
                  scope: null,
                  codeRevision: head.commitSha,
                  attemptLimit: 1,
                },
                { subject: principal.subject },
              ),
            ),
            Effect.provide(
              workStoreFor({
                organizationId: input.organizationId,
                projectId: intent.projectId,
                bindingId: intent.bindingId,
                workId,
                subject: principal.subject,
              }),
            ),
            Effect.mapError((error) => fail(error.code, error.message)),
          );
          const activatedAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`INSERT INTO organization_work_intent_activations
      (intent_id, organization_id, work_id, selection_json, activated_by, activated_at)
      VALUES (${input.intentId}, ${input.organizationId}, ${workId}, ${snapshot},
        ${principal.subject}, ${activatedAt})`;
          if (standingAuthorizationId !== null) {
            const used = yield* sql<{ authorization_id: string }>`
              UPDATE organization_standing_work_authorizations
              SET used_activations = used_activations + 1
              WHERE authorization_id = ${standingAuthorizationId}
                AND revoked_at IS NULL AND used_activations < max_activations
              RETURNING authorization_id`;
            if (used.length !== 1)
              return yield* fail("conflict", "Standing work authorization capacity changed.");
            yield* sql`INSERT INTO organization_standing_work_activation_uses
              (intent_id, authorization_id, work_id, used_at)
              VALUES (${input.intentId}, ${standingAuthorizationId}, ${workId}, ${activatedAt})`;
          }
          return {
            intentId: input.intentId,
            organizationId: input.organizationId,
            workId,
            selection: selected,
            activatedBy: principal.subject,
            activatedAt,
          } satisfies OrganizationWorkIntentActivationRecord;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isActivationError(error)
            ? error
            : fail("unavailable", "Work activation storage is unavailable."),
        ),
      );
  });

/** Explicit human activation remains the only RPC-facing entry point. */
export const activateOrganizationWorkIntent = (
  input: OrganizationWorkIntentActivationInput,
  principal: OrganizationWorkIntentActivationPrincipal,
) => activateOrganizationWorkIntentInternal(input, principal, null);

/** Server-only reconciler entry point; the persisted grant is checked in the activation transaction. */
export const activateOrganizationWorkIntentFromStandingAuthorization = (
  input: OrganizationWorkIntentActivationInput,
  authorizationId: string,
) =>
  activateOrganizationWorkIntentInternal(
    input,
    { subject: standingSubject(authorizationId), interactive: false },
    authorizationId,
  );

/** Server policy lookup; the immutable selection is fenced to a persisted WorkStore item. */
export const readOrganizationWorkIntentActivationByWorkId = (workId: OrganizationWorkId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql<ActivationRow & { workflow_id: string }>`SELECT a.*, work.workflow_id
      FROM organization_work_intent_activations a
      JOIN organization_work_items work ON work.work_id = a.work_id
      JOIN organization_work_intents intent ON intent.intent_id = a.intent_id
      WHERE a.work_id = ${workId}
        AND work.organization_id = a.organization_id
        AND intent.organization_id = a.organization_id
        AND work.finding_id = intent.finding_id
        AND work.project_id = intent.project_id
        AND work.binding_id = intent.binding_id
        AND work.binding_version = intent.binding_version
        AND work.published_revision = intent.published_revision
        AND work.creator_subject = a.activated_by`)[0];
    if (!row) return yield* fail("not_found", "Activated work selection was not found.");
    const decoded = yield* decodeRow(row);
    if (decoded.selection.workflowId !== row.workflow_id)
      return yield* fail("conflict", "Saved work workflow differs from its activation.");
    return decoded;
  }).pipe(
    Effect.mapError((error) =>
      isActivationError(error)
        ? error
        : fail("unavailable", "Work activation lookup is unavailable."),
    ),
  );

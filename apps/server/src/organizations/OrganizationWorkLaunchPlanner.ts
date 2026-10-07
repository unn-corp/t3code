// @effect-diagnostics nodeBuiltinImport:off - This Node-only server module uses synchronous host crypto for persistent IDs or hashes; replacing it would add Crypto service requirements through the persistence API.
import * as NodeCrypto from "node:crypto";
import { OrganizationPublishedConfig, type OrganizationWorkId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";

type BindingRow = {
  organization_id: string;
  project_id: string;
  access: string;
  capabilities_json: string;
  scope: string | null;
  updated_at: string;
  detached_at: string | null;
};
type ProjectRow = { workspace_root: string; deleted_at: string | null };
type OrganizationRow = { lifecycle: string; published_revision: number | null };
type ConfigRow = { config_json: string };

export interface OrganizationWorkLaunchPlan {
  readonly workId: OrganizationWorkId;
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly scope: string | null;
  readonly publishedRevision: number;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly baseCommit: string;
  readonly projectRoot: string;
  /** Hint only: planning does not reserve an attempt or a resource permit. */
  readonly nextAttemptNumber: number;
  /** A name under a server-owned worktree directory; never a Project checkout fallback. */
  readonly worktreeName: string;
  readonly branchName: string;
}

export class OrganizationWorkLaunchError extends Schema.TaggedError<OrganizationWorkLaunchError>()(
  "OrganizationWorkLaunchError",
  {
    code: Schema.Literals(["not_found", "forbidden", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}
const fail = (code: OrganizationWorkLaunchError["code"], message: string) =>
  new OrganizationWorkLaunchError({ code, message });
const unavailable = () => fail("unavailable", "Organization work launch preflight is unavailable.");
const CapabilitiesJson = Schema.fromJsonString(Schema.Array(Schema.String));
const PublishedJson = Schema.fromJsonString(OrganizationPublishedConfig);
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface OrganizationWorkLaunchPlannerShape {
  readonly plan: (
    workId: OrganizationWorkId,
  ) => Effect.Effect<OrganizationWorkLaunchPlan, OrganizationWorkLaunchError>;
}
export class OrganizationWorkLaunchPlanner extends Context.Service<
  OrganizationWorkLaunchPlanner,
  OrganizationWorkLaunchPlannerShape
>()("t3/organizations/OrganizationWorkLaunchPlanner") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workStore = yield* OrganizationWorkStore;
  const git = yield* GitVcsDriver;
  const plan: OrganizationWorkLaunchPlannerShape["plan"] = (workId) =>
    Effect.gen(function* () {
      const detail = yield* workStore
        .getWork(workId)
        .pipe(Effect.mapError(() => fail("not_found", "Organization work item is unavailable.")));
      const work = detail.work;
      if (work.status !== "pending" && work.status !== "retrying")
        return yield* fail("conflict", "Work is not ready for an attempt.");
      if (work.attemptCount >= work.attemptLimit)
        return yield* fail("conflict", "Attempt limit reached.");
      const organization = (yield* sql<OrganizationRow>`SELECT lifecycle, published_revision
        FROM organizations WHERE organization_id = ${work.organizationId}`)[0];
      if (
        !organization ||
        organization.lifecycle !== "active" ||
        organization.published_revision === null
      )
        return yield* fail("forbidden", "Organization runtime is not active and published.");
      const binding = (yield* sql<BindingRow>`SELECT organization_id, project_id, access,
          capabilities_json, scope, updated_at, detached_at
        FROM organization_project_bindings WHERE binding_id = ${work.bindingId}`)[0];
      if (
        !binding ||
        binding.organization_id !== work.organizationId ||
        binding.project_id !== work.projectId ||
        binding.detached_at !== null ||
        binding.access !== "write" ||
        binding.updated_at !== work.bindingVersion ||
        binding.scope !== work.scope
      )
        return yield* fail("forbidden", "Current Project binding no longer authorizes this work.");
      const capabilities = yield* Schema.decodeEffect(CapabilitiesJson)(
        binding.capabilities_json,
      ).pipe(Effect.mapError(() => unavailable()));
      if (
        !capabilities.includes("read-files") ||
        !capabilities.includes("write-files") ||
        !capabilities.includes("run-tests")
      )
        return yield* fail("forbidden", "Current binding lacks required repository capabilities.");
      const project = (yield* sql<ProjectRow>`SELECT workspace_root, deleted_at
        FROM projection_projects WHERE project_id = ${work.projectId}`)[0];
      if (!project || project.deleted_at !== null || !project.workspace_root.trim())
        return yield* fail("forbidden", "Project checkout is unavailable.");
      const configRow = (yield* sql<ConfigRow>`SELECT config_json
        FROM organization_config_versions WHERE organization_id = ${work.organizationId}
          AND revision = ${work.publishedRevision}`)[0];
      if (!configRow) return yield* fail("conflict", "Pinned configuration is missing.");
      const config = yield* Schema.decodeEffect(PublishedJson)(configRow.config_json).pipe(
        Effect.mapError(() => unavailable()),
      );
      if (
        !config.workflows.some(
          (workflow) =>
            workflow.id === work.workflowId && workflow.version === work.workflowVersion,
        )
      )
        return yield* fail("conflict", "Pinned workflow is missing or changed.");
      if (!FULL_COMMIT.test(work.codeRevision))
        return yield* fail("conflict", "Work has no full pinned Git commit.");
      const resolved = yield* git
        .resolveCommit({ cwd: project.workspace_root, revision: work.codeRevision })
        .pipe(
          Effect.mapError(() =>
            fail("conflict", "Pinned Git commit is unavailable in the Project checkout."),
          ),
        );
      if (resolved.commitSha !== work.codeRevision)
        return yield* fail("conflict", "Pinned Git commit no longer resolves identically.");
      const nextAttemptNumber = work.attemptCount + 1;
      const suffix = NodeCrypto.createHash("sha256")
        .update(`${work.organizationId}\0${work.id}\0${nextAttemptNumber}`)
        .digest("hex")
        .slice(0, 24);
      return {
        workId: work.id,
        organizationId: work.organizationId,
        projectId: work.projectId,
        bindingId: work.bindingId,
        bindingVersion: work.bindingVersion,
        scope: work.scope,
        publishedRevision: work.publishedRevision,
        workflowId: work.workflowId,
        workflowVersion: work.workflowVersion,
        baseCommit: resolved.commitSha,
        projectRoot: project.workspace_root,
        nextAttemptNumber,
        worktreeName: `organization-${suffix}`,
        branchName: `organization/${suffix}`,
      };
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(OrganizationWorkLaunchError)(error) ? error : unavailable(),
      ),
    );
  return { plan } satisfies OrganizationWorkLaunchPlannerShape;
});

/** Planning is read-only. No live worker or execution authority is installed here. */
export const OrganizationWorkLaunchPlannerLive = Layer.effect(OrganizationWorkLaunchPlanner, make);

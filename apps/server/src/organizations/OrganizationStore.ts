import {
  Organization,
  OrganizationAuditEntry,
  OrganizationBindingId,
  OrganizationBindProjectInput,
  OrganizationCreateInput,
  OrganizationDetachProjectInput,
  OrganizationError,
  OrganizationGetInput,
  OrganizationGraph,
  OrganizationLayout,
  OrganizationLifecycleInput,
  OrganizationMutationInput,
  OrganizationPublishInput,
  OrganizationPublishedConfig,
  OrganizationProjectBinding,
  OrganizationRoleId,
  OrganizationId,
  OrganizationArchitectAllowedChange,
  type OrganizationArchitectApplyBatchInput,
  OrganizationWorkflowDefinition,
  type OrganizationRole,
  type OrganizationWorkflowStepId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type OrganizationRow = {
  organization_id: string;
  title: string;
  mission: string;
  lifecycle: string;
  draft_revision: number;
  published_revision: number | null;
  architect_role_id: string;
  director_role_id: string;
  graph_json: string;
  workflows_json: string;
  layout_json: string;
  created_at: string;
  updated_at: string;
};
type BindingRow = {
  binding_id: string;
  organization_id: string;
  project_id: string;
  access: string;
  capabilities_json: string;
  scope: string | null;
  detached_at: string | null;
  created_at: string;
  updated_at: string;
};
type AuditRow = {
  mutation_id: string;
  organization_id: string;
  actor: string;
  action: string;
  base_revision: number;
  applied_revision: number;
  payload_json: string;
  created_at: string;
};

const invalid = (message: string) => new OrganizationError({ code: "invalid", message });
const conflict = (message: string) => new OrganizationError({ code: "conflict", message });
const notFound = () =>
  new OrganizationError({ code: "not_found", message: "Organization not found." });
const unavailable = () =>
  new OrganizationError({ code: "unavailable", message: "Organization storage is unavailable." });
const decodeOrganization = (value: unknown) =>
  Schema.decodeUnknownEffect(Organization)(value).pipe(
    Effect.mapError(() => invalid("Stored organization data is invalid.")),
  );
const decodeBindingValue = (value: unknown) =>
  Schema.decodeUnknownEffect(OrganizationProjectBinding)(value).pipe(
    Effect.mapError(() => invalid("Stored Project binding is invalid.")),
  );
const decodePublished = (value: unknown) =>
  Schema.decodeUnknownEffect(OrganizationPublishedConfig)(value).pipe(
    Effect.mapError(() => invalid("Stored published configuration is invalid.")),
  );
const decodeAudit = (value: unknown) =>
  Schema.decodeUnknownEffect(OrganizationAuditEntry)(value).pipe(
    Effect.mapError(() => invalid("Stored organization audit is invalid.")),
  );
const parseJson = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => invalid("Stored organization JSON is invalid.")),
  );
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const json = (value: unknown) => JSON.stringify(value);

/** Checks structural invariants in the responsibility graph. */
export const validateOrganizationGraph = (
  organization: Pick<Organization, "graph" | "layout" | "architectRoleId" | "directorRoleId">,
): ReadonlyArray<string> => {
  const { roles, edges } = organization.graph;
  const issues: string[] = [];
  const roleIds = new Set<string>();
  for (const role of roles) {
    if (roleIds.has(role.id)) issues.push(`Duplicate role '${role.id}'.`);
    roleIds.add(role.id);
  }
  if (organization.architectRoleId === organization.directorRoleId)
    issues.push("Architect and Director must be distinct.");
  const architect = roles.find((role) => role.id === organization.architectRoleId);
  const director = roles.find((role) => role.id === organization.directorRoleId);
  if (architect?.kind !== "architect")
    issues.push("Architect role is missing or has the wrong kind.");
  if (director?.kind !== "director") issues.push("Director role is missing or has the wrong kind.");
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) issues.push(`Duplicate edge '${edge.id}'.`);
    edgeIds.add(edge.id);
    if (!roleIds.has(edge.fromRoleId) || !roleIds.has(edge.toRoleId))
      issues.push(`Edge '${edge.id}' refers to a missing role.`);
    if (edge.fromRoleId === edge.toRoleId) issues.push(`Edge '${edge.id}' cannot point to itself.`);
    if (edge.kind === "reviews" && edge.fromRoleId === edge.toRoleId)
      issues.push("A role cannot review itself.");
  }
  const positions = new Set<string>();
  for (const position of organization.layout.positions) {
    if (!roleIds.has(position.roleId))
      issues.push(`Layout refers to missing role '${position.roleId}'.`);
    if (positions.has(position.roleId))
      issues.push(`Duplicate layout position for '${position.roleId}'.`);
    positions.add(position.roleId);
  }
  // Supervision and delegation may not form a cycle. Consultation and review are non-scheduling edges.
  const directed = edges.filter(
    (edge) => edge.kind === "reports-to" || edge.kind === "delegates-to",
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (roleId: string): boolean => {
    if (visiting.has(roleId)) return true;
    if (visited.has(roleId)) return false;
    visiting.add(roleId);
    for (const edge of directed) {
      if (edge.fromRoleId === roleId && visit(edge.toRoleId)) return true;
    }
    visiting.delete(roleId);
    visited.add(roleId);
    return false;
  };
  if (roles.some((role) => visit(role.id)))
    issues.push("Supervision or delegation cycle is not allowed.");
  return issues;
};

/** Validates an executable workflow independently of the responsibility graph. */
export const validateOrganizationWorkflow = (
  workflow: OrganizationWorkflowDefinition,
  roles: ReadonlyArray<OrganizationRole>,
): ReadonlyArray<string> => {
  const issues: string[] = [];
  const steps = new Map(workflow.steps.map((step) => [step.id, step]));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  if (steps.size !== workflow.steps.length) issues.push("Workflow step IDs must be unique.");
  if (workflow.steps.filter((step) => step.kind === "trigger").length !== 1)
    issues.push("Workflow needs exactly one trigger.");
  if (!workflow.steps.some((step) => step.kind === "finish"))
    issues.push("Workflow needs a finish step.");
  const transitionIds = new Set<string>();
  for (const transition of workflow.transitions) {
    if (transitionIds.has(transition.id)) issues.push(`Duplicate transition '${transition.id}'.`);
    transitionIds.add(transition.id);
    if (!steps.has(transition.fromStepId) || !steps.has(transition.toStepId))
      issues.push(`Transition '${transition.id}' refers to a missing step.`);
    if (transition.fromStepId === transition.toStepId && transition.maxTraversals === null)
      issues.push(`Self-loop '${transition.id}' needs a traversal limit.`);
  }
  for (const step of workflow.steps) {
    const role = step.roleId === null ? null : roleById.get(step.roleId);
    if (step.roleId !== null && !role) issues.push(`Step '${step.id}' refers to a missing role.`);
    if ((step.kind === "work" || step.kind === "qa" || step.kind === "integrate") && !role)
      issues.push(`Step '${step.id}' needs an assigned role.`);
    if ((step.kind === "trigger" || step.kind === "finish") && step.roleId !== null)
      issues.push(`Step '${step.id}' cannot assign a role.`);
    if (step.kind === "qa" && role?.kind !== "qa")
      issues.push(`QA step '${step.id}' must use a QA role.`);
    if (step.kind === "qa" || step.kind === "approval") {
      const reviewed = step.reviewsStepId === null ? undefined : steps.get(step.reviewsStepId);
      if (reviewed?.kind !== "work")
        issues.push(`Review step '${step.id}' must reference a work step.`);
      if (role && reviewed?.roleId === role.id)
        issues.push(`Review step '${step.id}' cannot approve its own role's work.`);
    } else if (step.reviewsStepId !== null) {
      issues.push(`Step '${step.id}' cannot review another step.`);
    }
    const incoming = workflow.transitions.filter((edge) => edge.toStepId === step.id);
    const outgoing = workflow.transitions.filter((edge) => edge.fromStepId === step.id);
    if (step.kind === "trigger" && incoming.length > 0)
      issues.push("Trigger cannot have incoming transitions.");
    if (step.kind === "finish" && outgoing.length > 0)
      issues.push(`Finish step '${step.id}' cannot have outgoing transitions.`);
    if (step.kind !== "trigger" && incoming.length === 0)
      issues.push(`Step '${step.id}' has no incoming transition.`);
    if (step.kind !== "finish" && outgoing.length === 0)
      issues.push(`Step '${step.id}' has no outgoing transition.`);
  }
  if (issues.length > 0) return issues;

  // Removing every bounded edge must leave an acyclic graph. Then each possible
  // cycle consumes one of a finite set of traversal permits.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const unbounded = workflow.transitions.filter((edge) => edge.maxTraversals === null);
  const hasUnboundedCycle = (stepId: OrganizationWorkflowStepId): boolean => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    for (const edge of unbounded) {
      if (edge.fromStepId === stepId && hasUnboundedCycle(edge.toStepId)) return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  if (workflow.steps.some((step) => hasUnboundedCycle(step.id)))
    issues.push("Workflow has an unbounded cycle.");

  const trigger = workflow.steps.find((step) => step.kind === "trigger");
  if (!trigger) return issues;
  const queue: Array<{
    stepId: OrganizationWorkflowStepId;
    unreviewedWork: ReadonlyArray<string>;
    qaCompleted: boolean;
  }> = [{ stepId: trigger.id, unreviewedWork: [], qaCompleted: false }];
  const reached = new Set<string>();
  const reachedSteps = new Set<string>();
  let finishReached = false;
  while (queue.length > 0) {
    const state = queue.shift();
    if (!state) break;
    const key = `${state.stepId}:${state.qaCompleted}:${state.unreviewedWork.join(",")}`;
    if (reached.has(key)) continue;
    if (reached.size >= 4_096) {
      issues.push("Workflow has too many reachable review states.");
      break;
    }
    reached.add(key);
    reachedSteps.add(state.stepId);
    const step = steps.get(state.stepId);
    if (!step) continue;
    const unreviewedWork = new Set(state.unreviewedWork);
    let qaCompleted = state.qaCompleted;
    if (step.kind === "work") unreviewedWork.add(step.id);
    if (step.kind === "qa") {
      if (step.reviewsStepId !== null && unreviewedWork.has(step.reviewsStepId)) {
        unreviewedWork.delete(step.reviewsStepId);
        qaCompleted = true;
      } else {
        issues.push(`QA step '${step.id}' is reachable before the work it reviews.`);
      }
    }
    if (step.kind === "integrate" && (!qaCompleted || unreviewedWork.size > 0))
      issues.push(`Integration step '${step.id}' can bypass QA for prior work.`);
    if (step.kind === "finish") {
      finishReached = true;
      if (unreviewedWork.size > 0)
        issues.push(`Finish step '${step.id}' can bypass QA for prior work.`);
    }
    const nextUnreviewedWork = [...unreviewedWork].sort();
    for (const edge of workflow.transitions) {
      if (edge.fromStepId === step.id)
        queue.push({ stepId: edge.toStepId, unreviewedWork: nextUnreviewedWork, qaCompleted });
    }
  }
  if (!finishReached) issues.push("Finish step is unreachable.");
  for (const step of workflow.steps) {
    if (!reachedSteps.has(step.id)) issues.push(`Step '${step.id}' is unreachable.`);
  }
  return [...new Set(issues)];
};

const applyChange = (
  organization: Organization,
  change: OrganizationMutationInput["change"],
): Organization => {
  const graph = organization.graph;
  switch (change.type) {
    case "add-role":
      return { ...organization, graph: { ...graph, roles: [...graph.roles, change.role] } };
    case "update-role":
      if (!graph.roles.some((role) => role.id === change.roleId)) throw invalid("Role not found.");
      return {
        ...organization,
        graph: {
          ...graph,
          roles: graph.roles.map((role) =>
            role.id === change.roleId
              ? {
                  ...role,
                  ...(change.title !== undefined ? { title: change.title } : {}),
                  ...(change.mandate !== undefined ? { mandate: change.mandate } : {}),
                  ...(change.poolSize !== undefined ? { poolSize: change.poolSize } : {}),
                }
              : role,
          ),
        },
      };
    case "remove-role":
      if (
        change.roleId === organization.architectRoleId ||
        change.roleId === organization.directorRoleId
      )
        throw invalid("Core identities cannot be removed.");
      if (!graph.roles.some((role) => role.id === change.roleId)) throw invalid("Role not found.");
      if (
        graph.edges.some(
          (edge) => edge.fromRoleId === change.roleId || edge.toRoleId === change.roleId,
        )
      )
        throw invalid("Disconnect the role before removing it.");
      return {
        ...organization,
        graph: { ...graph, roles: graph.roles.filter((role) => role.id !== change.roleId) },
        layout: {
          positions: organization.layout.positions.filter(
            (position) => position.roleId !== change.roleId,
          ),
        },
      };
    case "add-edge":
      return { ...organization, graph: { ...graph, edges: [...graph.edges, change.edge] } };
    case "remove-edge":
      if (!graph.edges.some((edge) => edge.id === change.edgeId)) throw invalid("Edge not found.");
      return {
        ...organization,
        graph: { ...graph, edges: graph.edges.filter((edge) => edge.id !== change.edgeId) },
      };
    case "set-layout":
      return { ...organization, layout: change.layout };
    case "set-title":
      return { ...organization, title: change.title };
    case "set-mission":
      return { ...organization, mission: change.mission };
    case "upsert-workflow": {
      const previous = organization.workflows.find(
        (workflow) => workflow.id === change.workflow.id,
      );
      if (change.workflow.version !== (previous?.version ?? 0) + 1)
        throw invalid("Workflow version must advance by one from its current version.");
      return {
        ...organization,
        workflows: [
          ...organization.workflows.filter((workflow) => workflow.id !== change.workflow.id),
          change.workflow,
        ],
      };
    }
    case "remove-workflow":
      if (!organization.workflows.some((workflow) => workflow.id === change.workflowId))
        throw invalid("Workflow not found.");
      return {
        ...organization,
        workflows: organization.workflows.filter((workflow) => workflow.id !== change.workflowId),
      };
  }
};

export interface OrganizationStoreShape {
  readonly create: (
    input: OrganizationCreateInput,
  ) => Effect.Effect<Organization, OrganizationError>;
  readonly get: (input: OrganizationGetInput) => Effect.Effect<Organization, OrganizationError>;
  readonly applyArchitectBatch: (
    input: OrganizationArchitectApplyBatchInput,
  ) => Effect.Effect<Organization, OrganizationError>;
  readonly list: () => Effect.Effect<
    { organizations: ReadonlyArray<Organization> },
    OrganizationError
  >;
  readonly mutate: (
    input: OrganizationMutationInput,
  ) => Effect.Effect<Organization, OrganizationError>;
  readonly publish: (
    input: OrganizationPublishInput,
  ) => Effect.Effect<Organization, OrganizationError>;
  readonly getPublishedConfig: (input: {
    organizationId: OrganizationId;
    revision: number;
  }) => Effect.Effect<OrganizationPublishedConfig, OrganizationError>;
  readonly setLifecycle: (
    input: OrganizationLifecycleInput,
  ) => Effect.Effect<Organization, OrganizationError>;
  readonly bindProject: (
    input: OrganizationBindProjectInput,
  ) => Effect.Effect<Organization, OrganizationError>;
  readonly detachProject: (
    input: OrganizationDetachProjectInput,
  ) => Effect.Effect<Organization, OrganizationError>;
  readonly listAudit: (input: {
    organizationId: OrganizationId;
  }) => Effect.Effect<{ entries: ReadonlyArray<OrganizationAuditEntry> }, OrganizationError>;
}
export class OrganizationStore extends Context.Service<OrganizationStore, OrganizationStoreShape>()(
  "t3/organizations/OrganizationStore",
) {}

/** Only the explicit, server-owned work activation path may open execution. */
export class OrganizationLifecycleActivationAuthority extends Context.Service<
  OrganizationLifecycleActivationAuthority,
  {
    readonly permits: (input: OrganizationLifecycleInput) => boolean;
  }
>()("t3/organizations/OrganizationStore/OrganizationLifecycleActivationAuthority") {}
export const OrganizationLifecycleActivationDisabled = Layer.succeed(
  OrganizationLifecycleActivationAuthority,
  { permits: () => false },
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lifecycleActivation = yield* OrganizationLifecycleActivationAuthority;
  const getRows = (organizationId: OrganizationId) => sql<OrganizationRow>`
    SELECT * FROM organizations WHERE organization_id = ${organizationId}
  `;
  const bindingRows = (organizationId: OrganizationId) => sql<BindingRow>`
    SELECT * FROM organization_project_bindings WHERE organization_id = ${organizationId}
    ORDER BY created_at, binding_id
  `;
  const decodeBindingRow = Effect.fnUntraced(function* (row: BindingRow) {
    const capabilities = yield* parseJson(row.capabilities_json);
    return yield* decodeBindingValue({
      id: row.binding_id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      access: row.access,
      capabilities,
      scope: row.scope,
      detachedAt: row.detached_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });
  const load = Effect.fnUntraced(function* (organizationId: OrganizationId) {
    const row = (yield* getRows(organizationId))[0];
    if (!row) return yield* notFound();
    const graph = yield* parseJson(row.graph_json);
    const workflows = yield* parseJson(row.workflows_json);
    const layout = yield* parseJson(row.layout_json);
    const bindings: OrganizationProjectBinding[] = [];
    for (const binding of yield* bindingRows(organizationId))
      bindings.push(yield* decodeBindingRow(binding));
    return yield* decodeOrganization({
      id: row.organization_id,
      title: row.title,
      mission: row.mission,
      lifecycle: row.lifecycle,
      draftRevision: row.draft_revision,
      publishedRevision: row.published_revision,
      architectRoleId: row.architect_role_id,
      directorRoleId: row.director_role_id,
      graph,
      workflows,
      layout,
      bindings,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });
  const audit = (input: {
    mutationId: string;
    organizationId: OrganizationId;
    actor: string;
    action: string;
    baseRevision: number;
    appliedRevision: number;
    payload: unknown;
    createdAt: string;
  }) => sql`
    INSERT INTO organization_audit
      (mutation_id, organization_id, actor, action, base_revision, applied_revision, payload_json, created_at)
    VALUES (${input.mutationId}, ${input.organizationId}, ${input.actor}, ${input.action},
      ${input.baseRevision}, ${input.appliedRevision}, ${json(input.payload)}, ${input.createdAt})
  `;
  const ensureMutationUnused = Effect.fnUntraced(function* (mutationId: string) {
    const rows = yield* sql<{
      mutation_id: string;
    }>`SELECT mutation_id FROM organization_audit WHERE mutation_id = ${mutationId}`;
    if (rows.length > 0)
      return yield* new OrganizationError({
        code: "duplicate_mutation",
        message: "Mutation ID has already been applied.",
      });
  });
  const checkedCurrent = Effect.fnUntraced(function* (input: {
    organizationId: OrganizationId;
    baseRevision: number;
    mutationId: string;
  }) {
    yield* ensureMutationUnused(input.mutationId);
    const current = yield* load(input.organizationId);
    if (current.lifecycle === "archived")
      return yield* new OrganizationError({
        code: "forbidden",
        message: "Archived organizations cannot be changed.",
      });
    if (current.draftRevision !== input.baseRevision)
      return yield* conflict(
        `Expected revision ${input.baseRevision}; current revision is ${current.draftRevision}.`,
      );
    return current;
  });
  const bump = Effect.fnUntraced(function* (input: {
    current: Organization;
    next: Organization;
    mutationId: string;
    actor: string;
    action: string;
    payload: unknown;
  }) {
    const { current, next } = input;
    const updatedAt = yield* now;
    const revision = current.draftRevision + 1;
    const updatedRows = yield* sql<{ organization_id: string }>`
      UPDATE organizations SET title = ${next.title}, mission = ${next.mission},
        lifecycle = ${next.lifecycle}, draft_revision = ${revision},
        published_revision = ${next.publishedRevision}, graph_json = ${json(next.graph)},
        workflows_json = ${json(next.workflows)}, layout_json = ${json(next.layout)}, updated_at = ${updatedAt}
      WHERE organization_id = ${current.id} AND draft_revision = ${current.draftRevision}
      RETURNING organization_id
    `;
    if (updatedRows.length !== 1)
      return yield* conflict("Organization revision changed before the edit committed.");
    yield* audit({
      mutationId: input.mutationId,
      organizationId: current.id,
      actor: input.actor,
      action: input.action,
      baseRevision: current.draftRevision,
      appliedRevision: revision,
      payload: input.payload,
      createdAt: updatedAt,
    });
    return yield* load(current.id);
  });
  const transaction = <A, E>(
    effect: Effect.Effect<A, E, never>,
  ): Effect.Effect<A, OrganizationError> =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) => (Schema.is(OrganizationError)(error) ? error : unavailable())),
      );

  const create: OrganizationStoreShape["create"] = (input) =>
    transaction(
      Effect.gen(function* () {
        yield* ensureMutationUnused(input.mutationId);
        const existing = yield* getRows(input.organizationId);
        if (existing.length > 0) return yield* conflict("Organization ID already exists.");
        const createdAt = yield* now;
        const architectRoleId = OrganizationRoleId.make(`${input.organizationId}:architect`);
        const directorRoleId = OrganizationRoleId.make(`${input.organizationId}:director`);
        const graph: OrganizationGraph = {
          roles: [
            {
              id: architectRoleId,
              kind: "architect",
              title: "Architect",
              mandate: "Design the organization",
              poolSize: 1,
            },
            {
              id: directorRoleId,
              kind: "director",
              title: "Director",
              mandate: "Represent the organization",
              poolSize: 1,
            },
          ],
          edges: [],
        };
        const layout: OrganizationLayout = { positions: [] };
        yield* sql`
      INSERT INTO organizations (organization_id, title, mission, lifecycle, draft_revision,
        published_revision, architect_role_id, director_role_id, graph_json, workflows_json, layout_json, created_at, updated_at)
      VALUES (${input.organizationId}, ${input.title}, ${input.mission}, 'draft', 1, NULL,
        ${architectRoleId}, ${directorRoleId}, ${json(graph)}, '[]', ${json(layout)}, ${createdAt}, ${createdAt})
    `;
        yield* audit({
          mutationId: input.mutationId,
          organizationId: input.organizationId,
          actor: input.actor,
          action: "create",
          baseRevision: 0,
          appliedRevision: 1,
          payload: { title: input.title, mission: input.mission },
          createdAt,
        });
        return yield* load(input.organizationId);
      }),
    );

  const get: OrganizationStoreShape["get"] = ({ organizationId }) =>
    load(organizationId).pipe(
      Effect.mapError((error) => (Schema.is(OrganizationError)(error) ? error : unavailable())),
    );
  const list: OrganizationStoreShape["list"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ organization_id: string }>`
      SELECT organization_id FROM organizations ORDER BY created_at, organization_id
    `;
      const organizations: Organization[] = [];
      for (const row of rows)
        organizations.push(yield* load(OrganizationId.make(row.organization_id)));
      return { organizations };
    }).pipe(
      Effect.mapError((error) => (Schema.is(OrganizationError)(error) ? error : unavailable())),
    );

  const mutate: OrganizationStoreShape["mutate"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* checkedCurrent(input);
        if (
          input.actor !== "user" &&
          (input.change.type === "set-mission" ||
            (input.change.type === "add-role" && input.change.role.poolSize > 1) ||
            (input.change.type === "update-role" && input.change.poolSize !== undefined))
        )
          return yield* new OrganizationError({
            code: "forbidden",
            message: "A user must approve mission or capacity changes.",
          });
        const next = yield* Effect.try({
          try: () => applyChange(current, input.change),
          catch: (error) =>
            Schema.is(OrganizationError)(error) ? error : invalid("Invalid organization change."),
        });
        const issues = validateOrganizationGraph(next);
        if (issues.length > 0) return yield* invalid(issues.join(" "));
        return yield* bump({
          current,
          next,
          mutationId: input.mutationId,
          actor: input.actor,
          action: input.change.type,
          payload: input.change,
        });
      }),
    );

  const applyArchitectBatch: OrganizationStoreShape["applyArchitectBatch"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* checkedCurrent(input);
        if (new Set(input.proposalIds).size !== input.proposalIds.length)
          return yield* invalid("Architect proposal IDs must be distinct.");
        const saved: Array<{
          id: string;
          requestId: string;
          position: number;
          change: typeof OrganizationArchitectAllowedChange.Type;
        }> = [];
        for (const proposalId of input.proposalIds) {
          const row = (yield* sql<{
            proposal_id: string;
            request_id: string;
            position: number;
            base_revision: number;
            change_json: string;
            request_status: string;
          }>`SELECT p.proposal_id, p.request_id, p.position, p.base_revision,
            p.change_json, r.status AS request_status
            FROM organization_architect_proposals p
            JOIN organization_architect_requests r ON r.request_id = p.request_id
            WHERE p.proposal_id = ${proposalId}
              AND p.organization_id = ${input.organizationId}
              AND r.organization_id = ${input.organizationId}`)[0];
          if (
            !row ||
            row.base_revision !== input.baseRevision ||
            row.request_status !== "completed"
          )
            return yield* conflict("Architect proposal is no longer available for this draft.");
          const change = yield* Schema.decodeUnknownEffect(OrganizationArchitectAllowedChange)(
            yield* parseJson(row.change_json),
          ).pipe(Effect.mapError(() => invalid("Saved Architect proposal is invalid.")));
          saved.push({
            id: row.proposal_id,
            requestId: row.request_id,
            position: row.position,
            change,
          });
        }
        if (new Set(saved.map((proposal) => proposal.requestId)).size !== 1)
          return yield* invalid("Apply proposals from one Architect response at a time.");
        saved.sort((left, right) => left.position - right.position);
        let next = current;
        for (const proposal of saved) {
          next = yield* Effect.try({
            try: () => applyChange(next, proposal.change),
            catch: (error) =>
              Schema.is(OrganizationError)(error)
                ? error
                : invalid("Architect proposal cannot be applied."),
          });
        }
        const issues = [
          ...validateOrganizationGraph(next),
          ...next.workflows.flatMap((workflow) =>
            validateOrganizationWorkflow(workflow, next.graph.roles),
          ),
        ];
        if (new Set(next.workflows.map((workflow) => workflow.id)).size !== next.workflows.length)
          issues.push("Duplicate workflow IDs.");
        if (issues.length > 0) return yield* invalid(issues.join(" "));
        return yield* bump({
          current,
          next,
          mutationId: input.mutationId,
          actor: "user",
          action: "architect-batch",
          payload: {
            proposalIds: saved.map((proposal) => proposal.id),
            changes: saved.map((proposal) => proposal.change),
          },
        });
      }),
    );

  const publish: OrganizationStoreShape["publish"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* checkedCurrent(input);
        if (input.actor !== "user")
          return yield* new OrganizationError({
            code: "forbidden",
            message: "Only a user may publish configuration.",
          });
        const issues = [...validateOrganizationGraph(current)];
        const workflowIds = new Set<string>();
        for (const workflow of current.workflows) {
          if (workflowIds.has(workflow.id)) issues.push(`Duplicate workflow '${workflow.id}'.`);
          workflowIds.add(workflow.id);
          issues.push(...validateOrganizationWorkflow(workflow, current.graph.roles));
        }
        if (issues.length > 0) return yield* invalid(issues.join(" "));
        const publishedAt = yield* now;
        const revision = current.draftRevision + 1;
        const config: OrganizationPublishedConfig = {
          organizationId: current.id,
          revision,
          title: current.title,
          mission: current.mission,
          graph: current.graph,
          workflows: current.workflows,
          bindings: current.bindings.filter((binding) => binding.detachedAt === null),
          publishedAt,
        };
        yield* sql`
      INSERT INTO organization_config_versions (organization_id, revision, config_json, published_at)
      VALUES (${current.id}, ${revision}, ${json(config)}, ${publishedAt})
    `;
        return yield* bump({
          current,
          next: { ...current, publishedRevision: revision },
          mutationId: input.mutationId,
          actor: input.actor,
          action: "publish",
          payload: {},
        });
      }),
    );
  const getPublishedConfig: OrganizationStoreShape["getPublishedConfig"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ config_json: string }>`
      SELECT config_json FROM organization_config_versions
      WHERE organization_id = ${input.organizationId} AND revision = ${input.revision}
    `;
      const row = rows[0];
      if (!row) return yield* notFound();
      return yield* decodePublished(yield* parseJson(row.config_json));
    }).pipe(
      Effect.mapError((error) => (Schema.is(OrganizationError)(error) ? error : unavailable())),
    );

  const requireNoOpenExecution = Effect.fnUntraced(function* (
    organizationId: OrganizationId,
    bindingId: OrganizationBindingId | null,
  ) {
    const claims = yield* sql<{ work_id: string }>`
      SELECT claim.work_id FROM organization_live_work_phase_claims claim
      JOIN organization_work_items w ON w.work_id = claim.work_id
      WHERE claim.organization_id = ${organizationId}
        AND (${bindingId} IS NULL OR w.binding_id = ${bindingId})
      LIMIT 1`;
    if (claims.length > 0)
      return yield* conflict(
        "An admitted Organization work phase must settle before changing its authority.",
      );
    const rows = yield* sql<{ work_id: string }>`
      SELECT w.work_id FROM organization_work_items w
      JOIN organization_work_attempts a ON a.work_id = w.work_id
      LEFT JOIN organization_work_scopes s ON s.attempt_id = a.attempt_id
      WHERE w.organization_id = ${organizationId}
        AND (${bindingId} IS NULL OR w.binding_id = ${bindingId})
        AND (a.status = 'running' OR
          (s.attempt_id IS NOT NULL AND s.verified_stopped_at IS NULL))
      LIMIT 1
    `;
    if (rows.length > 0)
      return yield* conflict(
        "Stop and verify active Organization work before changing its authority.",
      );
  });

  const setLifecycle: OrganizationStoreShape["setLifecycle"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* checkedCurrent(input);
        if (input.actor !== "user")
          return yield* new OrganizationError({
            code: "forbidden",
            message: "Only a user may change lifecycle.",
          });
        if (input.lifecycle === "draft") return yield* invalid("Lifecycle cannot return to draft.");
        if (input.lifecycle === "active" && !lifecycleActivation.permits(input))
          return yield* new OrganizationError({
            code: "unavailable",
            message: "Project work runtime is not ready; check worker recovery before activating.",
          });
        if (input.lifecycle === "active" && current.publishedRevision === null)
          return yield* invalid("Publish configuration before activating the Organization.");
        if (input.lifecycle === current.lifecycle)
          return yield* invalid("Lifecycle is already in that state.");
        if (input.lifecycle === "paused" && current.lifecycle !== "active")
          return yield* invalid("Only an active Organization can be paused.");
        if (input.lifecycle === "paused" || input.lifecycle === "archived")
          yield* requireNoOpenExecution(current.id, null);
        if (input.lifecycle === "archived") {
          const emergencyStop = yield* sql<{ organization_id: string }>`
            SELECT organization_id FROM organization_emergency_stops
            WHERE organization_id = ${current.id} LIMIT 1`;
          if (emergencyStop.length > 0)
            return yield* conflict("Resolve emergency stop before archiving this Organization.");
          const openWork = yield* sql<{ work_id: string }>`
            SELECT work_id FROM organization_work_items
            WHERE organization_id = ${current.id}
              AND status NOT IN ('succeeded', 'failed', 'canceled')
            LIMIT 1
          `;
          if (openWork.length > 0)
            return yield* new OrganizationError({
              code: "conflict",
              message: "Resolve or cancel open Organization work before archiving.",
            });
          const detachedAt = yield* now;
          yield* sql`
            UPDATE organization_project_bindings
            SET detached_at = ${detachedAt}, updated_at = ${detachedAt}
            WHERE organization_id = ${current.id} AND detached_at IS NULL
          `;
          yield* sql`DELETE FROM organization_live_work_drains
            WHERE organization_id = ${current.id} AND completed_at IS NOT NULL`;
        }
        return yield* bump({
          current,
          next: { ...current, lifecycle: input.lifecycle },
          mutationId: input.mutationId,
          actor: input.actor,
          action: `lifecycle:${input.lifecycle}`,
          payload: { lifecycle: input.lifecycle },
        });
      }),
    );

  const bindProject: OrganizationStoreShape["bindProject"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* checkedCurrent(input);
        if (input.actor !== "user")
          return yield* new OrganizationError({
            code: "forbidden",
            message: "Only a user may grant Project access.",
          });
        if (
          input.access !== "write" &&
          input.capabilities.some(
            (capability) => capability === "write-files" || capability === "run-tests",
          )
        )
          return yield* invalid("Write capabilities require write access.");
        const projects = yield* sql<{ project_id: string }>`
      SELECT project_id FROM projection_projects WHERE project_id = ${input.projectId} AND deleted_at IS NULL
    `;
        if (projects.length === 0)
          return yield* invalid("Target Project does not exist or is deleted.");
        if (
          current.bindings.some(
            (binding) => binding.projectId === input.projectId && binding.detachedAt === null,
          )
        )
          return yield* conflict("Organization already has an active binding to this Project.");
        if (input.access === "write") {
          const steward = yield* sql<{ binding_id: string }>`
        SELECT binding_id FROM organization_project_bindings
        WHERE project_id = ${input.projectId} AND access = 'write' AND detached_at IS NULL
      `;
          if (steward.length > 0) return yield* conflict("Project already has a write steward.");
        }
        const createdAt = yield* now;
        yield* sql`
      INSERT INTO organization_project_bindings (binding_id, organization_id, project_id,
        access, capabilities_json, scope, detached_at, created_at, updated_at)
      VALUES (${input.bindingId}, ${input.organizationId}, ${input.projectId}, ${input.access},
        ${json(input.capabilities)}, ${input.scope}, NULL, ${createdAt}, ${createdAt})
    `;
        return yield* bump({
          current,
          next: current,
          mutationId: input.mutationId,
          actor: input.actor,
          action: "bind-project",
          payload: {
            bindingId: input.bindingId,
            projectId: input.projectId,
            access: input.access,
            capabilities: input.capabilities,
            scope: input.scope,
          },
        });
      }),
    );

  const detachProject: OrganizationStoreShape["detachProject"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* checkedCurrent(input);
        if (input.actor !== "user")
          return yield* new OrganizationError({
            code: "forbidden",
            message: "Only a user may detach a Project.",
          });
        const binding = current.bindings.find(
          (entry) => entry.id === input.bindingId && entry.detachedAt === null,
        );
        if (!binding) return yield* invalid("Active Project binding not found.");
        yield* requireNoOpenExecution(current.id, input.bindingId);
        const openWork = yield* sql<{ work_id: string }>`
          SELECT work_id FROM organization_work_items
          WHERE binding_id = ${input.bindingId}
            AND status NOT IN ('succeeded', 'failed', 'canceled')
          LIMIT 1
        `;
        if (openWork.length > 0)
          return yield* conflict("Resolve or cancel bound Organization work before detaching.");
        const detachedAt = yield* now;
        yield* sql`
      UPDATE organization_project_bindings SET detached_at = ${detachedAt}, updated_at = ${detachedAt}
      WHERE binding_id = ${input.bindingId} AND organization_id = ${input.organizationId} AND detached_at IS NULL
    `;
        return yield* bump({
          current,
          next: current,
          mutationId: input.mutationId,
          actor: input.actor,
          action: "detach-project",
          payload: { bindingId: input.bindingId, projectId: binding.projectId },
        });
      }),
    );

  const listAudit: OrganizationStoreShape["listAudit"] = (input) =>
    Effect.gen(function* () {
      yield* load(input.organizationId);
      const rows = yield* sql<AuditRow>`
      SELECT * FROM organization_audit WHERE organization_id = ${input.organizationId}
      ORDER BY applied_revision, mutation_id
    `;
      const entries: OrganizationAuditEntry[] = [];
      for (const row of rows)
        entries.push(
          yield* decodeAudit({
            mutationId: row.mutation_id,
            organizationId: row.organization_id,
            actor: row.actor,
            action: row.action,
            baseRevision: row.base_revision,
            appliedRevision: row.applied_revision,
            payload: yield* parseJson(row.payload_json),
            createdAt: row.created_at,
          }),
        );
      return { entries };
    }).pipe(
      Effect.mapError((error) => (Schema.is(OrganizationError)(error) ? error : unavailable())),
    );

  return {
    create,
    get,
    list,
    mutate,
    applyArchitectBatch,
    publish,
    getPublishedConfig,
    setLifecycle,
    bindProject,
    detachProject,
    listAudit,
  } satisfies OrganizationStoreShape;
});

export const OrganizationStoreLayer = Layer.effect(OrganizationStore, make);
export const OrganizationStoreLive = OrganizationStoreLayer.pipe(
  Layer.provide(OrganizationLifecycleActivationDisabled),
);

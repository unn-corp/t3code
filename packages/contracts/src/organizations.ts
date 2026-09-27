import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const OrganizationId = TrimmedNonEmptyString.pipe(Schema.brand("OrganizationId"));
export type OrganizationId = typeof OrganizationId.Type;
export const OrganizationRoleId = TrimmedNonEmptyString.pipe(Schema.brand("OrganizationRoleId"));
export type OrganizationRoleId = typeof OrganizationRoleId.Type;
export const OrganizationEdgeId = TrimmedNonEmptyString.pipe(Schema.brand("OrganizationEdgeId"));
export type OrganizationEdgeId = typeof OrganizationEdgeId.Type;
export const OrganizationBindingId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrganizationBindingId"),
);
export type OrganizationBindingId = typeof OrganizationBindingId.Type;

export const OrganizationLifecycle = Schema.Literals(["draft", "active", "paused", "archived"]);
export type OrganizationLifecycle = typeof OrganizationLifecycle.Type;
export const OrganizationActor = Schema.Literals(["user", "architect", "server"]);
export type OrganizationActor = typeof OrganizationActor.Type;
export const OrganizationRoleKind = Schema.Literals([
  "architect",
  "director",
  "engineering",
  "qa",
  "security",
  "research",
  "custom",
]);
export const OrganizationEdgeKind = Schema.Literals([
  "reports-to",
  "delegates-to",
  "reviews",
  "consults",
  "escalates-to",
]);
export const OrganizationBindingAccess = Schema.Literals(["read", "proposal", "write"]);
export type OrganizationBindingAccess = typeof OrganizationBindingAccess.Type;
export const OrganizationCapability = Schema.Literals([
  "read-files",
  "read-history",
  "propose-work",
  "write-files",
  "run-tests",
]);
export type OrganizationCapability = typeof OrganizationCapability.Type;

export const OrganizationRole = Schema.Struct({
  id: OrganizationRoleId,
  kind: OrganizationRoleKind,
  title: TrimmedNonEmptyString,
  mandate: Schema.String,
  poolSize: PositiveInt,
});
export type OrganizationRole = typeof OrganizationRole.Type;
export const OrganizationEdge = Schema.Struct({
  id: OrganizationEdgeId,
  fromRoleId: OrganizationRoleId,
  toRoleId: OrganizationRoleId,
  kind: OrganizationEdgeKind,
});
export type OrganizationEdge = typeof OrganizationEdge.Type;
export const OrganizationGraph = Schema.Struct({
  roles: Schema.Array(OrganizationRole),
  edges: Schema.Array(OrganizationEdge),
});
export type OrganizationGraph = typeof OrganizationGraph.Type;
export const OrganizationLayoutPosition = Schema.Struct({
  roleId: OrganizationRoleId,
  x: Schema.Finite,
  y: Schema.Finite,
});
export const OrganizationLayout = Schema.Struct({
  positions: Schema.Array(OrganizationLayoutPosition),
});
export type OrganizationLayout = typeof OrganizationLayout.Type;

/** Workflow edges are executable routing, separate from organization relationships. */
export const OrganizationWorkflowId = TrimmedNonEmptyString.check(Schema.isMaxLength(120)).pipe(
  Schema.brand("OrganizationWorkflowId"),
);
export type OrganizationWorkflowId = typeof OrganizationWorkflowId.Type;
export const OrganizationWorkflowStepId = TrimmedNonEmptyString.check(Schema.isMaxLength(120)).pipe(
  Schema.brand("OrganizationWorkflowStepId"),
);
export type OrganizationWorkflowStepId = typeof OrganizationWorkflowStepId.Type;
export const OrganizationWorkflowTransitionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(120),
).pipe(Schema.brand("OrganizationWorkflowTransitionId"));
export type OrganizationWorkflowTransitionId = typeof OrganizationWorkflowTransitionId.Type;
export const OrganizationWorkflowStepKind = Schema.Literals([
  "trigger",
  "work",
  "qa",
  "approval",
  "integrate",
  "finish",
]);
export const OrganizationWorkflowStep = Schema.Struct({
  id: OrganizationWorkflowStepId,
  kind: OrganizationWorkflowStepKind,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  roleId: Schema.NullOr(OrganizationRoleId),
  /** A QA or approval step names the work step whose author it evaluates. */
  reviewsStepId: Schema.NullOr(OrganizationWorkflowStepId),
});
export type OrganizationWorkflowStep = typeof OrganizationWorkflowStep.Type;
export const OrganizationWorkflowTransition = Schema.Struct({
  id: OrganizationWorkflowTransitionId,
  fromStepId: OrganizationWorkflowStepId,
  toStepId: OrganizationWorkflowStepId,
  /** A cycle is allowed only when traversing one of its edges has a fixed limit. */
  maxTraversals: Schema.NullOr(PositiveInt.check(Schema.isLessThanOrEqualTo(3))),
});
export type OrganizationWorkflowTransition = typeof OrganizationWorkflowTransition.Type;
export const OrganizationWorkflowDefinition = Schema.Struct({
  id: OrganizationWorkflowId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  version: PositiveInt,
  steps: Schema.Array(OrganizationWorkflowStep).check(Schema.isMaxLength(64)),
  transitions: Schema.Array(OrganizationWorkflowTransition).check(Schema.isMaxLength(128)),
});
export type OrganizationWorkflowDefinition = typeof OrganizationWorkflowDefinition.Type;
const Workflows = Schema.Array(OrganizationWorkflowDefinition)
  .check(Schema.isMaxLength(24))
  .pipe(Schema.withDecodingDefault(Effect.succeed([])));

export const OrganizationProjectBinding = Schema.Struct({
  id: OrganizationBindingId,
  organizationId: OrganizationId,
  projectId: ProjectId,
  access: OrganizationBindingAccess,
  capabilities: Schema.Array(OrganizationCapability),
  scope: Schema.NullOr(TrimmedNonEmptyString),
  detachedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrganizationProjectBinding = typeof OrganizationProjectBinding.Type;
export const OrganizationPublishedConfig = Schema.Struct({
  organizationId: OrganizationId,
  revision: PositiveInt,
  title: TrimmedNonEmptyString,
  mission: Schema.String,
  graph: OrganizationGraph,
  workflows: Workflows,
  bindings: Schema.Array(OrganizationProjectBinding),
  publishedAt: IsoDateTime,
});
export type OrganizationPublishedConfig = typeof OrganizationPublishedConfig.Type;

export const Organization = Schema.Struct({
  id: OrganizationId,
  title: TrimmedNonEmptyString,
  mission: Schema.String,
  lifecycle: OrganizationLifecycle,
  draftRevision: PositiveInt,
  publishedRevision: Schema.NullOr(PositiveInt),
  architectRoleId: OrganizationRoleId,
  directorRoleId: OrganizationRoleId,
  graph: OrganizationGraph,
  workflows: Workflows,
  layout: OrganizationLayout,
  bindings: Schema.Array(OrganizationProjectBinding),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Organization = typeof Organization.Type;
export const OrganizationGetInput = Schema.Struct({ organizationId: OrganizationId });
export type OrganizationGetInput = typeof OrganizationGetInput.Type;
export const OrganizationListInput = Schema.Struct({});
export type OrganizationListInput = typeof OrganizationListInput.Type;
export const OrganizationListResult = Schema.Struct({ organizations: Schema.Array(Organization) });
export type OrganizationListResult = typeof OrganizationListResult.Type;

export class OrganizationError extends Schema.TaggedError<OrganizationError>()(
  "OrganizationError",
  {
    code: Schema.Literals([
      "invalid",
      "not_found",
      "conflict",
      "duplicate_mutation",
      "forbidden",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}

export const OrganizationCreateInput = Schema.Struct({
  organizationId: OrganizationId,
  mutationId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  mission: Schema.String,
  actor: OrganizationActor,
});
export type OrganizationCreateInput = typeof OrganizationCreateInput.Type;

export const OrganizationChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("add-role"), role: OrganizationRole }),
  Schema.Struct({
    type: Schema.Literal("update-role"),
    roleId: OrganizationRoleId,
    title: Schema.optional(TrimmedNonEmptyString),
    mandate: Schema.optional(Schema.String),
    poolSize: Schema.optional(PositiveInt),
  }),
  Schema.Struct({ type: Schema.Literal("remove-role"), roleId: OrganizationRoleId }),
  Schema.Struct({ type: Schema.Literal("add-edge"), edge: OrganizationEdge }),
  Schema.Struct({ type: Schema.Literal("remove-edge"), edgeId: OrganizationEdgeId }),
  Schema.Struct({ type: Schema.Literal("set-layout"), layout: OrganizationLayout }),
  Schema.Struct({ type: Schema.Literal("set-title"), title: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("set-mission"), mission: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("upsert-workflow"),
    workflow: OrganizationWorkflowDefinition,
  }),
  Schema.Struct({ type: Schema.Literal("remove-workflow"), workflowId: OrganizationWorkflowId }),
]);
export type OrganizationChange = typeof OrganizationChange.Type;
export const OrganizationMutationInput = Schema.Struct({
  organizationId: OrganizationId,
  mutationId: TrimmedNonEmptyString,
  baseRevision: PositiveInt,
  actor: OrganizationActor,
  change: OrganizationChange,
});
export type OrganizationMutationInput = typeof OrganizationMutationInput.Type;

const RevisionedAction = {
  organizationId: OrganizationId,
  mutationId: TrimmedNonEmptyString,
  baseRevision: PositiveInt,
  actor: OrganizationActor,
};
export const OrganizationPublishInput = Schema.Struct(RevisionedAction);
export type OrganizationPublishInput = typeof OrganizationPublishInput.Type;
export const OrganizationLifecycleInput = Schema.Struct({
  ...RevisionedAction,
  lifecycle: OrganizationLifecycle,
});
export type OrganizationLifecycleInput = typeof OrganizationLifecycleInput.Type;
export const OrganizationBindProjectInput = Schema.Struct({
  ...RevisionedAction,
  bindingId: OrganizationBindingId,
  projectId: ProjectId,
  access: OrganizationBindingAccess,
  capabilities: Schema.Array(OrganizationCapability),
  scope: Schema.NullOr(TrimmedNonEmptyString),
});
export type OrganizationBindProjectInput = typeof OrganizationBindProjectInput.Type;
export const OrganizationDetachProjectInput = Schema.Struct({
  ...RevisionedAction,
  bindingId: OrganizationBindingId,
});
export type OrganizationDetachProjectInput = typeof OrganizationDetachProjectInput.Type;

export const OrganizationAuditEntry = Schema.Struct({
  mutationId: TrimmedNonEmptyString,
  organizationId: OrganizationId,
  actor: OrganizationActor,
  action: TrimmedNonEmptyString,
  baseRevision: NonNegativeInt,
  appliedRevision: PositiveInt,
  payload: Schema.Unknown,
  createdAt: IsoDateTime,
});
export type OrganizationAuditEntry = typeof OrganizationAuditEntry.Type;
export const OrganizationAuditListInput = Schema.Struct({ organizationId: OrganizationId });
export type OrganizationAuditListInput = typeof OrganizationAuditListInput.Type;
export const OrganizationAuditListResult = Schema.Struct({
  entries: Schema.Array(OrganizationAuditEntry),
});
export type OrganizationAuditListResult = typeof OrganizationAuditListResult.Type;

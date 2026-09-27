import {
  OrganizationWorkflowId,
  OrganizationWorkflowStepId,
  OrganizationWorkflowTransitionId,
  type Organization,
  type OrganizationChange,
  type OrganizationRole,
  type OrganizationWorkflowDefinition,
  type OrganizationWorkflowStep,
  type OrganizationWorkflowTransition,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { Input } from "../ui/input";

const SELECT_CLASS =
  "min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const MAX_TITLE_LENGTH = 160;
const MAX_TRANSITIONS = 128;
const WORK_ROLE_KINDS = new Set<OrganizationRole["kind"]>([
  "engineering",
  "security",
  "research",
  "custom",
]);

export function workflowWorkRoles(roles: ReadonlyArray<OrganizationRole>): OrganizationRole[] {
  return roles.filter((role) => WORK_ROLE_KINDS.has(role.kind));
}

function template(
  title: string,
  workRoleId: OrganizationRole["id"],
  qaRoleId: OrganizationRole["id"],
  retries: number,
): OrganizationWorkflowDefinition {
  const trigger = OrganizationWorkflowStepId.make(randomUUID());
  const work = OrganizationWorkflowStepId.make(randomUUID());
  const qa = OrganizationWorkflowStepId.make(randomUUID());
  const integrate = OrganizationWorkflowStepId.make(randomUUID());
  const finish = OrganizationWorkflowStepId.make(randomUUID());
  const route = (
    fromStepId: OrganizationWorkflowStepId,
    toStepId: OrganizationWorkflowStepId,
    maxTraversals: number | null = null,
  ): OrganizationWorkflowTransition => ({
    id: OrganizationWorkflowTransitionId.make(randomUUID()),
    fromStepId,
    toStepId,
    maxTraversals,
  });
  return {
    id: OrganizationWorkflowId.make(randomUUID()),
    title,
    version: 1,
    steps: [
      { id: trigger, kind: "trigger", title: "Start", roleId: null, reviewsStepId: null },
      { id: work, kind: "work", title: "Do the work", roleId: workRoleId, reviewsStepId: null },
      { id: qa, kind: "qa", title: "Review the work", roleId: qaRoleId, reviewsStepId: work },
      {
        id: integrate,
        kind: "integrate",
        title: "Integrate approved work",
        roleId: workRoleId,
        reviewsStepId: null,
      },
      { id: finish, kind: "finish", title: "Finish", roleId: null, reviewsStepId: null },
    ],
    transitions: [
      route(trigger, work),
      route(work, qa),
      route(qa, integrate),
      route(integrate, finish),
      ...(retries > 0 ? [route(qa, work, retries)] : []),
    ],
  };
}

function draftIssues(
  workflow: OrganizationWorkflowDefinition,
  roles: ReadonlyArray<OrganizationRole>,
): string[] {
  const issues: string[] = [];
  const steps = new Map(workflow.steps.map((step) => [step.id, step]));
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  if (!workflow.title.trim() || workflow.title.trim().length > MAX_TITLE_LENGTH)
    issues.push("Give the workflow a title of 1 to 160 characters.");
  if (steps.size !== workflow.steps.length) issues.push("Step IDs must be unique.");
  if (workflow.steps.filter((step) => step.kind === "trigger").length !== 1)
    issues.push("A workflow needs exactly one trigger.");
  if (!workflow.steps.some((step) => step.kind === "finish"))
    issues.push("A workflow needs a finish step.");
  for (const step of workflow.steps) {
    if (!step.title.trim() || step.title.trim().length > MAX_TITLE_LENGTH)
      issues.push(`Give each step a title of 1 to 160 characters.`);
    const role = step.roleId === null ? null : rolesById.get(step.roleId);
    if (step.roleId !== null && !role) issues.push(`Assign an existing role to ${step.title}.`);
    if ((step.kind === "work" || step.kind === "qa" || step.kind === "integrate") && !role)
      issues.push(`${step.title} needs a role.`);
    if ((step.kind === "trigger" || step.kind === "finish") && step.roleId !== null)
      issues.push(`${step.title} cannot have a role.`);
    if (step.kind === "qa" && role?.kind !== "qa") issues.push(`${step.title} needs a QA role.`);
    if (step.kind === "qa" || step.kind === "approval") {
      const reviewed = step.reviewsStepId === null ? null : steps.get(step.reviewsStepId);
      if (reviewed?.kind !== "work") issues.push(`${step.title} must review a work step.`);
      if (role && reviewed?.roleId === role.id)
        issues.push(`${step.title} cannot review work assigned to the same role.`);
    } else if (step.reviewsStepId !== null) {
      issues.push(`${step.title} cannot review another step.`);
    }
    const incoming = workflow.transitions.filter((route) => route.toStepId === step.id);
    const outgoing = workflow.transitions.filter((route) => route.fromStepId === step.id);
    if (step.kind === "trigger" && incoming.length > 0)
      issues.push("The trigger cannot have an incoming transition.");
    if (step.kind === "finish" && outgoing.length > 0)
      issues.push("A finish step cannot have an outgoing transition.");
    if (step.kind !== "trigger" && incoming.length === 0)
      issues.push(`${step.title} needs an incoming transition.`);
    if (step.kind !== "finish" && outgoing.length === 0)
      issues.push(`${step.title} needs an outgoing transition.`);
  }
  if (workflow.transitions.length > MAX_TRANSITIONS)
    issues.push(`Keep at most ${MAX_TRANSITIONS} transitions.`);
  const transitionIds = new Set<string>();
  for (const transition of workflow.transitions) {
    if (transitionIds.has(transition.id)) issues.push("Transition IDs must be unique.");
    transitionIds.add(transition.id);
    if (!steps.has(transition.fromStepId) || !steps.has(transition.toStepId))
      issues.push("Every transition must connect existing steps.");
    if (transition.fromStepId === transition.toStepId && transition.maxTraversals === null)
      issues.push("A transition back to the same step needs a retry limit.");
  }
  const visiting = new Set<OrganizationWorkflowStepId>();
  const visited = new Set<OrganizationWorkflowStepId>();
  const hasUnboundedCycle = (stepId: OrganizationWorkflowStepId): boolean => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    for (const route of workflow.transitions) {
      if (
        route.maxTraversals === null &&
        route.fromStepId === stepId &&
        hasUnboundedCycle(route.toStepId)
      )
        return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  if (workflow.steps.some((step) => hasUnboundedCycle(step.id)))
    issues.push("A cycle needs a transition with a retry limit of one to three.");
  return [...new Set(issues)];
}

function WorkflowEditor({
  workflow,
  roles,
  busy,
  onChange,
}: {
  readonly workflow: OrganizationWorkflowDefinition;
  readonly roles: ReadonlyArray<OrganizationRole>;
  readonly busy: boolean;
  readonly onChange: (change: OrganizationChange) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(workflow);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const issues = draftIssues(draft, roles);
  const dirty = JSON.stringify(draft) !== JSON.stringify(workflow);
  const workSteps = draft.steps.filter((step) => step.kind === "work");
  const stepName = (stepId: OrganizationWorkflowStepId) =>
    draft.steps.find((step) => step.id === stepId)?.title ?? "Missing step";

  function updateStep(
    stepId: OrganizationWorkflowStepId,
    update: Partial<OrganizationWorkflowStep>,
  ) {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === stepId ? { ...step, ...update } : step)),
    }));
  }

  function updateTransition(
    transitionId: OrganizationWorkflowTransitionId,
    update: Partial<OrganizationWorkflowTransition>,
  ) {
    setDraft((current) => ({
      ...current,
      transitions: current.transitions.map((transition) =>
        transition.id === transitionId ? { ...transition, ...update } : transition,
      ),
    }));
  }

  async function save() {
    if (busy || !dirty || issues.length > 0) return;
    await onChange({
      type: "upsert-workflow",
      workflow: {
        ...draft,
        title: draft.title.trim(),
        version: workflow.version + 1,
        steps: draft.steps.map((step) => ({ ...step, title: step.title.trim() })),
      },
    });
  }

  return (
    <Card>
      <CardPanel className="space-y-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Edit workflow</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Definition version {workflow.version}. Changes save as version {workflow.version + 1}.
            </p>
          </div>
          <Badge variant="outline">Current draft</Badge>
        </div>
        <label className="block space-y-1.5 text-sm font-medium">
          <span>Workflow title</span>
          <Input
            value={draft.title}
            onValueChange={(title) => setDraft((current) => ({ ...current, title }))}
            maxLength={MAX_TITLE_LENGTH}
            disabled={busy}
          />
        </label>

        <section className="space-y-3" aria-labelledby="workflow-steps-heading">
          <div>
            <h4 id="workflow-steps-heading" className="font-semibold">
              Steps
            </h4>
            <p className="text-sm text-muted-foreground">
              QA must use a QA role and review work assigned to another role.
            </p>
          </div>
          <ol className="space-y-3">
            {draft.steps.map((step, index) => {
              const assignable = step.kind !== "trigger" && step.kind !== "finish";
              const availableRoles =
                step.kind === "qa"
                  ? roles.filter((role) => role.kind === "qa")
                  : step.kind === "work" || step.kind === "integrate"
                    ? workflowWorkRoles(roles)
                    : roles;
              const currentRole = roles.find((role) => role.id === step.roleId);
              return (
                <li key={step.id} className="space-y-3 rounded-xl border border-border p-4">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">
                      {index + 1}. {step.kind}
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm font-medium">
                      <span>Step title</span>
                      <Input
                        value={step.title}
                        maxLength={MAX_TITLE_LENGTH}
                        onValueChange={(title) => updateStep(step.id, { title })}
                        disabled={busy}
                      />
                    </label>
                    {assignable ? (
                      <label className="space-y-1 text-sm font-medium">
                        <span>Assigned role</span>
                        <select
                          className={SELECT_CLASS}
                          value={step.roleId ?? ""}
                          onChange={(event) =>
                            updateStep(step.id, {
                              roleId: event.currentTarget.value
                                ? roleIdFromChoice(event.currentTarget.value, roles)
                                : null,
                            })
                          }
                          disabled={busy}
                        >
                          <option value="">Choose a role</option>
                          {currentRole &&
                          !availableRoles.some((role) => role.id === currentRole.id) ? (
                            <option value={currentRole.id}>
                              {currentRole.title} ({currentRole.kind}, current assignment)
                            </option>
                          ) : null}
                          {availableRoles.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.title} ({role.kind})
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {step.kind === "qa" || step.kind === "approval" ? (
                      <label className="space-y-1 text-sm font-medium">
                        <span>Reviews work step</span>
                        <select
                          className={SELECT_CLASS}
                          value={step.reviewsStepId ?? ""}
                          onChange={(event) =>
                            updateStep(step.id, {
                              reviewsStepId:
                                workSteps.find(
                                  (candidate) => candidate.id === event.currentTarget.value,
                                )?.id ?? null,
                            })
                          }
                          disabled={busy}
                        >
                          <option value="">Choose work</option>
                          {workSteps.map((workStep) => (
                            <option key={workStep.id} value={workStep.id}>
                              {workStep.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="space-y-3" aria-labelledby="workflow-routes-heading">
          <div>
            <h4 id="workflow-routes-heading" className="font-semibold">
              Transitions
            </h4>
            <p className="text-sm text-muted-foreground">
              These routes control workflow order. Any route that creates a cycle needs a limit of
              one to three traversals.
            </p>
          </div>
          <ul className="space-y-3">
            {draft.transitions.map((transition) => (
              <li key={transition.id} className="rounded-xl border border-border p-4">
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem_auto] sm:items-end">
                  <label className="space-y-1 text-sm font-medium">
                    <span>From</span>
                    <select
                      className={SELECT_CLASS}
                      value={transition.fromStepId}
                      onChange={(event) =>
                        updateTransition(transition.id, {
                          fromStepId: OrganizationWorkflowStepId.make(event.currentTarget.value),
                        })
                      }
                      disabled={busy}
                    >
                      {draft.steps.map((step) => (
                        <option key={step.id} value={step.id}>
                          {step.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm font-medium">
                    <span>To</span>
                    <select
                      className={SELECT_CLASS}
                      value={transition.toStepId}
                      onChange={(event) =>
                        updateTransition(transition.id, {
                          toStepId: OrganizationWorkflowStepId.make(event.currentTarget.value),
                        })
                      }
                      disabled={busy}
                    >
                      {draft.steps.map((step) => (
                        <option key={step.id} value={step.id}>
                          {step.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm font-medium">
                    <span>Traversal limit</span>
                    <select
                      className={SELECT_CLASS}
                      value={transition.maxTraversals ?? ""}
                      onChange={(event) =>
                        updateTransition(transition.id, {
                          maxTraversals: event.currentTarget.value
                            ? Number(event.currentTarget.value)
                            : null,
                        })
                      }
                      disabled={busy}
                    >
                      <option value="">No limit</option>
                      {[1, 2, 3].map((limit) => (
                        <option key={limit} value={limit}>
                          {limit}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    variant="ghost-destructive"
                    aria-label={`Remove transition from ${stepName(transition.fromStepId)} to ${stepName(transition.toStepId)}`}
                    disabled={busy}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        transitions: current.transitions.filter(
                          (item) => item.id !== transition.id,
                        ),
                      }))
                    }
                  >
                    <Trash2Icon /> Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            disabled={busy || draft.transitions.length >= MAX_TRANSITIONS || draft.steps.length < 2}
            onClick={() => {
              const fromStepId = draft.steps[0]?.id;
              const toStepId = draft.steps[1]?.id;
              if (!fromStepId || !toStepId) return;
              setDraft((current) => ({
                ...current,
                transitions: [
                  ...current.transitions,
                  {
                    id: OrganizationWorkflowTransitionId.make(randomUUID()),
                    fromStepId,
                    toStepId,
                    maxTraversals: null,
                  },
                ],
              }));
            }}
          >
            <PlusIcon /> Add transition
          </Button>
        </section>

        {issues.length > 0 ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
          >
            <p className="font-medium">Resolve these draft issues before saving:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            Basic draft checks pass. Publishing in Governance checks every route, QA gate, and
            cycle.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !dirty || issues.length > 0} onClick={() => void save()}>
            Save new version
          </Button>
          <Button variant="outline" disabled={busy || !dirty} onClick={() => setDraft(workflow)}>
            Discard changes
          </Button>
          <Button
            variant={confirmRemove ? "destructive" : "destructive-outline"}
            disabled={busy}
            onClick={() => {
              if (!confirmRemove) {
                setConfirmRemove(true);
                return;
              }
              void onChange({ type: "remove-workflow", workflowId: workflow.id });
            }}
          >
            <Trash2Icon /> {confirmRemove ? "Confirm removal" : "Remove workflow"}
          </Button>
          {confirmRemove ? (
            <Button variant="outline" disabled={busy} onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </CardPanel>
    </Card>
  );
}

function roleIdFromChoice(value: string, roles: ReadonlyArray<OrganizationRole>) {
  return roles.find((role) => role.id === value)?.id ?? null;
}

export function OrganizationWorkflows({
  organization,
  busy,
  onChange,
}: {
  readonly organization: Organization;
  readonly busy: boolean;
  readonly onChange: (change: OrganizationChange) => Promise<boolean>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    organization.workflows[0]?.id ?? null,
  );
  const [title, setTitle] = useState("");
  const [workRoleId, setWorkRoleId] = useState<string>("");
  const [qaRoleId, setQaRoleId] = useState<string>("");
  const [retries, setRetries] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const workRoles = workflowWorkRoles(organization.graph.roles);
  const qaRoles = organization.graph.roles.filter((role) => role.kind === "qa");
  const workRole = workRoles.find((role) => role.id === workRoleId) ?? workRoles[0];
  const qaRole = qaRoles.find((role) => role.id === qaRoleId) ?? qaRoles[0];
  const selected = organization.workflows.find((workflow) => workflow.id === selectedId) ?? null;
  const canCreate =
    !busy &&
    organization.workflows.length < 24 &&
    title.trim().length > 0 &&
    title.trim().length <= MAX_TITLE_LENGTH &&
    !!workRole &&
    !!qaRole &&
    workRole.id !== qaRole.id;

  async function create() {
    if (!canCreate || !workRole || !qaRole) return;
    const workflow = template(title.trim(), workRole.id, qaRole.id, retries);
    if (await onChange({ type: "upsert-workflow", workflow })) {
      setSelectedId(workflow.id);
      setTitle("");
      setNotice("Workflow draft created. Review its steps and publish from Governance when ready.");
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        Workflow definitions are saved in the current draft. Publishing validates their routes and
        records a versioned configuration. Worker execution is not available in this workspace yet.
      </div>
      {organization.lifecycle === "archived" ? (
        <p role="status" className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          This Organization is archived. Its workflow definitions are read only.
        </p>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardPanel className="space-y-4 p-5">
              <h2 className="text-lg font-semibold">Saved workflows</h2>
              {organization.workflows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workflow definitions yet.</p>
              ) : (
                <ul className="space-y-2">
                  {organization.workflows.map((workflow) => (
                    <li key={workflow.id}>
                      <Button
                        className="min-h-11 w-full justify-between gap-3 whitespace-normal text-left"
                        variant={selected?.id === workflow.id ? "secondary" : "outline"}
                        aria-pressed={selected?.id === workflow.id}
                        onClick={() => setSelectedId(workflow.id)}
                      >
                        <span className="min-w-0 break-words">{workflow.title}</span>
                        <span className="shrink-0 text-sm text-muted-foreground">
                          v{workflow.version}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardPanel>
          </Card>
          <Card>
            <CardPanel className="space-y-4 p-5">
              <div>
                <h2 className="text-lg font-semibold">Create workflow</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Starts with trigger, work, QA, integrate, and finish. The QA role must differ from
                  the work role.
                </p>
              </div>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
              >
                <label className="block space-y-1 text-sm font-medium">
                  <span>Workflow title</span>
                  <Input
                    value={title}
                    maxLength={MAX_TITLE_LENGTH}
                    onValueChange={setTitle}
                    disabled={busy}
                  />
                </label>
                <label className="block space-y-1 text-sm font-medium">
                  <span>Work role</span>
                  <select
                    className={SELECT_CLASS}
                    value={workRole?.id ?? ""}
                    onChange={(event) => setWorkRoleId(event.currentTarget.value)}
                    disabled={busy || workRoles.length === 0}
                  >
                    {workRoles.length === 0 ? (
                      <option value="">Add a work role in Designer</option>
                    ) : null}
                    {workRoles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.title} ({role.kind})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1 text-sm font-medium">
                  <span>QA role</span>
                  <select
                    className={SELECT_CLASS}
                    value={qaRole?.id ?? ""}
                    onChange={(event) => setQaRoleId(event.currentTarget.value)}
                    disabled={busy || qaRoles.length === 0}
                  >
                    {qaRoles.length === 0 ? (
                      <option value="">Add a QA role in Designer</option>
                    ) : null}
                    {qaRoles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1 text-sm font-medium">
                  <span>QA retry limit</span>
                  <select
                    className={SELECT_CLASS}
                    value={retries}
                    onChange={(event) => setRetries(Number(event.currentTarget.value))}
                    disabled={busy}
                  >
                    <option value={0}>No retry route</option>
                    {[1, 2, 3].map((limit) => (
                      <option key={limit} value={limit}>
                        {limit} {limit === 1 ? "retry" : "retries"}
                      </option>
                    ))}
                  </select>
                </label>
                <Button type="submit" disabled={!canCreate}>
                  <PlusIcon /> Create draft
                </Button>
              </form>
              {qaRoles.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Add a QA role in Designer before creating a workflow.
                </p>
              ) : null}
              {workRoles.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Add an engineering, security, research, or custom role in Designer before creating
                  a workflow.
                </p>
              ) : null}
              {notice ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {notice}
                </p>
              ) : null}
            </CardPanel>
          </Card>
        </div>
        <div className="min-w-0">
          {selected ? (
            <WorkflowEditor
              key={`${selected.id}:${selected.version}`}
              workflow={selected}
              roles={organization.graph.roles}
              busy={busy}
              onChange={onChange}
            />
          ) : (
            <Card>
              <CardPanel className="p-5 text-sm text-muted-foreground">
                Select a saved workflow to inspect its steps and transitions.
              </CardPanel>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

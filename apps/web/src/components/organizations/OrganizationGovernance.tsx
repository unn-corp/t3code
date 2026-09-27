import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  Organization,
  OrganizationBindingAccess,
  OrganizationChange,
  OrganizationProjectBinding,
  OrganizationProviderBudgetCeiling,
  ProjectId,
} from "@t3tools/contracts";
import { Link2Icon, RefreshCwIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { OrganizationObservationModeControl } from "./OrganizationProposalControls";

const SELECT_CLASS =
  "min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const ACCESS_VALUES = [
  "read",
  "proposal",
  "write",
] as const satisfies ReadonlyArray<OrganizationBindingAccess>;

function BudgetCeiling({
  ceiling,
}: {
  readonly ceiling: OrganizationProviderBudgetCeiling | null;
}) {
  if (ceiling === null)
    return <p className="text-sm text-muted-foreground">Unconfigured. Default: zero capacity.</p>;
  return (
    <div className="space-y-1 text-sm">
      <p
        className={
          ceiling.maxConcurrent === 0 ? "font-medium text-amber-700 dark:text-amber-400" : ""
        }
      >
        {ceiling.maxConcurrent} concurrent {ceiling.maxConcurrent === 0 ? "(disabled)" : "maximum"}
      </p>
      <p>{ceiling.maxDailyCalls.toLocaleString()} calls per day maximum</p>
      <p>{ceiling.maxDailyEstimatedTokens.toLocaleString()} estimated tokens per day maximum</p>
      {ceiling.maxDailyCalls === 0 || ceiling.maxDailyEstimatedTokens === 0 ? (
        <p className="font-medium text-amber-700 dark:text-amber-400">
          Zero daily ceiling disables capacity.
        </p>
      ) : null}
    </div>
  );
}

export function OrganizationGovernance({
  organization,
  projects,
  busy,
  offline,
  onChange,
  onBind,
  onDetach,
  onPublish,
  onLifecycle,
}: {
  readonly organization: Organization;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly busy: boolean;
  readonly offline: boolean;
  readonly onChange: (change: OrganizationChange) => Promise<boolean>;
  readonly onBind: (projectId: ProjectId, access: OrganizationBindingAccess) => Promise<boolean>;
  readonly onDetach: (binding: OrganizationProjectBinding) => Promise<boolean>;
  readonly onPublish: () => Promise<boolean>;
  readonly onLifecycle: (lifecycle: Organization["lifecycle"]) => Promise<boolean>;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const audit = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listAudit({
          environmentId,
          input: { organizationId: organization.id },
        }),
  );
  const [budgetPage, setBudgetPage] = useState<{
    organizationId: string;
    cursors: ReadonlyArray<ProjectId | null>;
  }>({ organizationId: organization.id, cursors: [null] });
  const budgetCursors = budgetPage.organizationId === organization.id ? budgetPage.cursors : [null];
  const afterProjectId = budgetCursors.at(-1) ?? null;
  const budgets = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.readProviderBudgets({
          environmentId,
          input: { organizationId: organization.id, afterProjectId },
        }),
  );
  const nextBudgetCursor = budgets.data?.nextProjectCursor ?? null;
  const [title, setTitle] = useState(organization.title);
  const [mission, setMission] = useState(organization.mission);
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? "");
  const [access, setAccess] = useState<OrganizationBindingAccess>("read");
  const activeBindings = organization.bindings.filter((binding) => binding.detachedAt === null);
  const availableProjects = projects.filter(
    (project) => !activeBindings.some((binding) => binding.projectId === project.id),
  );
  const selectedProject =
    availableProjects.find((project) => project.id === projectId) ?? availableProjects[0];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardPanel className="space-y-4 p-5">
          <h2 className="text-lg font-semibold">Charter</h2>
          <p className="text-sm text-muted-foreground">
            Changes are saved to the draft revision. Publish when the structure is ready.
          </p>
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Name</span>
              <Input
                aria-label="Organization name"
                value={title}
                onValueChange={setTitle}
                disabled={busy}
              />
            </label>
            <Button
              variant="outline"
              disabled={busy || !title.trim() || title.trim() === organization.title}
              onClick={() => void onChange({ type: "set-title", title: title.trim() })}
            >
              Save name
            </Button>
          </div>
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Mission</span>
              <Textarea
                aria-label="Organization mission"
                value={mission}
                onChange={(event) => setMission(event.currentTarget.value)}
                disabled={busy}
              />
            </label>
            <Button
              variant="outline"
              disabled={busy || mission === organization.mission}
              onClick={() => void onChange({ type: "set-mission", mission })}
            >
              Save mission
            </Button>
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardPanel className="space-y-4 p-5">
          <h2 className="text-lg font-semibold">Publication and lifecycle</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt>Current lifecycle</dt>
              <dd>
                <Badge variant="outline">{organization.lifecycle}</Badge>
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Draft revision</dt>
              <dd>{organization.draftRevision}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Published revision</dt>
              <dd>{organization.publishedRevision ?? "None"}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || organization.publishedRevision === organization.draftRevision}
              onClick={() => void onPublish()}
            >
              Publish draft
            </Button>
            {organization.lifecycle === "active" ? (
              <Button variant="outline" disabled={busy} onClick={() => void onLifecycle("paused")}>
                Pause
              </Button>
            ) : null}
            {organization.lifecycle !== "archived" ? (
              <Button
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void onLifecycle("archived")}
              >
                Archive
              </Button>
            ) : null}
          </div>
          <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            Execution setup is pending. Publishing records a validated configuration; this screen
            does not start autonomous workers. Archiving and Project detachment require bound work
            to finish or be canceled and any worker scope to be verified stopped.
          </p>
        </CardPanel>
      </Card>

      <Card>
        <CardPanel className="space-y-4 p-5">
          <h2 className="text-lg font-semibold">Project access</h2>
          <p className="text-sm text-muted-foreground">
            An Organization may have no linked Projects or several. Each binding has its own access
            ceiling.
          </p>
          <ul className="space-y-2">
            {activeBindings.length === 0 ? (
              <li className="text-sm text-muted-foreground">No Projects linked.</li>
            ) : null}
            {activeBindings.map((binding) => (
              <li
                key={binding.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {projects.find((project) => project.id === binding.projectId)?.title ??
                      binding.projectId}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{binding.access} access</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  disabled={busy}
                  onClick={() => void onDetach(binding)}
                >
                  <UnlinkIcon /> Detach
                </Button>
              </li>
            ))}
          </ul>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (selectedProject) void onBind(selectedProject.id, access);
            }}
          >
            <label className="block space-y-1 text-sm font-medium">
              <span>Project</span>
              <select
                className={SELECT_CLASS}
                aria-label="Project to link"
                value={selectedProject?.id ?? ""}
                onChange={(event) => setProjectId(event.currentTarget.value)}
                disabled={busy || availableProjects.length === 0}
              >
                {availableProjects.length === 0 ? (
                  <option value="">No available Projects</option>
                ) : (
                  availableProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label className="block space-y-1 text-sm font-medium">
              <span>Access ceiling</span>
              <select
                className={SELECT_CLASS}
                aria-label="Project access ceiling"
                value={access}
                onChange={(event) => {
                  const value = ACCESS_VALUES.find((item) => item === event.currentTarget.value);
                  if (value) setAccess(value);
                }}
                disabled={busy}
              >
                {ACCESS_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={busy || !selectedProject}>
              <Link2Icon /> Link Project
            </Button>
          </form>
        </CardPanel>
      </Card>

      <OrganizationObservationModeControl organization={organization} offline={offline} />

      <Card className="lg:col-span-2">
        <CardPanel>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Provider capacity ceilings</h2>
              <Button
                size="sm"
                variant="ghost"
                disabled={offline || environmentId === null}
                onClick={budgets.refresh}
              >
                <RefreshCwIcon /> Refresh
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Configured ceilings for this Organization and its linked Projects. These are capacity
              settings, not measured usage or provider spend. Zero means disabled capacity.
            </p>
            {budgets.error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                Could not load provider ceilings: {budgets.error}
              </p>
            ) : null}
            {budgets.isPending && !budgets.data ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading provider ceilings…
              </p>
            ) : null}
            {budgets.data ? (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-border p-3">
                  <h3 className="mb-2 font-medium">Global ceiling</h3>
                  <BudgetCeiling ceiling={budgets.data.global} />
                </div>
                <div className="rounded-lg border border-border p-3">
                  <h3 className="mb-2 font-medium">Organization ceiling</h3>
                  <BudgetCeiling ceiling={budgets.data.organization} />
                </div>
                <div className="space-y-3 md:col-span-2">
                  <h3 className="font-medium">Linked Project ceilings</h3>
                  {budgets.data.projects.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {afterProjectId === null
                        ? "No Projects linked."
                        : "No currently linked Projects remain on this page."}
                    </p>
                  ) : (
                    <ul className="grid gap-3 md:grid-cols-2">
                      {budgets.data.projects.map(({ projectId: linkedId, ceiling }) => (
                        <li key={linkedId} className="rounded-lg border border-border p-3">
                          <h4 className="mb-2 truncate font-medium">
                            {projects.find((project) => project.id === linkedId)?.title ?? linkedId}
                          </h4>
                          <BudgetCeiling ceiling={ceiling} />
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      Project page {budgetCursors.length}, up to 100 per page in ID order.
                    </span>
                    {budgetCursors.length > 1 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setBudgetPage({
                            organizationId: organization.id,
                            cursors: budgetCursors.slice(0, -1),
                          })
                        }
                      >
                        Previous Projects
                      </Button>
                    ) : null}
                    {budgets.data.hasMoreProjects && nextBudgetCursor !== null ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setBudgetPage({
                            organizationId: organization.id,
                            cursors: [...budgetCursors, nextBudgetCursor],
                          })
                        }
                      >
                        Next Projects
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardPanel className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Change history</h2>
            <Button
              size="sm"
              variant="ghost"
              disabled={offline || environmentId === null}
              onClick={audit.refresh}
            >
              <RefreshCwIcon /> Refresh
            </Button>
          </div>
          {audit.error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              Could not load history: {audit.error}
            </p>
          ) : null}
          {audit.isPending && !audit.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading history…
            </p>
          ) : null}
          <ol className="max-h-80 space-y-2 overflow-y-auto text-sm">
            {(audit.data?.entries ?? []).map((entry) => (
              <li key={entry.mutationId} className="rounded-lg border border-border p-3">
                <span className="font-medium">{entry.action}</span>
                <span className="text-muted-foreground">
                  {" "}
                  by {entry.actor}, revision {entry.appliedRevision}
                </span>
                <time className="block text-muted-foreground" dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
            {audit.isSuccess && audit.data?.entries.length === 0 ? (
              <li className="text-muted-foreground">No recorded changes.</li>
            ) : null}
          </ol>
        </CardPanel>
      </Card>
    </div>
  );
}

import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  OrganizationId,
  OrganizationBindingId,
  type Organization,
  type OrganizationArchitectProposal,
  type OrganizationBindingAccess,
  type OrganizationChange,
  type OrganizationProjectBinding,
  type ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment, useOrganizations } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { OrganizationDesigner } from "./OrganizationDesigner";
import { OrganizationArchitectConversation } from "./OrganizationArchitectConversation";
import { OrganizationDirectorConversation } from "./OrganizationDirectorConversation";
import { OrganizationGovernance } from "./OrganizationGovernance";
import { OrganizationLiveOperations } from "./OrganizationLiveOperations";
import { OrganizationMemoryAndDecisions } from "./OrganizationMemoryAndDecisions";
import { OrganizationRepository } from "./OrganizationRepository";
import { OrganizationPageShell } from "./OrganizationPageShell";
import { OrganizationSources } from "./OrganizationSources";
import { OrganizationWorkAndFindings } from "./OrganizationWorkAndFindings";
import { OrganizationWorkflows } from "./OrganizationWorkflows";

type WorkspaceTab =
  | "overview"
  | "designer"
  | "director"
  | "workflows"
  | "sources"
  | "work"
  | "operations"
  | "memory"
  | "repository"
  | "governance";

export function OrganizationWorkspace({ organizationId }: { readonly organizationId: string }) {
  const environmentId = usePrimaryEnvironmentId();
  const { networkStatus } = useEnvironments();
  const isOffline = networkStatus === "offline";
  const wasOffline = useRef(isOffline);
  const list = useOrganizations();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const id = OrganizationId.make(organizationId);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.get({ environmentId, input: { organizationId: id } }),
  );
  const mutate = useAtomCommand(organizationEnvironment.mutate);
  const applyArchitectBatch = useAtomCommand(organizationEnvironment.architectApplyBatch);
  const bindProject = useAtomCommand(organizationEnvironment.bindProject);
  const detachProject = useAtomCommand(organizationEnvironment.detachProject);
  const publish = useAtomCommand(organizationEnvironment.publish);
  const setLifecycle = useAtomCommand(organizationEnvironment.setLifecycle);
  const [localSnapshot, setLocalSnapshot] = useState<Organization | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const organization =
    localSnapshot?.id === id &&
    (query.data === null ||
      localSnapshot.draftRevision > query.data.draftRevision ||
      (localSnapshot.draftRevision === query.data.draftRevision &&
        localSnapshot.updatedAt > query.data.updatedAt))
      ? localSnapshot
      : query.data;
  const isArchived = organization?.lifecycle === "archived";

  useEffect(() => {
    if (wasOffline.current && !isOffline) {
      query.refresh();
      list.refresh();
    }
    wasOffline.current = isOffline;
  }, [isOffline, query.refresh, list.refresh]);

  function refresh() {
    if (isOffline || environmentId === null) return;
    query.refresh();
    list.refresh();
  }

  async function acceptResult<E>(result: AtomCommandResult<Organization, E>) {
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : String(error));
      query.refresh();
      return false;
    }
    setLocalSnapshot(result.value);
    setActionError(null);
    query.refresh();
    list.refresh();
    return true;
  }

  async function applyChange(
    change: OrganizationChange,
    options?: { readonly mutationId: string; readonly expectedRevision: number },
  ) {
    if (!organization || environmentId === null || busy || isOffline || isArchived) return false;
    if (options && options.expectedRevision !== organization.draftRevision) {
      setActionError("The suggested change belongs to an earlier draft revision.");
      query.refresh();
      return false;
    }
    setBusy(true);
    try {
      return await acceptResult(
        await mutate({
          environmentId,
          input: {
            organizationId: organization.id,
            mutationId: options?.mutationId ?? randomUUID(),
            baseRevision: organization.draftRevision,
            actor: "user",
            change,
          },
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyProposalBatch(proposals: ReadonlyArray<OrganizationArchitectProposal>) {
    if (
      !organization ||
      environmentId === null ||
      busy ||
      isOffline ||
      isArchived ||
      proposals.length === 0
    ) {
      return false;
    }
    const baseRevision = proposals[0]!.baseRevision;
    if (
      baseRevision !== organization.draftRevision ||
      proposals.some((proposal) => proposal.baseRevision !== baseRevision)
    ) {
      setActionError("The suggestions belong to an earlier draft revision.");
      query.refresh();
      return false;
    }
    setBusy(true);
    try {
      return await acceptResult(
        await applyArchitectBatch({
          environmentId,
          input: {
            organizationId: organization.id,
            mutationId: randomUUID(),
            baseRevision,
            proposalIds: proposals.map((proposal) => proposal.id),
          },
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function bind(projectId: ProjectId, access: OrganizationBindingAccess) {
    if (!organization || environmentId === null || busy || isOffline || isArchived) return false;
    setBusy(true);
    try {
      return await acceptResult(
        await bindProject({
          environmentId,
          input: {
            organizationId: organization.id,
            mutationId: randomUUID(),
            baseRevision: organization.draftRevision,
            actor: "user",
            bindingId: OrganizationBindingId.make(randomUUID()),
            projectId,
            access,
            capabilities:
              access === "write"
                ? ["read-files", "read-history", "propose-work", "write-files", "run-tests"]
                : access === "proposal"
                  ? ["read-files", "read-history", "propose-work"]
                  : ["read-files", "read-history"],
            scope: null,
          },
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function detach(binding: OrganizationProjectBinding) {
    if (!organization || environmentId === null || busy || isOffline || isArchived) return false;
    setBusy(true);
    try {
      return await acceptResult(
        await detachProject({
          environmentId,
          input: {
            organizationId: organization.id,
            mutationId: randomUUID(),
            baseRevision: organization.draftRevision,
            actor: "user",
            bindingId: binding.id,
          },
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function publishDraft() {
    if (!organization || environmentId === null || busy || isOffline || isArchived) return false;
    setBusy(true);
    try {
      return await acceptResult(
        await publish({
          environmentId,
          input: {
            organizationId: organization.id,
            mutationId: randomUUID(),
            baseRevision: organization.draftRevision,
            actor: "user",
          },
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function changeLifecycle(lifecycle: Organization["lifecycle"]) {
    if (!organization || environmentId === null || busy || isOffline || isArchived) return false;
    setBusy(true);
    try {
      return await acceptResult(
        await setLifecycle({
          environmentId,
          input: {
            organizationId: organization.id,
            mutationId: randomUUID(),
            baseRevision: organization.draftRevision,
            actor: "user",
            lifecycle,
          },
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <OrganizationPageShell>
      <header className="space-y-4 border-b border-border/70 pb-5">
        <Button size="sm" variant="ghost" render={<Link to="/organizations" />}>
          <ArrowLeftIcon /> Organizations
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {organization?.title ?? "Organization"}
              </h1>
              {organization ? (
                <Badge variant={organization.lifecycle === "active" ? "success" : "outline"}>
                  {organization.lifecycle}
                </Badge>
              ) : null}
            </div>
            {organization ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Draft revision {organization.draftRevision}
                {organization.publishedRevision === null
                  ? ", not published"
                  : `, published revision ${organization.publishedRevision}`}
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={environmentId === null || isOffline}
          >
            <RefreshCwIcon /> Refresh
          </Button>
        </div>
      </header>

      {environmentId === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connect an environment to open this Organization.
        </p>
      ) : null}
      {isOffline ? (
        <p role="status" className="rounded-xl border border-border bg-muted/50 p-4 text-sm">
          Offline. This Organization may be out of date. Editing will be available after the
          connection returns.
        </p>
      ) : null}
      {isArchived ? (
        <p role="status" className="rounded-xl border border-border bg-muted/50 p-4 text-sm">
          This Organization is archived. Its draft, Project bindings, and lifecycle are read only.
        </p>
      ) : null}
      {query.isPending && organization === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading Organization…
        </p>
      ) : null}
      {query.error ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive-foreground"
        >
          Could not load Organization: {query.error}
        </p>
      ) : null}
      {actionError ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive-foreground"
        >
          Last change was not saved: {actionError} Review the latest revision before editing.
        </p>
      ) : null}

      {organization ? (
        <>
          <nav
            aria-label="Organization views"
            className="flex flex-wrap gap-2 border-b border-border/70 pb-3"
          >
            {(
              [
                "overview",
                "designer",
                "director",
                "workflows",
                "sources",
                "work",
                "operations",
                "memory",
                "repository",
                "governance",
              ] as const
            ).map((view) => (
              <Button
                key={view}
                size="sm"
                variant={tab === view ? "secondary" : "ghost"}
                aria-current={tab === view ? "page" : undefined}
                onClick={() => setTab(view)}
              >
                {view === "work"
                  ? "Work & Findings"
                  : view === "operations"
                    ? "Live Operations"
                    : view === "memory"
                      ? "Memory & Decisions"
                      : view === "director"
                        ? "Director"
                        : view[0]!.toUpperCase() + view.slice(1)}
              </Button>
            ))}
          </nav>

          {tab === "overview" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardPanel className="p-6">
                  <h2 className="text-lg font-semibold">Mission</h2>
                  <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {organization.mission || "No mission set yet."}
                  </p>
                </CardPanel>
              </Card>
              <Card>
                <CardPanel className="p-6">
                  <h2 className="text-lg font-semibold">Current structure</h2>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt>Roles</dt>
                      <dd>{organization.graph.roles.length}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Relationships</dt>
                      <dd>{organization.graph.edges.length}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Linked Projects</dt>
                      <dd>
                        {
                          organization.bindings.filter((binding) => binding.detachedAt === null)
                            .length
                        }
                      </dd>
                    </div>
                  </dl>
                </CardPanel>
              </Card>
              <Card className="md:col-span-2">
                <CardPanel className="p-6">
                  <h2 className="text-lg font-semibold">Operating status</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Live Operations shows evidence, waiting intents, Project work, approvals, and
                    runtime readiness. Link a Project and publish a reviewed workflow to begin.
                  </p>
                </CardPanel>
              </Card>
            </div>
          ) : null}
          {tab === "designer" ? (
            <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
              <div className="min-w-0 xl:order-2">
                <OrganizationArchitectConversation
                  organization={organization}
                  offline={isOffline}
                  busy={busy}
                  onApplyBatch={applyProposalBatch}
                />
              </div>
              <div className="min-w-0 xl:order-1">
                <OrganizationDesigner
                  organization={organization}
                  busy={busy || isOffline || isArchived}
                  onChange={applyChange}
                />
              </div>
            </div>
          ) : null}
          {tab === "director" ? (
            <OrganizationDirectorConversation
              organization={organization}
              offline={isOffline}
              onNavigate={setTab}
            />
          ) : null}
          {tab === "sources" ? (
            <OrganizationSources organization={organization} offline={isOffline} />
          ) : null}
          {tab === "workflows" ? (
            <OrganizationWorkflows
              organization={organization}
              busy={busy || isOffline || organization.lifecycle === "archived"}
              onChange={applyChange}
            />
          ) : null}
          {tab === "work" ? (
            <OrganizationWorkAndFindings organization={organization} offline={isOffline} />
          ) : null}
          {tab === "operations" ? (
            <OrganizationLiveOperations
              organization={organization}
              offline={isOffline}
              onNavigate={setTab}
            />
          ) : null}
          {tab === "memory" ? (
            <OrganizationMemoryAndDecisions organization={organization} offline={isOffline} />
          ) : null}
          {tab === "repository" ? (
            <OrganizationRepository organization={organization} offline={isOffline} />
          ) : null}
          {tab === "governance" ? (
            <OrganizationGovernance
              key={`${organization.id}:${organization.draftRevision}`}
              organization={organization}
              projects={projects}
              busy={busy || isOffline || isArchived}
              offline={isOffline}
              onChange={applyChange}
              onBind={bind}
              onDetach={detach}
              onPublish={publishDraft}
              onLifecycle={changeLifecycle}
              onRefresh={refresh}
            />
          ) : null}
        </>
      ) : null}
    </OrganizationPageShell>
  );
}

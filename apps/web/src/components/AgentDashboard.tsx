import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  FolderGit2Icon,
  GitBranchIcon,
  LoaderIcon,
  MessageCircleWarningIcon,
  RefreshCwIcon,
  ServerIcon,
  SquareTerminalIcon,
  TelescopeIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  buildDashboardWorktreeGroups,
  buildResearchRepositoryGroups,
  configuredResearchDashboardUrl,
  normalizeAgentDashboardSnapshot,
  resolveDashboardRepositoryName,
  resolveDashboardRepositoryStatus,
  resolveDashboardThreadState,
  resolveDashboardThreadStateLabel,
  selectDashboardThreadsForRepository,
  type DashboardRepositoryState,
  type DashboardServerRepository,
  type DashboardThreadRecord,
  type DashboardThreadState,
  type DashboardWorktreeGroup,
} from "../researchDashboard";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { agentDashboardEnvironment } from "../state/agentDashboard";
import { vcsEnvironment } from "../state/vcs";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { SidebarInset } from "./ui/sidebar";

function repositoryStatusVariant(state: DashboardRepositoryState) {
  switch (state) {
    case "behind-main":
      return "warning" as const;
    case "ahead-of-main":
      return "info" as const;
    case "changes":
      return "outline" as const;
    case "clean":
      return "success" as const;
    case "not-repository":
    case "unavailable":
      return "outline" as const;
  }
}

function threadStatusVariant(state: DashboardThreadState) {
  switch (state) {
    case "running":
      return "info" as const;
    case "needs-input":
      return "warning" as const;
    case "error":
      return "error" as const;
    case "ready":
      return "success" as const;
    case "paused":
    case "idle":
      return "outline" as const;
  }
}

function RepositoryStatusBadge({
  state,
  label,
}: {
  readonly state: DashboardRepositoryState;
  readonly label: string;
}) {
  return (
    <Badge variant={repositoryStatusVariant(state)} size="sm">
      {state === "behind-main" ? <TriangleAlertIcon /> : null}
      {label}
    </Badge>
  );
}

function ThreadStatusBadge({ state }: { readonly state: DashboardThreadState }) {
  return (
    <Badge variant={threadStatusVariant(state)} size="sm">
      {state === "running" ? <LoaderIcon className="animate-spin" /> : null}
      {resolveDashboardThreadStateLabel(state)}
    </Badge>
  );
}

function DashboardThreadRow({
  thread,
  onOpenThread,
}: {
  readonly thread: DashboardThreadRecord;
  readonly onOpenThread: (thread: DashboardThreadRecord) => void;
}) {
  const state = resolveDashboardThreadState(thread);
  const providerLabel = thread.session?.providerName ?? thread.modelSelection.instanceId;
  const updatedLabel = formatRelativeTimeLabel(thread.updatedAt);

  return (
    <div className="flex min-w-0 items-center gap-3 border-t border-border/60 px-3 py-2.5 first:border-t-0">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <SquareTerminalIcon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium">{thread.title}</p>
          <ThreadStatusBadge state={state} />
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="truncate font-mono">{thread.branch ?? "No branch"}</span>
          <span aria-hidden="true" className="text-muted-foreground/45">
            ·
          </span>
          <span className="truncate">{providerLabel}</span>
          {updatedLabel ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground/45">
                ·
              </span>
              <span>{updatedLabel}</span>
            </>
          ) : null}
        </div>
      </div>
      <Button
        aria-label={`Open thread ${thread.title}`}
        onClick={() => onOpenThread(thread)}
        size="xs"
        variant="outline"
      >
        <ArrowUpRightIcon />
        <span className="hidden sm:inline">Open</span>
      </Button>
    </div>
  );
}

function DashboardWorktree({
  worktree,
  onOpenThread,
}: {
  readonly worktree: DashboardWorktreeGroup;
  readonly onOpenThread: (thread: DashboardThreadRecord) => void;
}) {
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: worktree.environmentId as EnvironmentId,
      input: { cwd: worktree.path },
    }),
  );
  const status = resolveDashboardRepositoryStatus(statusQuery.data, statusQuery.error);
  const branch = statusQuery.data?.refName ?? worktree.branch ?? "Detached HEAD";

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <GitBranchIcon className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-mono text-sm font-medium">{branch}</p>
            <RepositoryStatusBadge state={status.state} label={status.label} />
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{worktree.path}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {worktree.threads.length} {worktree.threads.length === 1 ? "agent" : "agents"}
        </span>
      </div>
      <div className="bg-muted/25">
        {worktree.threads.map((thread) => (
          <DashboardThreadRow key={thread.id} thread={thread} onOpenThread={onOpenThread} />
        ))}
      </div>
    </div>
  );
}

function RepositoryCard({
  group,
  threads,
  environmentLabelById,
  serverRepository,
  serverSnapshotPending,
  refreshServerSnapshot,
  onOpenThread,
}: {
  readonly group: ReturnType<typeof buildResearchRepositoryGroups>[number];
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly serverRepository: DashboardServerRepository | null;
  readonly serverSnapshotPending: boolean;
  readonly refreshServerSnapshot: () => void;
  readonly onOpenThread: (thread: DashboardThreadRecord) => void;
}) {
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: group.representative.environmentId,
      input: { cwd: group.representative.workspaceRoot },
    }),
  );
  const status = serverRepository?.vcs ?? statusQuery.data;
  const statusError = serverRepository === null ? statusQuery.error : null;
  const statusPending = serverRepository === null ? statusQuery.isPending : serverSnapshotPending;
  const repositoryStatus = resolveDashboardRepositoryStatus(status, statusError);
  const repositoryThreads = useMemo(
    () => selectDashboardThreadsForRepository(threads, group.memberProjectRefs),
    [group.memberProjectRefs, threads],
  );
  const mainThreads = repositoryThreads.filter((thread) => thread.worktreePath === null);
  const worktrees = useMemo(
    () =>
      buildDashboardWorktreeGroups({
        threads: repositoryThreads,
        projectRefs: group.memberProjectRefs,
      }),
    [group.memberProjectRefs, repositoryThreads],
  );
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const primaryEnvironmentLabel =
    environmentLabelById.get(group.representative.environmentId) ?? "Environment";
  const branchLabel =
    status === null && statusPending ? "Loading" : (status?.refName ?? "Detached HEAD");
  const workingTreeLabel =
    status === null
      ? statusPending
        ? "Loading"
        : "Unavailable"
      : status.hasWorkingTreeChanges
        ? "Changes"
        : "Clean";

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-4 border-b border-border/60 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted text-muted-foreground">
            <FolderGit2Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate text-base">
              {resolveDashboardRepositoryName(group.representative)}
            </CardTitle>
            <CardDescription className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="truncate font-mono">{group.representative.workspaceRoot}</span>
              <span aria-hidden="true" className="text-muted-foreground/45">
                ·
              </span>
              <span>{primaryEnvironmentLabel}</span>
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <RepositoryStatusBadge state={repositoryStatus.state} label={repositoryStatus.label} />
        </CardAction>
      </CardHeader>

      <CardPanel className="space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <RepositoryFact label="Branch" value={branchLabel} icon={<GitBranchIcon />} />
          <RepositoryFact label="Working tree" value={workingTreeLabel} icon={<FolderGit2Icon />} />
          <RepositoryFact
            label="Threads"
            value={String(repositoryThreads.length)}
            icon={<SquareTerminalIcon />}
          />
          <RepositoryFact
            label="Checkouts"
            value={String(group.members.length)}
            icon={<ServerIcon />}
          />
        </div>

        {statusError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs text-destructive-foreground">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{statusError}</span>
          </div>
        ) : null}

        <section className="overflow-hidden rounded-xl border border-border/70 bg-background">
          <div className="flex items-start gap-3 px-3 py-3">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <GitBranchIcon className="size-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {status?.isDefaultRef ? "Main checkout" : "Primary checkout"}
              </p>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {group.representative.workspaceRoot}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{repositoryStatus.detail}</p>
            </div>
            <Button
              aria-label={`Refresh status for ${resolveDashboardRepositoryName(group.representative)}`}
              disabled={statusPending}
              onClick={serverRepository === null ? statusQuery.refresh : refreshServerSnapshot}
              size="icon-xs"
              variant="ghost"
            >
              <RefreshCwIcon className={cn(statusPending && "animate-spin")} />
            </Button>
          </div>
          {mainThreads.length > 0 ? (
            <div className="border-t border-border/60">
              {mainThreads.map((thread) => (
                <DashboardThreadRow key={thread.id} thread={thread} onOpenThread={onOpenThread} />
              ))}
            </div>
          ) : (
            <p className="border-t border-border/60 px-3 py-3 text-xs text-muted-foreground">
              No active threads are attached to the primary checkout.
            </p>
          )}
        </section>

        {worktrees.length > 0 ? (
          <Collapsible open={worktreesOpen} onOpenChange={setWorktreesOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted/45">
              <span>
                Worktrees <span className="text-muted-foreground">({worktrees.length})</span>
              </span>
              <ChevronDownIcon
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  worktreesOpen && "rotate-180",
                )}
              />
            </CollapsibleTrigger>
            <CollapsiblePanel className="mt-2 overflow-hidden rounded-xl border border-border/70 bg-background">
              {worktrees.map((worktree) => (
                <DashboardWorktree
                  key={worktree.key}
                  worktree={worktree}
                  onOpenThread={onOpenThread}
                />
              ))}
            </CollapsiblePanel>
          </Collapsible>
        ) : null}

        {group.members.length > 1 ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>Grouped checkouts:</span>
            {group.members.map(({ project }) => (
              <span key={`${project.environmentId}:${project.id}`} className="font-mono">
                {project.workspaceRoot}
              </span>
            ))}
          </div>
        ) : null}
      </CardPanel>
    </Card>
  );
}

function RepositoryFact({
  label,
  value,
  icon,
}: {
  readonly label: string;
  readonly value: string;
  readonly icon: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="[&_svg]:size-3">{icon}</span>
        <span>{label}</span>
      </div>
      <p className="mt-1 truncate text-sm font-medium">{value}</p>
    </div>
  );
}

function DashboardLoadingState() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {["one", "two"].map((key) => (
        <div key={key} className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {["a", "b", "c", "d"].map((fact) => (
              <Skeleton key={fact} className="h-14 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-28 rounded-xl" />
        </div>
      ))}
    </div>
  );
}

function DashboardEmptyState() {
  return (
    <Empty className="min-h-[min(28rem,60vh)] rounded-2xl border border-dashed border-border/80 bg-card">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderGit2Icon />
        </EmptyMedia>
        <EmptyTitle>No repositories yet</EmptyTitle>
        <EmptyDescription>
          Add a project to T3 Code and it will appear here with its branch, worktrees, and agent
          threads.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          render={<a href={configuredResearchDashboardUrl()} target="_blank" rel="noreferrer" />}
          variant="outline"
        >
          <ExternalLinkIcon />
          Open standalone dashboard
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function AgentDashboard() {
  const projects = useProjects();
  const threads = useThreadShells();
  const allEnvironmentShellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const router = useRouter();
  const dashboardUrl = configuredResearchDashboardUrl();
  const serverSnapshotQuery = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : agentDashboardEnvironment.snapshot({
          environmentId: primaryEnvironmentId,
          input: {},
        }),
  );
  const serverRepositories = useMemo(
    () =>
      serverSnapshotQuery.data === null || primaryEnvironmentId === null
        ? []
        : normalizeAgentDashboardSnapshot(serverSnapshotQuery.data, primaryEnvironmentId),
    [primaryEnvironmentId, serverSnapshotQuery.data],
  );
  const serverRepositoryByProjectKey = useMemo(
    () =>
      new Map(
        serverRepositories.map((repository) => [
          `${repository.environmentId}:${repository.projectId}`,
          repository,
        ]),
      ),
    [serverRepositories],
  );
  const portfolioHealth = serverSnapshotQuery.data?.portfolioHealth;
  const needsInputCount =
    serverSnapshotQuery.data?.feed.filter((item) => item.status === "needs-input").length ?? 0;
  const failedRunCount =
    serverSnapshotQuery.data?.automationRuns.filter((run) => run.status === "failed").length ?? 0;
  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const repositoryGroups = useMemo(
    () => buildResearchRepositoryGroups(projects, primaryEnvironmentId),
    [primaryEnvironmentId, projects],
  );
  const activeThreadCount = threads.filter((thread) => thread.archivedAt === null).length;
  const openThread = useCallback(
    (thread: DashboardThreadRecord) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          ...scopeThreadRef(thread.environmentId as EnvironmentId, thread.id as ThreadId),
        },
      });
    },
    [router],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/70 bg-background px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card text-muted-foreground">
              <FolderGit2Icon className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight">Agent Dashboard</p>
              <p className="truncate text-xs text-muted-foreground/75">
                Repositories and agent work across this T3 environment
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge className="hidden sm:inline-flex" size="sm" variant="outline">
              {repositoryGroups.length}{" "}
              {repositoryGroups.length === 1 ? "repository" : "repositories"}
            </Badge>
            <Button render={<Link to="/agent-dashboard/findings" />} size="sm" variant="outline">
              <FileSearchIcon />
              <span className="hidden sm:inline">Findings</span>
            </Button>
            {serverSnapshotQuery.data !== null ? (
              <Badge className="hidden md:inline-flex" size="sm" variant="outline">
                T3 server snapshot
              </Badge>
            ) : null}
            <Button
              render={
                <a
                  href={dashboardUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open standalone dashboard"
                />
              }
              size="sm"
              variant="outline"
            >
              <ExternalLinkIcon />
              <span className="hidden sm:inline">Standalone</span>
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="font-heading text-xl font-semibold tracking-tight">
                  Repository overview
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Live branch, worktree, and agent associations from T3 Code.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {activeThreadCount} active {activeThreadCount === 1 ? "thread" : "threads"}
              </p>
            </div>

            {portfolioHealth ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Card
                  className="transition-colors hover:border-success/50"
                  render={<Link to="/agent-dashboard/runs" />}
                >
                  <CardPanel className="p-4">
                    <p className="text-xs text-muted-foreground">Healthy repositories</p>
                    <p className="mt-1 text-lg font-semibold text-success">
                      {portfolioHealth.healthyRepositoryCount}/{portfolioHealth.repositoryCount}
                    </p>
                  </CardPanel>
                </Card>
                <Card
                  className="transition-colors hover:border-warning/60"
                  render={<Link to="/agent-dashboard/findings" />}
                >
                  <CardPanel className="p-4">
                    <p className="text-xs text-muted-foreground">Needs attention</p>
                    <p className="mt-1 text-lg font-semibold text-warning">
                      {portfolioHealth.attentionRepositoryCount}
                    </p>
                  </CardPanel>
                </Card>
                <Card
                  className="transition-colors hover:border-muted-foreground/50"
                  render={<Link to="/agent-dashboard/runs" />}
                >
                  <CardPanel className="p-4">
                    <p className="text-xs text-muted-foreground">Unassessed</p>
                    <p className="mt-1 text-lg font-semibold">
                      {portfolioHealth.unassessedRepositoryCount}
                    </p>
                  </CardPanel>
                </Card>
                <Card
                  className="transition-colors hover:border-primary/50"
                  render={<Link to="/agent-dashboard/findings" />}
                >
                  <CardPanel className="p-4">
                    <p className="text-xs text-muted-foreground">Open findings</p>
                    <p className="mt-1 text-lg font-semibold">{portfolioHealth.openFindingCount}</p>
                  </CardPanel>
                </Card>
                <Card
                  className="transition-colors hover:border-info/50"
                  render={<Link to="/agent-dashboard/runs" />}
                >
                  <CardPanel className="p-4">
                    <p className="text-xs text-muted-foreground">Active runs</p>
                    <p className="mt-1 text-lg font-semibold">{portfolioHealth.activeRunCount}</p>
                  </CardPanel>
                </Card>
              </div>
            ) : null}

            {portfolioHealth &&
            (portfolioHealth.criticalFindingCount > 0 ||
              portfolioHealth.attentionRepositoryCount > 0 ||
              needsInputCount > 0 ||
              failedRunCount > 0) ? (
              <Card className="border-warning/35">
                <CardHeader className="p-4 sm:p-5">
                  <CardTitle className="text-base">Needs you now</CardTitle>
                  <CardDescription>
                    The highest-signal items that may need a decision or intervention.
                  </CardDescription>
                </CardHeader>
                <CardPanel className="grid gap-2 border-t border-border/60 p-3 sm:grid-cols-2 sm:p-4">
                  {needsInputCount > 0 ? (
                    <Button
                      className="h-auto justify-start gap-3 py-3"
                      render={<Link to="/agent-dashboard/feed" />}
                      variant="ghost"
                    >
                      <MessageCircleWarningIcon className="text-warning" />
                      <span className="text-left">
                        <span className="block font-medium">{needsInputCount} agent responses</span>
                        <span className="block text-xs text-muted-foreground">
                          Waiting for input
                        </span>
                      </span>
                    </Button>
                  ) : null}
                  {portfolioHealth.criticalFindingCount > 0 ? (
                    <Button
                      className="h-auto justify-start gap-3 py-3"
                      render={<Link to="/agent-dashboard/findings" />}
                      variant="ghost"
                    >
                      <TriangleAlertIcon className="text-destructive" />
                      <span className="text-left">
                        <span className="block font-medium">
                          {portfolioHealth.criticalFindingCount} critical findings
                        </span>
                        <span className="block text-xs text-muted-foreground">Review priority</span>
                      </span>
                    </Button>
                  ) : null}
                  {portfolioHealth.attentionRepositoryCount > 0 ? (
                    <Button
                      className="h-auto justify-start gap-3 py-3"
                      render={<Link to="/agent-dashboard/runs" />}
                      variant="ghost"
                    >
                      <TelescopeIcon className="text-warning" />
                      <span className="text-left">
                        <span className="block font-medium">
                          {portfolioHealth.attentionRepositoryCount} repositories need attention
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Inspect coverage
                        </span>
                      </span>
                    </Button>
                  ) : null}
                  {failedRunCount > 0 ? (
                    <Button
                      className="h-auto justify-start gap-3 py-3"
                      render={<Link to="/agent-dashboard/runs" />}
                      variant="ghost"
                    >
                      <CircleAlertIcon className="text-destructive" />
                      <span className="text-left">
                        <span className="block font-medium">{failedRunCount} failed runs</span>
                        <span className="block text-xs text-muted-foreground">
                          Retry or diagnose
                        </span>
                      </span>
                    </Button>
                  ) : null}
                </CardPanel>
              </Card>
            ) : null}

            {!allEnvironmentShellsBootstrapped && repositoryGroups.length === 0 ? (
              <DashboardLoadingState />
            ) : repositoryGroups.length === 0 ? (
              <DashboardEmptyState />
            ) : (
              <div className="grid items-start gap-4 lg:grid-cols-2">
                {repositoryGroups.map((group) => (
                  <RepositoryCard
                    key={group.key}
                    group={group}
                    threads={threads}
                    environmentLabelById={environmentLabelById}
                    serverRepository={
                      group.members
                        .map(({ project }) =>
                          serverRepositoryByProjectKey.get(
                            `${project.environmentId}:${project.id}`,
                          ),
                        )
                        .find(
                          (repository): repository is DashboardServerRepository =>
                            repository !== undefined,
                        ) ?? null
                    }
                    serverSnapshotPending={serverSnapshotQuery.isPending}
                    refreshServerSnapshot={serverSnapshotQuery.refresh}
                    onOpenThread={openThread}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

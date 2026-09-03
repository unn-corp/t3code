import { useEffect, useMemo, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  Clock3Icon,
  LoaderIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";

import type {
  AgentDashboardAutomationRun,
  AgentDashboardRepositoryPolicy,
} from "@t3tools/contracts";
import type { AgentRunsSearch } from "../agentDashboardRouteSearch";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";

const EMPTY_AGENT_RUNS_SEARCH = {} satisfies AgentRunsSearch;

function runVariant(status: AgentDashboardAutomationRun["status"]) {
  switch (status) {
    case "succeeded":
      return "success" as const;
    case "partial":
      return "warning" as const;
    case "failed":
    case "cancelled":
      return "error" as const;
    case "queued":
    case "running":
    case "ingesting":
      return "info" as const;
  }
}

function statusIcon(status: AgentDashboardAutomationRun["status"]) {
  switch (status) {
    case "succeeded":
      return <CheckCircle2Icon className="size-4 text-success" />;
    case "failed":
    case "cancelled":
      return <CircleAlertIcon className="size-4 text-destructive" />;
    case "partial":
      return <CircleAlertIcon className="size-4 text-warning" />;
    case "queued":
    case "running":
    case "ingesting":
      return <LoaderIcon className="size-4 animate-spin text-info" />;
  }
}

function policyLabel(policy: AgentDashboardRepositoryPolicy): string {
  return `${policy.cadenceMinutes} min cadence, priority ${policy.priority}, ${policy.riskTier} risk`;
}

function runDuration(run: AgentDashboardAutomationRun): string {
  const started = Date.parse(run.startedAt ?? run.createdAt);
  const ended = Date.parse(run.completedAt ?? run.updatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return "Unknown";
  const seconds = Math.round((ended - started) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function runStage(status: AgentDashboardAutomationRun["status"]): number {
  if (status === "queued") return 0;
  if (status === "running") return 1;
  if (status === "ingesting") return 2;
  return 3;
}

function runTitle(run: AgentDashboardAutomationRun): string {
  switch (run.kind) {
    case "continuous-improvement":
      return "Continuous improvement";
    case "pull-request-rollup":
      return "Pull request rollup";
    case "inactive-worktree-cleanup":
      return "Inactive worktree cleanup";
    default:
      return run.kind;
  }
}

function runStatusLabel(run: AgentDashboardAutomationRun): string {
  if (run.kind !== "continuous-improvement" && run.kind !== "pull-request-rollup") {
    return run.status;
  }
  switch (run.status) {
    case "queued":
      return "Starting";
    case "running":
      return "Working";
    case "ingesting":
      return "Checking pull request";
    case "succeeded":
      return run.kind === "pull-request-rollup" ? "Rollup PR opened" : "PR opened";
    case "partial":
      return "Needs attention";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
  }
}

export function AgentRuns({
  initialSearch = EMPTY_AGENT_RUNS_SEARCH,
}: {
  readonly initialSearch?: AgentRunsSearch;
}) {
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const retryRun = useAtomCommand(agentDashboardEnvironment.retryRun, { reportFailure: false });
  const updatePolicy = useAtomCommand(agentDashboardEnvironment.updateRepositoryPolicy, {
    reportFailure: false,
  });
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [updatingPolicyId, setUpdatingPolicyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState(initialSearch.status ?? "all");
  const [projectFilter, setProjectFilter] = useState(initialSearch.project ?? "all");
  const runs = useMemo(
    () => dashboardSnapshot.data?.automationRuns ?? [],
    [dashboardSnapshot.data?.automationRuns],
  );
  const policies = dashboardSnapshot.data?.repositoryPolicies ?? [];
  const coverage = dashboardSnapshot.data?.repositoryCoverage ?? [];
  const health = dashboardSnapshot.data?.portfolioHealth;
  const repositoryNames = useMemo(
    () =>
      new Map(
        (dashboardSnapshot.data?.repositories ?? []).map((repository) => [
          String(repository.projectId),
          repository.title,
        ]),
      ),
    [dashboardSnapshot.data?.repositories],
  );
  const visibleRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          (statusFilter === "all" || run.status === statusFilter) &&
          (projectFilter === "all" || String(run.repository.projectId) === projectFilter),
      ),
    [projectFilter, runs, statusFilter],
  );
  useEffect(() => {
    const targetId = initialSearch.runId
      ? `agent-run-${initialSearch.runId}`
      : initialSearch.focus === "coverage" && initialSearch.project
        ? `agent-coverage-${initialSearch.project}`
        : null;
    if (!targetId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [coverage, initialSearch.focus, initialSearch.project, initialSearch.runId, visibleRuns]);

  const showFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "Try again after refreshing.",
      }),
    );
  };

  const retry = async (run: AgentDashboardAutomationRun) => {
    if (!dashboardSnapshot.environmentId || retryingRunId !== null) return;
    setRetryingRunId(run.id);
    try {
      const result = await retryRun({
        environmentId: dashboardSnapshot.environmentId,
        input: { id: run.id },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          showFailure("Run could not be retried", squashAtomCommandFailure(result));
        return;
      }
      await dashboardSnapshot.refresh();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Retry queued",
          description: `A new run was started for ${repositoryNames.get(String(run.repository.projectId)) ?? "the repository"}.`,
        }),
      );
    } finally {
      setRetryingRunId(null);
    }
  };

  const togglePolicy = async (policy: AgentDashboardRepositoryPolicy) => {
    if (!dashboardSnapshot.environmentId || updatingPolicyId !== null) return;
    setUpdatingPolicyId(String(policy.repository.projectId));
    try {
      const result = await updatePolicy({
        environmentId: dashboardSnapshot.environmentId,
        input: { ...policy, enabled: !policy.enabled, updatedAt: new Date().toISOString() },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          showFailure("Policy could not be updated", squashAtomCommandFailure(result));
        return;
      }
      await dashboardSnapshot.refresh();
    } finally {
      setUpdatingPolicyId(null);
    }
  };

  const changePolicy = async (
    policy: AgentDashboardRepositoryPolicy,
    patch: Partial<
      Pick<AgentDashboardRepositoryPolicy, "cadenceMinutes" | "priority" | "riskTier">
    >,
  ) => {
    if (!dashboardSnapshot.environmentId || updatingPolicyId !== null) return;
    const id = String(policy.repository.projectId);
    setUpdatingPolicyId(id);
    try {
      const result = await updatePolicy({
        environmentId: dashboardSnapshot.environmentId,
        input: { ...policy, ...patch, updatedAt: new Date().toISOString() },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          showFailure("Policy could not be updated", squashAtomCommandFailure(result));
        }
        return;
      }
      await dashboardSnapshot.refresh();
    } finally {
      setUpdatingPolicyId(null);
    }
  };

  return (
    <AgentDashboardPageShell
      actions={
        <Button
          aria-label="Refresh automation runs"
          disabled={dashboardSnapshot.isPending}
          onClick={dashboardSnapshot.refresh}
          size="icon-sm"
          variant="outline"
        >
          <RefreshCwIcon className={dashboardSnapshot.isPending ? "animate-spin" : undefined} />
        </Button>
      }
      title="Runs and coverage"
      description="Durable automation history, repository freshness, policy, retries, and failure state."
    >
      {health ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Card>
            <CardPanel className="p-4">
              <p className="text-xs text-muted-foreground">Repositories</p>
              <p className="mt-1 text-lg font-semibold">{health.repositoryCount}</p>
            </CardPanel>
          </Card>
          <Card>
            <CardPanel className="p-4">
              <p className="text-xs text-muted-foreground">Unassessed</p>
              <p className="mt-1 text-lg font-semibold">{health.unassessedRepositoryCount}</p>
            </CardPanel>
          </Card>
          <Card>
            <CardPanel className="p-4">
              <p className="text-xs text-muted-foreground">Healthy</p>
              <p className="mt-1 text-lg font-semibold text-success">
                {health.healthyRepositoryCount}
              </p>
            </CardPanel>
          </Card>
          <Card>
            <CardPanel className="p-4">
              <p className="text-xs text-muted-foreground">Attention</p>
              <p className="mt-1 text-lg font-semibold text-warning">
                {health.attentionRepositoryCount}
              </p>
            </CardPanel>
          </Card>
          <Card>
            <CardPanel className="p-4">
              <p className="text-xs text-muted-foreground">Open findings</p>
              <p className="mt-1 text-lg font-semibold">{health.openFindingCount}</p>
            </CardPanel>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader className="p-4 sm:p-5">
          <CardTitle className="text-base">Repository automation policy</CardTitle>
          <CardDescription>
            Disabled repositories are skipped by scheduled reviews, continuous improvement, and pull
            request rollups.
          </CardDescription>
        </CardHeader>
        <CardPanel className="grid gap-2 border-t border-border/60 p-4 sm:p-5">
          {policies.map((policy) => {
            const id = String(policy.repository.projectId);
            const repositoryCoverage = coverage.find(
              (item) => String(item.repository.projectId) === id,
            );
            return (
              <div
                className="flex scroll-mt-4 flex-col gap-3 rounded-lg border border-border/60 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between"
                id={`agent-coverage-${id}`}
                key={id}
                tabIndex={-1}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{repositoryNames.get(id) ?? id}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{policyLabel(policy)}</p>
                  {repositoryCoverage ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Coverage: {repositoryCoverage.status}
                      {repositoryCoverage.nextDueAt
                        ? `, next ${formatRelativeTimeUntilLabel(repositoryCoverage.nextDueAt)}`
                        : ""}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    disabled={updatingPolicyId !== null}
                    value={String(policy.cadenceMinutes)}
                    onValueChange={(value) => {
                      if (value) void changePolicy(policy, { cadenceMinutes: Number(value) });
                    }}
                  >
                    <SelectTrigger
                      aria-label={`Review cadence for ${repositoryNames.get(id) ?? id}`}
                      className="w-32"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value="60">Hourly</SelectItem>
                      <SelectItem value="120">Every 2 hours</SelectItem>
                      <SelectItem value="360">Every 6 hours</SelectItem>
                      <SelectItem value="1440">Daily</SelectItem>
                    </SelectPopup>
                  </Select>
                  <Select
                    disabled={updatingPolicyId !== null}
                    value={policy.riskTier}
                    onValueChange={(value) => {
                      if (
                        value === "low" ||
                        value === "medium" ||
                        value === "high" ||
                        value === "critical"
                      ) {
                        void changePolicy(policy, { riskTier: value });
                      }
                    }}
                  >
                    <SelectTrigger
                      aria-label={`Risk tier for ${repositoryNames.get(id) ?? id}`}
                      className="w-28"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value="low">Low risk</SelectItem>
                      <SelectItem value="medium">Medium risk</SelectItem>
                      <SelectItem value="high">High risk</SelectItem>
                      <SelectItem value="critical">Critical risk</SelectItem>
                    </SelectPopup>
                  </Select>
                  <Button
                    disabled={updatingPolicyId !== null}
                    onClick={() => void togglePolicy(policy)}
                    size="sm"
                    variant={policy.enabled ? "outline" : "ghost"}
                  >
                    {updatingPolicyId === id ? <LoaderIcon className="animate-spin" /> : null}
                    {policy.enabled ? "Pause automations" : "Resume automations"}
                  </Button>
                </div>
              </div>
            );
          })}
        </CardPanel>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Select value={projectFilter} onValueChange={(value) => value && setProjectFilter(value)}>
          <SelectTrigger aria-label="Filter runs by repository" className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="all">All repositories</SelectItem>
            {[...repositoryNames.entries()]
              .toSorted((left, right) => left[1].localeCompare(right[1]))
              .map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
          </SelectPopup>
        </Select>
        <Select value={statusFilter} onValueChange={(value) => value && setStatusFilter(value)}>
          <SelectTrigger aria-label="Filter runs by status" className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="ingesting">Ingesting</SelectItem>
            <SelectItem value="succeeded">Succeeded</SelectItem>
            <SelectItem value="partial">Partial</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      {visibleRuns.length > 0 ? (
        <div className="grid gap-3">
          {visibleRuns.map((run) => (
            <div
              className="scroll-mt-4 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id={`agent-run-${run.id}`}
              key={run.id}
              tabIndex={-1}
            >
              <Card>
                <CardHeader className="gap-3 p-4 sm:p-5">
                  <div className="flex min-w-0 items-start gap-3">
                    {statusIcon(run.status)}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-base">{runTitle(run)}</CardTitle>
                        <Badge size="sm" variant={runVariant(run.status)}>
                          {runStatusLabel(run)}
                        </Badge>
                        <Badge size="sm" variant="outline">
                          {run.trigger}
                        </Badge>
                      </div>
                      <CardDescription className="mt-1 truncate">
                        {repositoryNames.get(String(run.repository.projectId)) ??
                          String(run.repository.projectId)}
                        {run.target ? `, ${run.target}` : ""}
                      </CardDescription>
                    </div>
                    {(run.status === "failed" || run.status === "partial") &&
                    run.kind !== "pull-request-rollup" &&
                    run.kind !== "inactive-worktree-cleanup" ? (
                      <Button
                        disabled={retryingRunId !== null}
                        onClick={() => void retry(run)}
                        size="sm"
                        variant="outline"
                      >
                        {retryingRunId === run.id ? (
                          <LoaderIcon className="animate-spin" />
                        ) : (
                          <RotateCcwIcon />
                        )}
                        Retry
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
                <CardPanel className="flex flex-col gap-2 border-t border-border/60 p-4 text-xs text-muted-foreground sm:p-5">
                  <div className="grid grid-cols-4 gap-1" aria-label={`Run stage: ${run.status}`}>
                    {["Queued", "Running", "Ingesting", "Complete"].map((label, index) => (
                      <div key={label}>
                        <div
                          className={`h-1.5 rounded-full ${index <= runStage(run.status) ? "bg-primary" : "bg-muted"}`}
                        />
                        <span className="mt-1 block text-[10px]">{label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock3Icon className="size-3.5" />
                      {formatRelativeTimeLabel(run.updatedAt) || "Unknown time"}
                    </span>
                    <span>Model: {run.model ?? "Unmeasured"}</span>
                    <span>Findings: {run.findingCount}</span>
                    <span>Retries: {run.retryCount}</span>
                    <span>Cost: {run.costUnits === null ? "Unmeasured" : run.costUnits}</span>
                    <span>Duration: {runDuration(run)}</span>
                  </div>
                  {run.error ? <p className="text-destructive">{run.error}</p> : null}
                </CardPanel>
              </Card>
            </div>
          ))}
        </div>
      ) : (
        <Empty className="min-h-56 border border-dashed border-border/70 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Clock3Icon />
            </EmptyMedia>
            <EmptyTitle>No automation runs yet</EmptyTitle>
            <EmptyDescription>
              Run an investigation or wait for scheduled automation to create durable history.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AgentDashboardPageShell>
  );
}

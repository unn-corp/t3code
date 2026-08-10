import { useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  Clock3Icon,
  LoaderIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";

import type { AgentDashboardAutomationRun, AgentDashboardRepositoryPolicy } from "@t3tools/contracts";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";

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

export function AgentRuns() {
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const retryRun = useAtomCommand(agentDashboardEnvironment.retryRun, { reportFailure: false });
  const updatePolicy = useAtomCommand(agentDashboardEnvironment.updateRepositoryPolicy, {
    reportFailure: false,
  });
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [updatingPolicyId, setUpdatingPolicyId] = useState<string | null>(null);
  const runs = useMemo(
    () => dashboardSnapshot.data?.automationRuns ?? [],
    [dashboardSnapshot.data?.automationRuns],
  );
  const policies = dashboardSnapshot.data?.repositoryPolicies ?? [];
  const coverage = dashboardSnapshot.data?.repositoryCoverage ?? [];
  const health = dashboardSnapshot.data?.portfolioHealth;

  const retry = async (run: AgentDashboardAutomationRun) => {
    if (!dashboardSnapshot.environmentId || retryingRunId !== null) return;
    setRetryingRunId(run.id);
    try {
      const result = await retryRun({
        environmentId: dashboardSnapshot.environmentId,
        input: { id: run.id },
      });
      if (result._tag === "Success") await dashboardSnapshot.refresh();
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
      if (result._tag === "Success") await dashboardSnapshot.refresh();
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card><CardPanel className="p-4"><p className="text-xs text-muted-foreground">Repositories</p><p className="mt-1 text-lg font-semibold">{health.repositoryCount}</p></CardPanel></Card>
          <Card><CardPanel className="p-4"><p className="text-xs text-muted-foreground">Healthy</p><p className="mt-1 text-lg font-semibold text-success">{health.healthyRepositoryCount}</p></CardPanel></Card>
          <Card><CardPanel className="p-4"><p className="text-xs text-muted-foreground">Attention</p><p className="mt-1 text-lg font-semibold text-warning">{health.attentionRepositoryCount}</p></CardPanel></Card>
          <Card><CardPanel className="p-4"><p className="text-xs text-muted-foreground">Open findings</p><p className="mt-1 text-lg font-semibold">{health.openFindingCount}</p></CardPanel></Card>
        </div>
      ) : null}

      <Card>
        <CardHeader className="p-4 sm:p-5">
          <CardTitle className="text-base">Repository policy</CardTitle>
          <CardDescription>Scheduling is deterministic and policy-driven. Disabled repositories are skipped.</CardDescription>
        </CardHeader>
        <CardPanel className="grid gap-2 border-t border-border/60 p-4 sm:p-5">
          {policies.map((policy) => {
            const id = String(policy.repository.projectId);
            const repositoryCoverage = coverage.find(
              (item) => String(item.repository.projectId) === id,
            );
            return (
              <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between" key={id}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{id}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{policyLabel(policy)}</p>
                  {repositoryCoverage ? <p className="mt-1 text-xs text-muted-foreground">Coverage: {repositoryCoverage.status}</p> : null}
                </div>
                <Button
                  disabled={updatingPolicyId !== null}
                  onClick={() => void togglePolicy(policy)}
                  size="sm"
                  variant={policy.enabled ? "outline" : "ghost"}
                >
                  {updatingPolicyId === id ? <LoaderIcon className="animate-spin" /> : null}
                  {policy.enabled ? "Enabled" : "Disabled"}
                </Button>
              </div>
            );
          })}
        </CardPanel>
      </Card>

      {runs.length > 0 ? (
        <div className="grid gap-3">
          {runs.map((run) => (
            <Card key={run.id}>
              <CardHeader className="gap-3 p-4 sm:p-5">
                <div className="flex min-w-0 items-start gap-3">
                  {statusIcon(run.status)}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">{run.kind}</CardTitle>
                      <Badge size="sm" variant={runVariant(run.status)}>{run.status}</Badge>
                      <Badge size="sm" variant="outline">{run.trigger}</Badge>
                    </div>
                    <CardDescription className="mt-1 truncate">Repository {String(run.repository.projectId)}{run.target ? `, ${run.target}` : ""}</CardDescription>
                  </div>
                  {run.status === "failed" || run.status === "partial" ? (
                    <Button
                      disabled={retryingRunId !== null}
                      onClick={() => void retry(run)}
                      size="sm"
                      variant="outline"
                    >
                      {retryingRunId === run.id ? <LoaderIcon className="animate-spin" /> : <RotateCcwIcon />}
                      Retry
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardPanel className="flex flex-col gap-2 border-t border-border/60 p-4 text-xs text-muted-foreground sm:p-5">
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  <span className="inline-flex items-center gap-1.5"><Clock3Icon className="size-3.5" />{formatRelativeTimeLabel(run.updatedAt) || "Unknown time"}</span>
                  <span>Model: {run.model ?? "Unmeasured"}</span>
                  <span>Findings: {run.findingCount}</span>
                  <span>Retries: {run.retryCount}</span>
                  <span>Cost: {run.costUnits === null ? "Unmeasured" : run.costUnits}</span>
                </div>
                {run.error ? <p className="text-destructive">{run.error}</p> : null}
              </CardPanel>
            </Card>
          ))}
        </div>
      ) : (
        <Empty className="min-h-56 border border-dashed border-border/70 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Clock3Icon /></EmptyMedia>
            <EmptyTitle>No automation runs yet</EmptyTitle>
            <EmptyDescription>Run an investigation or wait for the scheduled review to create durable history.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AgentDashboardPageShell>
  );
}

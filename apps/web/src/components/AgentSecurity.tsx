import { useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  LoaderIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";

import type { AgentDashboardFinding, AgentDashboardDispositionAction } from "@t3tools/contracts";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";

function severityVariant(severity: AgentDashboardFinding["severity"]) {
  switch (severity) {
    case "critical":
    case "high":
      return "error" as const;
    case "medium":
      return "warning" as const;
    case "low":
    case "info":
      return "outline" as const;
  }
}

function dispositionVariant(state: AgentDashboardFinding["disposition"]["state"]) {
  return state === "open" ? ("warning" as const) : ("outline" as const);
}

export function AgentSecurity() {
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const applyFindingAction = useAtomCommand(agentDashboardEnvironment.applyFindingAction, {
    reportFailure: false,
  });
  const collect = useAtomCommand(agentDashboardEnvironment.collect, { reportFailure: false });
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [isCollecting, setIsCollecting] = useState(false);
  const findings = useMemo(
    () => dashboardSnapshot.data?.findings.filter((finding) => finding.kind === "security") ?? [],
    [dashboardSnapshot.data?.findings],
  );
  const collectors = dashboardSnapshot.data?.collectorStates.filter(
    (state) => state.kind === "security" || state.kind === "all",
  ) ?? [];

  const apply = async (finding: AgentDashboardFinding, action: AgentDashboardDispositionAction) => {
    if (!dashboardSnapshot.environmentId || updatingId !== null) return;
    setUpdatingId(finding.id);
    try {
      const result = await applyFindingAction({
        environmentId: dashboardSnapshot.environmentId,
        input: { id: finding.id, action },
      });
      if (result._tag === "Success") await dashboardSnapshot.refresh();
    } finally {
      setUpdatingId(null);
    }
  };

  const collectNow = async () => {
    if (!dashboardSnapshot.environmentId || isCollecting) return;
    setIsCollecting(true);
    try {
      const result = await collect({
        environmentId: dashboardSnapshot.environmentId,
        input: { kind: "security" },
      });
      if (result._tag === "Success") await dashboardSnapshot.refresh();
    } finally {
      setIsCollecting(false);
    }
  };

  return (
    <AgentDashboardPageShell
      actions={
        <div className="flex items-center gap-2">
          <Button
            disabled={isCollecting || dashboardSnapshot.environmentId === null}
            onClick={() => void collectNow()}
            size="sm"
            variant="outline"
          >
            {isCollecting ? <LoaderIcon className="animate-spin" /> : <ShieldAlertIcon />}
            {isCollecting ? "Scanning" : "Scan now"}
          </Button>
          <Button
            aria-label="Refresh security findings"
            disabled={dashboardSnapshot.isPending}
            onClick={dashboardSnapshot.refresh}
            size="icon-sm"
            variant="outline"
          >
            <RefreshCwIcon className={dashboardSnapshot.isPending ? "animate-spin" : undefined} />
          </Button>
        </div>
      }
      title="Security"
      description="Local-first security observations with explicit collector availability and reversible finding actions."
    >
      {collectors.length > 0 ? (
        <Card>
          <CardHeader className="p-4 sm:p-5">
            <CardTitle className="text-base">Collector health</CardTitle>
            <CardDescription>Unavailable integrations stay visible instead of being reported as clean.</CardDescription>
          </CardHeader>
          <CardPanel className="grid gap-2 border-t border-border/60 p-4 sm:p-5">
            {collectors.map((collector) => (
              <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between" key={collector.id}>
                <div>
                  <p className="text-sm font-medium">{collector.source}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{collector.message ?? "Collector completed."}</p>
                </div>
                <Badge variant={collector.status === "available" ? "success" : "warning"}>{collector.status}</Badge>
              </div>
            ))}
          </CardPanel>
        </Card>
      ) : null}

      {findings.length > 0 ? (
        <div className="grid gap-3">
          {findings.map((finding) => (
            <Card key={finding.id}>
              <CardHeader className="gap-3 p-4 sm:p-5">
                <div className="flex min-w-0 items-start gap-3">
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">{finding.title}</CardTitle>
                      <Badge size="sm" variant={severityVariant(finding.severity)}>{finding.severity}</Badge>
                      <Badge size="sm" variant={dispositionVariant(finding.disposition.state)}>{finding.disposition.state}</Badge>
                    </div>
                    <CardDescription className="mt-1">{finding.summary}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardPanel className="flex flex-col gap-4 border-t border-border/60 p-4 sm:p-5">
                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                  <span>Repository: {String(finding.repository.projectId)}</span>
                  <span>Source: {finding.provenance.source}</span>
                  <span>Collected {formatRelativeTimeLabel(finding.provenance.collectedAt) || "Unknown time"}</span>
                  <span>Seen {finding.occurrenceCount} time{finding.occurrenceCount === 1 ? "" : "s"}</span>
                </div>
                <ul className="grid gap-1 text-sm text-foreground/80">
                  {finding.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={updatingId !== null} onClick={() => void apply(finding, "acknowledge")} size="sm" variant="outline">
                    <CheckCircle2Icon /> Acknowledge
                  </Button>
                  <Button disabled={updatingId !== null} onClick={() => void apply(finding, "snooze")} size="sm" variant="outline">
                    Snooze
                  </Button>
                  <Button disabled={updatingId !== null} onClick={() => void apply(finding, "dismiss")} size="sm" variant="outline">
                    Dismiss
                  </Button>
                  {finding.disposition.state !== "open" ? (
                    <Button disabled={updatingId !== null} onClick={() => void apply(finding, "reopen")} size="sm" variant="ghost">
                      Reopen
                    </Button>
                  ) : null}
                </div>
              </CardPanel>
            </Card>
          ))}
        </div>
      ) : (
        <Empty className="min-h-56 border border-dashed border-border/70 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CheckCircle2Icon /></EmptyMedia>
            <EmptyTitle>No security findings</EmptyTitle>
            <EmptyDescription>Run a local security scan to check the connected repositories.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AgentDashboardPageShell>
  );
}

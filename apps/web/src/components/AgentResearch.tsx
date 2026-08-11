import { useMemo, useState } from "react";
import {
  ActivityIcon,
  BookOpenIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  SearchIcon,
  TerminalIcon,
  RefreshCwIcon,
  LoaderIcon,
} from "lucide-react";

import { buildNativeResearchRecordsFromDurableFindings } from "../agentDashboardPages";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";

function signalVariant(signal: "active" | "needs-attention" | "connected") {
  switch (signal) {
    case "active":
      return "info" as const;
    case "needs-attention":
      return "warning" as const;
    case "connected":
      return "outline" as const;
  }
}

function signalLabel(signal: "active" | "needs-attention" | "connected"): string {
  switch (signal) {
    case "active":
      return "Active signal";
    case "needs-attention":
      return "Needs attention";
    case "connected":
      return "Connected";
  }
}

function scoreVariant(score: number) {
  if (score >= 80) return "success" as const;
  if (score >= 60) return "warning" as const;
  return "outline" as const;
}

export function AgentResearch() {
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const collect = useAtomCommand(agentDashboardEnvironment.collect, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [signalFilter, setSignalFilter] = useState("all");
  const [isCollecting, setIsCollecting] = useState(false);
  const records = useMemo(() => {
    if (dashboardSnapshot.data === null || dashboardSnapshot.environmentId === null) return [];
    return buildNativeResearchRecordsFromDurableFindings(
      dashboardSnapshot.data,
      dashboardSnapshot.environmentId,
    );
  }, [dashboardSnapshot.data, dashboardSnapshot.environmentId]);

  const collectNow = async () => {
    if (!dashboardSnapshot.environmentId || isCollecting) return;
    setIsCollecting(true);
    try {
      const result = await collect({
        environmentId: dashboardSnapshot.environmentId,
        input: { kind: "research" },
      });
      if (result._tag === "Success") {
        await dashboardSnapshot.refresh();
      }
    } finally {
      setIsCollecting(false);
    }
  };
  const visibleRecords = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return records.filter((record) => {
      if (signalFilter !== "all" && record.signal !== signalFilter) return false;
      if (!needle) return true;
      return [
        record.repositoryName,
        record.title,
        record.summary,
        record.source,
        record.workspaceRoot,
        ...record.categories,
        ...record.evidence,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [query, records, signalFilter]);

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
            {isCollecting ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
            {isCollecting ? "Collecting" : "Collect now"}
          </Button>
          <Button
            aria-label="Refresh research"
            disabled={dashboardSnapshot.isPending}
            onClick={dashboardSnapshot.refresh}
            size="icon-sm"
            variant="outline"
          >
            <RefreshCwIcon className={dashboardSnapshot.isPending ? "animate-spin" : undefined} />
          </Button>
        </div>
      }
      title="Research"
      description="Research findings collected from the configured research sources, with the newest observation first."
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search research findings"
            className="pl-9"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search findings, repositories, or evidence"
            value={query}
          />
        </div>
        <Select value={signalFilter} onValueChange={(value) => value && setSignalFilter(value)}>
          <SelectTrigger aria-label="Filter research by signal" className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="all">All signals</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="needs-attention">Needs attention</SelectItem>
            <SelectItem value="connected">Connected</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      {visibleRecords.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {visibleRecords.map((record) => (
            <Card key={record.id}>
              <CardHeader className="gap-3 p-5">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <BookOpenIcon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="min-w-0 truncate text-base">
                        {record.repositoryName}
                      </CardTitle>
                      <Badge size="sm" variant="outline">
                        {record.source}
                      </Badge>
                      <Badge size="sm" variant={signalVariant(record.signal)}>
                        {signalLabel(record.signal)}
                      </Badge>
                      <Badge size="sm" variant={scoreVariant(record.relevanceScore)}>
                        {record.relevanceScore}/100
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">{record.title}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardPanel className="flex flex-col gap-4 border-t border-border/60 p-5">
                <p className="text-sm text-foreground/85">{record.summary}</p>
                {record.durableFinding?.topicContext ? (
                  <div className="rounded-lg border border-border/70 bg-muted/35 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Why it surfaced</p>
                    <p className="mt-1 text-sm">{record.durableFinding.topicContext}</p>
                  </div>
                ) : null}
                {record.durableFinding ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>Finding {record.durableFinding.id}</span>
                    {record.durableFinding.occurrences > 1 ? (
                      <span>Seen {record.durableFinding.occurrences} times</span>
                    ) : null}
                    {record.durableFinding.published ? (
                      <span>Published {record.durableFinding.published}</span>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  {record.categories.map((category) => (
                    <Badge key={category} size="sm" variant="outline">
                      {category}
                    </Badge>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex min-w-0 items-start gap-2 text-sm">
                    <FolderGit2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Workspace</p>
                      <p className="mt-1 truncate font-mono text-xs" title={record.workspaceRoot}>
                        {record.workspaceRoot}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <ActivityIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Latest activity</p>
                      <p className="mt-1 text-xs">
                        {formatRelativeTimeLabel(record.latestActivityAt) || "Unknown time"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Agents</p>
                      <p className="mt-1 text-xs">
                        {record.threadCount} total, {record.activeThreadCount} active
                      </p>
                    </div>
                  </div>
                  {record.latestThreadTitle ? (
                    <div className="min-w-0 text-sm sm:col-span-2">
                      <p className="text-xs text-muted-foreground">Most recent agent</p>
                      <p className="mt-1 truncate text-xs">{record.latestThreadTitle}</p>
                    </div>
                  ) : null}
                </div>
                <div className="border-t border-border/60 pt-3">
                  <p className="text-xs font-medium text-muted-foreground">Evidence</p>
                  <ul className="mt-2 grid gap-1 text-xs text-foreground/80">
                    {record.evidence.map((evidence) => (
                      <li key={evidence} className="truncate" title={evidence}>
                        {evidence}
                      </li>
                    ))}
                  </ul>
                </div>
                {record.remoteUrl && /^https?:\/\//i.test(record.remoteUrl) ? (
                  <div>
                    <Button
                      render={<a href={record.remoteUrl} target="_blank" rel="noreferrer" />}
                      size="sm"
                      variant="outline"
                    >
                      <ExternalLinkIcon />
                      {record.durableFinding ? "Open source" : "Open repository source"}
                    </Button>
                    {record.durableFinding?.pdfUrl &&
                    /^https?:\/\//i.test(record.durableFinding.pdfUrl) ? (
                      <Button
                        className="ml-2"
                        render={
                          <a href={record.durableFinding.pdfUrl} target="_blank" rel="noreferrer" />
                        }
                        size="sm"
                        variant="ghost"
                      >
                        Open PDF
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </CardPanel>
            </Card>
          ))}
        </div>
      ) : (
        <Empty className="min-h-72 border border-dashed border-border/70 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpenIcon />
            </EmptyMedia>
            <EmptyTitle>
              {records.length === 0 ? "No research findings yet" : "No matching findings"}
            </EmptyTitle>
            <EmptyDescription>
              {records.length === 0
                ? "Run a research collection in T3 Code and its findings will appear here."
                : "Try a different search or signal filter."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AgentDashboardPageShell>
  );
}

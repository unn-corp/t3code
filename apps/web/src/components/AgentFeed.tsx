import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  Clock3Icon,
  GitBranchIcon,
  InboxIcon,
  RadioIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildNativeAgentFeed,
  buildNativeAgentFeedFromDurableCards,
  buildNativeAgentFeedFromSnapshot,
  compareDashboardRecency,
  mergeNativeAgentFeedRecords,
  nativeAgentStateLabel,
  type NativeAgentState,
} from "../agentDashboardPages";
import type { AgentDashboardFeedAction } from "@t3tools/contracts";
import { readLocalApi } from "../localApi";
import { useAgentDashboardSnapshot } from "../state/agentDashboard";
import { agentDashboardEnvironment } from "../state/agentDashboard";
import { useAtomCommand } from "../state/use-atom-command";
import { useProjects, useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";

const FEED_DISMISSED_STORAGE_KEY = "t3.agent-dashboard.feed.dismissed";

function stateVariant(state: NativeAgentState) {
  switch (state) {
    case "running":
      return "info" as const;
    case "needs-input":
      return "warning" as const;
    case "error":
      return "error" as const;
    case "completed":
      return "success" as const;
    case "paused":
    case "idle":
      return "outline" as const;
  }
}

function levelVariant(level: ReturnType<typeof buildNativeAgentFeed>[number]["level"]) {
  switch (level) {
    case "error":
      return "error" as const;
    case "warn":
      return "warning" as const;
    case "success":
      return "success" as const;
    case "info":
      return "outline" as const;
  }
}

function readDismissedFeedIds(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(FEED_DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? new Set(value)
      : new Set();
  } catch {
    return new Set();
  }
}

function safeFeedFileUrl(workspaceRoot: string, file: string): string | null {
  const trimmed = file.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const segments = trimmed.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const base = workspaceRoot.trim().replaceAll("\\", "/").replace(/\/$/, "");
  const target = trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed)
    ? trimmed.replaceAll("\\", "/")
    : `${base}/${trimmed.replace(/^\.\//, "")}`;
  if (!base || (target !== base && !target.startsWith(`${base}/`))) return null;
  return encodeURI(target.startsWith("file://") ? target : `file://${target}`);
}

function AgentFeedCard({
  item,
  onDismiss,
  onOpen,
  onAction,
}: {
  readonly item: ReturnType<typeof buildNativeAgentFeed>[number];
  readonly onDismiss: (id: string) => void;
  readonly onOpen: () => void;
  readonly onAction: (action: AgentDashboardFeedAction) => void;
}) {
  return (
    <Card>
      <CardHeader className="gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <BotIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="min-w-0 truncate text-base">{item.title}</CardTitle>
              <Badge size="sm" variant={stateVariant(item.state)}>
                {nativeAgentStateLabel(item.state)}
              </Badge>
            </div>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{item.projectName}</span>
              <span aria-hidden="true">·</span>
              <span>{item.provider}</span>
              {item.model ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{item.model}</span>
                </>
              ) : null}
              <span aria-hidden="true">·</span>
              <span>{item.kind}</span>
            </CardDescription>
            <p className="mt-3 text-sm text-foreground/80">{item.summary}</p>
            {item.durableCard?.imageUrl ? (
              <img
                alt={item.durableCard.title ?? "Agent update"}
                className="mt-3 max-h-80 w-full rounded-lg border border-border/70 object-contain"
                src={item.durableCard.imageUrl}
              />
            ) : null}
            {item.durableCard?.actions && item.durableCard.actions.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {item.durableCard.actions.map((action) =>
                  action.url && /^https?:\/\//i.test(action.url) ? (
                    <Button
                      key={`${action.label}-${action.url}`}
                      render={<a href={action.url} rel="noreferrer" target="_blank" />}
                      size="sm"
                      variant="outline"
                    >
                      {action.label}
                    </Button>
                  ) : action.file ? (
                    <Button
                      key={`${action.label}-${action.file}`}
                      onClick={() => onAction(action)}
                      size="sm"
                      variant="outline"
                    >
                      {action.reveal ? "Reveal" : action.label}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground" key={action.label}>
                      {action.label}
                    </span>
                  ),
                )}
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge size="sm" variant={levelVariant(item.level)}>
                {item.level}
              </Badge>
              {item.tags.map((tag) => (
                <Badge key={tag} size="sm" variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
          <Button
            aria-label={`Dismiss ${item.title}`}
            className="shrink-0"
            onClick={() => onDismiss(item.id)}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4 border-t border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Clock3Icon className="size-3.5 shrink-0" />
            {formatRelativeTimeLabel(item.updatedAt) || "Unknown time"}
          </span>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{item.branch ?? "No branch"}</span>
          </span>
          {item.workspaceRoot ? (
            <span className="max-w-full truncate font-mono" title={item.workspaceRoot}>
              {item.workspaceRoot}
            </span>
          ) : null}
          {item.worktreePath ? (
            <span className="max-w-full truncate font-mono">{item.worktreePath}</span>
          ) : null}
        </div>
        {item.threadId ? (
          <Button className="shrink-0" onClick={onOpen} size="sm" variant="outline">
            {item.chatLabel ?? "Open chat"}
          </Button>
        ) : null}
      </CardPanel>
    </Card>
  );
}

export function AgentFeed() {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const dismissFeedCard = useAtomCommand(agentDashboardEnvironment.dismissFeedCard, {
    reportFailure: false,
  });
  const clearFeed = useAtomCommand(agentDashboardEnvironment.clearFeed, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() =>
    readDismissedFeedIds(),
  );
  const records = useMemo(() => {
    if (dashboardSnapshot.data === null) return buildNativeAgentFeed(projects, threads);
    const environmentId = dashboardSnapshot.environmentId ?? "native";
    return mergeNativeAgentFeedRecords(
      buildNativeAgentFeedFromSnapshot(dashboardSnapshot.data).map((record) => ({
        ...record,
        environmentId,
      })),
      buildNativeAgentFeedFromDurableCards(
        dashboardSnapshot.data.externalFeed,
        environmentId,
        projects,
        threads,
      ),
    );
  }, [dashboardSnapshot.data, dashboardSnapshot.environmentId, projects, threads]);
  const visibleRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return records
      .filter((record) => !dismissedIds.has(record.id))
      .filter((record) => levelFilter === "all" || record.level === levelFilter)
      .filter((record) => agentFilter === "all" || record.provider === agentFilter)
      .filter((record) => {
        if (!normalizedQuery) return true;
        return [
          record.title,
          record.summary,
          record.projectName,
          record.provider,
          record.model,
          record.kind,
          ...record.tags,
          record.branch ?? "",
          record.workspaceRoot,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      })
      .toSorted(compareDashboardRecency);
  }, [agentFilter, dismissedIds, levelFilter, query, records]);

  const agents = useMemo(
    () =>
      [
        "all",
        ...new Set(records.map((record) => record.provider).filter(Boolean)).values(),
      ].toSorted(),
    [records],
  );

  const counts = useMemo(
    () => ({
      updates: records.length,
      agents: new Set(records.map((record) => record.provider)).size,
      attention: records.filter((record) => record.level === "warn" || record.level === "error")
        .length,
      success: records.filter((record) => record.level === "success").length,
    }),
    [records],
  );

  const dismiss = (id: string) => {
    const durableCard = records.find((record) => record.id === id)?.durableCard;
    if (durableCard && dashboardSnapshot.environmentId) {
      void dismissFeedCard({
        environmentId: dashboardSnapshot.environmentId,
        input: { id: durableCard.id },
      }).then(() => dashboardSnapshot.refresh());
      setDismissedIds((current) => new Set([...current, id]));
      return;
    }
    setDismissedIds((current) => {
      const next = new Set(current);
      next.add(id);
      try {
        window.localStorage.setItem(FEED_DISMISSED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // A private browsing context can reject localStorage. The in-memory dismissal still works.
      }
      return next;
    });
  };

  const dismissAll = () => {
    if (dashboardSnapshot.data !== null && dashboardSnapshot.environmentId) {
      void clearFeed({
        environmentId: dashboardSnapshot.environmentId,
        input: {},
      }).then(() => dashboardSnapshot.refresh());
      setDismissedIds(new Set(records.map((record) => record.id)));
      return;
    }
    const next = new Set(dismissedIds);
    for (const record of records) next.add(record.id);
    setDismissedIds(next);
    try {
      window.localStorage.setItem(FEED_DISMISSED_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Keep the in-memory clear when storage is unavailable.
    }
  };

  const openFeedAction = (action: AgentDashboardFeedAction, record: (typeof records)[number]) => {
    if (!action.file) return;
    const fileUrl = safeFeedFileUrl(record.workspaceRoot, action.file);
    if (!fileUrl) return;
    void readLocalApi()?.shell.openExternal(fileUrl);
  };

  return (
    <AgentDashboardPageShell
      actions={
        <Button
          aria-label="Refresh agent feed"
          disabled={dashboardSnapshot.isPending}
          onClick={dashboardSnapshot.refresh}
          size="icon-sm"
          variant="outline"
        >
          <RefreshCwIcon className={dashboardSnapshot.isPending ? "animate-spin" : undefined} />
        </Button>
      }
      title="Agent Feed"
      description="A live, native view of the agents currently known to T3 Code, ordered with the most recent activity first."
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardPanel className="flex items-center gap-3 p-4">
            <RadioIcon className="size-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Updates</p>
              <p className="mt-1 text-lg font-semibold">{counts.updates}</p>
            </div>
          </CardPanel>
        </Card>
        <Card>
          <CardPanel className="flex items-center gap-3 p-4">
            <BotIcon className="size-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Agents</p>
              <p className="mt-1 text-lg font-semibold">{counts.agents}</p>
            </div>
          </CardPanel>
        </Card>
        <Card>
          <CardPanel className="flex items-center gap-3 p-4">
            {counts.attention > 0 ? (
              <CircleAlertIcon className="size-4 text-warning" />
            ) : (
              <CheckCircle2Icon className="size-4 text-success" />
            )}
            <div>
              <p className="text-xs text-muted-foreground">Attention</p>
              <p className="mt-1 text-lg font-semibold">{counts.attention}</p>
            </div>
          </CardPanel>
        </Card>
        <Card>
          <CardPanel className="flex items-center gap-3 p-4">
            <CheckCircle2Icon className="size-4 text-success" />
            <div>
              <p className="text-xs text-muted-foreground">Success</p>
              <p className="mt-1 text-lg font-semibold">{counts.success}</p>
            </div>
          </CardPanel>
        </Card>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search agent feed"
            className="pl-9"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search agents, projects, or branches"
            value={query}
          />
        </div>
        <Select value={levelFilter} onValueChange={(value) => value && setLevelFilter(value)}>
          <SelectTrigger aria-label="Filter feed by level" className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="warn">Warning</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectPopup>
        </Select>
        <Select value={agentFilter} onValueChange={(value) => value && setAgentFilter(value)}>
          <SelectTrigger aria-label="Filter feed by agent" className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {agents.map((agent) => (
              <SelectItem key={agent} value={agent}>
                {agent === "all" ? "All agents" : agent}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button disabled={records.length === 0} onClick={dismissAll} size="sm" variant="ghost">
          <XIcon />
          Clear view
        </Button>
      </div>

      {visibleRecords.length > 0 ? (
        <div className="grid gap-3">
          {visibleRecords.map((item) => (
            <AgentFeedCard
              item={item}
              key={item.id}
              onAction={(action) => openFeedAction(action, item)}
              onDismiss={dismiss}
              onOpen={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: {
                    environmentId: item.environmentId,
                    threadId: item.threadId,
                  },
                })
              }
            />
          ))}
        </div>
      ) : (
        <Empty className="min-h-72 border border-dashed border-border/70 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>{records.length === 0 ? "No agents yet" : "No matching agents"}</EmptyTitle>
            <EmptyDescription>
              {records.length === 0
                ? "Start a thread in T3 Code and its native activity will appear here."
                : "Try a different search or state filter."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AgentDashboardPageShell>
  );
}

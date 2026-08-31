import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentDashboardFeedAction } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  InfoIcon,
  LoaderIcon,
  MessageCircleQuestionIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildAgentDashboardUpdateRecords,
  safeDashboardUpdateFileUrl,
  type NativeAgentFeedItem,
} from "../agentDashboardPages";
import { readLocalApi } from "../localApi";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { useProjects, useThreadShells } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { stackedThreadToast, toastManager } from "./ui/toast";

const COLLAPSED_UPDATE_COUNT = 5;

function updateLevelPresentation(level: NativeAgentFeedItem["level"]) {
  switch (level) {
    case "error":
      return { label: "Error", variant: "error", icon: CircleAlertIcon } as const;
    case "warn":
      return { label: "Needs attention", variant: "warning", icon: TriangleAlertIcon } as const;
    case "success":
      return { label: "Completed", variant: "success", icon: CheckCircle2Icon } as const;
    case "info":
      return { label: "Update", variant: "outline", icon: InfoIcon } as const;
  }
}

function DashboardUpdateRow({
  item,
  dismissing,
  onAsk,
  onDismiss,
  onOpenAction,
  onOpenThread,
}: {
  readonly item: NativeAgentFeedItem;
  readonly dismissing: boolean;
  readonly onAsk: (item: NativeAgentFeedItem) => void;
  readonly onDismiss: (item: NativeAgentFeedItem) => void;
  readonly onOpenAction: (action: AgentDashboardFeedAction, item: NativeAgentFeedItem) => void;
  readonly onOpenThread: (environmentId: string, threadId: string) => void;
}) {
  const presentation = updateLevelPresentation(item.level);
  const StatusIcon = presentation.icon;
  const relativeTime = formatRelativeTimeLabel(item.updatedAt);

  return (
    <div className="border-t border-border/60 px-3 py-3 first:border-t-0 sm:px-4">
      <div className="flex min-w-0 items-start gap-3">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground",
            item.level === "error" && "border-destructive/30 bg-destructive/8 text-destructive",
            item.level === "warn" && "border-warning/30 bg-warning/10 text-warning-foreground",
            item.level === "success" && "border-success/30 bg-success/10 text-success",
          )}
        >
          <StatusIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-sm font-semibold">{item.title}</p>
            <Badge size="sm" variant={presentation.variant}>
              {presentation.label}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-foreground/80">{item.summary}</p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">
            {item.projectName} · {item.provider}
            {relativeTime ? ` · ${relativeTime}` : ""}
          </p>

          {item.durableCard?.imageUrl ? (
            <img
              alt={item.durableCard.title ?? "Agent update"}
              className="mt-3 max-h-44 w-full rounded-lg border border-border/70 object-contain"
              src={item.durableCard.imageUrl}
            />
          ) : null}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {item.durableCard?.actions?.map((action) =>
              action.url && /^https?:\/\//i.test(action.url) ? (
                <Button
                  key={`${action.label}-${action.url}`}
                  render={<a href={action.url} rel="noreferrer" target="_blank" />}
                  size="xs"
                  variant="outline"
                >
                  {action.label}
                  <ArrowUpRightIcon />
                </Button>
              ) : action.file ? (
                <Button
                  key={`${action.label}-${action.file}`}
                  onClick={() => onOpenAction(action, item)}
                  size="xs"
                  variant="outline"
                >
                  {action.reveal ? "Reveal" : action.label}
                </Button>
              ) : null,
            )}
            <Button onClick={() => onAsk(item)} size="xs" variant="ghost">
              <MessageCircleQuestionIcon />
              Ask
            </Button>
            {item.threadId ? (
              <Button
                onClick={() => onOpenThread(item.environmentId, item.threadId)}
                size="xs"
                variant="ghost"
              >
                {item.chatLabel ?? "Open session"}
                <ArrowUpRightIcon />
              </Button>
            ) : null}
          </div>
        </div>
        <Button
          aria-label={`Dismiss update ${item.title}`}
          disabled={dismissing}
          onClick={() => onDismiss(item)}
          size="icon-xs"
          variant="ghost"
        >
          {dismissing ? <LoaderIcon className="animate-spin" /> : <XIcon />}
        </Button>
      </div>
    </div>
  );
}

export function AgentDashboardUpdates({
  onAsk,
  onOpenThread,
}: {
  readonly onAsk: (item: NativeAgentFeedItem) => void;
  readonly onOpenThread: (environmentId: string, threadId: string) => void;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const dismissFeedCard = useAtomCommand(agentDashboardEnvironment.dismissFeedCard, {
    reportFailure: false,
  });
  const [expanded, setExpanded] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const updates = useMemo(
    () =>
      buildAgentDashboardUpdateRecords(
        dashboardSnapshot.data,
        dashboardSnapshot.environmentId,
        projects,
        threads,
      ),
    [dashboardSnapshot.data, dashboardSnapshot.environmentId, projects, threads],
  );
  const visibleUpdates = expanded ? updates : updates.slice(0, COLLAPSED_UPDATE_COUNT);

  const dismissUpdate = async (item: NativeAgentFeedItem) => {
    if (!item.durableCard || dashboardSnapshot.environmentId === null || dismissingId !== null) {
      return;
    }
    setDismissingId(item.id);
    try {
      const result = await dismissFeedCard({
        environmentId: dashboardSnapshot.environmentId,
        input: { id: item.durableCard.id },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Update could not be dismissed",
              description: error instanceof Error ? error.message : "Refresh and try again.",
            }),
          );
        }
        return;
      }
      await dashboardSnapshot.refresh();
    } finally {
      setDismissingId(null);
    }
  };

  const openAction = (action: AgentDashboardFeedAction, item: NativeAgentFeedItem) => {
    if (!action.file) return;
    const fileUrl = safeDashboardUpdateFileUrl(item.workspaceRoot, action.file);
    if (!fileUrl) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "File is outside this repository",
          description: "Only files inside the update's repository can be opened here.",
        }),
      );
      return;
    }
    void readLocalApi()?.shell.openExternal(fileUrl);
  };

  return (
    <Card className="overflow-hidden" id="dashboard-updates">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60 p-3 sm:p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Updates</CardTitle>
            {updates.length > 0 ? (
              <Badge size="sm" variant="outline">
                {updates.length}
              </Badge>
            ) : null}
          </div>
          <CardDescription className="mt-1">
            Results, handoffs, and files delivered by agents.
          </CardDescription>
        </div>
        <Button
          aria-label="Refresh agent updates"
          disabled={dashboardSnapshot.isPending}
          onClick={dashboardSnapshot.refresh}
          size="xs"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(dashboardSnapshot.isPending && "animate-spin")} />
          Refresh
        </Button>
      </CardHeader>
      <CardPanel className="p-0">
        {dashboardSnapshot.isPending && dashboardSnapshot.data === null ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-4 w-52" />
            <Skeleton className="h-3 w-full max-w-xl" />
          </div>
        ) : updates.length === 0 ? (
          <div className="flex min-h-20 items-center gap-3 px-4 py-4">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <CheckCircle2Icon className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">No delivered updates</p>
              <p className="mt-1 text-xs text-muted-foreground">
                New agent handoffs and actionable results will appear here.
              </p>
            </div>
          </div>
        ) : (
          <>
            {visibleUpdates.map((item) => (
              <DashboardUpdateRow
                dismissing={dismissingId === item.id}
                item={item}
                key={item.id}
                onAsk={onAsk}
                onDismiss={(update) => void dismissUpdate(update)}
                onOpenAction={openAction}
                onOpenThread={onOpenThread}
              />
            ))}
            {updates.length > COLLAPSED_UPDATE_COUNT ? (
              <Button
                className="h-9 w-full rounded-none border-x-0 border-b-0"
                onClick={() => setExpanded((current) => !current)}
                variant="ghost"
              >
                {expanded
                  ? "Show fewer updates"
                  : `Show ${updates.length - visibleUpdates.length} more`}
                <ChevronDownIcon className={cn("transition-transform", expanded && "rotate-180")} />
              </Button>
            ) : null}
          </>
        )}
      </CardPanel>
    </Card>
  );
}

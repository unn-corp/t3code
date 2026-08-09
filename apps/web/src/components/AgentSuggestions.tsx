import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  LightbulbIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildNativeSuggestions,
  buildNativeReviewSuggestionsFromSnapshot,
  buildNativeSuggestionsFromSnapshot,
} from "../agentDashboardPages";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { useAtomCommand } from "../state/use-atom-command";
import { useProjects, useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";

const SUGGESTIONS_DISMISSED_STORAGE_KEY = "t3.agent-dashboard.suggestions.dismissed";
const SUGGESTIONS_BLOCKED_STORAGE_KEY = "t3.agent-dashboard.suggestions.blocked";

function readDismissedSuggestionIds(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(SUGGESTIONS_DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? new Set(value)
      : new Set();
  } catch {
    return new Set();
  }
}

function readStoredIds(key: string): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? new Set(value)
      : new Set();
  } catch {
    return new Set();
  }
}

function suggestionIcon(
  kind:
    | "needs-input"
    | "error"
    | "stale-agent"
    | "review-changes"
    | "sync-branch"
    | "respond-to-thread"
    | "review-plan"
    | "inspect-error",
) {
  switch (kind) {
    case "needs-input":
      return <AlertCircleIcon className="size-4 text-warning" />;
    case "error":
      return <AlertCircleIcon className="size-4 text-destructive" />;
    case "stale-agent":
      return <CheckCircle2Icon className="size-4 text-muted-foreground" />;
    case "review-changes":
    case "sync-branch":
      return <AlertCircleIcon className="size-4 text-warning" />;
    case "respond-to-thread":
    case "review-plan":
      return <LightbulbIcon className="size-4 text-warning" />;
    case "inspect-error":
      return <AlertCircleIcon className="size-4 text-destructive" />;
  }
}

export function AgentSuggestions() {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const reviewSuggestion = useAtomCommand(agentDashboardEnvironment.reviewSuggestion, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() =>
    readDismissedSuggestionIds(),
  );
  const [blockedIds, setBlockedIds] = useState<ReadonlySet<string>>(() =>
    readStoredIds(SUGGESTIONS_BLOCKED_STORAGE_KEY),
  );
  const records = useMemo(() => {
    if (
      dashboardSnapshot.data !== null &&
      dashboardSnapshot.data.reviewSuggestions.length > 0 &&
      dashboardSnapshot.environmentId
    ) {
      return buildNativeReviewSuggestionsFromSnapshot(
        dashboardSnapshot.data,
        dashboardSnapshot.environmentId,
      );
    }
    const nativeSuggestions =
      dashboardSnapshot.data !== null && dashboardSnapshot.data.suggestions.length > 0
        ? buildNativeSuggestionsFromSnapshot(dashboardSnapshot.data).map((suggestion) => ({
            ...suggestion,
            environmentId: dashboardSnapshot.environmentId ?? suggestion.environmentId,
          }))
        : buildNativeSuggestions(projects, threads);
    return nativeSuggestions;
  }, [dashboardSnapshot.data, dashboardSnapshot.environmentId, projects, threads]);
  const suggestions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return records.filter((item) => {
      if (dismissedIds.has(item.id) || blockedIds.has(item.id)) return false;
      if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
      if (!needle) return true;
      return [item.title, item.description, item.projectName, item.category, ...item.evidence]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [blockedIds, categoryFilter, dismissedIds, query, records]);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string | null>(null);
  const selectedSuggestion =
    records.find((suggestion) => suggestion.id === selectedSuggestionId) ?? null;

  const dismiss = (id: string) => {
    const suggestion = records.find((item) => item.id === id);
    if (suggestion?.durableSuggestion && dashboardSnapshot.environmentId) {
      void reviewSuggestion({
        environmentId: dashboardSnapshot.environmentId,
        input: { id, action: "dismiss" },
      }).then(() => dashboardSnapshot.refresh());
    }
    setDismissedIds((current) => {
      const next = new Set(current);
      next.add(id);
      try {
        window.localStorage.setItem(SUGGESTIONS_DISMISSED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // A private browsing context can reject localStorage. Keep this dismissal in memory.
      }
      return next;
    });
    setSelectedSuggestionId(null);
  };

  const block = (id: string) => {
    const suggestion = records.find((item) => item.id === id);
    if (suggestion?.durableSuggestion && dashboardSnapshot.environmentId) {
      void reviewSuggestion({
        environmentId: dashboardSnapshot.environmentId,
        input: { id, action: "block" },
      }).then(() => dashboardSnapshot.refresh());
    }
    setBlockedIds((current) => {
      const next = new Set(current);
      next.add(id);
      try {
        window.localStorage.setItem(SUGGESTIONS_BLOCKED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Keep the in-memory block when storage is unavailable.
      }
      return next;
    });
    setSelectedSuggestionId(null);
  };

  const openSuggestionThread = (threadId: string, environmentId: string) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  return (
    <AgentDashboardPageShell
      actions={
        <Button
          aria-label="Refresh suggestions"
          disabled={dashboardSnapshot.isPending}
          onClick={dashboardSnapshot.refresh}
          size="icon-sm"
          variant="outline"
        >
          <RefreshCwIcon className={dashboardSnapshot.isPending ? "animate-spin" : undefined} />
        </Button>
      }
      title="Suggestions"
      description="Repository review findings migrated into T3 Code, ordered newest first."
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          aria-label="Search suggestions"
          className="min-w-0 flex-1"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search suggestions, repositories, or evidence"
          value={query}
        />
        <Select value={categoryFilter} onValueChange={(value) => value && setCategoryFilter(value)}>
          <SelectTrigger aria-label="Filter suggestions by category" className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="all">All categories</SelectItem>
            <SelectItem value="bug">Bugs</SelectItem>
            <SelectItem value="feature">Features</SelectItem>
            <SelectItem value="gap">Gaps</SelectItem>
            <SelectItem value="insight">Insights</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {suggestions.length > 0 ? (
        <div className="grid gap-3">
          {suggestions.map((suggestion) => (
            <Card key={suggestion.id}>
              <CardHeader className="gap-3 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                    <LightbulbIcon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">{suggestion.title}</CardTitle>
                      <Badge size="sm" variant="outline">
                        {suggestion.category}
                      </Badge>
                      <Badge
                        size="sm"
                        variant={suggestion.priority === "high" ? "warning" : "outline"}
                      >
                        {suggestion.priority === "high" ? "Priority" : "Suggestion"}
                      </Badge>
                      <Badge size="sm" variant="outline">
                        {suggestion.confidence} confidence
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">{suggestion.description}</CardDescription>
                  </div>
                  <Button
                    aria-label={`Dismiss ${suggestion.title}`}
                    className="shrink-0"
                    onClick={() => dismiss(suggestion.id)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                </div>
              </CardHeader>
              <CardPanel className="flex flex-col gap-4 border-t border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  {suggestionIcon(suggestion.kind)}
                  <span>{suggestion.projectName}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatRelativeTimeLabel(suggestion.updatedAt) || "Unknown time"}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="shrink-0"
                    onClick={() => setSelectedSuggestionId(suggestion.id)}
                    size="sm"
                    variant="outline"
                  >
                    View finding
                  </Button>
                  {suggestion.threadId ? (
                    <Button
                      className="shrink-0"
                      onClick={() =>
                        openSuggestionThread(suggestion.threadId!, suggestion.environmentId)
                      }
                      size="sm"
                      variant="outline"
                    >
                      Open agent
                    </Button>
                  ) : null}
                </div>
              </CardPanel>
            </Card>
          ))}
        </div>
      ) : (
        <Empty className="min-h-72 border border-dashed border-border/70 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2Icon />
            </EmptyMedia>
            <EmptyTitle>No suggestions right now</EmptyTitle>
            <EmptyDescription>
              {records.length === 0
                ? "T3 Code will surface a native suggestion when an agent needs input, reports an error, or finds a repository change to review."
                : "Try a different search or category filter."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <Dialog
        open={selectedSuggestion !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedSuggestionId(null);
        }}
      >
        {selectedSuggestion ? (
          <DialogPopup className="max-w-2xl" showCloseButton>
            <DialogHeader>
              <DialogTitle>{selectedSuggestion.title}</DialogTitle>
              <DialogDescription>{selectedSuggestion.description}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-5">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{selectedSuggestion.category}</Badge>
                <Badge variant="outline">{selectedSuggestion.confidence} confidence</Badge>
                <Badge variant={selectedSuggestion.priority === "high" ? "warning" : "outline"}>
                  {selectedSuggestion.impact} impact
                </Badge>
                <Badge variant="outline">{selectedSuggestion.projectName}</Badge>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Finding</p>
                <p className="mt-2 text-sm">{selectedSuggestion.report}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Evidence</p>
                <ul className="mt-2 grid gap-1 text-sm">
                  {selectedSuggestion.evidence.map((evidence) => (
                    <li key={evidence}>{evidence}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/45 p-3">
                <p className="text-xs font-medium text-muted-foreground">Recommended next step</p>
                <p className="mt-1 text-sm">{selectedSuggestion.nextStep}</p>
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button onClick={() => block(selectedSuggestion.id)} variant="ghost">
                Block
              </Button>
              <Button onClick={() => dismiss(selectedSuggestion.id)} variant="outline">
                Dismiss
              </Button>
              {selectedSuggestion.threadId ? (
                <Button
                  onClick={() =>
                    openSuggestionThread(
                      selectedSuggestion.threadId!,
                      selectedSuggestion.environmentId,
                    )
                  }
                >
                  Open agent
                </Button>
              ) : null}
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>
    </AgentDashboardPageShell>
  );
}

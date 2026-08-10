import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentDashboardDispositionAction,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  GithubIcon,
  LightbulbIcon,
  LoaderIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  buildSuggestionWorkPrompt,
  buildNativeReviewSuggestionsFromSnapshot,
  type NativeSuggestion,
} from "../agentDashboardPages";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { usePrimarySettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import { resolveAppModelSelectionState } from "../modelSelection";
import { newMessageId, newThreadId } from "../lib/utils";
import { waitForStartedServerThread } from "./ChatView.logic";
import { usePrimaryEnvironment } from "../state/environments";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useProjects } from "../state/entities";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { stackedThreadToast, toastManager } from "./ui/toast";
import ChatMarkdown from "./ChatMarkdown";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";

const SUGGESTIONS_DISMISSED_STORAGE_KEY = "t3.agent-dashboard.suggestions.dismissed";
const SUGGESTIONS_BLOCKED_STORAGE_KEY = "t3.agent-dashboard.suggestions.blocked";

const canonicalFindingIsHidden = (suggestion: NativeSuggestion): boolean => {
  if (suggestion.findingState === "dismissed" || suggestion.findingState === "blocked") {
    return true;
  }
  return (
    suggestion.findingState === "snoozed" &&
    suggestion.findingSnoozeUntil !== null &&
    suggestion.findingSnoozeUntil !== undefined &&
    Date.parse(suggestion.findingSnoozeUntil) > Date.now()
  );
};

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

function normalizeRepositoryPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return "";
  const normalized = trimmed.replace(/[/\\]+$/, "");
  return normalized.length > 0 ? normalized : "/";
}

function findSuggestionProject(
  projects: ReadonlyArray<EnvironmentProject>,
  suggestion: NativeSuggestion,
  environmentId: string,
): EnvironmentProject | null {
  const repositoryPath = normalizeRepositoryPath(suggestion.repositoryPath);
  const pathMatch = projects.find(
    (project) =>
      project.environmentId === environmentId &&
      repositoryPath.length > 0 &&
      normalizeRepositoryPath(project.workspaceRoot) === repositoryPath,
  );
  return (
    pathMatch ??
    projects.find(
      (project) => project.environmentId === environmentId && project.id === suggestion.projectId,
    ) ??
    null
  );
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
  const settings = usePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const applyFindingAction = useAtomCommand(agentDashboardEnvironment.applyFindingAction, {
    reportFailure: false,
  });
  const reviewSuggestion = useAtomCommand(agentDashboardEnvironment.reviewSuggestion, {
    reportFailure: false,
  });
  const runInvestigationCommand = useAtomCommand(agentDashboardEnvironment.runInvestigation, {
    reportFailure: false,
  });
  const createGithubIssueCommand = useAtomCommand(agentDashboardEnvironment.createGithubIssue, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [startingSuggestionId, setStartingSuggestionId] = useState<string | null>(null);
  const [creatingIssueId, setCreatingIssueId] = useState<string | null>(null);
  const [isRunningInvestigation, setIsRunningInvestigation] = useState(false);
  const [updatingFindingId, setUpdatingFindingId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() =>
    readDismissedSuggestionIds(),
  );
  const [blockedIds, setBlockedIds] = useState<ReadonlySet<string>>(() =>
    readStoredIds(SUGGESTIONS_BLOCKED_STORAGE_KEY),
  );
  const records = useMemo(() => {
    if (dashboardSnapshot.data === null || !dashboardSnapshot.environmentId) return [];
    return buildNativeReviewSuggestionsFromSnapshot(
      dashboardSnapshot.data,
      dashboardSnapshot.environmentId,
    );
  }, [dashboardSnapshot.data, dashboardSnapshot.environmentId]);
  const suggestions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return records.filter((item) => {
      if (canonicalFindingIsHidden(item)) return false;
      if (dismissedIds.has(item.id) || blockedIds.has(item.id)) return false;
      if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
      if (!needle) return true;
      return [item.title, item.description, item.projectName, item.category, ...item.evidence]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [blockedIds, categoryFilter, dismissedIds, query, records]);
  const hasActionableRecords = records.some(
    (suggestion) =>
      !canonicalFindingIsHidden(suggestion) &&
      !dismissedIds.has(suggestion.id) &&
      !blockedIds.has(suggestion.id),
  );
  const showInvestigationEmptyState = Boolean(
    dashboardSnapshot.data !== null && !hasActionableRecords && dashboardSnapshot.environmentId,
  );
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string | null>(null);
  const selectedSuggestion =
    records.find((suggestion) => suggestion.id === selectedSuggestionId) ?? null;

  const applyCanonicalDisposition = useCallback(
    async (
      suggestion: NativeSuggestion,
      action: AgentDashboardDispositionAction,
      extra: { readonly assignee?: string; readonly note?: string } = {},
    ): Promise<boolean> => {
      const environmentId = dashboardSnapshot.environmentId;
      if (!suggestion.findingId || !environmentId) return false;
      setUpdatingFindingId(suggestion.findingId);
      try {
        const result = await applyFindingAction({
          environmentId,
          input: {
            id: suggestion.findingId,
            action,
            ...(extra.assignee ? { assignee: extra.assignee } : {}),
            ...(extra.note ? { note: extra.note } : {}),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not update finding",
                description:
                  error instanceof Error ? error.message : "The finding mutation failed.",
              }),
            );
          }
          return false;
        }
        if (!result.value.ok || result.value.outcome === "not-found") {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Finding was not updated",
              description: result.value.message ?? "The finding no longer exists.",
            }),
          );
          return false;
        }
        await dashboardSnapshot.refresh();
        return true;
      } finally {
        setUpdatingFindingId(null);
      }
    },
    [applyFindingAction, dashboardSnapshot],
  );

  const dismiss = async (id: string) => {
    const suggestion = records.find((item) => item.id === id);
    if (suggestion?.findingId) {
      if (await applyCanonicalDisposition(suggestion, "dismiss")) setSelectedSuggestionId(null);
      return;
    }
    if (suggestion?.durableSuggestion && dashboardSnapshot.environmentId) {
      const result = await reviewSuggestion({
        environmentId: dashboardSnapshot.environmentId,
        input: { id, action: "dismiss" },
      });
      if (result._tag === "Success" && result.value.ok) {
        await dashboardSnapshot.refresh();
      } else {
        return;
      }
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

  const block = async (id: string) => {
    const suggestion = records.find((item) => item.id === id);
    if (suggestion?.findingId) {
      if (await applyCanonicalDisposition(suggestion, "block")) setSelectedSuggestionId(null);
      return;
    }
    if (suggestion?.durableSuggestion && dashboardSnapshot.environmentId) {
      const result = await reviewSuggestion({
        environmentId: dashboardSnapshot.environmentId,
        input: { id, action: "block" },
      });
      if (result._tag === "Success" && result.value.ok) {
        await dashboardSnapshot.refresh();
      } else {
        return;
      }
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

  const acknowledge = (suggestion: NativeSuggestion) =>
    void applyCanonicalDisposition(suggestion, "acknowledge");
  const snooze = (suggestion: NativeSuggestion) =>
    void applyCanonicalDisposition(suggestion, "snooze");
  const assign = (suggestion: NativeSuggestion) =>
    void applyCanonicalDisposition(suggestion, "assign", {
      assignee: "dashboard",
      note: "Assigned from the T3 Code Agent Dashboard.",
    });
  const reopen = (suggestion: NativeSuggestion) =>
    void applyCanonicalDisposition(suggestion, "reopen");

  const openGithubIssue = useCallback(async (url: string) => {
    const localApi = readLocalApi();
    if (!localApi) return;
    try {
      await localApi.shell.openExternal(url);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open GitHub issue",
          description:
            error instanceof Error ? error.message : "The issue link could not be opened.",
        }),
      );
    }
  }, []);

  const runRepositoryInvestigation = useCallback(async () => {
    const environmentId = dashboardSnapshot.environmentId;
    if (!environmentId || isRunningInvestigation) return;
    setIsRunningInvestigation(true);
    try {
      const result = await runInvestigationCommand({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start investigation",
              description:
                error instanceof Error
                  ? error.message
                  : "The repository investigation could not be started.",
            }),
          );
        }
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Investigation started",
          description: "The two-hour repository review is running in the background.",
        }),
      );
      dashboardSnapshot.refresh();
    } finally {
      setIsRunningInvestigation(false);
    }
  }, [dashboardSnapshot, isRunningInvestigation, runInvestigationCommand]);

  const createGithubIssueForSuggestion = useCallback(
    async (suggestion: NativeSuggestion) => {
      if (suggestion.githubIssueUrl) {
        await openGithubIssue(suggestion.githubIssueUrl);
        return;
      }
      if (!suggestion.durableSuggestion?.repository.githubRepo) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "No GitHub repository detected",
            description: "This finding does not have a GitHub origin configured.",
          }),
        );
        return;
      }
      const environmentId = dashboardSnapshot.environmentId;
      if (!environmentId || creatingIssueId !== null) return;
      setCreatingIssueId(suggestion.id);
      try {
        const result = await createGithubIssueCommand({
          environmentId,
          input: { id: suggestion.legacySuggestionId ?? suggestion.id },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not create GitHub issue",
                description:
                  error instanceof Error ? error.message : "The GitHub issue could not be created.",
              }),
            );
          }
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "GitHub issue created",
            description: "The issue link is now attached to this finding.",
          }),
        );
        dashboardSnapshot.refresh();
      } finally {
        setCreatingIssueId(null);
      }
    },
    [createGithubIssueCommand, creatingIssueId, dashboardSnapshot, openGithubIssue],
  );

  const openSuggestionThread = (threadId: string, environmentId: string) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  const startSuggestionWork = useCallback(
    async (suggestion: NativeSuggestion) => {
      if (startingSuggestionId !== null) return;

      const environmentId =
        suggestion.environmentId !== "native"
          ? (suggestion.environmentId as EnvironmentId)
          : (dashboardSnapshot.environmentId ?? primaryEnvironment?.environmentId ?? null);
      if (!environmentId) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Connect an environment first",
            description: "The suggestion needs a T3 Code environment to start a work session.",
          }),
        );
        return;
      }

      const project = findSuggestionProject(projects, suggestion, environmentId);
      if (!project) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Add this repository to T3 Code first",
            description: `No project is configured for ${suggestion.repositoryPath || suggestion.projectName}.`,
          }),
        );
        return;
      }

      const modelSelection = resolveAppModelSelectionState(settings, serverProviders);
      if (modelSelection.model.trim().length === 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Enable an agent provider first",
            description: "Choose and authenticate a provider before starting suggestion work.",
          }),
        );
        return;
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = `Work on: ${suggestion.title}`.slice(0, 80);
      setStartingSuggestionId(suggestion.id);

      try {
        const result = await startThreadTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: buildSuggestionWorkPrompt(suggestion),
              attachments: [],
            },
            modelSelection,
            titleSeed: title,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: project.id,
                title,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
            createdAt,
          },
        });

        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not start suggestion work",
                description:
                  error instanceof Error
                    ? error.message
                    : "The suggestion work session could not be started.",
              }),
            );
          }
          return;
        }

        await waitForStartedServerThread(scopeThreadRef(environmentId, threadId));
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId },
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open suggestion work",
            description:
              error instanceof Error
                ? error.message
                : "The suggestion work session could not be opened.",
          }),
        );
      } finally {
        setStartingSuggestionId(null);
      }
    },
    [
      dashboardSnapshot.environmentId,
      navigate,
      primaryEnvironment?.environmentId,
      projects,
      serverProviders,
      settings,
      startThreadTurn,
      startingSuggestionId,
    ],
  );

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
                      {suggestion.findingState ? (
                        <Badge
                          size="sm"
                          variant={
                            suggestion.findingState === "open" ? "warning" : "outline"
                          }
                        >
                          {suggestion.findingState}
                        </Badge>
                      ) : null}
                    </div>
                    <CardDescription className="mt-1">
                      <ChatMarkdown
                        className="text-sm"
                        cwd={suggestion.repositoryPath || undefined}
                        text={suggestion.description}
                      />
                    </CardDescription>
                  </div>
                  <Button
                    aria-label={`Dismiss ${suggestion.title}`}
                    className="shrink-0"
                    onClick={() => void dismiss(suggestion.id)}
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
                  {suggestion.findingId ? (
                    <>
                      {suggestion.findingState !== "acknowledged" ? (
                        <Button
                          disabled={updatingFindingId !== null}
                          onClick={() => acknowledge(suggestion)}
                          size="sm"
                          variant="outline"
                        >
                          Acknowledge
                        </Button>
                      ) : null}
                      <Button
                        disabled={updatingFindingId !== null}
                        onClick={() => snooze(suggestion)}
                        size="sm"
                        variant="outline"
                      >
                        Snooze
                      </Button>
                      <Button
                        disabled={updatingFindingId !== null}
                        onClick={() => assign(suggestion)}
                        size="sm"
                        variant="outline"
                      >
                        Assign
                      </Button>
                      {suggestion.findingState !== "open" ? (
                        <Button
                          disabled={updatingFindingId !== null}
                          onClick={() => reopen(suggestion)}
                          size="sm"
                          variant="ghost"
                        >
                          Reopen
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  <Button
                    className="shrink-0"
                    disabled={startingSuggestionId !== null}
                    onClick={() => void startSuggestionWork(suggestion)}
                    size="sm"
                  >
                    {startingSuggestionId === suggestion.id ? (
                      <LoaderIcon className="animate-spin" />
                    ) : (
                      <BotIcon />
                    )}
                    {startingSuggestionId === suggestion.id ? "Starting work" : "Work on this"}
                  </Button>
                  <Button
                    className="shrink-0"
                    disabled={
                      creatingIssueId !== null ||
                      (!suggestion.githubIssueUrl &&
                        !suggestion.durableSuggestion?.repository.githubRepo)
                    }
                    onClick={() => void createGithubIssueForSuggestion(suggestion)}
                    size="sm"
                    title={
                      suggestion.githubIssueUrl ||
                      suggestion.durableSuggestion?.repository.githubRepo
                        ? undefined
                        : "No GitHub origin was detected"
                    }
                    variant="outline"
                  >
                    {creatingIssueId === suggestion.id ? (
                      <LoaderIcon className="animate-spin" />
                    ) : suggestion.githubIssueUrl ? (
                      <ExternalLinkIcon />
                    ) : (
                      <GithubIcon />
                    )}
                    {creatingIssueId === suggestion.id
                      ? "Creating issue"
                      : suggestion.githubIssueUrl
                        ? "Open GitHub issue"
                        : "Create GitHub issue"}
                  </Button>
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
              {dashboardSnapshot.data === null
                ? "Loading repository review findings."
                : hasActionableRecords
                  ? "Try a different search or category filter."
                  : "There are no pending repository review findings."}
            </EmptyDescription>
          </EmptyHeader>
          {showInvestigationEmptyState ? (
            <EmptyContent>
              <Button
                disabled={isRunningInvestigation}
                onClick={() => void runRepositoryInvestigation()}
                size="sm"
              >
                {isRunningInvestigation ? (
                  <LoaderIcon className="animate-spin" />
                ) : (
                  <FlaskConicalIcon />
                )}
                {isRunningInvestigation ? "Starting investigation" : "Run investigation"}
              </Button>
            </EmptyContent>
          ) : null}
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
              <DialogDescription render={<div />}>
                <ChatMarkdown
                  cwd={selectedSuggestion.repositoryPath || undefined}
                  text={selectedSuggestion.description}
                />
              </DialogDescription>
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
                <ChatMarkdown
                  className="mt-2"
                  cwd={selectedSuggestion.repositoryPath || undefined}
                  text={selectedSuggestion.report}
                />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Evidence</p>
                <ul className="mt-2 grid gap-1 text-sm">
                  {selectedSuggestion.evidence.map((evidence) => (
                    <li key={evidence}>
                      <ChatMarkdown
                        cwd={selectedSuggestion.repositoryPath || undefined}
                        text={evidence}
                      />
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/45 p-3">
                <p className="text-xs font-medium text-muted-foreground">Recommended next step</p>
                <ChatMarkdown
                  className="mt-1"
                  cwd={selectedSuggestion.repositoryPath || undefined}
                  text={selectedSuggestion.nextStep}
                />
              </div>
            </DialogPanel>
            <DialogFooter>
              {selectedSuggestion.findingId ? (
                <>
                  <Button
                    disabled={updatingFindingId !== null}
                    onClick={() => acknowledge(selectedSuggestion)}
                    variant="ghost"
                  >
                    Acknowledge
                  </Button>
                  <Button
                    disabled={updatingFindingId !== null}
                    onClick={() => snooze(selectedSuggestion)}
                    variant="ghost"
                  >
                    Snooze
                  </Button>
                  <Button
                    disabled={updatingFindingId !== null}
                    onClick={() => assign(selectedSuggestion)}
                    variant="ghost"
                  >
                    Assign
                  </Button>
                  {selectedSuggestion.findingState !== "open" ? (
                    <Button
                      disabled={updatingFindingId !== null}
                      onClick={() => reopen(selectedSuggestion)}
                      variant="ghost"
                    >
                      Reopen
                    </Button>
                  ) : null}
                </>
              ) : null}
              <Button onClick={() => void block(selectedSuggestion.id)} variant="ghost">
                Block
              </Button>
              <Button onClick={() => void dismiss(selectedSuggestion.id)} variant="outline">
                Dismiss
              </Button>
              {selectedSuggestion.githubIssueUrl ? (
                <Button
                  onClick={() => void openGithubIssue(selectedSuggestion.githubIssueUrl!)}
                  variant="outline"
                >
                  <ExternalLinkIcon />
                  Open GitHub issue
                </Button>
              ) : (
                <Button
                  disabled={
                    creatingIssueId !== null ||
                    !selectedSuggestion.durableSuggestion?.repository.githubRepo
                  }
                  onClick={() => void createGithubIssueForSuggestion(selectedSuggestion)}
                  variant="outline"
                  title={
                    selectedSuggestion.durableSuggestion?.repository.githubRepo
                      ? undefined
                      : "No GitHub origin was detected"
                  }
                >
                  {creatingIssueId === selectedSuggestion.id ? (
                    <LoaderIcon className="animate-spin" />
                  ) : (
                    <GithubIcon />
                  )}
                  {creatingIssueId === selectedSuggestion.id
                    ? "Creating issue"
                    : "Create GitHub issue"}
                </Button>
              )}
              <Button
                disabled={startingSuggestionId !== null}
                onClick={() => void startSuggestionWork(selectedSuggestion)}
              >
                {startingSuggestionId === selectedSuggestion.id ? (
                  <LoaderIcon className="animate-spin" />
                ) : (
                  <BotIcon />
                )}
                {startingSuggestionId === selectedSuggestion.id ? "Starting work" : "Work on this"}
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

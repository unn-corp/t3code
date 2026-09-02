import { useAtomValue } from "@effect/atom-react";
import type { AgentDashboardDispositionAction, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  ClockIcon,
  EyeIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  GithubIcon,
  LightbulbIcon,
  LoaderIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  buildSuggestionWorkPrompt,
  buildNativeReviewSuggestionsFromSnapshot,
  findDashboardProject,
  githubRepositoryForIdentity,
  suggestionWorkflowStatus,
  suggestionWorkModelSelection,
  suggestionWorktreeBaseBranch,
  type NativeSuggestion,
  type SuggestionWorkflowStatus,
} from "../agentDashboardPages";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { usePrimarySettings } from "../hooks/useSettings";
import { openProjectExternalLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import { resolveAppModelSelectionState } from "../modelSelection";
import { newMessageId, newThreadId, randomHex } from "../lib/utils";
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
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
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
import { AgentFindingActions } from "./AgentFindingActions";

const SUGGESTIONS_DISMISSED_STORAGE_KEY = "t3.agent-dashboard.suggestions.dismissed";
const SUGGESTIONS_BLOCKED_STORAGE_KEY = "t3.agent-dashboard.suggestions.blocked";

type SuggestionActionError =
  | {
      readonly action: "create-issue";
      readonly message: string;
      readonly suggestionId: string;
    }
  | {
      readonly action: "start-work";
      readonly message: string;
      readonly suggestionId: string;
    }
  | {
      readonly action: "link-work";
      readonly environmentId: EnvironmentId;
      readonly message: string;
      readonly projectId: EnvironmentProject["id"];
      readonly suggestionId: string;
      readonly threadId: ThreadId;
    };

const SUGGESTION_STATUS_ORDER = ["pending", "in-progress", "tracked", "done"] as const;

const SUGGESTION_STATUS_COPY = {
  pending: {
    description: "Ready to start or track in GitHub.",
    label: "Pending",
  },
  "in-progress": {
    description: "Active agent work, available from the sidebar.",
    label: "In progress",
  },
  tracked: {
    description: "Saved as GitHub issues for follow-up.",
    label: "Tracked",
  },
  done: {
    description: "Completed and available to reopen if more work is needed.",
    label: "Done",
  },
} as const satisfies Record<
  SuggestionWorkflowStatus,
  { readonly description: string; readonly label: string }
>;

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

const SUGGESTION_STATUS_CARD_CLASS = {
  pending: "border-l-4 border-l-warning/60",
  "in-progress": "border-info/40 border-l-4 border-l-info/70 bg-info/4",
  tracked: "border-success/40 border-l-4 border-l-success/70 bg-success/4",
  done: "border-success/40 border-l-4 border-l-success/70 bg-success/4",
} as const satisfies Record<SuggestionWorkflowStatus, string>;

function suggestionStatusIcon(status: SuggestionWorkflowStatus) {
  switch (status) {
    case "pending":
      return <LightbulbIcon className="size-4 text-warning" />;
    case "in-progress":
      return <BotIcon className="size-4 text-info" />;
    case "tracked":
      return <GithubIcon className="size-4 text-success" />;
    case "done":
      return <CheckCircle2Icon className="size-4 text-success" />;
  }
}

function suggestionStatusBadgeVariant(status: SuggestionWorkflowStatus) {
  switch (status) {
    case "pending":
      return "warning" as const;
    case "in-progress":
      return "info" as const;
    case "tracked":
      return "success" as const;
    case "done":
      return "success" as const;
  }
}

function githubIssueLabel(url: string | null): string {
  const issueNumber = url?.match(/\/issues\/([0-9]+)$/)?.[1];
  return issueNumber ? `Open issue #${issueNumber}` : "Open GitHub issue";
}

export function AgentSuggestions() {
  const navigate = useNavigate();
  const settings = usePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const applyFindingAction = useAtomCommand(agentDashboardEnvironment.applyFindingAction, {
    reportFailure: false,
  });
  const linkFindingThread = useAtomCommand(agentDashboardEnvironment.linkFindingThread, {
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
  const [actionError, setActionError] = useState<SuggestionActionError | null>(null);
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
  const suggestionGroups = useMemo(
    () =>
      SUGGESTION_STATUS_ORDER.map((status) => ({
        status,
        suggestions: suggestions.filter(
          (suggestion) => suggestionWorkflowStatus(suggestion) === status,
        ),
      })).filter((group) => group.suggestions.length > 0),
    [suggestions],
  );
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
  const selectedSuggestionStatus = selectedSuggestion
    ? suggestionWorkflowStatus(selectedSuggestion)
    : null;
  const selectedSuggestionActionError =
    selectedSuggestion && actionError?.suggestionId === selectedSuggestion.id ? actionError : null;

  const dashboardRepositoryForSuggestion = useCallback(
    (suggestion: NativeSuggestion) => {
      const repositoryPath = normalizeRepositoryPath(suggestion.repositoryPath);
      return dashboardSnapshot.data?.repositories.find(
        (candidate) =>
          String(candidate.projectId) === suggestion.projectId ||
          (repositoryPath.length > 0 &&
            normalizeRepositoryPath(candidate.workspaceRoot) === repositoryPath),
      );
    },
    [dashboardSnapshot.data?.repositories],
  );

  const githubRepositoryForSuggestion = useCallback(
    (suggestion: NativeSuggestion): string | null => {
      const environmentId =
        suggestion.environmentId === "native"
          ? dashboardSnapshot.environmentId
          : suggestion.environmentId;
      const project = environmentId
        ? findDashboardProject(
            projects,
            {
              projectId: suggestion.projectId,
              repositoryPath: suggestion.repositoryPath,
            },
            environmentId,
          )
        : null;
      const repository = dashboardRepositoryForSuggestion(suggestion);
      return (
        githubRepositoryForIdentity(repository?.repositoryIdentity) ??
        githubRepositoryForIdentity(project?.repositoryIdentity)
      );
    },
    [dashboardRepositoryForSuggestion, dashboardSnapshot.environmentId, projects],
  );

  const projectForSuggestion = useCallback(
    (suggestion: NativeSuggestion): EnvironmentProject | null => {
      const environmentId =
        suggestion.environmentId === "native"
          ? dashboardSnapshot.environmentId
          : suggestion.environmentId;
      return environmentId
        ? findDashboardProject(
            projects,
            {
              projectId: suggestion.projectId,
              repositoryPath: suggestion.repositoryPath,
            },
            environmentId,
          )
        : null;
    },
    [dashboardSnapshot.environmentId, projects],
  );

  const applyCanonicalDisposition = useCallback(
    async (
      suggestion: NativeSuggestion,
      action: AgentDashboardDispositionAction,
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

  const snooze = (suggestion: NativeSuggestion) =>
    void applyCanonicalDisposition(suggestion, "snooze");
  const complete = (suggestion: NativeSuggestion) =>
    void applyCanonicalDisposition(suggestion, "complete");
  const reopen = (suggestion: NativeSuggestion) =>
    void applyCanonicalDisposition(suggestion, "reopen");

  const openGithubIssue = useCallback(
    async (url: string, suggestion: NativeSuggestion) => {
      const localApi = readLocalApi();
      if (!localApi) return;
      try {
        await openProjectExternalLink(localApi.shell, url, projectForSuggestion(suggestion));
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
    },
    [projectForSuggestion],
  );

  const runRepositoryInvestigation = useCallback(async () => {
    const environmentId = dashboardSnapshot.environmentId;
    if (!environmentId || isRunningInvestigation) return;
    setIsRunningInvestigation(true);
    try {
      const result = await runInvestigationCommand({
        environmentId,
        input: {},
      });
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
          description: "The two-hour repository investigation is running in the background.",
        }),
      );
      dashboardSnapshot.refresh();
    } finally {
      setIsRunningInvestigation(false);
    }
  }, [dashboardSnapshot, isRunningInvestigation, runInvestigationCommand]);

  const linkSuggestionWork = useCallback(
    async (
      suggestion: NativeSuggestion,
      input: {
        readonly environmentId: EnvironmentId;
        readonly projectId: EnvironmentProject["id"];
        readonly threadId: ThreadId;
      },
    ): Promise<boolean> => {
      const findingId = suggestion.findingId ?? suggestion.legacySuggestionId;
      if (!findingId) {
        await dashboardSnapshot.refresh();
        return true;
      }

      const result = await linkFindingThread({
        environmentId: input.environmentId,
        input: {
          id: findingId,
          projectId: input.projectId,
          threadId: input.threadId,
        },
      });
      if (result._tag === "Failure" && isAtomCommandInterrupted(result)) return false;
      const failureMessage = (() => {
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          return error instanceof Error
            ? error.message
            : "The dashboard could not attach the running work to this suggestion.";
        }
        if (!result.value.ok || result.value.outcome === "not-found") {
          return (
            result.value.message ??
            "The dashboard could not attach the running work to this suggestion."
          );
        }
        return null;
      })();

      if (failureMessage) {
        setActionError({
          action: "link-work",
          environmentId: input.environmentId,
          message: failureMessage,
          projectId: input.projectId,
          suggestionId: suggestion.id,
          threadId: input.threadId,
        });
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Work started without a dashboard link",
            description: failureMessage,
          }),
        );
        return false;
      }

      setActionError((current) => (current?.suggestionId === suggestion.id ? null : current));
      await dashboardSnapshot.refresh();
      return true;
    },
    [dashboardSnapshot, linkFindingThread],
  );

  const createGithubIssueForSuggestion = useCallback(
    async (suggestion: NativeSuggestion) => {
      if (!githubRepositoryForSuggestion(suggestion)) return;
      if (suggestion.githubIssueUrl) {
        await openGithubIssue(suggestion.githubIssueUrl, suggestion);
        return;
      }
      const environmentId = dashboardSnapshot.environmentId;
      if (!environmentId || creatingIssueId !== null) return;
      setActionError((current) => (current?.suggestionId === suggestion.id ? null : current));
      setCreatingIssueId(suggestion.id);
      try {
        const result = await createGithubIssueCommand({
          environmentId,
          input: { id: suggestion.legacySuggestionId ?? suggestion.id },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            const message =
              error instanceof Error ? error.message : "The GitHub issue could not be created.";
            setActionError({
              action: "create-issue",
              message,
              suggestionId: suggestion.id,
            });
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not create GitHub issue",
                description: message,
              }),
            );
          }
          return;
        }
        if (!result.value.ok || result.value.outcome === "not-found") {
          const message = result.value.message ?? "The review suggestion could not be found.";
          setActionError({
            action: "create-issue",
            message,
            suggestionId: suggestion.id,
          });
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "GitHub issue was not created",
              description: message,
            }),
          );
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "GitHub issue created",
            description: "The issue link is now attached to this finding.",
          }),
        );
        setActionError((current) => (current?.suggestionId === suggestion.id ? null : current));
        await dashboardSnapshot.refresh();
      } finally {
        setCreatingIssueId(null);
      }
    },
    [
      createGithubIssueCommand,
      creatingIssueId,
      dashboardSnapshot,
      githubRepositoryForSuggestion,
      openGithubIssue,
    ],
  );

  const startSuggestionWork = useCallback(
    async (suggestion: NativeSuggestion) => {
      if (startingSuggestionId !== null) return;

      const showStartFailure = (title: string, message: string) => {
        setActionError({
          action: "start-work",
          message,
          suggestionId: suggestion.id,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title,
            description: message,
          }),
        );
      };

      const environmentId =
        suggestion.environmentId !== "native"
          ? (suggestion.environmentId as EnvironmentId)
          : (dashboardSnapshot.environmentId ?? primaryEnvironment?.environmentId ?? null);
      if (!environmentId) {
        showStartFailure(
          "Connect an environment first",
          "The suggestion needs a T3 Code environment to start a work session.",
        );
        return;
      }

      if (suggestion.threadId) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: suggestion.threadId },
        });
        return;
      }

      const project = findDashboardProject(
        projects,
        {
          projectId: suggestion.projectId,
          repositoryPath: suggestion.repositoryPath,
        },
        environmentId,
      );
      if (!project) {
        showStartFailure(
          "Add this repository to T3 Code first",
          `No project is configured for ${suggestion.repositoryPath || suggestion.projectName}.`,
        );
        return;
      }

      const dashboardRepository = dashboardRepositoryForSuggestion(suggestion);
      const baseBranch = suggestionWorktreeBaseBranch(dashboardRepository?.vcs);
      if (!baseBranch) {
        showStartFailure(
          "Primary branch not found",
          "T3 could not identify this repository's default branch. Refresh repository data and try again.",
        );
        return;
      }

      const availableModelSelection = resolveAppModelSelectionState(settings, serverProviders);
      if (availableModelSelection.model.trim().length === 0) {
        showStartFailure(
          "Enable an agent provider first",
          "Choose and authenticate a provider before starting suggestion work.",
        );
        return;
      }
      const modelSelection = suggestionWorkModelSelection(availableModelSelection);

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = `Work on: ${suggestion.title}`.slice(0, 80);
      setActionError((current) => (current?.suggestionId === suggestion.id ? null : current));
      setStartingSuggestionId(suggestion.id);
      let workStarted = false;

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
              prepareWorktree: {
                projectCwd: project.workspaceRoot,
                baseBranch,
                branch: buildTemporaryWorktreeBranchName(randomHex),
              },
              runSetupScript: true,
            },
            createdAt,
          },
        });

        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            showStartFailure(
              "Could not start suggestion work",
              error instanceof Error
                ? error.message
                : "The suggestion work session could not be started.",
            );
          }
          return;
        }

        workStarted = true;
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Work started",
            description: `The agent is running in a new worktree from ${baseBranch}. Open it from the sidebar when you are ready.`,
          }),
        );
        await linkSuggestionWork(suggestion, {
          environmentId,
          projectId: project.id,
          threadId,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The suggestion work session could not start.";
        if (workStarted) {
          setActionError({
            action: "link-work",
            environmentId,
            message,
            projectId: project.id,
            suggestionId: suggestion.id,
            threadId,
          });
        } else {
          showStartFailure("Could not start suggestion work", message);
        }
      } finally {
        setStartingSuggestionId(null);
      }
    },
    [
      dashboardRepositoryForSuggestion,
      dashboardSnapshot.environmentId,
      linkSuggestionWork,
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
      description="Staged investigative findings from individual repository research runs, ordered newest first."
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
        <div className="grid gap-7">
          {suggestionGroups.map((group) => {
            const statusCopy = SUGGESTION_STATUS_COPY[group.status];
            const headingId = `suggestions-${group.status}`;
            return (
              <section aria-labelledby={headingId} key={group.status}>
                <div className="mb-3 flex items-start gap-3 px-1">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-card shadow-xs">
                    {suggestionStatusIcon(group.status)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="font-semibold text-base" id={headingId}>
                        {statusCopy.label}
                      </h2>
                      <Badge size="sm" variant={suggestionStatusBadgeVariant(group.status)}>
                        {group.suggestions.length}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-sm">{statusCopy.description}</p>
                  </div>
                </div>
                <div className="grid gap-3">
                  {group.suggestions.map((suggestion) => {
                    const workflowStatus = suggestionWorkflowStatus(suggestion);
                    const hasGithubRepository = githubRepositoryForSuggestion(suggestion) !== null;
                    const suggestionActionError =
                      actionError?.suggestionId === suggestion.id ? actionError : null;
                    return (
                      <Card
                        className={SUGGESTION_STATUS_CARD_CLASS[workflowStatus]}
                        key={suggestion.id}
                      >
                        <CardHeader className="gap-3 p-4 sm:p-5">
                          <div className="flex items-start gap-3">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                              {suggestionStatusIcon(workflowStatus)}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <CardTitle className="text-base leading-snug">
                                  {suggestion.title}
                                </CardTitle>
                                <Badge
                                  size="sm"
                                  variant={suggestionStatusBadgeVariant(workflowStatus)}
                                >
                                  {SUGGESTION_STATUS_COPY[workflowStatus].label}
                                </Badge>
                                <Badge size="sm" variant="outline">
                                  {suggestion.category}
                                </Badge>
                                {suggestion.priority === "high" ? (
                                  <Badge size="sm" variant="warning">
                                    Priority
                                  </Badge>
                                ) : null}
                                <Badge size="sm" variant="outline">
                                  {suggestion.confidence} confidence
                                </Badge>
                              </div>
                              <CardDescription className="mt-1 max-w-3xl leading-relaxed">
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
                        {suggestionActionError ? (
                          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
                            <Alert controlAlignment="first-line" variant="error">
                              <AlertCircleIcon />
                              <AlertTitle>Action needs attention</AlertTitle>
                              <AlertDescription>{suggestionActionError.message}</AlertDescription>
                              <AlertAction>
                                <Button
                                  onClick={() => {
                                    if (suggestionActionError.action === "create-issue") {
                                      void createGithubIssueForSuggestion(suggestion);
                                    } else if (suggestionActionError.action === "start-work") {
                                      void startSuggestionWork(suggestion);
                                    } else {
                                      void linkSuggestionWork(suggestion, suggestionActionError);
                                    }
                                  }}
                                  size="sm"
                                  variant="outline"
                                >
                                  {suggestionActionError.action === "link-work"
                                    ? "Retry link"
                                    : "Retry"}
                                </Button>
                              </AlertAction>
                            </Alert>
                          </div>
                        ) : null}
                        <CardPanel className="flex flex-col gap-4 border-t border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                          <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground text-xs">
                            {suggestionIcon(suggestion.kind)}
                            <span>{suggestion.projectName}</span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {formatRelativeTimeLabel(suggestion.updatedAt) || "Unknown time"}
                            </span>
                          </div>
                          <AgentFindingActions
                            actions={[
                              {
                                id: "work",
                                label: suggestion.threadId ? "Open work" : "Start work",
                                pendingLabel: "Starting work",
                                icon: suggestion.threadId ? ExternalLinkIcon : BotIcon,
                                onSelect: () => void startSuggestionWork(suggestion),
                                pending: startingSuggestionId === suggestion.id,
                                disabled: startingSuggestionId !== null,
                              },
                              hasGithubRepository && {
                                id: "issue",
                                label: suggestion.githubIssueUrl
                                  ? githubIssueLabel(suggestion.githubIssueUrl)
                                  : "Create GitHub issue",
                                pendingLabel: "Creating issue",
                                icon: suggestion.githubIssueUrl ? ExternalLinkIcon : GithubIcon,
                                onSelect: () => void createGithubIssueForSuggestion(suggestion),
                                pending: creatingIssueId === suggestion.id,
                                disabled: creatingIssueId !== null,
                                variant: "outline",
                              },
                              {
                                id: "view",
                                label: "View finding",
                                icon: EyeIcon,
                                onSelect: () => setSelectedSuggestionId(suggestion.id),
                                variant: "outline",
                              },
                              suggestion.findingId &&
                                workflowStatus !== "done" && {
                                  id: "done",
                                  label: "Done",
                                  pendingLabel: "Saving",
                                  icon: CheckCircle2Icon,
                                  onSelect: () => complete(suggestion),
                                  pending: updatingFindingId === suggestion.findingId,
                                  disabled: updatingFindingId !== null,
                                  variant: "outline",
                                },
                              suggestion.findingId &&
                                workflowStatus === "pending" && {
                                  id: "snooze",
                                  label: "Snooze",
                                  icon: ClockIcon,
                                  onSelect: () => snooze(suggestion),
                                  disabled: updatingFindingId !== null,
                                  variant: "ghost",
                                },
                              suggestion.findingId &&
                                (suggestion.findingState === "snoozed" ||
                                  suggestion.findingState === "acknowledged" ||
                                  suggestion.findingState === "assigned" ||
                                  suggestion.findingState === "done") && {
                                  id: "reopen",
                                  label: "Reopen",
                                  icon: RotateCcwIcon,
                                  onSelect: () => reopen(suggestion),
                                  disabled: updatingFindingId !== null,
                                  variant: "ghost",
                                },
                            ]}
                          />
                        </CardPanel>
                      </Card>
                    );
                  })}
                </div>
              </section>
            );
          })}
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
                ? "Loading repository investigation findings."
                : hasActionableRecords
                  ? "Try a different search or category filter."
                  : "There are no pending repository investigation findings."}
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
                {selectedSuggestionStatus ? (
                  <Badge variant={suggestionStatusBadgeVariant(selectedSuggestionStatus)}>
                    {suggestionStatusIcon(selectedSuggestionStatus)}
                    {SUGGESTION_STATUS_COPY[selectedSuggestionStatus].label}
                  </Badge>
                ) : null}
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
              {selectedSuggestionActionError ? (
                <Alert controlAlignment="first-line" variant="error">
                  <AlertCircleIcon />
                  <AlertTitle>Action needs attention</AlertTitle>
                  <AlertDescription>{selectedSuggestionActionError.message}</AlertDescription>
                  <AlertAction>
                    <Button
                      onClick={() => {
                        if (selectedSuggestionActionError.action === "create-issue") {
                          void createGithubIssueForSuggestion(selectedSuggestion);
                        } else if (selectedSuggestionActionError.action === "start-work") {
                          void startSuggestionWork(selectedSuggestion);
                        } else {
                          void linkSuggestionWork(
                            selectedSuggestion,
                            selectedSuggestionActionError,
                          );
                        }
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {selectedSuggestionActionError.action === "link-work"
                        ? "Retry link"
                        : "Retry"}
                    </Button>
                  </AlertAction>
                </Alert>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <AgentFindingActions
                actions={[
                  {
                    id: "work",
                    label: selectedSuggestion.threadId ? "Open work" : "Start work",
                    pendingLabel: "Starting work",
                    icon: selectedSuggestion.threadId ? ExternalLinkIcon : BotIcon,
                    onSelect: () => void startSuggestionWork(selectedSuggestion),
                    pending: startingSuggestionId === selectedSuggestion.id,
                    disabled: startingSuggestionId !== null,
                  },
                  githubRepositoryForSuggestion(selectedSuggestion) !== null && {
                    id: "issue",
                    label: selectedSuggestion.githubIssueUrl
                      ? githubIssueLabel(selectedSuggestion.githubIssueUrl)
                      : "Create GitHub issue",
                    pendingLabel: "Creating issue",
                    icon: selectedSuggestion.githubIssueUrl ? ExternalLinkIcon : GithubIcon,
                    onSelect: () => void createGithubIssueForSuggestion(selectedSuggestion),
                    pending: creatingIssueId === selectedSuggestion.id,
                    disabled: creatingIssueId !== null,
                    variant: "outline",
                  },
                  selectedSuggestion.findingId &&
                    selectedSuggestion.findingState !== "done" && {
                      id: "done",
                      label: "Done",
                      pendingLabel: "Saving",
                      icon: CheckCircle2Icon,
                      onSelect: () => complete(selectedSuggestion),
                      pending: updatingFindingId === selectedSuggestion.findingId,
                      disabled: updatingFindingId !== null,
                      variant: "outline",
                    },
                  selectedSuggestion.findingId &&
                    selectedSuggestion.findingState !== "done" && {
                      id: "snooze",
                      label: "Snooze",
                      icon: ClockIcon,
                      onSelect: () => snooze(selectedSuggestion),
                      disabled: updatingFindingId !== null,
                      variant: "ghost",
                    },
                  selectedSuggestion.findingId &&
                    selectedSuggestion.findingState !== "open" && {
                      id: "reopen",
                      label: "Reopen",
                      icon: RotateCcwIcon,
                      onSelect: () => reopen(selectedSuggestion),
                      disabled: updatingFindingId !== null,
                      variant: "ghost",
                    },
                  {
                    id: "block",
                    label: "Block",
                    icon: AlertCircleIcon,
                    onSelect: () => void block(selectedSuggestion.id),
                    variant: "ghost",
                  },
                  {
                    id: "dismiss",
                    label: "Dismiss",
                    icon: XIcon,
                    onSelect: () => void dismiss(selectedSuggestion.id),
                    variant: "outline",
                  },
                ]}
                className="justify-end"
                size="default"
              />
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>
    </AgentDashboardPageShell>
  );
}

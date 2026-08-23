import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { ProjectId } from "@t3tools/contracts";
import type {
  AgentDashboardDispositionAction,
  AgentDashboardDispositionActionInput,
  AgentDashboardFinding,
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  RuntimeMode,
  SourceControlProjectPullRequest,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  BugIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  FlaskConicalIcon,
  FolderGit2Icon,
  GithubIcon,
  LightbulbIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  ShieldAlertIcon,
  SparklesIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  DASHBOARD_FINDING_TYPES,
  buildDashboardFindingPrompt,
  buildDashboardFindingQuestionPrompt,
  buildDashboardPullRequestCombinationPrompt,
  buildDashboardFindingRecords,
  filterDashboardFindingRecords,
  findDashboardProject,
  githubRepositoryForIdentity,
  groupDashboardFindingRecords,
  sortDashboardFindingRecords,
  suggestionWorkModelSelection,
  suggestionWorktreeBaseBranch,
  type DashboardFindingRecord,
  type DashboardFindingStatus,
  type DashboardFindingSort,
  type DashboardFindingType,
} from "../agentDashboardPages";
import { usePrimarySettings } from "../hooks/useSettings";
import { newMessageId, newThreadId, randomHex } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { getAppModelOptionsForInstance, resolveAppModelSelectionState } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { usePrimaryEnvironment } from "../state/environments";
import { useProjects } from "../state/entities";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../timestampFormat";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";
import { AgentFindingActions } from "./AgentFindingActions";
import { AgentFindingQuestionComposer } from "./AgentFindingQuestionComposer";
import { AgentProjectPullRequests } from "./AgentProjectPullRequests";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Textarea } from "./ui/textarea";

type FindingStatusFilter = "actionable" | "all" | DashboardFindingStatus;
type FindingIntent = "research" | "implement";

function parseFindingStatusFilter(value: string): FindingStatusFilter {
  switch (value) {
    case "actionable":
    case "all":
    case "open":
    case "in-progress":
    case "snoozed":
    case "done":
    case "archived":
      return value;
    default:
      return "actionable";
  }
}

function parseFindingSeverityFilter(value: string): "all" | AgentDashboardFinding["severity"] {
  switch (value) {
    case "critical":
    case "high":
    case "medium":
    case "low":
    case "info":
      return value;
    default:
      return "all";
  }
}

function parseFindingSort(value: string): DashboardFindingSort {
  return value === "recent" ? "recent" : "priority";
}

const TYPE_PRESENTATION = {
  bug: {
    label: "Bugs",
    singular: "Bug",
    icon: BugIcon,
    cardClass: "border-destructive/40",
    iconClass: "border-destructive/25 bg-destructive/8 text-destructive",
  },
  security: {
    label: "Security",
    singular: "Security",
    icon: ShieldAlertIcon,
    cardClass: "border-warning/45",
    iconClass: "border-warning/30 bg-warning/10 text-warning-foreground",
  },
  research: {
    label: "Research",
    singular: "Research",
    icon: FlaskConicalIcon,
    cardClass: "border-info/40",
    iconClass: "border-info/25 bg-info/8 text-info-foreground",
  },
  improvement: {
    label: "Improvements",
    singular: "Improvement",
    icon: SparklesIcon,
    cardClass: "border-success/40",
    iconClass: "border-success/25 bg-success/8 text-success-foreground",
  },
  review: {
    label: "Reviews",
    singular: "Review",
    icon: FileSearchIcon,
    cardClass: "border-primary/35",
    iconClass: "border-primary/25 bg-primary/8 text-primary",
  },
  operations: {
    label: "Operations",
    singular: "Operations",
    icon: WrenchIcon,
    cardClass: "border-muted-foreground/35",
    iconClass: "border-muted-foreground/25 bg-muted text-muted-foreground",
  },
} as const satisfies Record<
  DashboardFindingType,
  {
    readonly label: string;
    readonly singular: string;
    readonly icon: LucideIcon;
    readonly cardClass: string;
    readonly iconClass: string;
  }
>;

const STATUS_LABELS = {
  open: "Open",
  "in-progress": "In progress",
  snoozed: "Snoozed",
  done: "Done",
  archived: "Archived",
} as const satisfies Record<DashboardFindingStatus, string>;

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

function statusVariant(status: DashboardFindingStatus) {
  switch (status) {
    case "open":
      return "warning" as const;
    case "in-progress":
      return "info" as const;
    case "done":
      return "success" as const;
    case "snoozed":
    case "archived":
      return "outline" as const;
  }
}

function findingIntent(record: DashboardFindingRecord): FindingIntent {
  return record.type === "research" && record.finding.actionability?.readiness !== "ready"
    ? "research"
    : "implement";
}

export function AgentFindings() {
  const navigate = useNavigate();
  const settings = usePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const collect = useAtomCommand(agentDashboardEnvironment.collect, { reportFailure: false });
  const addResearchWatchItem = useAtomCommand(agentDashboardEnvironment.addResearchWatchItem, {
    reportFailure: false,
  });
  const applyFindingAction = useAtomCommand(agentDashboardEnvironment.applyFindingAction, {
    reportFailure: false,
  });
  const linkFindingThread = useAtomCommand(agentDashboardEnvironment.linkFindingThread, {
    reportFailure: false,
  });
  const createGithubIssue = useAtomCommand(agentDashboardEnvironment.createGithubIssue, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | DashboardFindingType>("all");
  const [severityFilter, setSeverityFilter] = useState<"all" | AgentDashboardFinding["severity"]>(
    "all",
  );
  const [statusFilter, setStatusFilter] = useState<FindingStatusFilter>("actionable");
  const [findingSort, setFindingSort] = useState<DashboardFindingSort>("priority");
  const [isCollecting, setIsCollecting] = useState(false);
  const [startingFindingId, setStartingFindingId] = useState<string | null>(null);
  const [creatingIssueId, setCreatingIssueId] = useState<string | null>(null);
  const [updatingFindingId, setUpdatingFindingId] = useState<string | null>(null);
  const [askingFindingId, setAskingFindingId] = useState<string | null>(null);
  const [combiningProjectId, setCombiningProjectId] = useState<string | null>(null);
  const [voiceFindingId, setVoiceFindingId] = useState<string | null>(null);
  const [researchSetupOpen, setResearchSetupOpen] = useState(false);
  const [researchProjectId, setResearchProjectId] = useState("");
  const [researchTitle, setResearchTitle] = useState("");
  const [researchSummary, setResearchSummary] = useState("");
  const [researchUrl, setResearchUrl] = useState("");
  const [savingResearchSource, setSavingResearchSource] = useState(false);
  const [selectedFindingIds, setSelectedFindingIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<AgentDashboardDispositionAction | null>(null);
  const [manageRecord, setManageRecord] = useState<DashboardFindingRecord | null>(null);
  const [manageAssignee, setManageAssignee] = useState("");
  const [manageNote, setManageNote] = useState("");
  const [snoozeDays, setSnoozeDays] = useState("3");
  const findingComposerModelCatalog = useMemo(() => {
    const providerInstanceEntries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
    );
    const modelOptionsByInstance = new Map<
      ProviderInstanceId,
      ReturnType<typeof getAppModelOptionsForInstance>
    >();
    for (const entry of providerInstanceEntries) {
      modelOptionsByInstance.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return {
      initialModelSelection: resolveAppModelSelectionState(settings, serverProviders),
      providerInstanceEntries,
      modelOptionsByInstance,
    };
  }, [serverProviders, settings]);

  const records = useMemo(
    () =>
      dashboardSnapshot.data === null ? [] : buildDashboardFindingRecords(dashboardSnapshot.data),
    [dashboardSnapshot.data],
  );
  const recordsAcrossTypes = useMemo(
    () =>
      filterDashboardFindingRecords(records, {
        query,
        projectId: projectFilter,
        status: statusFilter,
        type: "all",
        severity: severityFilter,
      }),
    [projectFilter, query, records, severityFilter, statusFilter],
  );
  const visibleRecords = useMemo(
    () =>
      sortDashboardFindingRecords(
        typeFilter === "all"
          ? recordsAcrossTypes
          : recordsAcrossTypes.filter((record) => record.type === typeFilter),
        findingSort,
      ),
    [findingSort, recordsAcrossTypes, typeFilter],
  );
  const groups = useMemo(() => groupDashboardFindingRecords(visibleRecords), [visibleRecords]);
  const selectedVisibleCount = visibleRecords.filter((record) =>
    selectedFindingIds.has(record.id),
  ).length;
  const allVisibleSelected =
    visibleRecords.length > 0 && selectedVisibleCount === visibleRecords.length;
  const projectOptions = useMemo(
    () =>
      [
        ...new Map(records.map((record) => [record.projectId, record.projectName])).entries(),
      ].toSorted((left, right) => left[1].localeCompare(right[1])),
    [records],
  );
  const typeCounts = useMemo(() => {
    const counts = new Map(DASHBOARD_FINDING_TYPES.map((type) => [type, 0]));
    for (const record of recordsAcrossTypes) {
      counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
    }
    return counts;
  }, [recordsAcrossTypes]);
  const collectorStates = dashboardSnapshot.data?.collectorStates ?? [];
  const unconfiguredResearchCollectors = collectorStates.filter(
    (collector) =>
      collector.status === "unavailable" && collector.source === "local-research-watchlist",
  );
  const collectorsNeedingAttention = collectorStates.filter(
    (collector) =>
      collector.status === "unavailable" && collector.source !== "local-research-watchlist",
  );
  const findingsSchedule =
    dashboardSnapshot.data?.findingsSchedule ?? dashboardSnapshot.data?.reviewSchedule ?? null;
  const lastCollectionLabel = findingsSchedule?.lastCompletedAt
    ? formatRelativeTimeLabel(findingsSchedule.lastCompletedAt)
    : null;
  const nextScheduledRunLabel = findingsSchedule
    ? formatRelativeTimeUntilLabel(findingsSchedule.nextRunAt)
    : null;
  const scheduleTimingLabel =
    findingsSchedule?.lastStatus === "running"
      ? "Running now"
      : nextScheduledRunLabel === "Expired"
        ? "Run due now"
        : nextScheduledRunLabel === "Soon"
          ? "Next run shortly"
          : nextScheduledRunLabel
            ? `Next run in ${nextScheduledRunLabel.replace(" left", "")}`
            : "Schedule ready";

  const showFailure = useCallback((title: string, message: string) => {
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  }, []);

  const dashboardRepositoryForRecord = useCallback(
    (record: DashboardFindingRecord) =>
      dashboardSnapshot.data?.repositories.find(
        (repository) => String(repository.projectId) === record.projectId,
      ) ?? null,
    [dashboardSnapshot.data?.repositories],
  );

  const projectForRecord = useCallback(
    (record: DashboardFindingRecord, environmentId: EnvironmentId): EnvironmentProject | null =>
      findDashboardProject(
        projects,
        { projectId: record.projectId, repositoryPath: record.repositoryPath },
        environmentId,
      ),
    [projects],
  );

  const githubRepositoryForRecord = useCallback(
    (record: DashboardFindingRecord): string | null => {
      const environmentId = dashboardSnapshot.environmentId;
      const project = environmentId ? projectForRecord(record, environmentId) : null;
      return (
        githubRepositoryForIdentity(dashboardRepositoryForRecord(record)?.repositoryIdentity) ??
        githubRepositoryForIdentity(project?.repositoryIdentity)
      );
    },
    [dashboardRepositoryForRecord, dashboardSnapshot.environmentId, projectForRecord],
  );

  const openExternal = useCallback(
    async (url: string) => {
      try {
        const localApi = readLocalApi();
        if (localApi) {
          await localApi.shell.openExternal(url);
          return;
        }
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (error) {
        showFailure(
          "Could not open GitHub issue",
          error instanceof Error ? error.message : "The link could not be opened.",
        );
      }
    },
    [showFailure],
  );

  const collectNow = useCallback(async () => {
    if (!dashboardSnapshot.environmentId || isCollecting) return;
    setIsCollecting(true);
    try {
      const result = await collect({
        environmentId: dashboardSnapshot.environmentId,
        input: { kind: "all" },
      });
      if (result._tag === "Failure") {
        showFailure(
          "Some finding sources did not start",
          "Refresh the dashboard, check collector availability, and try again.",
        );
        return;
      }
      await dashboardSnapshot.refresh();
    } finally {
      setIsCollecting(false);
    }
  }, [collect, dashboardSnapshot, isCollecting, showFailure]);

  const applyDisposition = useCallback(
    async (
      record: DashboardFindingRecord,
      action: AgentDashboardDispositionAction,
      details: Pick<AgentDashboardDispositionActionInput, "assignee" | "note" | "snoozeUntil"> = {},
    ) => {
      if (!dashboardSnapshot.environmentId || updatingFindingId !== null) return;
      setUpdatingFindingId(record.id);
      try {
        const result = await applyFindingAction({
          environmentId: dashboardSnapshot.environmentId,
          input: { id: record.id, action, ...details },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            showFailure(
              "Could not update finding",
              error instanceof Error ? error.message : "The finding could not be updated.",
            );
          }
          return;
        }
        if (!result.value.ok || result.value.outcome === "not-found") {
          showFailure(
            "Finding was not updated",
            result.value.message ?? "The finding no longer exists.",
          );
          return;
        }
        await dashboardSnapshot.refresh();
      } finally {
        setUpdatingFindingId(null);
      }
    },
    [applyFindingAction, dashboardSnapshot, showFailure, updatingFindingId],
  );

  const applyBulkDisposition = useCallback(
    async (action: AgentDashboardDispositionAction, snoozeUntil?: string) => {
      if (!dashboardSnapshot.environmentId || bulkAction !== null) return;
      const selected = visibleRecords.filter((record) => selectedFindingIds.has(record.id));
      if (selected.length === 0) return;
      setBulkAction(action);
      let failed = 0;
      try {
        for (const record of selected) {
          const result = await applyFindingAction({
            environmentId: dashboardSnapshot.environmentId,
            input: { id: record.id, action, ...(snoozeUntil ? { snoozeUntil } : {}) },
          });
          if (result._tag === "Failure" || !result.value.ok) failed += 1;
        }
        await dashboardSnapshot.refresh();
        setSelectedFindingIds(new Set());
        toastManager.add(
          stackedThreadToast({
            type: failed === 0 ? "success" : "warning",
            title: failed === 0 ? "Findings updated" : "Some findings were not updated",
            description:
              failed === 0
                ? `${selected.length} ${selected.length === 1 ? "finding" : "findings"} updated.`
                : `${selected.length - failed} updated, ${failed} failed.`,
          }),
        );
      } finally {
        setBulkAction(null);
      }
    },
    [applyFindingAction, bulkAction, dashboardSnapshot, selectedFindingIds, visibleRecords],
  );

  const createIssueForRecord = useCallback(
    async (record: DashboardFindingRecord) => {
      if (!dashboardSnapshot.environmentId || creatingIssueId !== null) return;
      if (record.finding.externalIssueUrl) {
        await openExternal(record.finding.externalIssueUrl);
        return;
      }
      if (!githubRepositoryForRecord(record)) {
        showFailure(
          "Connect this repository to GitHub first",
          "A GitHub remote is required before T3 Code can create an issue.",
        );
        return;
      }
      setCreatingIssueId(record.id);
      try {
        const result = await createGithubIssue({
          environmentId: dashboardSnapshot.environmentId,
          input: { id: record.id },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            showFailure(
              "Could not create GitHub issue",
              error instanceof Error ? error.message : "The GitHub issue could not be created.",
            );
          }
          return;
        }
        if (!result.value.ok || result.value.outcome === "not-found") {
          showFailure(
            "GitHub issue was not created",
            result.value.message ?? "The finding could not be found.",
          );
          return;
        }
        await dashboardSnapshot.refresh();
      } finally {
        setCreatingIssueId(null);
      }
    },
    [
      createGithubIssue,
      creatingIssueId,
      dashboardSnapshot,
      githubRepositoryForRecord,
      openExternal,
      showFailure,
    ],
  );

  const startFindingWork = useCallback(
    async (record: DashboardFindingRecord) => {
      if (startingFindingId !== null) return;
      const environmentId =
        dashboardSnapshot.environmentId ?? primaryEnvironment?.environmentId ?? null;
      if (!environmentId) {
        showFailure(
          "Connect an environment first",
          "This finding needs a T3 Code environment to start an agent session.",
        );
        return;
      }
      if (record.finding.thread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: record.finding.thread.threadId },
        });
        return;
      }
      const project = projectForRecord(record, environmentId);
      if (!project) {
        showFailure(
          "Add this repository to T3 Code first",
          `No project is configured for ${record.repositoryPath || record.projectName}.`,
        );
        return;
      }
      const intent = findingIntent(record);
      const baseBranch =
        intent === "implement"
          ? suggestionWorktreeBaseBranch(dashboardRepositoryForRecord(record)?.vcs)
          : null;
      if (intent === "implement" && !baseBranch) {
        showFailure(
          "Primary branch not found",
          "T3 could not identify this repository's default branch. Refresh repository data and try again.",
        );
        return;
      }
      const availableModelSelection = resolveAppModelSelectionState(settings, serverProviders);
      if (availableModelSelection.model.trim().length === 0) {
        showFailure(
          "Enable an agent provider first",
          "Choose and authenticate a provider before starting finding work.",
        );
        return;
      }

      const modelSelection = suggestionWorkModelSelection(availableModelSelection);
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title =
        `${intent === "research" ? "Research" : "Work on"}: ${record.finding.title}`.slice(0, 80);
      setStartingFindingId(record.id);
      try {
        const result = await startThreadTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: buildDashboardFindingPrompt(record, intent),
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
              ...(intent === "implement" && baseBranch
                ? {
                    prepareWorktree: {
                      projectCwd: project.workspaceRoot,
                      baseBranch,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                    },
                    runSetupScript: true,
                  }
                : {}),
            },
            createdAt,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            showFailure(
              intent === "research" ? "Could not start research" : "Could not start work",
              error instanceof Error ? error.message : "The agent session could not be started.",
            );
          }
          return;
        }
        const linkResult = await linkFindingThread({
          environmentId,
          input: { id: record.id, projectId: project.id, threadId },
        });
        if (linkResult._tag === "Failure" || !linkResult.value.ok) {
          showFailure(
            "Agent started without a dashboard link",
            linkResult._tag === "Success"
              ? (linkResult.value.message ?? "The finding could not be linked to the agent.")
              : "The finding could not be linked to the agent.",
          );
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: intent === "research" ? "Research started" : "Work started",
            description:
              intent === "research"
                ? "The agent is qualifying this finding against the repository."
                : `The agent is running in a new worktree from ${baseBranch}.`,
          }),
        );
        await dashboardSnapshot.refresh();
      } finally {
        setStartingFindingId(null);
      }
    },
    [
      dashboardRepositoryForRecord,
      dashboardSnapshot,
      linkFindingThread,
      navigate,
      primaryEnvironment?.environmentId,
      projectForRecord,
      serverProviders,
      settings,
      showFailure,
      startThreadTurn,
      startingFindingId,
    ],
  );

  const askAboutFinding = useCallback(
    async (
      record: DashboardFindingRecord,
      input: {
        readonly question: string;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: RuntimeMode;
      },
    ) => {
      const prompt = input.question.trim();
      if (!prompt || askingFindingId !== null) return;
      const environmentId =
        dashboardSnapshot.environmentId ?? primaryEnvironment?.environmentId ?? null;
      if (!environmentId) {
        showFailure(
          "Connect an environment first",
          "This question needs a T3 Code environment to start a session.",
        );
        return;
      }
      const project = projectForRecord(record, environmentId);
      if (!project) {
        showFailure(
          "Add this repository to T3 Code first",
          `No project is configured for ${record.repositoryPath || record.projectName}.`,
        );
        return;
      }
      if (input.modelSelection.model.trim().length === 0) {
        showFailure(
          "Enable an agent provider first",
          "Choose and authenticate a provider before asking about this finding.",
        );
        return;
      }

      const modelSelection = input.modelSelection;
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = `Ask: ${record.finding.title}`.slice(0, 80);
      setAskingFindingId(record.id);
      try {
        const result = await startThreadTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: buildDashboardFindingQuestionPrompt(record, prompt),
              attachments: [],
            },
            modelSelection,
            titleSeed: title,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: project.id,
                title,
                modelSelection,
                runtimeMode: input.runtimeMode,
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
            showFailure(
              "Could not start the conversation",
              error instanceof Error ? error.message : "The agent session could not be started.",
            );
          }
          return;
        }
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId },
        });
      } finally {
        setAskingFindingId(null);
      }
    },
    [
      askingFindingId,
      dashboardSnapshot.environmentId,
      navigate,
      primaryEnvironment?.environmentId,
      projectForRecord,
      showFailure,
      startThreadTurn,
    ],
  );

  const combineProjectPullRequests = useCallback(
    async (
      target: {
        readonly projectId: string;
        readonly projectName: string;
        readonly repositoryPath: string;
      },
      input: {
        readonly pullRequests: ReadonlyArray<SourceControlProjectPullRequest>;
        readonly title: string;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: RuntimeMode;
      },
    ): Promise<boolean> => {
      if (combiningProjectId !== null) return false;
      const environmentId =
        dashboardSnapshot.environmentId ?? primaryEnvironment?.environmentId ?? null;
      if (!environmentId) {
        showFailure(
          "Connect an environment first",
          "Combining pull requests needs a T3 Code environment to start an agent session.",
        );
        return false;
      }
      const project = findDashboardProject(projects, target, environmentId);
      if (!project) {
        showFailure(
          "Add this repository to T3 Code first",
          `No project is configured for ${target.repositoryPath || target.projectName}.`,
        );
        return false;
      }
      const uniquePullRequests = new Set(
        input.pullRequests.map((pullRequest) => pullRequest.number),
      );
      if (uniquePullRequests.size < 2 || uniquePullRequests.size !== input.pullRequests.length) {
        showFailure(
          "Select at least two pull requests",
          "Each source pull request can appear only once in a combination plan.",
        );
        return false;
      }
      const baseBranches = new Set(
        input.pullRequests.map((pullRequest) => pullRequest.baseRefName.trim()).filter(Boolean),
      );
      if (baseBranches.size !== 1) {
        showFailure(
          "Choose one target branch",
          "All source pull requests must target the same branch before they can be combined.",
        );
        return false;
      }
      const [baseBranch] = baseBranches;
      const outputTitle = input.title.trim();
      if (!baseBranch || !outputTitle || input.modelSelection.model.trim().length === 0) {
        showFailure(
          "Complete the launch setup",
          "Choose an available model, a target branch, and a title for the replacement PR.",
        );
        return false;
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = `Combine ${input.pullRequests.length} PRs: ${target.projectName}`.slice(0, 80);
      setCombiningProjectId(target.projectId);
      try {
        const result = await startThreadTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: buildDashboardPullRequestCombinationPrompt({
                projectName: target.projectName,
                repositoryPath: target.repositoryPath,
                baseRefName: baseBranch,
                outputTitle,
                pullRequests: input.pullRequests,
              }),
              attachments: [],
            },
            modelSelection: input.modelSelection,
            titleSeed: title,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: project.id,
                title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: project.workspaceRoot,
                baseBranch,
                branch: buildTemporaryWorktreeBranchName(randomHex),
                startFromOrigin: true,
              },
              runSetupScript: true,
            },
            createdAt,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            showFailure(
              "Could not launch the combination agent",
              error instanceof Error ? error.message : "The agent session could not be started.",
            );
          }
          return false;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Combination agent started",
            description: `${input.pullRequests.length} PRs will be integrated from ${baseBranch} in a new worktree.`,
          }),
        );
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId },
        });
        return true;
      } finally {
        setCombiningProjectId(null);
      }
    },
    [
      combiningProjectId,
      dashboardSnapshot.environmentId,
      navigate,
      primaryEnvironment?.environmentId,
      projects,
      showFailure,
      startThreadTurn,
    ],
  );

  const handleFindingVoiceActivityChange = useCallback((findingId: string, active: boolean) => {
    setVoiceFindingId((current) => {
      if (active) return current ?? findingId;
      return current === findingId ? null : current;
    });
  }, []);

  const saveResearchSource = useCallback(async () => {
    const environmentId = dashboardSnapshot.environmentId;
    const projectId = researchProjectId || projectOptions[0]?.[0] || "";
    if (
      !environmentId ||
      !projectId ||
      !researchTitle.trim() ||
      !researchSummary.trim() ||
      savingResearchSource
    ) {
      return;
    }
    setSavingResearchSource(true);
    try {
      const result = await addResearchWatchItem({
        environmentId,
        input: {
          projectId: ProjectId.make(projectId),
          title: researchTitle.trim(),
          summary: researchSummary.trim(),
          url: researchUrl.trim() || null,
          category: "watchlist",
        },
      });
      if (result._tag === "Failure" || !result.value.ok) {
        const message =
          result._tag === "Success"
            ? (result.value.message ?? "The research source could not be saved.")
            : "The research source could not be saved.";
        showFailure("Could not configure research", message);
        return;
      }
      await collect({
        environmentId,
        input: { kind: "research", projectId: ProjectId.make(projectId) },
      });
      await dashboardSnapshot.refresh();
      setResearchSetupOpen(false);
      setResearchTitle("");
      setResearchSummary("");
      setResearchUrl("");
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Research source configured",
          description: "T3 collected the watch item for the selected repository.",
        }),
      );
    } finally {
      setSavingResearchSource(false);
    }
  }, [
    addResearchWatchItem,
    collect,
    dashboardSnapshot,
    projectOptions,
    researchProjectId,
    researchSummary,
    researchTitle,
    researchUrl,
    savingResearchSource,
    showFailure,
  ]);

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
            {isCollecting ? <LoaderIcon className="animate-spin" /> : <LightbulbIcon />}
            {isCollecting ? "Collecting" : "Collect findings"}
          </Button>
          <Button
            aria-label="Refresh findings"
            disabled={dashboardSnapshot.isPending}
            onClick={dashboardSnapshot.refresh}
            size="icon-sm"
            variant="outline"
          >
            <RefreshCwIcon className={dashboardSnapshot.isPending ? "animate-spin" : undefined} />
          </Button>
        </div>
      }
      title="Findings"
      description="Research, security risks, bugs, reviews, and improvement ideas across every project, ready to filter and act on in one place."
    >
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_12rem_11rem_10rem_10rem]">
        <div className="relative min-w-0 md:col-span-2 lg:col-span-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search findings"
            className="pl-9"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search findings, projects, sources, or evidence"
            value={query}
          />
        </div>
        <Select value={projectFilter} onValueChange={(value) => value && setProjectFilter(value)}>
          <SelectTrigger aria-label="Filter findings by project" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="all">All projects</SelectItem>
            {projectOptions.map(([projectId, projectName]) => (
              <SelectItem key={projectId} value={projectId}>
                {projectName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(value) => value && setStatusFilter(parseFindingStatusFilter(value))}
        >
          <SelectTrigger aria-label="Filter findings by status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="actionable">Actionable</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in-progress">In progress</SelectItem>
            <SelectItem value="snoozed">Snoozed</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectPopup>
        </Select>
        <Select
          value={severityFilter}
          onValueChange={(value) => value && setSeverityFilter(parseFindingSeverityFilter(value))}
        >
          <SelectTrigger aria-label="Filter findings by severity" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="all">All severities</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="info">Info</SelectItem>
          </SelectPopup>
        </Select>
        <Select
          value={findingSort}
          onValueChange={(value) => value && setFindingSort(parseFindingSort(value))}
        >
          <SelectTrigger aria-label="Sort findings" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="priority">Priority first</SelectItem>
            <SelectItem value="recent">Most recent</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max gap-2" role="group" aria-label="Filter findings by type">
          <Button
            aria-pressed={typeFilter === "all"}
            onClick={() => setTypeFilter("all")}
            size="sm"
            variant={typeFilter === "all" ? "secondary" : "outline"}
          >
            All
            <Badge size="sm" variant="outline">
              {recordsAcrossTypes.length}
            </Badge>
          </Button>
          {DASHBOARD_FINDING_TYPES.map((type) => {
            const { icon: Icon, label } = TYPE_PRESENTATION[type];
            return (
              <Button
                aria-pressed={typeFilter === type}
                key={type}
                onClick={() => setTypeFilter(type)}
                size="sm"
                variant={typeFilter === type ? "secondary" : "outline"}
              >
                <Icon />
                {label}
                <Badge size="sm" variant="outline">
                  {typeCounts.get(type) ?? 0}
                </Badge>
              </Button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p aria-live="polite">
          {visibleRecords.length} {visibleRecords.length === 1 ? "finding" : "findings"} across{" "}
          {groups.length} {groups.length === 1 ? "project" : "projects"}
        </p>
        {collectorsNeedingAttention.length > 0 ? (
          <p className="flex items-center gap-1.5 text-warning-foreground">
            <ShieldAlertIcon className="size-4" />
            {collectorsNeedingAttention.length} collector
            {collectorsNeedingAttention.length === 1 ? "" : "s"} need attention
          </p>
        ) : unconfiguredResearchCollectors.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex items-center gap-1.5">
              <FlaskConicalIcon className="size-4" />
              Research watchlist is not configured
            </p>
            <Button
              onClick={() => {
                setResearchProjectId(projectOptions[0]?.[0] ?? "");
                setResearchSetupOpen(true);
              }}
              size="xs"
              variant="outline"
            >
              <PlusIcon />
              Set up research
            </Button>
          </div>
        ) : null}
      </div>

      {visibleRecords.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
          <label className="flex min-h-8 items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={allVisibleSelected}
              indeterminate={selectedVisibleCount > 0 && !allVisibleSelected}
              onCheckedChange={(checked) => {
                setSelectedFindingIds((current) => {
                  const next = new Set(current);
                  for (const record of visibleRecords) {
                    if (checked === true) next.add(record.id);
                    else next.delete(record.id);
                  }
                  return next;
                });
              }}
            />
            {selectedVisibleCount > 0
              ? `${selectedVisibleCount} selected`
              : `Select ${visibleRecords.length} visible`}
          </label>
          {selectedVisibleCount > 0 ? (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                disabled={bulkAction !== null}
                onClick={() => void applyBulkDisposition("complete")}
                size="xs"
                variant="outline"
              >
                {bulkAction === "complete" ? (
                  <LoaderIcon className="animate-spin" />
                ) : (
                  <CheckCircle2Icon />
                )}
                Done
              </Button>
              <Button
                disabled={bulkAction !== null}
                onClick={() =>
                  void applyBulkDisposition(
                    "snooze",
                    new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000).toISOString(),
                  )
                }
                size="xs"
                variant="outline"
              >
                {bulkAction === "snooze" ? <LoaderIcon className="animate-spin" /> : <ClockIcon />}
                Snooze 3 days
              </Button>
              <Button
                disabled={bulkAction !== null}
                onClick={() => void applyBulkDisposition("dismiss")}
                size="xs"
                variant="ghost"
              >
                {bulkAction === "dismiss" ? <LoaderIcon className="animate-spin" /> : <XIcon />}
                Dismiss
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {findingsSchedule ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <ClockIcon className="size-3.5" />
            Automatic portfolio collection
          </span>
          <span>
            Attempted {findingsSchedule.lastCoveredTypes.length}/{DASHBOARD_FINDING_TYPES.length}
          </span>
          <span>
            Completed {findingsSchedule.lastSuccessfulTypes.length}/{DASHBOARD_FINDING_TYPES.length}
          </span>
          {lastCollectionLabel ? <span>Last collected {lastCollectionLabel}</span> : null}
          <span>{scheduleTimingLabel}</span>
        </div>
      ) : null}

      {groups.length > 0 ? (
        <div className="grid gap-8">
          {groups.map((group) => {
            const headingId = `findings-project-${group.projectId}`;
            return (
              <section aria-labelledby={headingId} key={group.projectId}>
                <Collapsible defaultOpen>
                  <CollapsibleTrigger className="mb-3 flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-1 text-left outline-none transition-colors hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring data-panel-open:[&>svg]:rotate-180">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-xs">
                      <FolderGit2Icon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-semibold" id={headingId}>
                          {group.projectName}
                        </span>
                        <Badge size="sm" variant="outline">
                          {group.findings.length}
                        </Badge>
                      </div>
                      {group.repositoryPath ? (
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {group.repositoryPath}
                        </span>
                      ) : null}
                    </div>
                    <ChevronDownIcon className="mr-2 size-5 shrink-0 text-muted-foreground transition-transform" />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="grid gap-3 pb-1">
                      <AgentProjectPullRequests
                        combinationBusy={combiningProjectId === group.projectId}
                        environmentId={dashboardSnapshot.environmentId}
                        initialModelSelection={findingComposerModelCatalog.initialModelSelection}
                        modelOptionsByInstance={findingComposerModelCatalog.modelOptionsByInstance}
                        onCombinePullRequests={(input) =>
                          combineProjectPullRequests(
                            {
                              projectId: group.projectId,
                              projectName: group.projectName,
                              repositoryPath: group.repositoryPath,
                            },
                            input,
                          )
                        }
                        onOpenExternal={openExternal}
                        projectId={ProjectId.make(group.projectId)}
                        projectName={group.projectName}
                        providerInstanceEntries={
                          findingComposerModelCatalog.providerInstanceEntries
                        }
                      />
                      {group.findings.map((record) => {
                        const { finding } = record;
                        const {
                          cardClass,
                          icon: TypeIcon,
                          iconClass,
                          singular: typeLabel,
                        } = TYPE_PRESENTATION[record.type];
                        const intent = findingIntent(record);
                        const isUpdating = updatingFindingId === record.id;
                        const canCreateIssue =
                          finding.externalIssueUrl !== null ||
                          githubRepositoryForRecord(record) !== null;
                        return (
                          <Card className={cardClass} key={record.id}>
                            <CardHeader className="gap-3 p-4 sm:p-5">
                              <div className="flex min-w-0 items-start gap-3">
                                <Checkbox
                                  aria-label={`Select ${finding.title}`}
                                  checked={selectedFindingIds.has(record.id)}
                                  onCheckedChange={(checked) =>
                                    setSelectedFindingIds((current) => {
                                      const next = new Set(current);
                                      if (checked === true) next.add(record.id);
                                      else next.delete(record.id);
                                      return next;
                                    })
                                  }
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <CardTitle className="text-base leading-snug">
                                      {finding.title}
                                    </CardTitle>
                                    <Badge size="sm" variant="outline">
                                      {typeLabel}
                                    </Badge>
                                    <Badge size="sm" variant={severityVariant(finding.severity)}>
                                      {finding.severity}
                                    </Badge>
                                    <Badge size="sm" variant={statusVariant(record.status)}>
                                      {STATUS_LABELS[record.status]}
                                    </Badge>
                                  </div>
                                  <CardDescription className="mt-1 max-w-3xl whitespace-pre-wrap leading-relaxed">
                                    {finding.summary}
                                  </CardDescription>
                                </div>
                                <div
                                  aria-label={`${typeLabel} finding`}
                                  className={`flex size-14 shrink-0 items-center justify-center rounded-xl border ${iconClass}`}
                                  role="img"
                                >
                                  <TypeIcon className="size-7" />
                                </div>
                              </div>
                            </CardHeader>
                            <CardPanel className="flex flex-col gap-4 border-t border-border/60 p-4 sm:p-5">
                              {finding.evidence.length > 0 ? (
                                <ul className="grid gap-1 text-sm text-foreground/80">
                                  {finding.evidence.slice(0, 3).map((evidence) => (
                                    <li className="flex gap-2" key={evidence}>
                                      <span aria-hidden="true" className="text-muted-foreground">
                                        •
                                      </span>
                                      <span className="min-w-0 break-words">{evidence}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <span>{finding.provenance.source}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>{finding.confidence} confidence</span>
                                  <span aria-hidden="true">·</span>
                                  <span>
                                    {formatRelativeTimeLabel(finding.lastSeenAt) || "Unknown time"}
                                  </span>
                                  {finding.occurrenceCount > 1 ? (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span>Seen {finding.occurrenceCount} times</span>
                                    </>
                                  ) : null}
                                </div>
                                <AgentFindingActions
                                  actions={[
                                    {
                                      id: "manage",
                                      label: "Details and triage",
                                      icon: SlidersHorizontalIcon,
                                      onSelect: () => {
                                        setManageAssignee(finding.disposition.assignee ?? "");
                                        setManageNote(finding.disposition.note ?? "");
                                        setSnoozeDays("3");
                                        setManageRecord(record);
                                      },
                                      variant: "outline",
                                    },
                                    record.status !== "done" && record.status !== "archived"
                                      ? {
                                          id: "work",
                                          label: finding.thread
                                            ? "Open work"
                                            : intent === "research"
                                              ? "Research"
                                              : "Start work",
                                          pendingLabel: "Starting",
                                          icon: finding.thread ? ExternalLinkIcon : BotIcon,
                                          pending: startingFindingId === record.id,
                                          disabled: startingFindingId !== null,
                                          onSelect: () => void startFindingWork(record),
                                        }
                                      : null,
                                    canCreateIssue
                                      ? {
                                          id: "issue",
                                          label: finding.externalIssueUrl
                                            ? "Open issue"
                                            : "Create issue",
                                          pendingLabel: "Creating issue",
                                          icon: finding.externalIssueUrl
                                            ? ExternalLinkIcon
                                            : GithubIcon,
                                          pending: creatingIssueId === record.id,
                                          disabled: creatingIssueId !== null,
                                          onSelect: () => void createIssueForRecord(record),
                                          variant: "outline",
                                        }
                                      : null,
                                    record.status !== "done" && record.status !== "archived"
                                      ? {
                                          id: "done",
                                          label: "Done",
                                          pendingLabel: "Saving",
                                          icon: CheckCircle2Icon,
                                          pending: isUpdating,
                                          disabled: updatingFindingId !== null,
                                          onSelect: () => void applyDisposition(record, "complete"),
                                          variant: "outline",
                                        }
                                      : null,
                                    record.status === "open" || record.status === "in-progress"
                                      ? {
                                          id: "snooze",
                                          label: "Snooze",
                                          icon: ClockIcon,
                                          disabled: updatingFindingId !== null,
                                          onSelect: () => void applyDisposition(record, "snooze"),
                                          variant: "ghost",
                                        }
                                      : null,
                                    record.status === "snoozed" ||
                                    record.status === "done" ||
                                    record.status === "archived"
                                      ? {
                                          id: "reopen",
                                          label: "Reopen",
                                          pendingLabel: "Saving",
                                          icon: RotateCcwIcon,
                                          pending: isUpdating,
                                          disabled: updatingFindingId !== null,
                                          onSelect: () => void applyDisposition(record, "reopen"),
                                          variant: "outline",
                                        }
                                      : null,
                                    record.status !== "archived"
                                      ? {
                                          id: "dismiss",
                                          label: "Dismiss",
                                          icon: XIcon,
                                          disabled: updatingFindingId !== null,
                                          onSelect: () => void applyDisposition(record, "dismiss"),
                                          variant: "ghost",
                                        }
                                      : null,
                                  ]}
                                />
                              </div>
                              <div className="border-t border-border/60 pt-4">
                                <AgentFindingQuestionComposer
                                  busy={askingFindingId === record.id}
                                  disabled={askingFindingId !== null}
                                  findingId={record.id}
                                  findingTitle={finding.title}
                                  initialModelSelection={
                                    findingComposerModelCatalog.initialModelSelection
                                  }
                                  modelOptionsByInstance={
                                    findingComposerModelCatalog.modelOptionsByInstance
                                  }
                                  onSubmit={(input) => void askAboutFinding(record, input)}
                                  onVoiceActivityChange={handleFindingVoiceActivityChange}
                                  providerInstanceEntries={
                                    findingComposerModelCatalog.providerInstanceEntries
                                  }
                                  settings={settings}
                                  voiceDisabled={
                                    voiceFindingId !== null && voiceFindingId !== record.id
                                  }
                                />
                              </div>
                            </CardPanel>
                          </Card>
                        );
                      })}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
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
            <EmptyTitle>
              {records.length === 0 ? "No findings yet" : "No matching findings"}
            </EmptyTitle>
            <EmptyDescription>
              {records.length === 0
                ? "Collect findings to review research, security, engineering, and repository advice here."
                : "Try another project, type, status, or search term."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <Dialog
        open={manageRecord !== null}
        onOpenChange={(open) => {
          if (!open && updatingFindingId === null) setManageRecord(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{manageRecord?.finding.title ?? "Finding details"}</DialogTitle>
            <DialogDescription>
              Review complete evidence, then record ownership, notes, or a deliberate snooze.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-5">
            {manageRecord ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={severityVariant(manageRecord.finding.severity)}>
                    {manageRecord.finding.severity}
                  </Badge>
                  <Badge variant="outline">{TYPE_PRESENTATION[manageRecord.type].singular}</Badge>
                  <Badge variant={statusVariant(manageRecord.status)}>
                    {STATUS_LABELS[manageRecord.status]}
                  </Badge>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">
                  {manageRecord.finding.summary}
                </p>
                {manageRecord.finding.evidence.length > 0 ? (
                  <section>
                    <h3 className="text-sm font-semibold">Evidence</h3>
                    <ul className="mt-2 grid gap-1.5 text-sm text-foreground/80">
                      {manageRecord.finding.evidence.map((evidence) => (
                        <li className="break-words" key={evidence}>
                          • {evidence}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {manageRecord.finding.actionability ? (
                  <section className="grid gap-2 rounded-xl border bg-muted/20 p-3 text-sm">
                    <h3 className="font-semibold">Proposed work</h3>
                    <p>{manageRecord.finding.actionability.proposal}</p>
                    <h3 className="mt-1 font-semibold">Expected value</h3>
                    <p>{manageRecord.finding.actionability.expectedValue}</p>
                  </section>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel>Assignee</FieldLabel>
                    <Input
                      disabled={updatingFindingId !== null}
                      onChange={(event) => setManageAssignee(event.currentTarget.value)}
                      placeholder="Name or team"
                      value={manageAssignee}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Snooze duration</FieldLabel>
                    <Select
                      value={snoozeDays}
                      onValueChange={(value) => value && setSnoozeDays(value)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        <SelectItem value="1">1 day</SelectItem>
                        <SelectItem value="3">3 days</SelectItem>
                        <SelectItem value="7">1 week</SelectItem>
                        <SelectItem value="30">30 days</SelectItem>
                      </SelectPopup>
                    </Select>
                  </Field>
                </div>
                <Field>
                  <FieldLabel>Decision note</FieldLabel>
                  <Textarea
                    disabled={updatingFindingId !== null}
                    onChange={(event) => setManageNote(event.currentTarget.value)}
                    placeholder="Record context for the next person who reviews this finding."
                    rows={4}
                    value={manageNote}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Source: {manageRecord.finding.provenance.source}. First seen{" "}
                  {formatRelativeTimeLabel(manageRecord.finding.firstSeenAt) ||
                    "at an unknown time"}
                  ; seen {manageRecord.finding.occurrenceCount}{" "}
                  {manageRecord.finding.occurrenceCount === 1 ? "time" : "times"}.
                </p>
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter className="flex-wrap">
            <DialogClose render={<Button disabled={updatingFindingId !== null} variant="ghost" />}>
              Close
            </DialogClose>
            <Button
              disabled={!manageRecord || !manageNote.trim() || updatingFindingId !== null}
              onClick={() => {
                if (!manageRecord) return;
                void applyDisposition(manageRecord, "acknowledge", {
                  note: manageNote.trim(),
                }).then(() => setManageRecord(null));
              }}
              variant="outline"
            >
              Save note
            </Button>
            <Button
              disabled={!manageRecord || !manageAssignee.trim() || updatingFindingId !== null}
              onClick={() => {
                if (!manageRecord) return;
                void applyDisposition(manageRecord, "assign", {
                  assignee: manageAssignee.trim(),
                  note: manageNote.trim() || null,
                }).then(() => setManageRecord(null));
              }}
              variant="outline"
            >
              Assign
            </Button>
            <Button
              disabled={!manageRecord || updatingFindingId !== null}
              onClick={() => {
                if (!manageRecord) return;
                const days = Number(snoozeDays);
                const snoozeUntil = new Date(
                  Date.now() + days * 24 * 60 * 60 * 1_000,
                ).toISOString();
                void applyDisposition(manageRecord, "snooze", {
                  snoozeUntil,
                  note: manageNote.trim() || null,
                }).then(() => setManageRecord(null));
              }}
            >
              <ClockIcon />
              Snooze
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={researchSetupOpen}
        onOpenChange={(open) => {
          if (!savingResearchSource) setResearchSetupOpen(open);
        }}
      >
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveResearchSource();
            }}
          >
            <DialogHeader>
              <DialogTitle>Set up repository research</DialogTitle>
              <DialogDescription>
                Add a topic or source to the local watchlist. T3 will collect it immediately and
                include it in future portfolio runs.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="grid gap-4">
              <Field>
                <FieldLabel>Repository</FieldLabel>
                <Select
                  value={researchProjectId || projectOptions[0]?.[0] || ""}
                  onValueChange={(value) => value && setResearchProjectId(value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {projectOptions.map(([projectId, projectName]) => (
                      <SelectItem key={projectId} value={projectId}>
                        {projectName}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Topic or source</FieldLabel>
                <Input
                  autoFocus
                  disabled={savingResearchSource}
                  onChange={(event) => setResearchTitle(event.currentTarget.value)}
                  placeholder="Track compiler performance research"
                  required
                  value={researchTitle}
                />
              </Field>
              <Field>
                <FieldLabel>What should T3 watch for?</FieldLabel>
                <Textarea
                  disabled={savingResearchSource}
                  onChange={(event) => setResearchSummary(event.currentTarget.value)}
                  placeholder="Explain what would make a result relevant to this repository."
                  required
                  rows={4}
                  value={researchSummary}
                />
              </Field>
              <Field>
                <FieldLabel>Source URL (optional)</FieldLabel>
                <Input
                  disabled={savingResearchSource}
                  onChange={(event) => setResearchUrl(event.currentTarget.value)}
                  placeholder="https://example.com/research"
                  type="url"
                  value={researchUrl}
                />
              </Field>
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button disabled={savingResearchSource} variant="outline" />}>
                Cancel
              </DialogClose>
              <Button
                disabled={
                  !researchTitle.trim() ||
                  !researchSummary.trim() ||
                  projectOptions.length === 0 ||
                  savingResearchSource
                }
                type="submit"
              >
                {savingResearchSource ? <LoaderIcon className="animate-spin" /> : <PlusIcon />}
                {savingResearchSource ? "Saving" : "Save and collect"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </AgentDashboardPageShell>
  );
}

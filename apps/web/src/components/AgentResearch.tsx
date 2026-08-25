import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { AgentDashboardDispositionAction, EnvironmentId } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  ClockIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  FolderGit2Icon,
  GithubIcon,
  LoaderIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  buildNativeResearchRecordsFromCanonicalFindings,
  buildNativeResearchRecordsFromDurableFindings,
  buildResearchFindingPrompt,
  findDashboardProject,
  githubRepositoryForIdentity,
  mergeNativeResearchRecords,
  suggestionWorkModelSelection,
  suggestionWorktreeBaseBranch,
  type NativeResearchRecord,
} from "../agentDashboardPages";
import { usePrimarySettings } from "../hooks/useSettings";
import { newMessageId, newThreadId, randomHex } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { resolveAppModelSelectionState } from "../modelSelection";
import { agentDashboardEnvironment, useAgentDashboardSnapshot } from "../state/agentDashboard";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { AgentDashboardPageShell } from "./AgentDashboardPageShell";
import { AgentFindingActions } from "./AgentFindingActions";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type ResearchStage = "actionable" | "needs-research" | "ready" | "in-progress" | "done" | "archive";
type ResearchIntent = "research" | "implement";

function researchStage(record: NativeResearchRecord): Exclude<ResearchStage, "actionable"> {
  if (record.workflow.kind !== "finding") return "archive";
  if (record.workflow.state === "done") return "done";
  if (record.workflow.threadId || record.workflow.state === "in-progress") return "in-progress";
  return record.workflow.actionability?.readiness === "ready" ? "ready" : "needs-research";
}

function stageLabel(stage: Exclude<ResearchStage, "actionable">): string {
  switch (stage) {
    case "needs-research":
      return "Needs research";
    case "ready":
      return "Ready to implement";
    case "in-progress":
      return "In progress";
    case "done":
      return "Done";
    case "archive":
      return "Archive";
  }
}

function stageVariant(stage: Exclude<ResearchStage, "actionable">) {
  switch (stage) {
    case "needs-research":
      return "warning" as const;
    case "ready":
    case "in-progress":
      return "info" as const;
    case "done":
      return "success" as const;
    case "archive":
      return "outline" as const;
  }
}

function scoreVariant(score: number) {
  if (score >= 80) return "success" as const;
  if (score >= 60) return "warning" as const;
  return "outline" as const;
}

function canonicalFindingIsHidden(record: NativeResearchRecord): boolean {
  if (record.workflow.kind !== "finding") return false;
  if (record.workflow.state === "dismissed" || record.workflow.state === "blocked") return true;
  return (
    record.workflow.state === "snoozed" &&
    record.workflow.snoozeUntil !== null &&
    Date.parse(record.workflow.snoozeUntil) > Date.now()
  );
}

export function AgentResearch() {
  const navigate = useNavigate();
  const settings = usePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const dashboardSnapshot = useAgentDashboardSnapshot();
  const collect = useAtomCommand(agentDashboardEnvironment.collect, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
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
  const [stageFilter, setStageFilter] = useState<ResearchStage>("actionable");
  const [isCollecting, setIsCollecting] = useState(false);
  const [startingAction, setStartingAction] = useState<string | null>(null);
  const [creatingIssueId, setCreatingIssueId] = useState<string | null>(null);
  const [updatingFindingId, setUpdatingFindingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    readonly id: string;
    readonly message: string;
  } | null>(null);

  const records = useMemo(() => {
    if (dashboardSnapshot.data === null || dashboardSnapshot.environmentId === null) return [];
    return mergeNativeResearchRecords(
      buildNativeResearchRecordsFromCanonicalFindings(dashboardSnapshot.data),
      buildNativeResearchRecordsFromDurableFindings(
        dashboardSnapshot.data,
        dashboardSnapshot.environmentId,
      ),
    );
  }, [dashboardSnapshot.data, dashboardSnapshot.environmentId]);

  const visibleRecords = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return records.filter((record) => {
      if (canonicalFindingIsHidden(record)) return false;
      const stage = researchStage(record);
      if (
        stageFilter === "actionable"
          ? stage === "done" || stage === "archive"
          : stage !== stageFilter
      ) {
        return false;
      }
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
  }, [query, records, stageFilter]);

  const dashboardRepositoryForRecord = useCallback(
    (record: NativeResearchRecord) =>
      dashboardSnapshot.data?.repositories.find(
        (candidate) =>
          String(candidate.projectId) === record.projectId ||
          (record.workspaceRoot.length > 0 && candidate.workspaceRoot === record.workspaceRoot),
      ) ?? null,
    [dashboardSnapshot.data?.repositories],
  );

  const projectForRecord = useCallback(
    (record: NativeResearchRecord, environmentId: EnvironmentId): EnvironmentProject | null =>
      findDashboardProject(
        projects,
        { projectId: record.projectId, repositoryPath: record.workspaceRoot },
        environmentId,
      ),
    [projects],
  );

  const githubRepositoryForRecord = useCallback(
    (record: NativeResearchRecord): string | null => {
      const environmentId = dashboardSnapshot.environmentId;
      const project = environmentId ? projectForRecord(record, environmentId) : null;
      return (
        githubRepositoryForIdentity(dashboardRepositoryForRecord(record)?.repositoryIdentity) ??
        githubRepositoryForIdentity(project?.repositoryIdentity)
      );
    },
    [dashboardRepositoryForRecord, dashboardSnapshot.environmentId, projectForRecord],
  );

  const showFailure = useCallback((id: string, title: string, message: string) => {
    setActionError({ id, message });
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  }, []);

  const openExternal = useCallback(async (url: string, label: string) => {
    try {
      const localApi = readLocalApi();
      if (localApi) {
        await localApi.shell.openExternal(url);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not open ${label}`,
          description: error instanceof Error ? error.message : "The link could not be opened.",
        }),
      );
    }
  }, []);

  const collectNow = async () => {
    if (!dashboardSnapshot.environmentId || isCollecting) return;
    setIsCollecting(true);
    try {
      const result = await collect({
        environmentId: dashboardSnapshot.environmentId,
        input: { kind: "research" },
      });
      if (result._tag === "Success") await dashboardSnapshot.refresh();
    } finally {
      setIsCollecting(false);
    }
  };

  const applyDisposition = useCallback(
    async (record: NativeResearchRecord, action: AgentDashboardDispositionAction) => {
      if (record.workflow.kind !== "finding" || !dashboardSnapshot.environmentId) return;
      setUpdatingFindingId(record.workflow.findingId);
      setActionError((current) => (current?.id === record.id ? null : current));
      try {
        const result = await applyFindingAction({
          environmentId: dashboardSnapshot.environmentId,
          input: { id: record.workflow.findingId, action },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            showFailure(
              record.id,
              "Could not update finding",
              error instanceof Error ? error.message : "The finding could not be updated.",
            );
          }
          return;
        }
        if (!result.value.ok || result.value.outcome === "not-found") {
          showFailure(
            record.id,
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
    [applyFindingAction, dashboardSnapshot, showFailure],
  );

  const createIssueForRecord = useCallback(
    async (record: NativeResearchRecord) => {
      if (record.workflow.kind !== "finding" || !dashboardSnapshot.environmentId) return;
      if (record.workflow.githubIssueUrl) {
        await openExternal(record.workflow.githubIssueUrl, "GitHub issue");
        return;
      }
      if (!githubRepositoryForRecord(record) || creatingIssueId !== null) return;
      setCreatingIssueId(record.id);
      setActionError((current) => (current?.id === record.id ? null : current));
      try {
        const result = await createGithubIssue({
          environmentId: dashboardSnapshot.environmentId,
          input: { id: record.workflow.findingId },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            showFailure(
              record.id,
              "Could not create GitHub issue",
              error instanceof Error ? error.message : "The GitHub issue could not be created.",
            );
          }
          return;
        }
        if (!result.value.ok || result.value.outcome === "not-found") {
          showFailure(
            record.id,
            "GitHub issue was not created",
            result.value.message ?? "The finding could not be found.",
          );
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "GitHub issue created",
            description: "The issue link is now attached to this research finding.",
          }),
        );
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

  const startFindingThread = useCallback(
    async (record: NativeResearchRecord, intent: ResearchIntent) => {
      if (record.workflow.kind !== "finding" || startingAction !== null) return;
      const environmentId =
        dashboardSnapshot.environmentId ?? primaryEnvironment?.environmentId ?? null;
      if (!environmentId) {
        showFailure(
          record.id,
          "Connect an environment first",
          "This finding needs a T3 Code environment to start an agent session.",
        );
        return;
      }
      if (record.workflow.threadId) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: record.workflow.threadId },
        });
        return;
      }
      const project = projectForRecord(record, environmentId);
      if (!project) {
        showFailure(
          record.id,
          "Add this repository to T3 Code first",
          `No project is configured for ${record.workspaceRoot || record.repositoryName}.`,
        );
        return;
      }
      const actionability = record.workflow.actionability;
      if (intent === "implement" && actionability?.readiness !== "ready") {
        showFailure(
          record.id,
          "More research is needed",
          "Qualify a concrete proposal, code targets, and validation plan before starting implementation.",
        );
        return;
      }
      const baseBranch =
        intent === "implement"
          ? suggestionWorktreeBaseBranch(dashboardRepositoryForRecord(record)?.vcs)
          : null;
      if (intent === "implement" && !baseBranch) {
        showFailure(
          record.id,
          "Primary branch not found",
          "T3 could not identify this repository's default branch. Refresh repository data and try again.",
        );
        return;
      }
      const availableModelSelection = resolveAppModelSelectionState(settings, serverProviders);
      if (availableModelSelection.model.trim().length === 0) {
        showFailure(
          record.id,
          "Enable an agent provider first",
          "Choose and authenticate a provider before starting research work.",
        );
        return;
      }

      const modelSelection = suggestionWorkModelSelection(availableModelSelection);
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = `${intent === "implement" ? "Work on" : "Research"}: ${record.title}`.slice(
        0,
        80,
      );
      setStartingAction(`${intent}:${record.id}`);
      setActionError((current) => (current?.id === record.id ? null : current));
      try {
        const result = await startThreadTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: buildResearchFindingPrompt(record, intent),
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
              record.id,
              intent === "implement" ? "Could not start work" : "Could not start research",
              error instanceof Error ? error.message : "The agent session could not be started.",
            );
          }
          return;
        }

        const linkResult = await linkFindingThread({
          environmentId,
          input: { id: record.workflow.findingId, projectId: project.id, threadId },
        });
        const linkFailure = (() => {
          if (linkResult._tag === "Failure") {
            if (isAtomCommandInterrupted(linkResult)) return null;
            const error = squashAtomCommandFailure(linkResult);
            return error instanceof Error
              ? error.message
              : "The finding could not be linked to the agent.";
          }
          if (!linkResult.value.ok || linkResult.value.outcome === "not-found") {
            return linkResult.value.message ?? "The finding could not be linked to the agent.";
          }
          return null;
        })();
        if (linkFailure) {
          showFailure(record.id, "Agent started without a dashboard link", linkFailure);
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: intent === "implement" ? "Work started" : "Research started",
            description:
              intent === "implement"
                ? `The agent is running in a new worktree from ${baseBranch}.`
                : "The research agent is inspecting this repository now.",
          }),
        );
        await dashboardSnapshot.refresh();
      } finally {
        setStartingAction(null);
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
      startingAction,
    ],
  );

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
      description="Repository-grounded findings with a concrete path from research to implementation."
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
        <Select
          value={stageFilter}
          onValueChange={(value) => value && setStageFilter(value as ResearchStage)}
        >
          <SelectTrigger aria-label="Filter research by stage" className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="actionable">Actionable</SelectItem>
            <SelectItem value="needs-research">Needs research</SelectItem>
            <SelectItem value="ready">Ready to implement</SelectItem>
            <SelectItem value="in-progress">In progress</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="archive">Legacy archive</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      {visibleRecords.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {visibleRecords.map((record) => {
            const stage = researchStage(record);
            const workflow = record.workflow.kind === "finding" ? record.workflow : null;
            const actionability = workflow?.actionability ?? null;
            const repository = githubRepositoryForRecord(record);
            const actionIsPending = startingAction?.endsWith(`:${record.id}`) ?? false;
            const findingIsUpdating = workflow !== null && updatingFindingId === workflow.findingId;
            return (
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
                        <Badge size="sm" variant={stageVariant(stage)}>
                          {stageLabel(stage)}
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

                  {actionability ? (
                    <div className="grid gap-3 rounded-lg border border-border/70 bg-muted/25 p-3">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Proposed work</p>
                        <p className="mt-1 text-sm">{actionability.proposal}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Expected value</p>
                        <p className="mt-1 text-sm">{actionability.expectedValue}</p>
                      </div>
                      {actionability.targets.length > 0 ? (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground">Code targets</p>
                          <ul className="mt-1 grid gap-1 text-xs">
                            {actionability.targets.map((target) => (
                              <li key={`${target.path}:${target.symbol ?? ""}`}>
                                <code>{target.path}</code>
                                {target.symbol ? ` · ${target.symbol}` : ""}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {actionability.validationPlan.length > 0 ? (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground">Validation</p>
                          <ul className="mt-1 grid gap-1 text-xs">
                            {actionability.validationPlan.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : record.durableFinding?.topicContext ? (
                    <div className="rounded-lg border border-border/70 bg-muted/35 p-3">
                      <p className="text-xs font-medium text-muted-foreground">Why it surfaced</p>
                      <p className="mt-1 text-sm">{record.durableFinding.topicContext}</p>
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
                        <Tooltip>
                          <TooltipTrigger
                            render={<p className="mt-1 truncate font-mono text-xs" />}
                          >
                            {record.workspaceRoot || "Not linked"}
                          </TooltipTrigger>
                          <TooltipPopup>{record.workspaceRoot || "Not linked"}</TooltipPopup>
                        </Tooltip>
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
                    {workflow?.threadId ? (
                      <div className="flex items-start gap-2 text-sm sm:col-span-2">
                        <TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div>
                          <p className="text-xs text-muted-foreground">Agent work</p>
                          <p className="mt-1 text-xs">Linked to an active T3 Code thread</p>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {record.evidence.length > 0 ? (
                    <div className="border-t border-border/60 pt-3">
                      <p className="text-xs font-medium text-muted-foreground">Evidence</p>
                      <ul className="mt-2 grid gap-1 text-xs text-foreground/80">
                        {record.evidence.map((evidence) => (
                          <li key={evidence}>{evidence}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {actionError?.id === record.id ? (
                    <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {actionError.message}
                    </p>
                  ) : null}

                  <AgentFindingActions
                    className="border-t border-border/60 pt-3"
                    actions={[
                      workflow && workflow.state !== "done"
                        ? {
                            id: "research",
                            label: workflow.threadId ? "Open agent" : "Research further",
                            pendingLabel: "Starting research",
                            icon: FlaskConicalIcon,
                            pending: startingAction === `research:${record.id}`,
                            disabled: actionIsPending,
                            onSelect: () => void startFindingThread(record, "research"),
                            variant: "outline",
                          }
                        : null,
                      workflow && workflow.state !== "done" && !workflow.threadId
                        ? {
                            id: "implement",
                            label: "Start work",
                            pendingLabel: "Starting work",
                            icon: PlayIcon,
                            pending: startingAction === `implement:${record.id}`,
                            disabled: actionIsPending || actionability?.readiness !== "ready",
                            title:
                              actionability?.readiness === "ready"
                                ? undefined
                                : "Research this finding until it has a proposal, code targets, and validation plan.",
                            onSelect: () => void startFindingThread(record, "implement"),
                          }
                        : null,
                      workflow
                        ? {
                            id: "issue",
                            label: workflow.githubIssueUrl ? "Open issue" : "Create issue",
                            pendingLabel: "Creating issue",
                            icon: workflow.githubIssueUrl ? ExternalLinkIcon : GithubIcon,
                            pending: creatingIssueId === record.id,
                            disabled:
                              creatingIssueId !== null ||
                              (!workflow.githubIssueUrl && repository === null),
                            title:
                              !workflow.githubIssueUrl && repository === null
                                ? "Connect this repository to GitHub before creating an issue."
                                : undefined,
                            onSelect: () => void createIssueForRecord(record),
                            variant: "outline",
                          }
                        : null,
                      record.remoteUrl && /^https?:\/\//i.test(record.remoteUrl)
                        ? {
                            id: "source",
                            label: "Open source",
                            icon: ExternalLinkIcon,
                            onSelect: () => void openExternal(record.remoteUrl!, "research source"),
                            variant: "ghost",
                          }
                        : null,
                      workflow && workflow.state !== "done"
                        ? {
                            id: "done",
                            label: "Done",
                            icon: CheckCircle2Icon,
                            pending: findingIsUpdating,
                            disabled: updatingFindingId !== null,
                            onSelect: () => void applyDisposition(record, "complete"),
                            variant: "outline",
                          }
                        : null,
                      workflow && workflow.state !== "done"
                        ? {
                            id: "snooze",
                            label: "Snooze",
                            icon: ClockIcon,
                            pending: findingIsUpdating,
                            disabled: updatingFindingId !== null,
                            onSelect: () => void applyDisposition(record, "snooze"),
                            variant: "ghost",
                          }
                        : null,
                      workflow?.state === "done"
                        ? {
                            id: "reopen",
                            label: "Reopen",
                            icon: RotateCcwIcon,
                            pending: findingIsUpdating,
                            disabled: updatingFindingId !== null,
                            onSelect: () => void applyDisposition(record, "reopen"),
                            variant: "outline",
                          }
                        : null,
                      workflow && workflow.state !== "done"
                        ? {
                            id: "dismiss",
                            label: "Dismiss",
                            icon: XIcon,
                            pending: findingIsUpdating,
                            disabled: updatingFindingId !== null,
                            onSelect: () => void applyDisposition(record, "dismiss"),
                            variant: "ghost",
                          }
                        : null,
                    ]}
                  />
                </CardPanel>
              </Card>
            );
          })}
        </div>
      ) : (
        <Empty className="min-h-72 border border-dashed border-border/70 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpenIcon />
            </EmptyMedia>
            <EmptyTitle>
              {records.length === 0
                ? "No research findings yet"
                : stageFilter === "actionable"
                  ? "No actionable findings yet"
                  : "No matching findings"}
            </EmptyTitle>
            <EmptyDescription>
              {records.length === 0
                ? "Run a research collection in T3 Code and its findings will appear here."
                : stageFilter === "actionable"
                  ? "Imported research remains available in the Legacy archive. New findings appear here after they are tied to a repository."
                  : stageFilter === "archive"
                    ? "No legacy research matches this search."
                    : "Try a different search or research stage."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AgentDashboardPageShell>
  );
}

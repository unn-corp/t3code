import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type {
  SourceControlProjectPullRequest,
  SourceControlPullRequestMergeMethod,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  Clock3Icon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  LoaderIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { defaultDashboardPullRequestCombinationTitle } from "../agentDashboardPages";
import { cn } from "../lib/utils";
import type { AppModelOption } from "../modelSelection";
import type { ProviderInstanceEntry } from "../providerInstances";
import { agentDashboardEnvironment } from "../state/agentDashboard";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { getComposerProviderState } from "./chat/composerProviderState";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { RUNTIME_MODE_OPTIONS, RUNTIME_MODE_PRESENTATION } from "./chat/runtimeModePresentation";
import { TraitsPicker } from "./chat/TraitsPicker";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
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
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { stackedThreadToast, toastManager } from "./ui/toast";

function checkBadge(pullRequest: SourceControlProjectPullRequest) {
  switch (pullRequest.checkStatus) {
    case "passing":
      return { label: "Checks pass", variant: "success" as const, icon: CheckCircle2Icon };
    case "pending":
      return { label: "Checks pending", variant: "warning" as const, icon: Clock3Icon };
    case "failing":
      return { label: "Checks fail", variant: "error" as const, icon: CircleAlertIcon };
    case "unknown":
      return { label: "No checks", variant: "outline" as const, icon: Clock3Icon };
  }
}

function reviewBadge(pullRequest: SourceControlProjectPullRequest) {
  switch (pullRequest.reviewDecision) {
    case "approved":
      return { label: "Approved", variant: "success" as const };
    case "changes-requested":
      return { label: "Changes requested", variant: "error" as const };
    case "review-required":
      return { label: "Review required", variant: "warning" as const };
    case "none":
      return null;
  }
}

function safeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function AgentProjectPullRequests({
  environmentId,
  projectId,
  projectName,
  combinationBusy,
  initialModelSelection,
  providerInstanceEntries,
  modelOptionsByInstance,
  onCombinePullRequests,
  onOpenExternal,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly combinationBusy: boolean;
  readonly initialModelSelection: ModelSelection;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly onCombinePullRequests: (input: {
    readonly pullRequests: ReadonlyArray<SourceControlProjectPullRequest>;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
  }) => Promise<boolean>;
  readonly onOpenExternal: (url: string) => Promise<void>;
}) {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : agentDashboardEnvironment.projectPullRequests({
          environmentId,
          input: { projectId },
        }),
  );
  const mergePullRequest = useAtomCommand(agentDashboardEnvironment.mergeProjectPullRequest, {
    reportFailure: false,
  });
  const [selectedPullRequest, setSelectedPullRequest] =
    useState<SourceControlProjectPullRequest | null>(null);
  const [mergeMethod, setMergeMethod] = useState<SourceControlPullRequestMergeMethod>("squash");
  const [merging, setMerging] = useState(false);
  const [selectedPullRequestNumbers, setSelectedPullRequestNumbers] = useState<
    ReadonlyArray<number>
  >([]);
  const [combineDialogOpen, setCombineDialogOpen] = useState(false);
  const [combinationOrder, setCombinationOrder] = useState<
    ReadonlyArray<SourceControlProjectPullRequest>
  >([]);
  const [combinationTitle, setCombinationTitle] = useState("");
  const [combinationModelSelection, setCombinationModelSelection] =
    useState<ModelSelection>(initialModelSelection);
  const [combinationRuntimeMode, setCombinationRuntimeMode] =
    useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const pullRequests = query.data?.pullRequests ?? [];
  const selectedPullRequests = useMemo(
    () =>
      selectedPullRequestNumbers.flatMap((number) => {
        const pullRequest = pullRequests.find((candidate) => candidate.number === number);
        return pullRequest ? [pullRequest] : [];
      }),
    [pullRequests, selectedPullRequestNumbers],
  );
  const selectedBaseBranches = new Set(
    selectedPullRequests.map((pullRequest) => pullRequest.baseRefName),
  );
  const canCombine = selectedPullRequests.length >= 2 && selectedBaseBranches.size === 1;
  const selectedProviderEntry = providerInstanceEntries.find(
    (entry) => entry.instanceId === combinationModelSelection.instanceId,
  );
  const runtimeModeOption = RUNTIME_MODE_PRESENTATION[combinationRuntimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;

  useEffect(() => {
    const availableNumbers = new Set(pullRequests.map((pullRequest) => pullRequest.number));
    setSelectedPullRequestNumbers((current) =>
      current.every((number) => availableNumbers.has(number))
        ? current
        : current.filter((number) => availableNumbers.has(number)),
    );
  }, [pullRequests]);

  useEffect(() => {
    if (
      selectedProviderEntry?.enabled &&
      selectedProviderEntry.isAvailable &&
      combinationModelSelection.model.trim().length > 0
    ) {
      return;
    }
    setCombinationModelSelection(initialModelSelection);
  }, [combinationModelSelection.model, initialModelSelection, selectedProviderEntry]);

  const openCombinationDialog = () => {
    if (!canCombine || combinationBusy) return;
    setCombinationOrder(selectedPullRequests);
    setCombinationTitle(defaultDashboardPullRequestCombinationTitle(selectedPullRequests));
    setCombinationModelSelection(initialModelSelection);
    setCombinationRuntimeMode(DEFAULT_RUNTIME_MODE);
    setCombineDialogOpen(true);
  };

  const moveCombinationPullRequest = (index: number, offset: -1 | 1) => {
    setCombinationOrder((current) => {
      const targetIndex = index + offset;
      if (targetIndex < 0 || targetIndex >= current.length) return current;
      const next = [...current];
      const currentPullRequest = next[index];
      const targetPullRequest = next[targetIndex];
      if (!currentPullRequest || !targetPullRequest) return current;
      next[index] = targetPullRequest;
      next[targetIndex] = currentPullRequest;
      return next;
    });
  };

  const launchCombination = async () => {
    const title = combinationTitle.trim();
    if (
      combinationBusy ||
      combinationOrder.length < 2 ||
      !title ||
      combinationModelSelection.model.trim().length === 0
    ) {
      return;
    }
    const launched = await onCombinePullRequests({
      pullRequests: combinationOrder,
      title,
      modelSelection: combinationModelSelection,
      runtimeMode: combinationRuntimeMode,
    });
    if (launched) {
      setCombineDialogOpen(false);
      setSelectedPullRequestNumbers([]);
    }
  };

  const confirmMerge = async () => {
    if (!environmentId || !selectedPullRequest || merging) return;
    setMerging(true);
    try {
      const result = await mergePullRequest({
        environmentId,
        input: {
          projectId,
          number: selectedPullRequest.number,
          expectedHeadOid: selectedPullRequest.headRefOid,
          method: mergeMethod,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `PR #${selectedPullRequest.number} was not merged`,
              description:
                error instanceof Error
                  ? error.message
                  : "GitHub rejected the merge. Refresh the PR and review its current status.",
            }),
          );
        }
        query.refresh();
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Merge submitted for PR #${selectedPullRequest.number}`,
          description: `GitHub accepted the ${mergeMethod} request for ${projectName}.`,
        }),
      );
      setSelectedPullRequest(null);
      query.refresh();
    } finally {
      setMerging(false);
    }
  };

  return (
    <>
      <Collapsible>
        <div className="rounded-xl border border-border/70 bg-muted/15">
          <CollapsibleTrigger className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring data-panel-open:[&>svg]:rotate-180">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
              <GitPullRequestIcon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Pending pull requests</span>
                {query.isPending && query.data === null ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Badge
                    size="sm"
                    variant={pullRequests.length > 0 ? "info" : query.error ? "warning" : "outline"}
                  >
                    {query.error ? "Needs attention" : `${pullRequests.length} open`}
                  </Badge>
                )}
              </div>
              <span className="block truncate text-xs text-muted-foreground">
                Review checks, approvals, and merge readiness for {projectName}
              </span>
            </div>
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="border-t border-border/60 p-3">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="grid gap-0.5">
                  <p className="text-xs text-muted-foreground">
                    Direct merges require confirmation and verify the reviewed head commit.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Select two or more PRs with the same target to combine them in a new agent
                    session.
                  </p>
                </div>
                <Button
                  aria-label={`Refresh pull requests for ${projectName}`}
                  disabled={query.isPending}
                  onClick={query.refresh}
                  size="icon-xs"
                  variant="ghost"
                >
                  <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
                </Button>
              </div>
              {query.error ? (
                <div className="rounded-lg border border-warning/35 bg-warning/8 p-3 text-sm">
                  <div className="flex items-start gap-2">
                    <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                    <div className="grid gap-1">
                      <p className="font-medium text-foreground">Pull requests are unavailable</p>
                      <p className="text-muted-foreground">{query.error}</p>
                      <p className="text-xs text-muted-foreground">
                        Add a GitHub remote in Source control, or run gh auth login in the terminal,
                        then refresh.
                      </p>
                    </div>
                  </div>
                </div>
              ) : pullRequests.length === 0 && !query.isPending ? (
                <div className="rounded-lg border border-dashed border-border/70 px-3 py-5 text-center text-sm text-muted-foreground">
                  No open pull requests for this project.
                </div>
              ) : (
                <div className="grid gap-3">
                  <div
                    className={cn(
                      "grid gap-3 rounded-lg border border-border/70 bg-background p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
                      selectedPullRequests.length > 0 && "border-primary/35 bg-primary/4",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <ListChecksIcon className="size-4 text-muted-foreground" />
                        <p className="text-sm font-medium">
                          {selectedPullRequests.length === 0
                            ? "Build a combined pull request"
                            : `${selectedPullRequests.length} selected`}
                        </p>
                        {selectedBaseBranches.size > 1 ? (
                          <Badge size="sm" variant="warning">
                            Different target branches
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedBaseBranches.size > 1
                          ? "Choose PRs that target the same branch before continuing."
                          : selectedPullRequests.length === 1
                            ? "Select at least one more PR from this project."
                            : "The agent verifies each reviewed head, integrates them in order, and opens one replacement PR."}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                      <Button
                        className="min-h-11 sm:min-h-8"
                        disabled={selectedPullRequests.length === 0 || combinationBusy}
                        onClick={() => setSelectedPullRequestNumbers([])}
                        size="xs"
                        variant="outline"
                      >
                        Clear
                      </Button>
                      <Button
                        className="min-h-11 sm:min-h-8"
                        disabled={!canCombine || combinationBusy}
                        onClick={openCombinationDialog}
                        size="xs"
                      >
                        {combinationBusy ? (
                          <LoaderIcon className="animate-spin" />
                        ) : (
                          <GitPullRequestIcon />
                        )}
                        Combine PRs
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    {pullRequests.map((pullRequest) => {
                      const checks = checkBadge(pullRequest);
                      const ChecksIcon = checks.icon;
                      const review = reviewBadge(pullRequest);
                      const selected = selectedPullRequestNumbers.includes(pullRequest.number);
                      return (
                        <article
                          className={cn(
                            "grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg border border-border/70 bg-card p-3 transition-colors sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center",
                            selected && "border-primary/45 bg-primary/4",
                          )}
                          key={pullRequest.number}
                        >
                          <label className="-m-2 flex min-h-11 min-w-11 cursor-pointer items-start justify-center p-2 pt-2.5 sm:items-center sm:pt-2">
                            <Checkbox
                              aria-label={`Select PR #${pullRequest.number} to combine`}
                              checked={selected}
                              onCheckedChange={(checked) =>
                                setSelectedPullRequestNumbers((current) =>
                                  checked === true
                                    ? current.includes(pullRequest.number)
                                      ? current
                                      : [...current, pullRequest.number]
                                    : current.filter((number) => number !== pullRequest.number),
                                )
                              }
                            />
                          </label>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs text-muted-foreground">
                                #{pullRequest.number}
                              </span>
                              <h4 className="min-w-0 truncate text-sm font-medium">
                                {pullRequest.title}
                              </h4>
                              {pullRequest.isDraft ? (
                                <Badge size="sm" variant="outline">
                                  Draft
                                </Badge>
                              ) : null}
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                              <span className="truncate font-mono">
                                {pullRequest.headRefName} → {pullRequest.baseRefName}
                              </span>
                              {pullRequest.authorLogin ? (
                                <span>by {pullRequest.authorLogin}</span>
                              ) : null}
                              <span>{formatRelativeTimeLabel(pullRequest.updatedAt)}</span>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <Badge size="sm" variant={checks.variant}>
                                <ChecksIcon className="size-3" />
                                {checks.label}
                              </Badge>
                              {review ? (
                                <Badge size="sm" variant={review.variant}>
                                  <ShieldCheckIcon className="size-3" />
                                  {review.label}
                                </Badge>
                              ) : null}
                              <Badge
                                size="sm"
                                variant={pullRequest.canMerge ? "success" : "outline"}
                              >
                                <GitMergeIcon className="size-3" />
                                {pullRequest.canMerge ? "Merge ready" : "Merge blocked"}
                              </Badge>
                            </div>
                            {pullRequest.mergeBlockedReason ? (
                              <p className="mt-2 text-xs text-muted-foreground">
                                {pullRequest.mergeBlockedReason}
                              </p>
                            ) : null}
                          </div>
                          <div className="col-start-2 grid grid-cols-2 gap-2 sm:col-start-auto sm:flex sm:flex-wrap sm:justify-end">
                            <Button
                              className="min-h-11 sm:min-h-8"
                              onClick={() => {
                                const url = safeExternalUrl(pullRequest.url);
                                if (url) void onOpenExternal(url);
                              }}
                              size="xs"
                              variant="outline"
                            >
                              <ExternalLinkIcon />
                              Open
                            </Button>
                            <Button
                              className="min-h-11 sm:min-h-8"
                              disabled={!pullRequest.canMerge || merging}
                              onClick={() => {
                                setMergeMethod("squash");
                                setSelectedPullRequest(pullRequest);
                              }}
                              size="xs"
                            >
                              <GitMergeIcon />
                              Merge
                            </Button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </CollapsiblePanel>
        </div>
      </Collapsible>

      <Dialog
        open={selectedPullRequest !== null}
        onOpenChange={(open) => {
          if (!open && !merging) setSelectedPullRequest(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Merge PR #{selectedPullRequest?.number}</DialogTitle>
            <DialogDescription>
              Confirm the target and merge strategy. T3 will refuse the merge if the head commit
              changed after this review.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            {selectedPullRequest ? (
              <div className="grid gap-3 rounded-xl border bg-muted/20 p-3">
                <p className="text-sm font-medium">{selectedPullRequest.title}</p>
                <div className="grid gap-1 font-mono text-xs text-muted-foreground sm:grid-cols-2">
                  <span>From {selectedPullRequest.headRefName}</span>
                  <span>Into {selectedPullRequest.baseRefName}</span>
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  Reviewed commit {selectedPullRequest.headRefOid}
                </p>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="pull-request-merge-method">
                Merge strategy
              </label>
              <Select
                value={mergeMethod}
                onValueChange={(value) =>
                  value && setMergeMethod(value as SourceControlPullRequestMergeMethod)
                }
              >
                <SelectTrigger className="w-full" id="pull-request-merge-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value="squash">Squash and merge</SelectItem>
                  <SelectItem value="merge">Create a merge commit</SelectItem>
                  <SelectItem value="rebase">Rebase and merge</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button disabled={merging} variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={!selectedPullRequest || merging} onClick={() => void confirmMerge()}>
              {merging ? <LoaderIcon className="animate-spin" /> : <GitMergeIcon />}
              {merging ? "Merging" : `Merge PR #${selectedPullRequest?.number ?? ""}`}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={combineDialogOpen}
        onOpenChange={(open) => {
          if (!open && !combinationBusy) setCombineDialogOpen(false);
        }}
      >
        <DialogPopup className="max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Combine {combinationOrder.length} PRs into one</DialogTitle>
            <DialogDescription>
              Review integration order and launch a dedicated agent in a fresh worktree. Source PRs
              stay open and unchanged.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-5 md:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.65fr)]">
            <div className="grid min-w-0 content-start gap-4">
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor={`combine-pr-title-${projectId}`}>
                  New pull request title
                </label>
                <Input
                  disabled={combinationBusy}
                  id={`combine-pr-title-${projectId}`}
                  maxLength={120}
                  onChange={(event) => setCombinationTitle(event.currentTarget.value)}
                  value={combinationTitle}
                />
              </div>
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">Integration order</h3>
                  <Badge size="sm" variant="outline">
                    Into {combinationOrder[0]?.baseRefName ?? "target branch"}
                  </Badge>
                </div>
                <div className="grid gap-2">
                  {combinationOrder.map((pullRequest, index) => (
                    <div
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border/70 bg-card p-3"
                      key={pullRequest.number}
                    >
                      <div className="flex size-7 items-center justify-center rounded-md bg-muted font-mono text-xs font-medium text-muted-foreground">
                        {index + 1}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                            #{pullRequest.number}
                          </span>
                          {pullRequest.title}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {pullRequest.headRefName}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          aria-label={`Move PR #${pullRequest.number} earlier`}
                          className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
                          disabled={index === 0 || combinationBusy}
                          onClick={() => moveCombinationPullRequest(index, -1)}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          aria-label={`Move PR #${pullRequest.number} later`}
                          className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
                          disabled={index === combinationOrder.length - 1 || combinationBusy}
                          onClick={() => moveCombinationPullRequest(index, 1)}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <ArrowDownIcon />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-info/25 bg-info/6 p-3 text-xs text-muted-foreground">
                The agent checks every selected head SHA before editing, then resolves conflicts and
                runs combined validation before opening the new PR.
              </div>
              {combinationOrder.some((pullRequest) => pullRequest.isDraft) ? (
                <div className="rounded-lg border border-warning/30 bg-warning/8 p-3 text-xs text-muted-foreground">
                  This plan includes a draft PR. The agent will preserve its changes, but draft work
                  may be incomplete and should receive extra review in the replacement PR.
                </div>
              ) : null}
            </div>

            <div className="grid min-w-0 content-start gap-3 rounded-xl border border-border/70 bg-muted/20 p-3">
              <div>
                <h3 className="text-sm font-medium">Agent setup</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Choose the model, effort, and repository access for this session.
                </p>
              </div>
              <div className="grid gap-2">
                {selectedProviderEntry ? (
                  <ProviderModelPicker
                    activeInstanceId={combinationModelSelection.instanceId}
                    disabled={combinationBusy}
                    instanceEntries={providerInstanceEntries}
                    lockedProvider={null}
                    model={combinationModelSelection.model}
                    modelOptionsByInstance={modelOptionsByInstance}
                    onInstanceModelChange={(instanceId, model) => {
                      const entry = providerInstanceEntries.find(
                        (candidate) => candidate.instanceId === instanceId,
                      );
                      if (!entry) return;
                      const providerState = getComposerProviderState({
                        provider: entry.driverKind,
                        model,
                        models: entry.models,
                        planModeEnabled: false,
                        modelOptions:
                          combinationModelSelection.instanceId === instanceId
                            ? combinationModelSelection.options
                            : undefined,
                      });
                      setCombinationModelSelection(
                        createModelSelection(
                          instanceId,
                          model,
                          providerState.modelOptionsForDispatch,
                        ),
                      );
                    }}
                    triggerAriaLabel="Choose model for combined pull request"
                    triggerClassName="w-full justify-between"
                  />
                ) : (
                  <p className="rounded-lg border border-warning/30 bg-warning/8 p-3 text-xs text-muted-foreground">
                    Enable an agent provider before launching this session.
                  </p>
                )}
                {selectedProviderEntry ? (
                  <TraitsPicker
                    allowPromptInjectedEffort={false}
                    instanceId={combinationModelSelection.instanceId}
                    model={combinationModelSelection.model}
                    modelOptions={combinationModelSelection.options}
                    models={selectedProviderEntry.models}
                    planModeEnabled={false}
                    onModelOptionsChange={(options) =>
                      setCombinationModelSelection(
                        createModelSelection(
                          combinationModelSelection.instanceId,
                          combinationModelSelection.model,
                          options,
                        ),
                      )
                    }
                    onPromptChange={() => undefined}
                    prompt=""
                    provider={selectedProviderEntry.driverKind}
                    triggerClassName="w-full justify-between"
                  />
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor={`combine-pr-access-${projectId}`}>
                  Access
                </label>
                <Select
                  disabled={combinationBusy}
                  value={combinationRuntimeMode}
                  onValueChange={(value) =>
                    value && setCombinationRuntimeMode(value as RuntimeMode)
                  }
                >
                  <SelectTrigger className="w-full" id={`combine-pr-access-${projectId}`}>
                    <RuntimeModeIcon className="size-4 text-muted-foreground" />
                    <SelectValue>{runtimeModeOption.label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {RUNTIME_MODE_OPTIONS.map((mode) => {
                      const option = RUNTIME_MODE_PRESENTATION[mode];
                      const OptionIcon = option.icon;
                      return (
                        <SelectItem className="min-w-64 py-2" hideIndicator key={mode} value={mode}>
                          <div className="grid min-w-0 gap-0.5">
                            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                              <OptionIcon className="size-3.5 text-muted-foreground" />
                              {option.label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              </div>
              {combinationRuntimeMode !== "full-access" ? (
                <p className="text-xs text-muted-foreground">
                  The agent may pause for approval before fetching, pushing, or opening the PR.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button disabled={combinationBusy} variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={
                combinationBusy ||
                combinationOrder.length < 2 ||
                combinationTitle.trim().length === 0 ||
                combinationModelSelection.model.trim().length === 0
              }
              onClick={() => void launchCombination()}
            >
              {combinationBusy ? <LoaderIcon className="animate-spin" /> : <GitPullRequestIcon />}
              {combinationBusy ? "Launching agent" : "Launch combination agent"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

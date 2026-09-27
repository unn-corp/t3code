import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { Organization, OrganizationWorkId, ProjectId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { OrganizationIntentActivation } from "./OrganizationIntentActivation";

type Destination = "sources" | "work" | "governance";

function RecordedTime({ value }: { readonly value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

function EvidenceState({
  label,
  query,
  offline,
}: {
  readonly label: string;
  readonly query: EnvironmentQueryView<unknown>;
  readonly offline: boolean;
}) {
  if (query.error) {
    return (
      <p role="alert" className="text-sm text-destructive-foreground">
        {label} could not load: {query.error}
      </p>
    );
  }
  if (query.isPending && query.data === null && !offline) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading {label.toLowerCase()}…
      </p>
    );
  }
  if (query.data === null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {offline
          ? `No saved ${label.toLowerCase()} response is available offline.`
          : `${label} are unavailable.`}
      </p>
    );
  }
  return null;
}

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number | string | null;
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-semibold tabular-nums">
        {value === null ? (
          <span className="text-sm text-muted-foreground">Not loaded</span>
        ) : (
          <span className="break-words text-2xl">{value}</span>
        )}
      </dd>
    </div>
  );
}

function elapsedFrom(startedAt: string, now: number) {
  const elapsedMinutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (!Number.isFinite(elapsedMinutes)) return "Unknown";
  if (elapsedMinutes === 0) return "Under 1 minute";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours} hr ${elapsedMinutes % 60} min`;
  return `${Math.floor(hours / 24)} days ${hours % 24} hr`;
}

export function OrganizationLiveOperations({
  organization,
  offline,
  onNavigate,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
  readonly onNavigate: (destination: Destination) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const [metricsAsOf, setMetricsAsOf] = useState(() => Date.now());
  const [cancelingWorkId, setCancelingWorkId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const cancelRequestIds = useRef(new Map<string, string>());
  const cancelWork = useAtomCommand(organizationEnvironment.cancelWork, { reportFailure: false });
  useEffect(() => {
    const timer = setInterval(() => setMetricsAsOf(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectName = (id: ProjectId) => projects.find((project) => project.id === id)?.title ?? id;
  const input = { organizationId: organization.id };
  const observations = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listObservations({ environmentId, input }),
  );
  const jobs = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listCorrelationJobs({ environmentId, input }),
  );
  const findings = useEnvironmentQuery(
    environmentId === null ? null : organizationEnvironment.listFindings({ environmentId, input }),
  );
  const work = useEnvironmentQuery(
    environmentId === null ? null : organizationEnvironment.listWork({ environmentId, input }),
  );
  const workIntents = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listWorkIntents({
          environmentId,
          input: { organizationId: organization.id, afterIntentId: null, limit: 100 },
        }),
  );
  const workFailures = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listWorkFailures({ environmentId, input }),
  );
  const runtimeStatus = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.getWorkRuntimeStatus({ environmentId, input }),
  );
  const observationMode = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.observationModeGet({ environmentId, input }),
  );
  const proposals = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.proposalList({
          environmentId,
          input: { organizationId: organization.id, afterProposalId: null, limit: 25 },
        }),
  );
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) {
      observations.refresh();
      jobs.refresh();
      findings.refresh();
      work.refresh();
      workIntents.refresh();
      workFailures.refresh();
      runtimeStatus.refresh();
      observationMode.refresh();
      proposals.refresh();
    }
    wasOffline.current = offline;
  }, [
    offline,
    observations.refresh,
    jobs.refresh,
    findings.refresh,
    work.refresh,
    workIntents.refresh,
    workFailures.refresh,
    runtimeStatus.refresh,
    observationMode.refresh,
    proposals.refresh,
  ]);

  function refresh() {
    observations.refresh();
    jobs.refresh();
    findings.refresh();
    work.refresh();
    workIntents.refresh();
    workFailures.refresh();
    runtimeStatus.refresh();
    observationMode.refresh();
    proposals.refresh();
  }

  async function cancel(item: { readonly id: OrganizationWorkId }) {
    if (offline || environmentId === null || cancelingWorkId !== null) return;
    const transitionId = cancelRequestIds.current.get(item.id) ?? randomUUID();
    cancelRequestIds.current.set(item.id, transitionId);
    setCancelingWorkId(item.id);
    setCancelError(null);
    setCancelNotice(null);
    try {
      const result = await cancelWork({
        environmentId,
        input: { organizationId: organization.id, workId: item.id, transitionId },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setCancelError(cause instanceof Error ? cause.message : String(cause));
      } else {
        setCancelNotice(`Work ${item.id} was canceled.`);
        work.refresh();
        workFailures.refresh();
      }
    } finally {
      setCancelingWorkId(null);
    }
  }

  const activeBindings = organization.bindings.filter((binding) => binding.detachedAt === null);
  const observationItems = observations.data?.observations ?? [];
  const jobItems = jobs.data?.jobs ?? [];
  const findingItems = findings.data?.findings ?? [];
  const workItems = work.data?.items ?? [];
  const waitingIntents = workIntents.data?.intents ?? [];
  const currentIntents = waitingIntents.filter((intent) => intent.freshness === "current");
  const staleIntents = waitingIntents.filter((intent) => intent.freshness === "stale");
  const pendingWorkItems = workItems.filter(({ work: item }) => item.status === "pending");
  const oldestPendingWork = pendingWorkItems.reduce<string | null>(
    (oldest, { work: item }) =>
      oldest === null || item.createdAt < oldest ? item.createdAt : oldest,
    null,
  );
  const attemptItems = workItems.flatMap((detail) => detail.attempts);
  const qaRejectedAttempts = attemptItems.filter((attempt) => attempt.status === "qa-rejected");
  const qaAcceptedAttempts = attemptItems.filter((attempt) => attempt.status === "qa-accepted");
  const proposalItems = proposals.data?.proposals ?? [];
  const proposedItems = proposalItems.filter((proposal) => proposal.state === "proposed");
  const staleProposedItems = proposedItems.filter((proposal) => !proposal.currentlyEligible);
  const proposalStateCounts = {
    acknowledged: proposalItems.filter((proposal) => proposal.state === "acknowledged").length,
    rejected: proposalItems.filter((proposal) => proposal.state === "rejected").length,
    deferred: proposalItems.filter((proposal) => proposal.state === "deferred").length,
  };
  const attentionJobs = jobItems.filter(
    (job) =>
      job.state !== "complete" || job.outcome === "ambiguous" || job.outcome === "insufficient",
  );
  const attentionWork = workItems.filter(
    ({ work: item }) => item.status !== "succeeded" && item.status !== "canceled",
  );
  const allLoaded =
    !offline &&
    observations.data !== null &&
    jobs.data !== null &&
    findings.data !== null &&
    work.data !== null &&
    workIntents.data !== null &&
    workFailures.data !== null &&
    observationMode.data !== null &&
    proposals.data !== null &&
    !observations.error &&
    !jobs.error &&
    !findings.error &&
    !work.error &&
    !workIntents.error &&
    !workFailures.error &&
    !observationMode.error &&
    !proposals.error;

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold">Live Operations</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A read-only view of saved configuration and records. States reflect their last recorded
            update, not a live worker stream.
          </p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={offline || environmentId === null}>
          <RefreshCwIcon /> Refresh records
        </Button>
      </div>

      {offline ? (
        <p role="status" className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          Offline. Saved records may be out of date and will refresh when the connection returns.
        </p>
      ) : null}
      {environmentId === null ? (
        <p role="status" className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          Connect an environment to load operation records.
        </p>
      ) : null}

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <Card>
          <CardPanel className="space-y-4 p-4 sm:p-5">
            <h3 className="text-lg font-semibold">Configuration</h3>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Lifecycle</dt>
                <dd className="mt-1">
                  <Badge variant={organization.lifecycle === "active" ? "success" : "outline"}>
                    {organization.lifecycle}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Published revision</dt>
                <dd className="mt-1 font-medium">{organization.publishedRevision ?? "None"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Draft revision</dt>
                <dd className="mt-1 font-medium">{organization.draftRevision}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Active Project bindings</dt>
                <dd className="mt-1 font-medium">{activeBindings.length}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted-foreground">
              Lifecycle and publication describe saved configuration. They do not confirm execution.
            </p>
            <Button size="sm" variant="outline" onClick={() => onNavigate("governance")}>
              Open Governance
            </Button>
          </CardPanel>
        </Card>
        <Card>
          <CardPanel className="space-y-4 p-4 sm:p-5">
            <h3 className="text-lg font-semibold">Available capabilities</h3>
            <p className="text-sm">
              Director conversation reports from saved records. Current work intents can start one
              selected Project file through independent QA and your approval.
            </p>
            {runtimeStatus.error ? (
              <p role="status" className="text-sm text-muted-foreground">
                Project worker readiness could not be checked: {runtimeStatus.error}
              </p>
            ) : runtimeStatus.data?.ready ? (
              <p role="status" className="text-sm text-muted-foreground">
                Project worker is ready for reviewed work.
              </p>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Project worker is waiting for broker ownership and recovery checks.
              </p>
            )}
          </CardPanel>
        </Card>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <Card>
          <CardPanel className="space-y-3 p-4 sm:p-5">
            <h3 className="text-lg font-semibold">Observation mode</h3>
            {observationMode.error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                Observation mode could not load: {observationMode.error}
              </p>
            ) : null}
            {observationMode.isPending && observationMode.data === null ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading observation mode…
              </p>
            ) : null}
            {observationMode.data === null &&
            !observationMode.error &&
            !observationMode.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                {offline
                  ? "No saved observation mode response is available offline."
                  : "Observation mode is unavailable."}
              </p>
            ) : null}
            {observationMode.data ? (
              <>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Configured</dt>
                    <dd className="mt-1 font-medium">
                      {observationMode.data.enabled ? "Enabled" : "Disabled"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Effective</dt>
                    <dd className="mt-1 font-medium">
                      {observationMode.data.effective ? "Yes" : "No"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Setting version</dt>
                    <dd className="mt-1 font-medium">{observationMode.data.version}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Last updated</dt>
                    <dd className="mt-1 font-medium">
                      {observationMode.data.updatedAt ? (
                        <RecordedTime value={observationMode.data.updatedAt} />
                      ) : (
                        "Not recorded"
                      )}
                    </dd>
                  </div>
                </dl>
                {observationMode.data.enabled && !observationMode.data.effective ? (
                  <p className="text-sm text-muted-foreground">
                    Observation mode is enabled in settings but is not currently effective.
                  </p>
                ) : null}
                {observationMode.data.updatedBy ? (
                  <p className="break-all text-sm text-muted-foreground">
                    Updated by {observationMode.data.updatedBy}.
                  </p>
                ) : null}
              </>
            ) : null}
          </CardPanel>
        </Card>
        <Card>
          <CardPanel className="space-y-3 p-4 sm:p-5">
            <h3 className="text-lg font-semibold">Proposal state, first page</h3>
            <EvidenceState label="Proposals" query={proposals} offline={offline} />
            {proposals.data ? (
              <>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Records in first page</dt>
                    <dd className="mt-1 text-2xl font-semibold tabular-nums">
                      {proposalItems.length}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Awaiting review in first page</dt>
                    <dd className="mt-1 text-2xl font-semibold tabular-nums">
                      {proposedItems.length}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Acknowledged</dt>
                    <dd className="mt-1 font-medium">{proposalStateCounts.acknowledged}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Rejected</dt>
                    <dd className="mt-1 font-medium">{proposalStateCounts.rejected}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Deferred</dt>
                    <dd className="mt-1 font-medium">{proposalStateCounts.deferred}</dd>
                  </div>
                </dl>
                {proposalItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No proposals in the first page.</p>
                ) : null}
                {proposalItems.length > 0 ? (
                  <details className="rounded-xl border border-border p-3 text-sm">
                    <summary className="cursor-pointer font-medium">
                      View first-page proposal IDs and states
                    </summary>
                    <ul className="mt-3 space-y-2">
                      {proposalItems.map((proposal) => (
                        <li key={proposal.id} className="min-w-0 rounded-lg bg-muted/30 p-2">
                          <p className="break-words font-medium">{proposal.title}</p>
                          <p className="mt-1 break-all text-muted-foreground">
                            Proposal ID: <code>{proposal.id}</code>
                          </p>
                          <p className="mt-1 text-muted-foreground">
                            State: {proposal.state}; version {proposal.version}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {proposals.data.nextCursor ? (
                  <p className="text-sm text-muted-foreground">
                    More proposal pages exist. Counts here do not include them.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">This is the last proposal page.</p>
                )}
              </>
            ) : null}
          </CardPanel>
        </Card>
      </div>

      <Card>
        <CardPanel>
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Waiting work intents, first page</h3>
            <p className="text-sm text-muted-foreground">
              Each record is a waiting intent, not authorized work. Freshness only describes whether
              the saved proposal scope still matches current records.
            </p>
            <EvidenceState label="Waiting work intents" query={workIntents} offline={offline} />
            {workIntents.data ? (
              <>
                <dl className="grid gap-3 sm:grid-cols-3">
                  <Metric label="Waiting intents in first page" value={waitingIntents.length} />
                  <Metric label="Current in first page" value={currentIntents.length} />
                  <Metric label="Stale in first page" value={staleIntents.length} />
                </dl>
                {waitingIntents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No waiting intents in this page.</p>
                ) : (
                  <details className="rounded-xl border border-border p-3 text-sm">
                    <summary className="cursor-pointer font-medium">
                      View waiting intent records
                    </summary>
                    <ul className="mt-3 space-y-2">
                      {waitingIntents.map((intent) => (
                        <li key={intent.id} className="min-w-0 rounded-lg bg-muted/30 p-3">
                          <p className="break-all font-medium">{intent.id}</p>
                          <p className="mt-1 text-muted-foreground">
                            {intent.freshness === "current" ? "Current" : "Stale"} waiting intent,
                            not authorized work.
                          </p>
                          <p className="mt-1 break-words text-muted-foreground">
                            Proposal {intent.proposalId}; Project {intent.projectId}
                          </p>
                          {intent.staleReason ? (
                            <p className="mt-1 text-muted-foreground">
                              Reason: {intent.staleReason}
                            </p>
                          ) : null}
                          {intent.freshness === "current" ? (
                            <OrganizationIntentActivation
                              organization={organization}
                              intent={intent}
                              offline={offline}
                              onActivated={refresh}
                            />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {workIntents.data.nextCursor ? (
                  <p className="text-sm text-muted-foreground">
                    The first page is full. Additional waiting intents may exist.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardPanel>
          <div className="space-y-3">
            <h3 className="text-lg font-semibold">Project work failures</h3>
            <p className="text-sm text-muted-foreground">
              Budget exhaustion and temporary integration failures remain visible and can retry
              after capacity or service availability returns. Other failures stop this work for
              review.
            </p>
            <EvidenceState label="Project work failures" query={workFailures} offline={offline} />
            {workFailures.data?.failures.length === 0 ? (
              <p className="text-sm text-muted-foreground">No saved work failures.</p>
            ) : null}
            {workFailures.data?.failures.length ? (
              <ul className="space-y-2">
                {workFailures.data.failures.map((failure) => (
                  <li key={failure.workId} className="rounded-lg border border-border p-3 text-sm">
                    <p className="font-medium break-all">Work {failure.workId}</p>
                    <p className="text-muted-foreground">
                      {failure.phase} stopped: {failure.code.replaceAll("_", " ")}
                    </p>
                    <p className="text-muted-foreground">
                      <RecordedTime value={failure.occurredAt} />
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardPanel className="space-y-4 p-4 sm:p-5">
          <h3 className="text-lg font-semibold">Current Project bindings</h3>
          {activeBindings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active Project bindings are recorded.
            </p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {activeBindings.map((binding) => (
                <li
                  key={binding.id}
                  className="min-w-0 rounded-xl border border-border p-3 text-sm"
                >
                  <p className="font-medium break-words">{projectName(binding.projectId)}</p>
                  <p className="mt-1 text-muted-foreground">
                    Access: {binding.access}
                    {binding.scope ? (
                      <>
                        ; scope: <span className="break-all">{binding.scope}</span>
                      </>
                    ) : null}
                  </p>
                  <p className="mt-1 break-all text-muted-foreground">
                    Binding ID: <code>{binding.id}</code>
                  </p>
                  <p className="mt-1 break-all text-muted-foreground">
                    Project ID: <code>{binding.projectId}</code>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardPanel>
      </Card>

      <section aria-labelledby="recorded-state-heading" className="space-y-3">
        <h3 id="recorded-state-heading" className="text-lg font-semibold">
          Recorded state
        </h3>
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Observations" value={observations.data ? observationItems.length : null} />
          <Metric label="Correlation jobs" value={jobs.data ? jobItems.length : null} />
          <Metric label="Tentative findings" value={findings.data ? findingItems.length : null} />
          <Metric label="Saved work items" value={work.data ? workItems.length : null} />
        </dl>
        <p className="text-sm text-muted-foreground">
          Counts include only records returned by the current queries. A blank count means the query
          has not loaded.
        </p>
      </section>

      <section aria-labelledby="operational-metrics-heading" className="space-y-3">
        <div>
          <h3 id="operational-metrics-heading" className="text-lg font-semibold">
            Operational metrics
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Counts and ages come from saved records. They describe stored states, not live worker
            activity or a measured success rate.
          </p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Pending work items" value={work.data ? pendingWorkItems.length : null} />
          <Metric
            label="Oldest pending queue age"
            value={
              work.data
                ? oldestPendingWork
                  ? elapsedFrom(oldestPendingWork, metricsAsOf)
                  : "None pending"
                : null
            }
          />
          <Metric label="Recorded work attempts" value={work.data ? attemptItems.length : null} />
          <Metric
            label="Attempts marked QA rejected"
            value={work.data ? qaRejectedAttempts.length : null}
          />
          <Metric
            label="Attempts marked QA accepted"
            value={work.data ? qaAcceptedAttempts.length : null}
          />
          <Metric
            label="Succeeded work records"
            value={
              work.data
                ? workItems.filter(({ work: item }) => item.status === "succeeded").length
                : null
            }
          />
          <Metric
            label="Rejected proposals, first page"
            value={proposals.data ? proposalStateCounts.rejected : null}
          />
          <Metric
            label="Recorded observations"
            value={observations.data ? observationItems.length : null}
          />
          <Metric label="Cost" value="Unknown" />
        </dl>
        <p className="text-sm text-muted-foreground">
          Pending age uses each work item’s creation time because a separate queue entry time is not
          stored. Age is current as of{" "}
          <time dateTime={new Date(metricsAsOf).toISOString()}>
            {new Date(metricsAsOf).toLocaleTimeString()}
          </time>
          . QA and proposal rejection figures count current saved statuses, not every historical
          decision. Proposal figures cover only the first page of up to 25 records.
        </p>
        <p className="text-sm text-muted-foreground">
          No cost meter or validated price is present in these records. Human time saved is not
          measured.
        </p>
      </section>

      <Card>
        <CardPanel className="space-y-4 p-4 sm:p-5">
          <h3 className="text-lg font-semibold">Attention needed</h3>
          <ul className="space-y-2 text-sm">
            {organization.lifecycle === "draft" ? (
              <li>Lifecycle is draft. Review configuration in Governance.</li>
            ) : null}
            {organization.lifecycle === "paused" ? <li>Lifecycle is paused.</li> : null}
            {organization.lifecycle === "archived" ? <li>Organization is archived.</li> : null}
            {organization.publishedRevision === null ? (
              <li>No published revision is recorded.</li>
            ) : null}
            {activeBindings.length === 0 ? <li>No active Project binding is recorded.</li> : null}
            {observationMode.data?.enabled && !observationMode.data.effective ? (
              <li>Observation mode is configured on but is not currently effective.</li>
            ) : null}
            {proposedItems.length > 0 ? (
              <li>
                {proposedItems.length} proposal{proposedItems.length === 1 ? "" : "s"} awaiting
                review in the first page.
              </li>
            ) : null}
            {staleProposedItems.length > 0 ? (
              <li>
                {staleProposedItems.length} proposed item
                {staleProposedItems.length === 1 ? " has" : "s have"} stale scope and cannot be
                acknowledged under the current configuration.
              </li>
            ) : null}
            {proposals.data?.nextCursor ? (
              <li>Additional proposal pages exist and may contain other items needing review.</li>
            ) : null}
            {waitingIntents.length > 0 ? (
              <li>
                {waitingIntents.length} waiting intent{waitingIntents.length === 1 ? "" : "s"} in
                the first page, not authorized work. {staleIntents.length} stale.
              </li>
            ) : null}
            {attentionJobs.map((job) => (
              <li key={job.observationId} className="break-words">
                Correlation job for observation{" "}
                <code className="break-all">{job.observationId}</code>: {job.state}
                {job.outcome ? `, ${job.outcome}` : ""}
                {job.lastErrorCode ? ` (${job.lastErrorCode})` : ""}.
              </li>
            ))}
            {attentionWork.map(({ work: item }) => (
              <li key={item.id} className="break-words">
                Work <code className="break-all">{item.id}</code>: {item.status}.
              </li>
            ))}
            {findingItems.length > 0 ? (
              <li>
                {findingItems.length} tentative finding{findingItems.length === 1 ? "" : "s"}{" "}
                recorded; these do not authorize work.
              </li>
            ) : null}
            {allLoaded &&
            organization.lifecycle === "active" &&
            organization.publishedRevision !== null &&
            activeBindings.length > 0 &&
            !(observationMode.data?.enabled && !observationMode.data.effective) &&
            proposedItems.length === 0 &&
            proposals.data?.nextCursor === null &&
            waitingIntents.length === 0 &&
            workIntents.data?.nextCursor === null &&
            attentionJobs.length === 0 &&
            attentionWork.length === 0 &&
            findingItems.length === 0 ? (
              <li>No action pending in the loaded records.</li>
            ) : null}
          </ul>
          {!allLoaded ? (
            <p className="text-sm text-muted-foreground">
              This attention list may be incomplete until all record queries load while connected.
            </p>
          ) : null}
        </CardPanel>
      </Card>

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <Card>
          <CardPanel className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-lg font-semibold">Recent observations</h3>
              <Button size="sm" variant="outline" onClick={() => onNavigate("sources")}>
                Open Sources
              </Button>
            </div>
            <EvidenceState label="Observations" query={observations} offline={offline} />
            {observations.data && observationItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No observations recorded.</p>
            ) : null}
            <ul className="space-y-3">
              {observationItems
                .slice(-5)
                .reverse()
                .map((item) => (
                  <li key={item.id} className="min-w-0 rounded-xl border border-border p-3 text-sm">
                    <p className="font-medium break-words">{item.title}</p>
                    <p className="mt-1 text-muted-foreground">
                      Occurred <RecordedTime value={item.occurredAt} />;{" "}
                      {item.projectId ? projectName(item.projectId) : "Organization scope"}
                    </p>
                    <p className="mt-1 break-all text-muted-foreground">
                      Observation ID: <code>{item.id}</code>
                    </p>
                    <p className="mt-1 break-all text-muted-foreground">
                      Source ID: <code>{item.sourceId}</code>
                    </p>
                  </li>
                ))}
            </ul>
          </CardPanel>
        </Card>
        <Card>
          <CardPanel className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-lg font-semibold">Correlation jobs</h3>
              <Button size="sm" variant="outline" onClick={() => onNavigate("sources")}>
                Open Sources
              </Button>
            </div>
            <EvidenceState label="Correlation jobs" query={jobs} offline={offline} />
            {jobs.data && jobItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No correlation jobs recorded.</p>
            ) : null}
            <ul className="space-y-3">
              {jobItems.slice(0, 5).map((job) => (
                <li
                  key={job.observationId}
                  className="min-w-0 rounded-xl border border-border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={job.state === "terminal" ? "warning" : "outline"}>
                      {job.state}
                    </Badge>
                    <span>
                      {job.attempts} attempt{job.attempts === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-2 break-all text-muted-foreground">
                    Observation ID: <code>{job.observationId}</code>
                  </p>
                  {job.outcome ? <p className="mt-1 break-words">Outcome: {job.outcome}</p> : null}
                  {job.lastErrorCode ? (
                    <p className="mt-1 break-words">Last error code: {job.lastErrorCode}</p>
                  ) : null}
                  <p className="mt-1 text-muted-foreground">
                    Updated <RecordedTime value={job.updatedAt} />
                  </p>
                </li>
              ))}
            </ul>
          </CardPanel>
        </Card>
        <Card>
          <CardPanel className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-lg font-semibold">Tentative findings</h3>
              <Button size="sm" variant="outline" onClick={() => onNavigate("work")}>
                Open Work & Findings
              </Button>
            </div>
            <EvidenceState label="Findings" query={findings} offline={offline} />
            {findings.data && findingItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tentative findings recorded.</p>
            ) : null}
            <ul className="space-y-3">
              {findingItems
                .slice(-5)
                .reverse()
                .map((finding) => (
                  <li
                    key={finding.id}
                    className="min-w-0 rounded-xl border border-border p-3 text-sm"
                  >
                    <p className="font-medium break-words">{finding.title}</p>
                    <p className="mt-1 text-muted-foreground">
                      {finding.observationIds.length} evidence observation
                      {finding.observationIds.length === 1 ? "" : "s"}
                    </p>
                    <p className="mt-1 break-all text-muted-foreground">
                      Finding ID: <code>{finding.id}</code>
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Recorded <RecordedTime value={finding.createdAt} />
                    </p>
                  </li>
                ))}
            </ul>
          </CardPanel>
        </Card>
        <Card>
          <CardPanel className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-lg font-semibold">Saved work states</h3>
              <Button size="sm" variant="outline" onClick={() => onNavigate("work")}>
                Open Work & Findings
              </Button>
            </div>
            <EvidenceState label="Work records" query={work} offline={offline} />
            <p className="text-sm text-muted-foreground">
              Cancel applies to one work item. A running worker must have its scoped stop verified
              or recovered before cancellation can finish.
            </p>
            {cancelError ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {cancelError}
              </p>
            ) : null}
            {cancelNotice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {cancelNotice}
              </p>
            ) : null}
            {work.data && workItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No work records persisted.</p>
            ) : null}
            <ul className="space-y-3">
              {workItems
                .slice(-5)
                .reverse()
                .map(({ work: item }) => (
                  <li key={item.id} className="min-w-0 rounded-xl border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          item.status === "failed" || item.status === "blocked"
                            ? "warning"
                            : "outline"
                        }
                      >
                        {item.status}
                      </Badge>
                      <span>
                        {item.attemptCount} attempt{item.attemptCount === 1 ? "" : "s"} recorded
                      </span>
                    </div>
                    <p className="mt-2 break-all text-muted-foreground">
                      Work ID: <code>{item.id}</code>
                    </p>
                    <p className="mt-1 break-all text-muted-foreground">
                      Finding ID: <code>{item.findingId}</code>
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {projectName(item.projectId)}; updated <RecordedTime value={item.updatedAt} />
                    </p>
                    {item.status !== "succeeded" &&
                    item.status !== "failed" &&
                    item.status !== "canceled" ? (
                      <Button
                        className="mt-2"
                        size="sm"
                        variant="destructive-outline"
                        disabled={offline || environmentId === null || cancelingWorkId !== null}
                        onClick={() => void cancel(item)}
                      >
                        {cancelingWorkId === item.id ? "Canceling…" : "Cancel work"}
                      </Button>
                    ) : null}
                  </li>
                ))}
            </ul>
          </CardPanel>
        </Card>
      </div>
    </div>
  );
}

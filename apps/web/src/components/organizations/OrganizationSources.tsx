import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  OrganizationIntakeSourceId,
  OrganizationObservationId,
  ProjectId,
  type Organization,
  type OrganizationIntakeSourceKind,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const SELECT_CLASS =
  "min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function OrganizationSources({
  organization,
  offline,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectName = (id: ProjectId) => projects.find((project) => project.id === id)?.title ?? id;
  const input = { organizationId: organization.id };
  const sources = useEnvironmentQuery(
    environmentId === null ? null : organizationEnvironment.listSources({ environmentId, input }),
  );
  const observations = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listObservations({ environmentId, input }),
  );
  const correlationJobs = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listCorrelationJobs({ environmentId, input }),
  );
  const findings = useEnvironmentQuery(
    environmentId === null ? null : organizationEnvironment.listFindings({ environmentId, input }),
  );
  const intakeAudit = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listIntakeAudit({ environmentId, input }),
  );
  const registerSource = useAtomCommand(organizationEnvironment.registerSource);
  const rotateSecret = useAtomCommand(organizationEnvironment.rotateSourceSecret);
  const setSourceEnabled = useAtomCommand(organizationEnvironment.setSourceEnabled);
  const ingestManual = useAtomCommand(organizationEnvironment.ingestManual);
  const retryCorrelation = useAtomCommand(organizationEnvironment.retryCorrelation, {
    reportFailure: false,
  });
  const [sourceName, setSourceName] = useState("");
  const [sourceKind, setSourceKind] = useState<OrganizationIntakeSourceKind>("manual");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [reportSourceId, setReportSourceId] = useState("");
  const [reportProjectId, setReportProjectId] = useState("");
  const [reportTitle, setReportTitle] = useState("");
  const [reportBody, setReportBody] = useState("");
  const [reportCorrelationKey, setReportCorrelationKey] = useState("");
  const [oneTimeSecret, setOneTimeSecret] = useState<{ name: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const disabled =
    busy || offline || environmentId === null || organization.lifecycle === "archived";
  const activeBindings = organization.bindings.filter((binding) => binding.detachedAt === null);
  const manualSources = (sources.data?.sources ?? []).filter(
    (source) => source.kind === "manual" && source.enabled,
  );
  const selectedManualSource =
    manualSources.find((source) => source.id === reportSourceId) ?? manualSources[0];

  function refresh() {
    sources.refresh();
    observations.refresh();
    correlationJobs.refresh();
    findings.refresh();
    intakeAudit.refresh();
  }

  function checkResult<A, E>(result: AtomCommandResult<A, E>): A | null {
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice(null);
      return null;
    }
    setError(null);
    return result.value;
  }

  async function createSource() {
    if (disabled || !sourceName.trim() || environmentId === null) return;
    setBusy(true);
    try {
      const result = checkResult(
        await registerSource({
          environmentId,
          input: {
            organizationId: organization.id,
            sourceId: OrganizationIntakeSourceId.make(randomUUID()),
            projectId: sourceProjectId ? ProjectId.make(sourceProjectId) : null,
            kind: sourceKind,
            name: sourceName.trim(),
            ingestSubject: "interactive-session",
          },
        }),
      );
      if (!result) return;
      setOneTimeSecret(
        result.ingestSecret ? { name: result.source.name, secret: result.ingestSecret } : null,
      );
      setSourceName("");
      setNotice(`${result.source.name} was created.`);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function updateSource(sourceId: OrganizationIntakeSourceId, enabled: boolean) {
    if (disabled || environmentId === null) return;
    setBusy(true);
    try {
      const result = checkResult(
        await setSourceEnabled({
          environmentId,
          input: { organizationId: organization.id, sourceId, enabled },
        }),
      );
      if (!result) return;
      setOneTimeSecret(null);
      setNotice(`${result.name} ${enabled ? "enabled" : "disabled"}.`);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function rotate(sourceId: OrganizationIntakeSourceId) {
    if (disabled || environmentId === null) return;
    setBusy(true);
    try {
      const result = checkResult(
        await rotateSecret({ environmentId, input: { organizationId: organization.id, sourceId } }),
      );
      if (!result) return;
      setOneTimeSecret(
        result.ingestSecret ? { name: result.source.name, secret: result.ingestSecret } : null,
      );
      setNotice(`The previous secret for ${result.source.name} was revoked.`);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function submitReport() {
    if (disabled || !selectedManualSource || !reportTitle.trim() || environmentId === null) return;
    setBusy(true);
    try {
      const eventId = randomUUID();
      const result = checkResult(
        await ingestManual({
          environmentId,
          input: {
            organizationId: organization.id,
            sourceId: selectedManualSource.id,
            projectId:
              selectedManualSource.projectId ??
              (reportProjectId ? ProjectId.make(reportProjectId) : null),
            externalEventId: eventId,
            dedupKey: eventId,
            occurredAt: new Date().toISOString(),
            title: reportTitle.trim(),
            body: reportBody,
            attributes: {
              channel: "manual-report",
              ...(reportCorrelationKey.trim()
                ? { correlationKey: reportCorrelationKey.trim() }
                : {}),
            },
          },
        }),
      );
      if (!result) return;
      setReportTitle("");
      setReportBody("");
      setReportCorrelationKey("");
      const correlation = result.correlation?.outcome;
      setNotice(
        correlation === "created"
          ? "Report recorded. Matching scoped observations formed one tentative finding; no work was authorized."
          : correlation === "ambiguous"
            ? "Report recorded. Correlation is ambiguous and needs review; no work was authorized."
            : correlation === "unavailable"
              ? "Report recorded, but correlation is unavailable. Use Retry correlation on the saved observation."
              : "Report recorded as an observation. It has not authorized any work.",
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retryObservation(observationId: OrganizationObservationId) {
    if (disabled || environmentId === null) return;
    setBusy(true);
    try {
      const result = checkResult(
        await retryCorrelation({
          environmentId,
          input: { organizationId: organization.id, observationId },
        }),
      );
      if (!result) return;
      setNotice(
        result.outcome === "unavailable"
          ? "Correlation is still unavailable. The observation remains saved."
          : result.outcome === "created"
            ? "A tentative finding was created. No work was authorized."
            : `Correlation result: ${result.outcome}. No work was authorized.`,
      );
      findings.refresh();
      correlationJobs.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 p-3 text-sm xl:col-span-2"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted/30 p-3 text-sm xl:col-span-2"
        >
          {notice}
        </p>
      ) : null}
      <Card>
        <CardPanel className="space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Sources</h2>
              <p className="text-sm text-muted-foreground">
                Sources can submit observations only within this Organization and their Project
                scope.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={refresh}
              disabled={offline || environmentId === null}
            >
              Refresh
            </Button>
          </div>
          {sources.isPending ? <p role="status">Loading sources…</p> : null}
          {sources.error ? <p role="alert">Could not load sources: {sources.error}</p> : null}
          {(sources.data?.sources ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No sources configured.</p>
          ) : (
            <ul className="space-y-2">
              {(sources.data?.sources ?? []).map((source) => (
                <li key={source.id} className="rounded-lg border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <strong>{source.name}</strong>
                      <p className="text-muted-foreground">
                        {source.kind === "manual" ? "Manual report" : "Generic event adapter"} ·{" "}
                        {source.enabled ? "Enabled" : "Disabled"}
                        {source.projectId
                          ? ` · Project ${projectName(source.projectId)}`
                          : " · Organization scope"}
                      </p>
                      {(() => {
                        const sourceObservations = (observations.data?.observations ?? []).filter(
                          (observation) => observation.sourceId === source.id,
                        );
                        const latest = sourceObservations.at(-1);
                        const recentCount = sourceObservations.filter(
                          (observation) =>
                            Date.parse(observation.receivedAt) > Date.now() - 60 * 60 * 1000,
                        ).length;
                        const observationIds = new Set(sourceObservations.map((item) => item.id));
                        const sourceJobs = (correlationJobs.data?.jobs ?? []).filter((job) =>
                          observationIds.has(job.observationId),
                        );
                        const pendingJobs = sourceJobs.filter(
                          (job) => job.state === "pending" || job.state === "leased",
                        );
                        const terminalJobs = sourceJobs.filter((job) => job.state === "terminal");
                        const latestTerminal = terminalJobs.at(-1);
                        const oldestPending = pendingJobs.reduce<string | null>(
                          (oldest, job) =>
                            oldest === null || job.updatedAt < oldest ? job.updatedAt : oldest,
                          null,
                        );
                        return (
                          <div className="space-y-1 text-xs text-muted-foreground">
                            <p>
                              Last successful intake:{" "}
                              {latest ? new Date(latest.receivedAt).toLocaleString() : "none"} ·{" "}
                              {recentCount} new observation(s) in the past hour
                              {source.kind === "generic-http" ? " (limit 1,000 per hour)" : ""}
                            </p>
                            <p>
                              Correlation: {pendingJobs.length} queued or checking
                              {oldestPending
                                ? ` since ${new Date(oldestPending).toLocaleString()}`
                                : ""}
                              {terminalJobs.length > 0
                                ? ` · ${terminalJobs.length} terminal error(s)${latestTerminal?.lastErrorCode ? ` (latest: ${latestTerminal.lastErrorCode})` : ""}`
                                : ""}
                              .
                              {observations.data === null || correlationJobs.data === null
                                ? " Status is not fully loaded."
                                : ""}
                            </p>
                          </div>
                        );
                      })()}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {source.kind === "generic-http" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => void rotate(source.id)}
                        >
                          Rotate secret
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => void updateSource(source.id, !source.enabled)}
                      >
                        {source.enabled ? "Disable" : "Enable"}
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {oneTimeSecret ? (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p className="font-medium">Ingest secret for {oneTimeSecret.name}</p>
              <p className="mt-1 text-muted-foreground">
                Copy this secret now. It will not be shown again.
              </p>
              <code className="mt-2 block break-all rounded bg-background p-2 select-all">
                {oneTimeSecret.secret}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setOneTimeSecret(null)}
              >
                Done
              </Button>
            </div>
          ) : null}
          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="font-semibold">Add source</h3>
            <label className="block space-y-1 text-sm">
              <span>Name</span>
              <Input
                aria-label="Source name"
                value={sourceName}
                onValueChange={setSourceName}
                disabled={disabled}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Kind</span>
              <select
                className={SELECT_CLASS}
                value={sourceKind}
                disabled={disabled}
                onChange={(event) =>
                  setSourceKind(event.target.value as OrganizationIntakeSourceKind)
                }
              >
                <option value="manual">Manual report</option>
                <option value="generic-http">Generic event adapter</option>
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>Project scope</span>
              <select
                className={SELECT_CLASS}
                value={sourceProjectId}
                disabled={disabled}
                onChange={(event) => setSourceProjectId(event.target.value)}
              >
                <option value="">Organization only</option>
                {activeBindings.map((binding) => (
                  <option key={binding.id} value={binding.projectId}>
                    {projectName(binding.projectId)}
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={disabled || !sourceName.trim()} onClick={() => void createSource()}>
              Add source
            </Button>
            {sourceKind === "generic-http" ? (
              <p className="text-xs text-muted-foreground">
                Generic sources accept normalized events at{" "}
                <code>/api/organizations/intake/events</code>. A Project-scoped source can also
                accept selected GitHub issue or plain-text email relay payloads at{" "}
                <code>/api/organizations/intake/relay</code>. The upstream relay must select
                relevant events and authenticate to its provider; this does not connect a GitHub or
                email account in Arcwright Code.
              </p>
            ) : null}
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardPanel className="space-y-4 p-5">
          <h2 className="text-lg font-semibold">Manual report</h2>
          <p className="text-sm text-muted-foreground">
            A report is an unverified observation. It does not grant permission to change code.
          </p>
          {manualSources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add an enabled manual source to submit a report.
            </p>
          ) : (
            <>
              <label className="block space-y-1 text-sm">
                <span>Source</span>
                <select
                  className={SELECT_CLASS}
                  value={selectedManualSource?.id ?? ""}
                  disabled={disabled}
                  onChange={(event) => setReportSourceId(event.target.value)}
                >
                  {manualSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedManualSource?.projectId === null ? (
                <label className="block space-y-1 text-sm">
                  <span>Project context</span>
                  <select
                    className={SELECT_CLASS}
                    value={reportProjectId}
                    disabled={disabled}
                    onChange={(event) => setReportProjectId(event.target.value)}
                  >
                    <option value="">No Project</option>
                    {activeBindings.map((binding) => (
                      <option key={binding.id} value={binding.projectId}>
                        {projectName(binding.projectId)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="block space-y-1 text-sm">
                <span>Report title</span>
                <Input
                  aria-label="Report title"
                  value={reportTitle}
                  onValueChange={setReportTitle}
                  disabled={disabled}
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>What was observed</span>
                <Textarea
                  aria-label="Report body"
                  value={reportBody}
                  onChange={(event) => setReportBody(event.currentTarget.value)}
                  disabled={disabled}
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>Correlation key (optional)</span>
                <Input
                  aria-label="Correlation key"
                  value={reportCorrelationKey}
                  onValueChange={setReportCorrelationKey}
                  maxLength={160}
                  disabled={disabled}
                />
                <span className="text-xs text-muted-foreground">
                  Use the exact same case or incident ID across scoped sources. This only groups
                  observations into a tentative finding.
                </span>
              </label>
              <Button
                disabled={disabled || !reportTitle.trim()}
                onClick={() => void submitReport()}
              >
                Record report
              </Button>
            </>
          )}
        </CardPanel>
      </Card>

      <Card className="xl:col-span-2">
        <CardPanel className="space-y-3 p-5">
          <h2 className="text-lg font-semibold">Observations and findings</h2>
          <p className="text-sm text-muted-foreground">
            Observations are source data. Findings remain tentative until separately verified and
            authorized.
          </p>
          {observations.isPending || findings.isPending ? (
            <p role="status">Loading intake history…</p>
          ) : null}
          {observations.error || findings.error ? (
            <p role="alert">
              Could not load intake history: {observations.error ?? findings.error}
            </p>
          ) : null}
          {correlationJobs.error ? (
            <p role="alert">Could not load correlation status: {correlationJobs.error}</p>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <section>
              <h3 className="font-semibold">Observations</h3>
              {(observations.data?.observations ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">None recorded.</p>
              ) : null}
              <ul className="mt-2 space-y-2">
                {(observations.data?.observations ?? []).map((observation) => (
                  <li key={observation.id} className="rounded-lg border border-border p-3 text-sm">
                    <strong>{observation.title}</strong>
                    <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                      {observation.body}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Source {observation.sourceId} · Event {observation.externalEventId} ·{" "}
                      {new Date(observation.receivedAt).toLocaleString()}
                    </p>
                    {(() => {
                      const job = correlationJobs.data?.jobs.find(
                        (item) => item.observationId === observation.id,
                      );
                      return job ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Correlation:{" "}
                          {job.state === "complete"
                            ? (job.outcome ?? "complete")
                            : job.state === "terminal"
                              ? `stopped after ${job.attempts} attempts${
                                  job.lastErrorCode ? ` (${job.lastErrorCode})` : ""
                                }`
                              : job.state === "leased"
                                ? "checking now"
                                : "retry pending"}
                          {job.state === "pending" && job.attempts > 0
                            ? ` · next attempt ${new Date(job.nextAttemptAt).toLocaleString()}`
                            : ""}
                        </p>
                      ) : null;
                    })()}
                    {observation.projectId !== null && observation.attributes.correlationKey ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        disabled={disabled}
                        onClick={() => void retryObservation(observation.id)}
                      >
                        Retry correlation
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="font-semibold">Tentative findings</h3>
              {(findings.data?.findings ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">None proposed.</p>
              ) : null}
              <ul className="mt-2 space-y-2">
                {(findings.data?.findings ?? []).map((finding) => (
                  <li key={finding.id} className="rounded-lg border border-border p-3 text-sm">
                    <strong>{finding.title}</strong>
                    <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                      {finding.summary}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {finding.observationIds.length} evidence observation(s)
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </CardPanel>
      </Card>
      <Card className="xl:col-span-2">
        <CardPanel className="space-y-2 p-5">
          <h2 className="text-lg font-semibold">Source changes</h2>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {(intakeAudit.data?.entries ?? []).map((entry) => (
              <li key={entry.id}>
                {entry.action} · {entry.sourceId} · {entry.actorSubject} ·{" "}
                {new Date(entry.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
          {(intakeAudit.data?.entries ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No source changes recorded.</p>
          ) : null}
        </CardPanel>
      </Card>
    </div>
  );
}

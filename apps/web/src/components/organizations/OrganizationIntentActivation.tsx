import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  OrganizationBindingId,
  ProjectId,
  type Organization,
  type OrganizationWaitingWorkIntent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const FIELD_CLASS =
  "min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function OrganizationIntentActivation({
  organization,
  intent,
  offline,
  onActivated,
}: {
  readonly organization: Organization;
  readonly intent: OrganizationWaitingWorkIntent;
  readonly offline: boolean;
  readonly onActivated: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const runtimeStatus = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.getWorkRuntimeStatus({
          environmentId,
          input: { organizationId: organization.id },
        }),
  );
  const publishedConfig = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.getPublishedConfig({
          environmentId,
          input: { organizationId: organization.id, revision: intent.publishedRevision },
        }),
  );
  const sources = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listSources({
          environmentId,
          input: { organizationId: organization.id },
        }),
  );
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
  ).filter(
    (entry) =>
      (entry.driverKind === "codex" || entry.driverKind === "claude") &&
      entry.enabled &&
      entry.isAvailable &&
      entry.installed &&
      entry.status === "ready" &&
      entry.snapshot.supportsTextGeneration !== false,
  );
  const [instanceId, setInstanceId] = useState("");
  const [modelSlug, setModelSlug] = useState("");
  const selectedEntry =
    entries.find((entry) => entry.instanceId === instanceId) ??
    entries.find(
      (entry) => entry.instanceId === settings.textGenerationModelSelection.instanceId,
    ) ??
    entries[0];
  const models = selectedEntry ? getAppModelOptionsForInstance(settings, selectedEntry) : [];
  const selectedModel =
    models.find((model) => model.slug === modelSlug) ??
    models.find((model) => model.slug === settings.textGenerationModelSelection.model) ??
    models.find((model) => model.isDefault) ??
    models[0];
  const workflows = (publishedConfig.data?.workflows ?? []).filter((workflow) =>
    ["work", "qa", "approval", "integrate"].every((kind) =>
      workflow.steps.some((step) => step.kind === kind),
    ),
  );
  const [workflowId, setWorkflowId] = useState("");
  const selectedWorkflow = workflows.find((workflow) => workflow.id === workflowId) ?? workflows[0];
  const [fileName, setFileName] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [taskText, setTaskText] = useState("");
  const [exportName, setExportName] = useState("");
  const [casesText, setCasesText] = useState("");
  const [allowFutureWork, setAllowFutureWork] = useState(false);
  const [standingSourceId, setStandingSourceId] = useState("");
  const [maxActivations, setMaxActivations] = useState(5);
  const [expiryDays, setExpiryDays] = useState(7);
  const grantRequest = useRef<{ key: string; requestId: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const activate = useAtomCommand(organizationEnvironment.activateWorkIntent, {
    reportFailure: false,
  });
  const createStanding = useAtomCommand(organizationEnvironment.createStandingWorkAuthorization, {
    reportFailure: false,
  });
  const eligibleSources = (sources.data?.sources ?? []).filter(
    (source) =>
      source.kind === "generic-http" &&
      source.enabled &&
      source.projectId === intent.projectId &&
      intent.evidence.some(
        (evidence) => evidence.sourceId === source.id && evidence.projectId === intent.projectId,
      ),
  );
  const eligibleSource =
    eligibleSources.find((source) => source.id === standingSourceId) ?? eligibleSources[0];
  let cases: Array<{ input: unknown; expected: unknown }> | null = null;
  try {
    const parsed: unknown = JSON.parse(casesText);
    if (
      Array.isArray(parsed) &&
      parsed.length >= 1 &&
      parsed.length <= 8 &&
      parsed.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          Object.hasOwn(item, "input") &&
          Object.hasOwn(item, "expected"),
      )
    ) {
      cases = parsed as Array<{ input: unknown; expected: unknown }>;
    }
  } catch {
    // The form stays disabled until the cases are complete JSON.
  }
  const valid =
    !offline &&
    runtimeStatus.data?.ready === true &&
    intent.freshness === "current" &&
    environmentId !== null &&
    organization.publishedRevision === intent.publishedRevision &&
    publishedConfig.data?.revision === intent.publishedRevision &&
    selectedWorkflow !== undefined &&
    selectedEntry !== undefined &&
    selectedModel !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/.test(fileName) &&
    /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(targetRef) &&
    taskText.trim().length > 0 &&
    new TextEncoder().encode(taskText).length <= 4_000 &&
    /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(exportName) &&
    cases !== null &&
    (!allowFutureWork ||
      (eligibleSource !== undefined &&
        Number.isInteger(maxActivations) &&
        maxActivations >= 1 &&
        maxActivations <= 32 &&
        Number.isInteger(expiryDays) &&
        expiryDays >= 1 &&
        expiryDays <= 30)) &&
    !busy;

  async function submit() {
    if (
      !valid ||
      !selectedWorkflow ||
      !selectedEntry ||
      !selectedModel ||
      !cases ||
      environmentId === null
    )
      return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const selection = {
        workflowId: selectedWorkflow.id,
        targetRef,
        fileName,
        taskText: taskText.trim(),
        modelSelection: createModelSelection(selectedEntry.instanceId, selectedModel.slug),
        qaPlan: { version: 1 as const, exportName, cases },
      };
      if (allowFutureWork && eligibleSource) {
        const key = JSON.stringify({
          organizationId: organization.id,
          projectId: intent.projectId,
          bindingId: intent.bindingId,
          sourceId: eligibleSource.id,
          selection,
          maxActivations,
          expiryDays,
        });
        if (grantRequest.current?.key !== key) {
          grantRequest.current = {
            key,
            requestId: randomUUID(),
            expiresAt: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1_000).toISOString(),
          };
        }
        const result = await createStanding({
          environmentId,
          input: {
            organizationId: organization.id,
            requestId: grantRequest.current.requestId,
            projectId: ProjectId.make(intent.projectId),
            sourceId: eligibleSource.id,
            bindingId: OrganizationBindingId.make(intent.bindingId),
            selection,
            maxActivations,
            expiresAt: grantRequest.current.expiresAt,
          },
        });
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : String(cause));
        } else {
          setSuccess(
            "Standing work is authorized. Matching waiting and future intents will start automatically. Final Git integration still requires your approval.",
          );
          onActivated();
        }
        return;
      }
      const result = await activate({
        environmentId,
        input: {
          organizationId: organization.id,
          intentId: intent.id,
          selection,
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : String(cause));
      } else {
        setSuccess(`Work ${result.value.workId} is queued.`);
        onActivated();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-3 rounded-lg border border-border p-3">
      <summary className="cursor-pointer font-medium">Prepare one file for Project work</summary>
      <div className="mt-3 space-y-3">
        <p className="text-muted-foreground">
          Choose a published workflow, one flat .mjs file, and independent QA examples. The selected
          model proposes a change. You review the exact result before Git integration. Configure
          host, Organization, and Project provider limits first; a zero limit prevents the model
          call. Use a branch that points at the current HEAD and is not checked out in any worktree.
        </p>
        <label className="block space-y-1">
          <span>Workflow</span>
          <select
            className={FIELD_CLASS}
            value={selectedWorkflow?.id ?? ""}
            onChange={(event) => setWorkflowId(event.currentTarget.value)}
          >
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.title}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span>File name in Project root</span>
          <input
            className={FIELD_CLASS}
            value={fileName}
            onChange={(event) => setFileName(event.currentTarget.value)}
            placeholder="answer.mjs"
            autoComplete="off"
          />
        </label>
        <label className="block space-y-1">
          <span>Git branch at current HEAD (must not be checked out)</span>
          <input
            className={FIELD_CLASS}
            value={targetRef}
            onChange={(event) => setTargetRef(event.currentTarget.value)}
            placeholder="refs/heads/org-work"
            autoComplete="off"
          />
        </label>
        <label className="block space-y-1">
          <span>Task for the model</span>
          <Textarea
            value={taskText}
            onChange={(event) => setTaskText(event.currentTarget.value)}
            placeholder="Describe the exact change to this file"
            rows={4}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span>Provider</span>
            <select
              className={FIELD_CLASS}
              value={selectedEntry?.instanceId ?? ""}
              onChange={(event) => {
                setInstanceId(event.currentTarget.value);
                setModelSlug("");
              }}
            >
              {entries.map((entry) => (
                <option key={entry.instanceId} value={entry.instanceId}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span>Model</span>
            <select
              className={FIELD_CLASS}
              value={selectedModel?.slug ?? ""}
              onChange={(event) => setModelSlug(event.currentTarget.value)}
            >
              {models.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block space-y-1">
          <span>Exported function to test</span>
          <input
            className={FIELD_CLASS}
            value={exportName}
            onChange={(event) => setExportName(event.currentTarget.value)}
            placeholder="solve"
            autoComplete="off"
          />
        </label>
        <label className="block space-y-1">
          <span>QA cases (JSON array, 1–8 cases)</span>
          <Textarea
            value={casesText}
            onChange={(event) => setCasesText(event.currentTarget.value)}
            placeholder={'[{"input":{"value":2},"expected":4}]'}
            rows={4}
            spellCheck={false}
          />
        </label>
        {eligibleSource ? (
          <div className="space-y-3 rounded-lg border border-border p-3 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={allowFutureWork}
                onChange={(event) => setAllowFutureWork(event.currentTarget.checked)}
              />
              <span>Automatically start matching Project work from {eligibleSource.name}</span>
            </label>
            {allowFutureWork ? (
              <>
                {eligibleSources.length > 1 ? (
                  <label className="block space-y-1">
                    <span>HTTP source to authorize</span>
                    <select
                      className={FIELD_CLASS}
                      value={eligibleSource?.id ?? ""}
                      onChange={(event) => setStandingSourceId(event.currentTarget.value)}
                    >
                      {eligibleSources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <p className="text-muted-foreground">
                  This authorizes the exact Project, file, branch, workflow, model, task, and QA
                  examples above for future intents from this source. It expires or stops after the
                  chosen number of starts. You still approve each Git integration. Revoke it in
                  Governance at any time.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span>Maximum work starts (1–32)</span>
                    <input
                      className={FIELD_CLASS}
                      type="number"
                      min={1}
                      max={32}
                      value={maxActivations}
                      onChange={(event) => setMaxActivations(Number(event.currentTarget.value))}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span>Expires after days (1–30)</span>
                    <input
                      className={FIELD_CLASS}
                      type="number"
                      min={1}
                      max={30}
                      value={expiryDays}
                      onChange={(event) => setExpiryDays(Number(event.currentTarget.value))}
                    />
                  </label>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {success ? <p role="status">{success}</p> : null}
        {entries.length === 0 ? (
          <p role="status">Connect a ready Codex or Claude provider to continue.</p>
        ) : null}
        {workflows.length === 0 ? (
          <p role="status">
            {publishedConfig.error
              ? `Published workflow could not be loaded: ${publishedConfig.error}`
              : !publishedConfig.data
                ? "Loading published workflows…"
                : "Publish a workflow with work, QA, approval, and integration steps."}
          </p>
        ) : null}
        {runtimeStatus.error ? (
          <p role="status">Project work readiness could not be checked: {runtimeStatus.error}</p>
        ) : runtimeStatus.data?.ready === false ? (
          <p role="status">
            {runtimeStatus.data.reason === "scoped_broker_and_recovery_not_verified"
              ? "Project work is unavailable until the scoped worker and recovery checks are verified."
              : "Project work execution is not ready."}
          </p>
        ) : runtimeStatus.data === null && !offline ? (
          <p role="status">Checking Project work readiness…</p>
        ) : null}
        <Button disabled={!valid} onClick={() => void submit()}>
          {busy
            ? "Starting…"
            : allowFutureWork
              ? "Authorize automatic work"
              : "Start reviewed work"}
        </Button>
      </div>
    </details>
  );
}

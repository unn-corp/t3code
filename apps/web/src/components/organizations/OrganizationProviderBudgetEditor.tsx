import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { Organization, OrganizationProviderBudgetScope, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const FIELD_CLASS =
  "min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function OrganizationProviderBudgetEditor({
  organization,
  projectName,
  offline,
  onUpdated,
}: {
  readonly organization: Organization;
  readonly projectName: (projectId: ProjectId) => string;
  readonly offline: boolean;
  readonly onUpdated: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const [scopeKey, setScopeKey] = useState("organization");
  const projectBindings = organization.bindings.filter((binding) => binding.detachedAt === null);
  const selectedProject = projectBindings.find(
    (binding) => `project:${binding.projectId}` === scopeKey,
  );
  const scope: OrganizationProviderBudgetScope = selectedProject
    ? { kind: "project", projectId: selectedProject.projectId }
    : { kind: "organization", organizationId: organization.id };
  const budget = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.getProviderBudget({
          environmentId,
          input: { organizationId: organization.id, scope },
        }),
  );
  const update = useAtomCommand(organizationEnvironment.updateProviderBudget, {
    reportFailure: false,
  });
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        maxConcurrent: string;
        maxDailyCalls: string;
        maxDailyEstimatedTokens: string;
      }
    >
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const record = budget.data?.record ?? null;
  const draftKey = `${organization.id}:${scopeKey}:${record?.revision ?? "new"}`;
  const draft = drafts[draftKey] ?? {
    maxConcurrent: String(record?.limits.maxConcurrent ?? 0),
    maxDailyCalls: String(record?.limits.maxDailyCalls ?? 0),
    maxDailyEstimatedTokens: String(record?.limits.maxDailyEstimatedTokens ?? 0),
  };
  const { maxConcurrent, maxDailyCalls, maxDailyEstimatedTokens } = draft;
  function change(field: keyof typeof draft, value: string) {
    setDrafts((current) => ({ ...current, [draftKey]: { ...draft, [field]: value } }));
  }
  const concurrent = Number(maxConcurrent);
  const dailyCalls = Number(maxDailyCalls);
  const dailyTokens = Number(maxDailyEstimatedTokens);
  const valid =
    [concurrent, dailyCalls, dailyTokens].every(Number.isInteger) &&
    concurrent >= 0 &&
    concurrent <= 64 &&
    dailyCalls >= 0 &&
    dailyCalls <= 10_000 &&
    dailyTokens >= 0 &&
    dailyTokens <= 1_000_000_000;

  async function save() {
    if (!valid || busy || offline || environmentId === null || budget.data === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await update({
        environmentId,
        input: {
          organizationId: organization.id,
          scope,
          expectedRevision: record?.revision ?? null,
          limits: {
            maxConcurrent: concurrent,
            maxDailyCalls: dailyCalls,
            maxDailyEstimatedTokens: dailyTokens,
          },
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          `${cause instanceof Error ? cause.message : String(cause)} Current capacity was refreshed.`,
        );
        budget.refresh();
      } else {
        setNotice("Provider capacity ceiling saved.");
        budget.refresh();
        onUpdated();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="font-medium">Set provider capacity</h3>
      <p className="text-sm text-muted-foreground">
        A model call needs capacity at the global, Organization, and Project scopes. These are call
        and estimated token limits, not currency budgets. Provider charges or subscription usage may
        be unknown. The shared global ceiling is managed by the host administrator.
      </p>
      <label className="block space-y-1 text-sm">
        <span>Scope</span>
        <select
          className={FIELD_CLASS}
          value={scopeKey}
          onChange={(event) => {
            setScopeKey(event.currentTarget.value);
            setError(null);
            setNotice(null);
          }}
        >
          <option value="organization">This Organization</option>
          {projectBindings.map((binding) => (
            <option key={binding.id} value={`project:${binding.projectId}`}>
              Project: {projectName(binding.projectId)}
            </option>
          ))}
        </select>
      </label>
      {budget.error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {budget.error}
        </p>
      ) : null}
      {budget.data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1 text-sm">
            <span>Concurrent calls</span>
            <input
              className={FIELD_CLASS}
              type="number"
              min={0}
              max={64}
              value={maxConcurrent}
              onChange={(event) => change("maxConcurrent", event.currentTarget.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Calls per UTC day</span>
            <input
              className={FIELD_CLASS}
              type="number"
              min={0}
              max={10000}
              value={maxDailyCalls}
              onChange={(event) => change("maxDailyCalls", event.currentTarget.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Estimated tokens per UTC day</span>
            <input
              className={FIELD_CLASS}
              type="number"
              min={0}
              max={1000000000}
              value={maxDailyEstimatedTokens}
              onChange={(event) => change("maxDailyEstimatedTokens", event.currentTarget.value)}
            />
          </label>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      <Button onClick={() => void save()} disabled={!valid || !budget.data || offline || busy}>
        {busy ? "Saving…" : "Save capacity"}
      </Button>
    </div>
  );
}

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  OrganizationProposalMutationId,
  type Organization,
  type OrganizationProposalId,
  type OrganizationWorkProposal,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { Input } from "../ui/input";

function failureMessage(value: unknown): string {
  const cause = squashAtomCommandFailure(value as Parameters<typeof squashAtomCommandFailure>[0]);
  return cause instanceof Error ? cause.message : String(cause);
}

export function OrganizationObservationModeControl({
  organization,
  offline,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const mode = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.observationModeGet({
          environmentId,
          input: { organizationId: organization.id },
        }),
  );
  const setMode = useAtomCommand(organizationEnvironment.observationModeSet, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) mode.refresh();
    wasOffline.current = offline;
  }, [offline, mode.refresh]);

  async function change(enabled: boolean) {
    if (busy || offline || environmentId === null || !mode.data) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setMode({
        environmentId,
        input: {
          organizationId: organization.id,
          mutationId: OrganizationProposalMutationId.make(randomUUID()),
          expectedVersion: mode.data.version,
          enabled,
        },
      });
      if (result._tag === "Failure") setError(failureMessage(result));
      else {
        setNotice(enabled ? "Observation mode enabled." : "Observation mode disabled.");
        mode.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardPanel className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Observation mode</h2>
          <Badge variant="outline">
            {!mode.data
              ? "Loading"
              : mode.data.effective
                ? "Observing"
                : mode.data.enabled
                  ? "Suspended"
                  : "Off"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          With a published configuration, this mode reviews new scoped findings from linked Projects
          and saves proposals. Observation alone cannot start a worker; a separate standing work
          grant can authorize matching intents. Earlier findings are not imported when you first
          enable it.
        </p>
        {mode.isPending && !mode.data ? <p role="status">Loading observation settings…</p> : null}
        {mode.error || error ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? mode.error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm">
            {notice}
          </p>
        ) : null}
        {mode.data?.enabled && !mode.data.effective ? (
          <p className="text-sm text-muted-foreground">
            Observation is suspended until the Organization has a published configuration and is in
            draft or active lifecycle.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant={mode.data?.enabled ? "outline" : "default"}
            disabled={
              busy ||
              offline ||
              !mode.data ||
              organization.lifecycle === "archived" ||
              (organization.lifecycle === "paused" && !mode.data.enabled)
            }
            onClick={() => void change(!mode.data!.enabled)}
          >
            {!mode.data
              ? "Loading observation mode"
              : mode.data.enabled
                ? "Disable observation"
                : "Enable observation"}
          </Button>
          <Button variant="ghost" disabled={offline} onClick={mode.refresh}>
            <RefreshCwIcon /> Refresh
          </Button>
        </div>
      </CardPanel>
    </Card>
  );
}

export function OrganizationProposalList({
  organization,
  offline,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const [cursor, setCursor] = useState<OrganizationProposalId | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.proposalList({
          environmentId,
          input: { organizationId: organization.id, afterProposalId: cursor, limit: 25 },
        }),
  );
  const decide = useAtomCommand(organizationEnvironment.proposalDecide, {
    reportFailure: false,
  });
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) list.refresh();
    wasOffline.current = offline;
  }, [offline, list.refresh]);

  async function decision(
    proposal: OrganizationWorkProposal,
    action: "acknowledge" | "reject" | "defer",
  ) {
    if (offline || environmentId === null || busyId !== null) return;
    setBusyId(proposal.id);
    setError(null);
    try {
      const result = await decide({
        environmentId,
        input: {
          organizationId: organization.id,
          proposalId: proposal.id,
          mutationId: OrganizationProposalMutationId.make(randomUUID()),
          expectedVersion: proposal.version,
          decision: action,
          reason: reasons[proposal.id]?.trim() || null,
          reconsiderAt:
            action === "defer" ? new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString() : null,
        },
      });
      if (result._tag === "Failure") setError(failureMessage(result));
      else {
        setNotice(
          `Proposal ${action === "defer" ? "deferred for one day" : action === "reject" ? "rejected" : "acknowledged"}.`,
        );
        setReasons((current) => ({ ...current, [proposal.id]: "" }));
        list.refresh();
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="organization-proposals-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="organization-proposals-heading" className="text-lg font-semibold">
            Work proposals
          </h2>
          <p className="text-sm text-muted-foreground">
            Proposals are tentative recommendations based on recorded evidence. Acknowledgement
            records your review; it does not dispatch work.
          </p>
        </div>
        <Button variant="outline" disabled={offline} onClick={list.refresh}>
          <RefreshCwIcon /> Refresh
        </Button>
      </div>
      {list.error || error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? list.error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {list.isPending && !list.data ? <p role="status">Loading proposals…</p> : null}
      {list.data?.proposals.length === 0 ? (
        <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          No proposals on this page. Enable observation mode in Governance to review new findings.
        </p>
      ) : null}
      <ul className="space-y-3">
        {(list.data?.proposals ?? []).map((proposal) => (
          <li key={proposal.id}>
            <Card>
              <CardPanel className="space-y-3 p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="break-words font-semibold">{proposal.title}</h3>
                  <div className="flex flex-wrap gap-2">
                    {!proposal.currentlyEligible ? (
                      <Badge variant="outline">Stale scope</Badge>
                    ) : null}
                    <Badge variant="outline">{proposal.state}</Badge>
                  </div>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{proposal.summary}</p>
                {!proposal.currentlyEligible ? (
                  <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                    Current configuration no longer supports this proposal:{" "}
                    {proposal.staleReason ?? "scope changed"}. Review the current evidence before
                    acting on it.
                  </p>
                ) : null}
                <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                  <div>
                    <dt>Project</dt>
                    <dd className="break-all font-mono">{proposal.projectId}</dd>
                  </div>
                  <div>
                    <dt>Finding</dt>
                    <dd className="break-all font-mono">{proposal.findingId}</dd>
                  </div>
                  <div>
                    <dt>Proposal</dt>
                    <dd className="break-all font-mono">{proposal.id}</dd>
                  </div>
                  <div>
                    <dt>Published revision</dt>
                    <dd>{proposal.publishedRevision}</dd>
                  </div>
                  <div>
                    <dt>Evidence</dt>
                    <dd>
                      {proposal.evidence.length} observations from{" "}
                      {new Set(proposal.evidence.map((item) => item.sourceId)).size} sources
                    </dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>
                      <time dateTime={proposal.createdAt}>
                        {new Date(proposal.createdAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                </dl>
                <details className="rounded-lg border border-border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Evidence references</summary>
                  <ul className="mt-2 space-y-2">
                    {proposal.evidence.map((item) => (
                      <li
                        key={item.observationId}
                        className="break-all font-mono text-xs text-muted-foreground"
                      >
                        Observation {item.observationId} · Source {item.sourceId}
                      </li>
                    ))}
                  </ul>
                </details>
                {proposal.decisionReason ? (
                  <p className="text-sm text-muted-foreground">
                    Review reason: {proposal.decisionReason}
                  </p>
                ) : null}
                {proposal.reconsiderAfter ? (
                  <p className="text-sm text-muted-foreground">
                    Reconsider after{" "}
                    <time dateTime={proposal.reconsiderAfter}>
                      {new Date(proposal.reconsiderAfter).toLocaleString()}
                    </time>
                  </p>
                ) : null}
                {proposal.state === "proposed" && !offline ? (
                  <div className="space-y-2 border-t border-border pt-3">
                    <label className="block space-y-1 text-sm">
                      <span>Review reason (optional)</span>
                      <Input
                        value={reasons[proposal.id] ?? ""}
                        onValueChange={(value) =>
                          setReasons((current) => ({ ...current, [proposal.id]: value }))
                        }
                        maxLength={2_000}
                        disabled={busyId !== null}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busyId !== null || !proposal.currentlyEligible}
                        onClick={() => void decision(proposal, "acknowledge")}
                      >
                        Acknowledge
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId !== null}
                        onClick={() => void decision(proposal, "defer")}
                      >
                        Defer one day
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive-outline"
                        disabled={busyId !== null}
                        onClick={() => void decision(proposal, "reject")}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ) : null}
              </CardPanel>
            </Card>
          </li>
        ))}
      </ul>
      {cursor !== null ? (
        <Button variant="outline" onClick={() => setCursor(null)}>
          First page
        </Button>
      ) : null}
      {list.data?.nextCursor ? (
        <Button variant="outline" onClick={() => setCursor(list.data!.nextCursor)}>
          Next page
        </Button>
      ) : null}
    </section>
  );
}

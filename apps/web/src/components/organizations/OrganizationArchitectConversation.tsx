import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  OrganizationArchitectMessageId,
  type Organization,
  type OrganizationArchitectAllowedChange,
  type OrganizationArchitectProposal,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { RefreshCwIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { Textarea } from "../ui/textarea";

const SELECT_CLASS =
  "min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const START_SETUP_PROMPT =
  "Walk me through designing and setting up this Organization. Start with one question about the mission and outcomes. Guide me through roles, handoffs, workflows, resources, and authority, then Project work, GitHub sharing, and a final setup review.";
const CONTINUE_SETUP_PROMPT =
  "Continue the Organization setup walkthrough from our conversation and current draft. Ask one focused question about the next unconfirmed design or setup step.";

function proposalPresentation(
  change: OrganizationArchitectAllowedChange,
  organization: Organization,
) {
  const roleName = (id: string) =>
    organization.graph.roles.find((role) => role.id === id)?.title ?? id;
  switch (change.type) {
    case "add-role":
      return {
        title: `Add ${change.role.title}`,
        detail: `${change.role.kind} role, pool size ${change.role.poolSize}. ${change.role.mandate || "No mandate proposed."}`,
      };
    case "update-role":
      return {
        title: `Update ${roleName(change.roleId)}`,
        detail:
          [
            change.title ? `Name: ${change.title}` : null,
            change.mandate !== undefined ? `Mandate: ${change.mandate || "empty"}` : null,
            change.poolSize !== undefined ? `Pool size: ${change.poolSize}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "No field changes were proposed.",
      };
    case "add-edge":
      return {
        title: `Connect ${roleName(change.edge.fromRoleId)} to ${roleName(change.edge.toRoleId)}`,
        detail: `Relationship: ${change.edge.kind}.`,
      };
    case "upsert-workflow": {
      const previous = organization.workflows.find(
        (workflow) => workflow.id === change.workflow.id,
      );
      const steps = change.workflow.steps
        .slice(0, 6)
        .map(
          (step) =>
            `${step.title} (${step.kind}${step.roleId ? `, ${roleName(step.roleId)}` : ""})`,
        );
      return {
        title: `${previous ? "Update" : "Add"} workflow ${change.workflow.title}`,
        detail: `Version ${change.workflow.version}, ${change.workflow.steps.length} steps, ${change.workflow.transitions.length} transitions. ${steps.join(" → ")}${change.workflow.steps.length > steps.length ? " → more steps" : ""}`,
      };
    }
    case "set-title":
      return { title: "Change Organization name", detail: change.title };
    case "set-mission":
      return { title: "Change mission", detail: change.mission || "Clear the mission." };
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

export function OrganizationArchitectConversation({
  organization,
  offline,
  busy,
  onApplyBatch,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
  readonly busy: boolean;
  readonly onApplyBatch: (
    proposals: ReadonlyArray<OrganizationArchitectProposal>,
  ) => Promise<boolean>;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const { networkStatus } = useEnvironments();
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const entries = applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings);
  const architectEntries = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.isAvailable &&
      entry.installed &&
      entry.snapshot.supportsTextGeneration !== false &&
      entry.status === "ready",
  );
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedModelSlug, setSelectedModelSlug] = useState<string | null>(null);
  const preferredSelection = settings.textGenerationModelSelection;
  const selectedEntry: ProviderInstanceEntry | undefined =
    architectEntries.find((entry) => entry.instanceId === selectedInstanceId) ??
    architectEntries.find((entry) => entry.instanceId === preferredSelection.instanceId) ??
    architectEntries[0];
  const models = selectedEntry ? getAppModelOptionsForInstance(settings, selectedEntry) : [];
  const selectedModel =
    models.find((model) => model.slug === selectedModelSlug) ??
    models.find(
      (model) =>
        selectedEntry?.instanceId === preferredSelection.instanceId &&
        model.slug === preferredSelection.model,
    ) ??
    models.find((model) => model.isDefault) ??
    models[0];
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.architectList({
          environmentId,
          input: { organizationId: organization.id },
        }),
  );
  const sendCommand = useAtomCommand(organizationEnvironment.architectSend, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [appliedIds, setAppliedIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const draftBytes = new TextEncoder().encode(draft.trim()).length;
  const wasOffline = useRef(offline || networkStatus === "offline");
  const blocked =
    offline ||
    networkStatus === "offline" ||
    environmentId === null ||
    organization.lifecycle === "archived";
  const canSend =
    !blocked &&
    !busy &&
    !sending &&
    !!selectedEntry &&
    !!selectedModel &&
    draft.trim().length > 0 &&
    draft.trim().length <= 4_000 &&
    draftBytes <= 4_000;
  const messages = [...(list.data?.messages ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const requestsById = new Map(
    (list.data?.requests ?? []).map((request) => [request.requestId, request]),
  );
  const appliedMutationIds = new Set(list.data?.appliedProposalIds ?? []);

  useEffect(() => {
    const currentlyOffline = offline || networkStatus === "offline";
    if (wasOffline.current && !currentlyOffline) {
      list.refresh();
    }
    wasOffline.current = currentlyOffline;
  }, [offline, networkStatus, list.refresh]);

  function resultError<A, E>(result: AtomCommandResult<A, E>): string | null {
    if (result._tag !== "Failure") return null;
    const cause = squashAtomCommandFailure(result);
    return cause instanceof Error ? cause.message : String(cause);
  }

  async function send() {
    if (!canSend || !selectedEntry || !selectedModel || environmentId === null) return;
    const text = draft.trim();
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await sendCommand({
        environmentId,
        input: {
          organizationId: organization.id,
          messageId: OrganizationArchitectMessageId.make(randomUUID()),
          baseRevision: organization.draftRevision,
          text,
          modelSelection: createModelSelection(selectedEntry.instanceId, selectedModel.slug),
        },
      });
      const failure = resultError(result);
      if (failure) {
        setError(failure);
      } else {
        setDraft("");
        setNotice("Architect reply saved. Review any proposals before applying them.");
      }
      list.refresh();
    } finally {
      setSending(false);
    }
  }

  async function applyProposal(proposal: OrganizationArchitectProposal) {
    if (blocked || busy || applyingId !== null) return;
    if (proposal.baseRevision !== organization.draftRevision) {
      setError(
        "This proposal uses an earlier draft revision. Refresh and ask the Architect for an updated suggestion.",
      );
      return;
    }
    setApplyingId(proposal.id);
    setError(null);
    setNotice(null);
    try {
      const saved = await onApplyBatch([proposal]);
      if (saved) {
        setAppliedIds((current) => new Set([...current, proposal.id]));
        setNotice(
          "Proposal applied to the draft. Review the updated Designer and publish separately when ready.",
        );
        list.refresh();
      } else {
        setError(
          "The proposal was not applied. Refresh the Organization and review its current revision.",
        );
      }
    } finally {
      setApplyingId(null);
    }
  }

  async function applyBatch(proposals: ReadonlyArray<OrganizationArchitectProposal>) {
    if (blocked || busy || applyingId !== null || proposals.length < 2) return;
    if (proposals.some((proposal) => proposal.baseRevision !== organization.draftRevision)) {
      setError(
        "The draft changed since these suggestions. Ask Architect to review the updated canvas.",
      );
      return;
    }
    setApplyingId(`batch:${proposals[0]!.responseMessageId}`);
    setError(null);
    setNotice(null);
    try {
      const saved = await onApplyBatch(proposals);
      if (saved) {
        setAppliedIds(
          (current) => new Set([...current, ...proposals.map((proposal) => proposal.id)]),
        );
        setNotice(
          `${proposals.length} suggestions applied to the draft together. Review the canvas before publishing.`,
        );
        list.refresh();
      } else {
        setError(
          "The suggestions were not applied. Refresh the Organization and review its current revision.",
        );
      }
    } finally {
      setApplyingId(null);
    }
  }

  return (
    <Card>
      <CardPanel className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Design with Architect</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Work through the design and setup together, from mission and workflows to Project work
              and sharing. Review suggested changes on the canvas before publishing.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setDraft(messages.length === 0 ? START_SETUP_PROMPT : CONTINUE_SETUP_PROMPT)
              }
              disabled={blocked || sending}
            >
              {messages.length === 0 ? "Start setup walkthrough" : "Continue walkthrough"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => list.refresh()}
              disabled={environmentId === null}
            >
              <RefreshCwIcon /> Refresh
            </Button>
          </div>
        </div>

        {blocked ? (
          <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
            {organization.lifecycle === "archived"
              ? "This Organization is archived. Conversation and proposal edits are unavailable."
              : "Offline. Saved conversation may be out of date; sending and applying are unavailable."}
          </p>
        ) : null}
        {architectEntries.length === 0 ? (
          <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
            Connect an enabled provider in Settings to start designing with Architect.
          </p>
        ) : null}
        {selectedEntry && models.length === 0 ? (
          <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
            This provider instance has no configured model available for Architect conversation.
          </p>
        ) : null}
        {list.error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            Could not load Architect conversation: {list.error}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}

        <div
          className="min-h-48 max-h-[48rem] space-y-3 overflow-y-auto rounded-lg border border-border bg-background p-3"
          aria-label="Architect transcript"
        >
          {list.isPending && !list.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading saved conversation…
            </p>
          ) : null}
          {!list.isPending && !list.data && !list.error ? (
            <p className="text-sm text-muted-foreground">No saved conversation is available yet.</p>
          ) : null}
          {list.data && messages.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Start a guided design conversation, or ask for a review of the current canvas.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={blocked || sending}
                  onClick={() =>
                    setDraft(
                      "Review this Organization draft. What responsibilities or relationships are missing or unclear?",
                    )
                  }
                >
                  Review draft
                </Button>
              </div>
            </div>
          ) : null}
          {messages.map((message) => {
            const proposals =
              message.role === "architect"
                ? (list.data?.proposals ?? []).filter(
                    (proposal) => proposal.responseMessageId === message.id,
                  )
                : [];
            const request =
              message.role === "user" ? requestsById.get(message.requestId) : undefined;
            return (
              <article
                key={message.id}
                className="min-w-0 space-y-3 rounded-lg border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">
                    {message.role === "user" ? "You" : "Architect"}
                  </h3>
                  <div className="flex items-center gap-2">
                    {request?.status === "pending" ? (
                      <Badge variant="outline">Pending</Badge>
                    ) : null}
                    {request?.status === "failed" ? <Badge variant="error">Failed</Badge> : null}
                    <time className="text-sm text-muted-foreground" dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleString()}
                    </time>
                  </div>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
                {request?.status === "pending" ? (
                  <p className="text-sm text-muted-foreground">
                    The reply is still pending. Refresh to check for a saved result.
                  </p>
                ) : null}
                {request?.status === "failed" ? (
                  <p className="text-sm text-destructive-foreground">
                    {request.failureMessage || "The Architect could not complete this request."}
                  </p>
                ) : null}
                {proposals.length > 0 ? (
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium">Suggested draft changes</p>
                      {proposals.length > 1 &&
                      proposals.every(
                        (proposal) =>
                          !appliedIds.has(proposal.id) && !appliedMutationIds.has(proposal.id),
                      ) ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={
                            blocked ||
                            busy ||
                            !list.isSuccess ||
                            applyingId !== null ||
                            proposals.some(
                              (proposal) => proposal.baseRevision !== organization.draftRevision,
                            )
                          }
                          onClick={() => void applyBatch(proposals)}
                        >
                          {applyingId === `batch:${message.id}`
                            ? "Applying suggestions…"
                            : `Apply all ${proposals.length} to draft`}
                        </Button>
                      ) : null}
                    </div>
                    {proposals.map((proposal) => {
                      const presentation = proposalPresentation(proposal.change, organization);
                      const applied =
                        appliedIds.has(proposal.id) || appliedMutationIds.has(proposal.id);
                      const stale = proposal.baseRevision !== organization.draftRevision;
                      return (
                        <div
                          key={proposal.id}
                          className="min-w-0 rounded-lg border border-border bg-muted/30 p-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <h4 className="min-w-0 break-words text-sm font-semibold">
                              {presentation.title}
                            </h4>
                            <Badge variant={applied ? "success" : "outline"}>
                              {applied ? "Applied" : `Draft ${proposal.baseRevision}`}
                            </Badge>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                            {presentation.detail}
                          </p>
                          {!applied ? (
                            <div className="mt-3 space-y-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  blocked || busy || !list.isSuccess || applyingId !== null || stale
                                }
                                onClick={() => void applyProposal(proposal)}
                              >
                                {applyingId === proposal.id ? "Applying…" : "Apply to draft"}
                              </Button>
                              {stale ? (
                                <p className="text-sm text-muted-foreground">
                                  The draft changed since this suggestion. Ask Architect to review
                                  the updated canvas before applying another change.
                                </p>
                              ) : null}
                              {!list.isSuccess && !stale ? (
                                <p className="text-sm text-muted-foreground">
                                  Apply is available after proposal history loads.
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        {architectEntries.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium">
              <span>Provider</span>
              <select
                className={SELECT_CLASS}
                value={selectedEntry?.instanceId ?? ""}
                onChange={(event) => {
                  setSelectedInstanceId(event.currentTarget.value);
                  setSelectedModelSlug(null);
                }}
                disabled={blocked || sending}
              >
                {architectEntries.map((entry) => (
                  <option key={entry.instanceId} value={entry.instanceId}>
                    {entry.displayName}
                  </option>
                ))}
              </select>
            </label>
            {selectedEntry && models.length > 0 ? (
              <label className="space-y-1.5 text-sm font-medium">
                <span>Model</span>
                <select
                  className={SELECT_CLASS}
                  value={selectedModel?.slug ?? ""}
                  onChange={(event) => setSelectedModelSlug(event.currentTarget.value)}
                  disabled={blocked || sending}
                >
                  {models.map((model) => (
                    <option key={model.slug} value={model.slug}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          className="space-y-3"
        >
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Message</span>
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              maxLength={4_000}
              placeholder="Ask how to improve roles, responsibilities, or relationships"
              disabled={blocked || sending || architectEntries.length === 0}
            />
            <span
              className={
                draftBytes > 4_000
                  ? "text-xs text-destructive-foreground"
                  : "text-xs text-muted-foreground"
              }
            >
              {draftBytes.toLocaleString()} / 4,000 UTF-8 bytes
            </span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Organization configuration and this conversation are sent to the selected model.
              Repository files are not supplied. Enter credentials in their settings, not here.
            </p>
            <Button type="submit" disabled={!canSend}>
              <SendIcon /> {sending ? "Waiting for reply…" : "Send to Architect"}
            </Button>
          </div>
        </form>
      </CardPanel>
    </Card>
  );
}

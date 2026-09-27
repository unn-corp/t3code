import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  OrganizationDirectorRequestId,
  type Organization,
  type OrganizationDirectorEvidence,
  type ProjectId,
} from "@t3tools/contracts";
import { RefreshCwIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { Textarea } from "../ui/textarea";

type Destination = "sources" | "work" | "operations";
type PendingRequest = {
  readonly requestId: OrganizationDirectorRequestId;
  readonly projectId: ProjectId | null;
  readonly prompt: string;
};

const SELECT_CLASS =
  "min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

function evidenceDestination(evidence: OrganizationDirectorEvidence): Destination {
  switch (evidence.kind) {
    case "observation":
      return "sources";
    case "finding":
    case "work":
    case "proposal":
      return "work";
    default: {
      const exhaustive: never = evidence;
      return exhaustive;
    }
  }
}

function destinationLabel(destination: Destination) {
  switch (destination) {
    case "sources":
      return "Open Sources";
    case "work":
      return "Open Work & Findings";
    case "operations":
      return "Open Live Operations";
    default: {
      const exhaustive: never = destination;
      return exhaustive;
    }
  }
}

export function OrganizationDirectorConversation({
  organization,
  offline,
  onNavigate,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
  readonly onNavigate: (destination: Destination) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const activeBindings = organization.bindings.filter((binding) => binding.detachedAt === null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [pageCursor, setPageCursor] = useState<number | null>(null);
  const [previousCursors, setPreviousCursors] = useState<ReadonlyArray<number | null>>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [retryRequest, setRetryRequest] = useState<PendingRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedBinding = activeBindings.find((binding) => binding.projectId === selectedProjectId);
  const projectId = selectedBinding?.projectId ?? null;
  const scopeName = selectedBinding
    ? (projects.find((project) => project.id === selectedBinding.projectId)?.title ??
      selectedBinding.projectId)
    : "Organization-wide";
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.directorList({
          environmentId,
          input: {
            organizationId: organization.id,
            projectId,
            afterSequence: pageCursor,
            limit: 50,
          },
        }),
  );
  const ask = useAtomCommand(organizationEnvironment.directorAsk, { reportFailure: false });
  const wasOffline = useRef(offline);
  const blocked = offline || environmentId === null || organization.lifecycle === "archived";
  const prompt = draft.trim();
  const promptBytes = new TextEncoder().encode(prompt).length;
  const canSend =
    !blocked &&
    !sending &&
    retryRequest === null &&
    prompt.length > 0 &&
    prompt.length <= 4_000 &&
    promptBytes <= 4_000;
  const messages = [...(list.data?.messages ?? [])].sort(
    (left, right) => left.sequence - right.sequence,
  );

  useEffect(() => {
    if (wasOffline.current && !offline) list.refresh();
    wasOffline.current = offline;
  }, [offline, list.refresh]);

  function changeScope(value: string) {
    setSelectedProjectId(value);
    setPageCursor(null);
    setPreviousCursors([]);
    setError(null);
    setNotice(null);
  }

  async function sendRequest(request: PendingRequest) {
    if (blocked || sending || environmentId === null) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await ask({
        environmentId,
        input: {
          organizationId: organization.id,
          projectId: request.projectId,
          requestId: request.requestId,
          prompt: request.prompt,
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : String(cause));
        setRetryRequest(request);
        list.refresh();
        return;
      }
      setRetryRequest(null);
      setDraft("");
      setNotice("Director reply saved. Its cited records are listed with the message.");
      const afterSequence =
        result.value.userMessage.sequence > 1 ? result.value.userMessage.sequence - 1 : null;
      setPageCursor(afterSequence);
      setPreviousCursors([]);
      list.refresh();
    } finally {
      setSending(false);
    }
  }

  function nextPage() {
    const next = list.data?.nextCursor;
    if (next === null || next === undefined) return;
    setPreviousCursors((current) => [...current, pageCursor]);
    setPageCursor(next);
  }

  function previousPage() {
    const previous = previousCursors.at(-1);
    if (previous === undefined) return;
    setPageCursor(previous);
    setPreviousCursors((current) => current.slice(0, -1));
  }

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold">Director conversation</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask the Director about saved Organization records. Replies cite recorded evidence and
            cannot initiate an investigation or execute work.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => list.refresh()}
          disabled={environmentId === null || offline}
        >
          <RefreshCwIcon /> Refresh conversation
        </Button>
      </div>

      {offline ? (
        <p role="status" className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          Offline. Saved conversation may be out of date; sending is unavailable.
        </p>
      ) : null}
      {organization.lifecycle === "archived" ? (
        <p role="status" className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          This Organization is archived. Conversation is read-only.
        </p>
      ) : null}
      {environmentId === null ? (
        <p role="status" className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          Connect an environment to load the Director conversation.
        </p>
      ) : null}

      <Card>
        <CardPanel className="space-y-4 p-4 sm:p-5">
          <label className="block max-w-md space-y-1.5 text-sm font-medium">
            <span>Project scope</span>
            <select
              className={SELECT_CLASS}
              value={projectId ?? ""}
              onChange={(event) => changeScope(event.currentTarget.value)}
              disabled={sending}
            >
              <option value="">Organization-wide</option>
              {activeBindings.map((binding) => (
                <option key={binding.id} value={binding.projectId}>
                  {projects.find((project) => project.id === binding.projectId)?.title ??
                    binding.projectId}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm text-muted-foreground">
            Showing only {scopeName} messages. Project scopes require an active binding; selecting
            another scope opens its separate saved conversation.
          </p>
          {list.error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              Could not load Director conversation: {list.error}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              Message was not saved: {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}

          <section
            aria-label={scopeName + " Director transcript"}
            className="max-h-[36rem] space-y-3 overflow-y-auto rounded-lg border border-border bg-background p-3"
          >
            {list.isPending && !list.data ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading saved conversation…
              </p>
            ) : null}
            {!list.isPending && !list.data && !list.error ? (
              <p role="status" className="text-sm text-muted-foreground">
                {offline
                  ? "No saved transcript is available offline."
                  : "Saved conversation is unavailable."}
              </p>
            ) : null}
            {list.data && messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No messages in this scope yet. Ask about saved records to begin.
              </p>
            ) : null}
            {messages.map((message) => (
              <article
                key={message.id}
                className="min-w-0 space-y-2 rounded-xl border border-border p-3 sm:p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">
                    {message.role === "user" ? "You" : "Director"}
                  </h3>
                  <time className="text-sm text-muted-foreground" dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString()}
                  </time>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
                {message.evidence.length > 0 ? (
                  <div className="space-y-2 border-t border-border pt-3">
                    <h4 className="text-sm font-medium">Saved record citations</h4>
                    <ul className="space-y-2">
                      {message.evidence.map((evidence) => {
                        const destination = evidenceDestination(evidence);
                        return (
                          <li
                            key={evidence.kind + ":" + evidence.id}
                            className="min-w-0 rounded-lg bg-muted/30 p-2 text-sm"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">{evidence.label}</Badge>
                              <span className="capitalize">{evidence.kind}</span>
                            </div>
                            <p className="mt-1 break-all">
                              ID: <code>{evidence.id}</code>
                            </p>
                            <p className="mt-1 break-words text-muted-foreground">
                              {evidence.projectId
                                ? (projects.find((project) => project.id === evidence.projectId)
                                    ?.title ?? evidence.projectId)
                                : "Organization scope"}
                            </p>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onNavigate(destination)}
                            >
                              {destinationLabel(destination)}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </article>
            ))}
          </section>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="text-muted-foreground">
              {list.data
                ? "Showing " +
                  messages.length +
                  " saved message" +
                  (messages.length === 1 ? "" : "s") +
                  " on this page."
                : "Transcript page has not loaded."}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPageCursor(null);
                  setPreviousCursors([]);
                }}
                disabled={pageCursor === null || list.isPending}
              >
                First page
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={previousPage}
                disabled={previousCursors.length === 0 || list.isPending}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={nextPage}
                disabled={
                  list.data?.nextCursor === null ||
                  list.data?.nextCursor === undefined ||
                  list.isPending
                }
              >
                Next
              </Button>
            </div>
          </div>

          <form
            className="space-y-3 border-t border-border pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSend) return;
              void sendRequest({
                requestId: OrganizationDirectorRequestId.make(randomUUID()),
                projectId,
                prompt,
              });
            }}
          >
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Message to Director</span>
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                maxLength={4_000}
                placeholder="Ask what the saved records show about this Organization"
                disabled={blocked || sending}
              />
              <span
                className={
                  promptBytes > 4_000
                    ? "text-sm text-destructive-foreground"
                    : "text-sm text-muted-foreground"
                }
              >
                {promptBytes.toLocaleString()} / 4,000 UTF-8 bytes
              </span>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Only saved records in the selected scope can be cited. A reply does not change
                Organization or Project state.
              </p>
              <Button type="submit" disabled={!canSend}>
                <SendIcon /> {sending ? "Waiting for reply…" : "Ask Director"}
              </Button>
            </div>
            {retryRequest ? (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <p>
                  The prior request may have been saved. Retry with the same request ID to avoid a
                  duplicate message.
                </p>
                <Button
                  type="button"
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  disabled={blocked || sending || retryRequest.projectId !== projectId}
                  onClick={() => void sendRequest(retryRequest)}
                >
                  Retry prior request
                </Button>
                <Button
                  type="button"
                  className="mt-2 ml-2"
                  size="sm"
                  variant="ghost"
                  disabled={sending}
                  onClick={() => {
                    setRetryRequest(null);
                    setError(null);
                    setNotice("Retry dismissed. Check the saved transcript before sending again.");
                  }}
                >
                  Dismiss retry
                </Button>
                {retryRequest.projectId !== projectId ? (
                  <p className="mt-2 text-muted-foreground">
                    Select the original Project scope to retry.
                  </p>
                ) : null}
              </div>
            ) : null}
          </form>
        </CardPanel>
      </Card>
    </div>
  );
}

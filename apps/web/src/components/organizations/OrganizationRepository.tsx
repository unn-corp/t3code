import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  GitHubAccountId,
  OrganizationMemoryContent,
  OrganizationMemoryMutationId,
  OrganizationMemoryRecordId,
  type Organization,
  type OrganizationRepositoryRecordView,
  type OrganizationRepositoryStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { organizationEnvironment, useOrganizations } from "../../state/organizations";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";
import { Input } from "../ui/input";

const kinds = [
  "all",
  "configuration",
  "configuration-version",
  "architect-request",
  "architect-message",
  "architect-proposal",
  "director-request",
  "director-message",
  "memory",
  "memory-revision",
  "source",
  "observation",
  "finding",
  "proposal",
  "proposal-decision",
  "work-intent",
  "work",
  "work-transition",
  "work-attempt",
  "work-artifact",
  "qa-receipt",
  "approval-receipt",
  "integration-receipt",
  "organization-audit",
  "source-audit",
] as const;
type Kind = (typeof kinds)[number];
const isMemoryContent = Schema.is(OrganizationMemoryContent);

function errorText(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure") return "";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

function statusText(status: OrganizationRepositoryStatus) {
  const parts = [
    `${status.pendingCount} local pending`,
    `${status.incomingCount} incoming`,
    `${status.conflictCount} conflicts`,
  ];
  return parts.join(" · ");
}

export function OrganizationRepository({
  organization,
  offline,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings();
  const [repository, setRepository] = useState("");
  const [create, setCreate] = useState(true);
  const [visibility, setVisibility] = useState<"private" | "public" | "internal">("private");
  const [publicAcknowledged, setPublicAcknowledged] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [kind, setKind] = useState<Kind>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [selected, setSelected] = useState<OrganizationRepositoryRecordView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = { organizationId: organization.id };
  const preview = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.repositoryPreview({ environmentId, input }),
  );
  const status = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.repositoryStatus({ environmentId, input }),
  );
  const records = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.repositoryListRecords({
          environmentId,
          input: {
            ...input,
            ...(kind === "all" ? {} : { kind }),
            ...(cursor === null ? {} : { cursor }),
            limit: 25,
          },
        }),
  );
  const link = useAtomCommand(organizationEnvironment.repositoryLink, { reportFailure: false });
  const sync = useAtomCommand(organizationEnvironment.repositorySync, { reportFailure: false });
  const resolve = useAtomCommand(organizationEnvironment.repositoryResolveConflict, {
    reportFailure: false,
  });
  const createMemory = useAtomCommand(organizationEnvironment.memoryCreate, {
    reportFailure: false,
  });
  const blocked = offline || environmentId === null || busy;

  const refresh = () => {
    status.refresh();
    records.refresh();
    preview.refresh();
  };
  async function run<E>(
    action: () => Promise<AtomCommandResult<OrganizationRepositoryStatus, E>>,
    success: string,
  ) {
    if (blocked) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result._tag === "Failure") {
        setError(errorText(result));
        return;
      }
      setNotice(success);
      refresh();
    } finally {
      setBusy(false);
    }
  }
  function changeKind(next: Kind) {
    setKind(next);
    setCursor(null);
    setPrevious([]);
    setSelected(null);
  }
  function nextPage() {
    if (!records.data?.nextCursor) return;
    setPrevious((items) => [...items, cursor]);
    setCursor(records.data.nextCursor);
    setSelected(null);
  }
  function previousPage() {
    const before = previous.at(-1);
    if (before === undefined) return;
    setPrevious((items) => items.slice(0, -1));
    setCursor(before);
    setSelected(null);
  }
  async function adoptMemory() {
    if (
      blocked ||
      !selected ||
      selected.record.kind !== "memory" ||
      selected.record.content.project_id !== null ||
      !status.data?.repository
    )
      return;
    const original = selected.record.content.content;
    if (!isMemoryContent(original)) {
      setError("This shared memory cannot be saved locally because its content is invalid.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const reference = `github:${status.data.repository}:memory:${selected.record.id}`.slice(
        0,
        512,
      );
      const note =
        `Imported from the shared repository as an unverified reference. Original provenance: ${original.provenance.reference ?? original.provenance.kind}`.slice(
          0,
          1_000,
        );
      const result = await createMemory({
        environmentId: environmentId!,
        input: {
          organizationId: organization.id,
          projectId: null,
          mutationId: OrganizationMemoryMutationId.make(randomUUID()),
          recordId: OrganizationMemoryRecordId.make(randomUUID()),
          content: {
            ...original,
            provenance: { kind: "explicit-reference", reference, note },
            reviewedAt: null,
            staleAt: new Date().toISOString(),
          },
        },
      });
      if (result._tag === "Failure") {
        setError(errorText(result));
        return;
      }
      setNotice(
        "Shared memory saved as a local, unverified reference. Review it in Memory and decisions.",
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }
  const linked = status.data?.repository;

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-xl font-semibold">Organization repository</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Share this Organization’s ongoing knowledge and history through GitHub. Imported records
          are attributed reference material. Local Project access and policy approval stay on this
          server.
        </p>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {offline ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnect to manage the repository.
        </p>
      ) : null}
      <Card>
        <CardPanel>
          {linked ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium">{linked}</h3>
                  <p className="text-sm text-muted-foreground">
                    {status.data?.visibility} ·{" "}
                    {status.data ? statusText(status.data) : "Loading sync state"} ·{" "}
                    {status.data?.autoSyncEnabled ? "Automatic sync on" : "Manual sync"}
                  </p>
                </div>
                <Button
                  disabled={blocked}
                  onClick={() =>
                    void run(
                      () => sync({ environmentId: environmentId!, input }),
                      "Repository checked and local changes saved.",
                    )
                  }
                >
                  Save and sync
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Last accepted commit: {status.data?.lastAcceptedCommit ?? "none"}
              </p>
              {status.data?.lastError ? (
                <p role="status" className="text-sm text-destructive">
                  {status.data.lastError}
                </p>
              ) : null}
              {status.data?.visibility === "public" && !status.data.publicExposureAcknowledged ? (
                <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">
                  Sync is paused because this repository became public. Portable conversations,
                  observations, decisions, work history, and evidence can be exposed to everyone.
                  Known credentials are filtered, but user-entered text may still be sensitive.
                  Review the shared archive before continuing.
                  <label className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={publicAcknowledged}
                      onChange={(event) => setPublicAcknowledged(event.target.checked)}
                      disabled={blocked}
                    />
                    I understand this repository exposes shared records publicly.
                  </label>
                  <Button
                    disabled={blocked || !publicAcknowledged}
                    onClick={() =>
                      void run(
                        () =>
                          link({
                            environmentId: environmentId!,
                            input: {
                              organizationId: organization.id,
                              repository: linked,
                              create: false,
                              visibility: "public",
                              publicExposureAcknowledged: true,
                              autoSync: status.data?.autoSyncEnabled ?? false,
                            },
                          }),
                        "Public exposure acknowledged and sync resumed.",
                      )
                    }
                  >
                    Acknowledge and resume sync
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <h3 className="font-medium">Link a GitHub repository</h3>
              <p className="text-sm text-muted-foreground">
                Review what will be shared, then choose a dedicated repository. New repositories
                start private.
              </p>
              <div className="space-y-2">
                <label htmlFor="organization-repository-name" className="text-sm font-medium">
                  Owner / repository
                </label>
                <Input
                  id="organization-repository-name"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="owner/organization-record"
                  disabled={blocked}
                />
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={create}
                    onChange={(event) => setCreate(event.target.checked)}
                    disabled={blocked}
                  />{" "}
                  Create repository
                </label>
                <label className="flex items-center gap-2">
                  Visibility
                  <select
                    value={visibility}
                    onChange={(event) => setVisibility(event.target.value as typeof visibility)}
                    disabled={blocked || !create}
                    className="rounded-md border border-input bg-background px-2 py-1"
                  >
                    <option value="private">Private</option>
                    <option value="internal">Internal</option>
                    <option value="public">Public</option>
                  </select>
                </label>
              </div>
              {!create || visibility === "public" ? (
                <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">
                  {create
                    ? "A public repository"
                    : "An existing repository may be public. If it is public, it"}{" "}
                  exposes portable conversations, observations, decisions, work history, and
                  evidence to everyone. Known credentials are filtered, but user-entered text can
                  still contain sensitive details. Review the records before publishing.
                  <label className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={publicAcknowledged}
                      onChange={(event) => setPublicAcknowledged(event.target.checked)}
                      disabled={blocked}
                    />{" "}
                    I understand this repository may expose shared records publicly.
                  </label>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  GitHub account
                  <select
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                    disabled={blocked}
                    className="rounded-md border border-input bg-background px-2 py-1"
                  >
                    <option value="">Default GitHub CLI account</option>
                    {Object.entries(settings.githubAccounts).map(([id, account]) => (
                      <option key={id} value={id}>
                        {account.label || id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoSync}
                    onChange={(event) => setAutoSync(event.target.checked)}
                    disabled={blocked}
                  />{" "}
                  Sync automatically
                </label>
              </div>
              <Button
                disabled={
                  blocked ||
                  !preview.data ||
                  !repository.trim() ||
                  ((!create || visibility === "public") && !publicAcknowledged)
                }
                onClick={() =>
                  void run(
                    () =>
                      link({
                        environmentId: environmentId!,
                        input: {
                          organizationId: organization.id,
                          repository: repository.trim(),
                          create,
                          visibility,
                          publicExposureAcknowledged: publicAcknowledged,
                          autoSync,
                          ...(accountId
                            ? { githubAccountId: GitHubAccountId.make(accountId) }
                            : {}),
                        },
                      }),
                    "Repository linked and synchronized.",
                  )
                }
              >
                Link and share
              </Button>
            </>
          )}
        </CardPanel>
      </Card>
      <Card>
        <CardPanel>
          <h3 className="font-medium">Share preview</h3>
          {preview.data ? (
            <>
              <p className="text-sm">
                {preview.data.totalRecords} portable records across {preview.data.counts.length}{" "}
                categories
              </p>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {preview.data.counts.map((item) => (
                  <span key={item.kind} className="rounded border border-border px-2 py-1">
                    {item.kind}: {item.count}
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Kept local: {preview.data.excluded.join(", ")}.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Loading share preview.</p>
          )}
        </CardPanel>
      </Card>
      {linked ? (
        <Card>
          <CardPanel>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">Shared archive</h3>
              <select
                aria-label="Record category"
                value={kind}
                onChange={(event) => changeKind(event.target.value as Kind)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                {kinds.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Incoming records stay in this archive until reviewed. Choosing remote in a conflict
              keeps its record here as incoming; it does not apply policy or approvals locally.
            </p>
            {records.data?.records.length ? (
              <ul className="divide-y divide-border">
                {records.data.records.map((item) => (
                  <li key={item.recordKey} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        className="text-left text-sm font-medium underline-offset-2 hover:underline"
                        onClick={() => setSelected(item)}
                      >
                        {item.record.kind}: {item.record.id}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {item.remoteDigest === "0".repeat(64)
                          ? "remote deleted · previous content shown"
                          : item.state}
                      </span>
                    </div>
                    {item.state === "conflict" ? (
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={blocked}
                          onClick={() =>
                            void run(
                              () =>
                                resolve({
                                  environmentId: environmentId!,
                                  input: {
                                    organizationId: organization.id,
                                    recordKey: item.recordKey,
                                    choice: "local",
                                    expectedRemoteDigest: item.remoteDigest,
                                  },
                                }),
                              "Local version chosen and sync attempted.",
                            )
                          }
                        >
                          Keep local
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={blocked}
                          onClick={() =>
                            void run(
                              () =>
                                resolve({
                                  environmentId: environmentId!,
                                  input: {
                                    organizationId: organization.id,
                                    recordKey: item.recordKey,
                                    choice: "remote",
                                    expectedRemoteDigest: item.remoteDigest,
                                  },
                                }),
                              "Remote version retained as incoming archive material.",
                            )
                          }
                        >
                          Keep remote in archive
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No records in this page.</p>
            )}
            {selected ? (
              <div className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">{selected.recordKey}</h4>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                    Close
                  </Button>
                </div>
                {selected.record.kind === "memory" &&
                selected.record.content.project_id === null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={blocked}
                    onClick={() => void adoptMemory()}
                  >
                    Save as local memory reference
                  </Button>
                ) : null}
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(selected.record.content, null, 2)}
                </pre>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={previous.length === 0}
                onClick={previousPage}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!records.data?.nextCursor}
                onClick={nextPage}
              >
                Next
              </Button>
            </div>
          </CardPanel>
        </Card>
      ) : null}
    </div>
  );
}

export function OrganizationRepositoryLoader() {
  const navigate = useNavigate();
  const settings = usePrimarySettings();
  const organizations = useOrganizations();
  const environmentId = usePrimaryEnvironmentId();
  const load = useAtomCommand(organizationEnvironment.repositoryLoad, { reportFailure: false });
  const [repository, setRepository] = useState("");
  const [accountId, setAccountId] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [publicAcknowledged, setPublicAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!environmentId || busy || !repository.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await load({
        environmentId,
        input: {
          repository: repository.trim(),
          autoSync,
          publicExposureAcknowledged: publicAcknowledged,
          ...(accountId ? { githubAccountId: GitHubAccountId.make(accountId) } : {}),
        },
      });
      if (result._tag === "Failure") {
        setError(errorText(result));
        return;
      }
      organizations.refresh();
      void navigate({
        to: "/organizations/$organizationId",
        params: { organizationId: result.value.organizationId },
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardPanel>
        <h2 className="font-medium">Load a shared Organization</h2>
        <p className="text-sm text-muted-foreground">
          Open a GitHub Organization repository as a local draft. Shared history stays available in
          its archive; reconnect Projects and review policy here before publishing.
        </p>
        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          <label htmlFor="organization-repository-load" className="text-sm font-medium">
            Owner / repository
          </label>
          <Input
            id="organization-repository-load"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/organization-record"
            disabled={busy || environmentId === null}
          />
          <label className="flex items-center gap-2 text-sm">
            GitHub account
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              disabled={busy || environmentId === null}
              className="rounded-md border border-input bg-background px-2 py-1"
            >
              <option value="">Default GitHub CLI account</option>
              {Object.entries(settings.githubAccounts).map(([id, account]) => (
                <option key={id} value={id}>
                  {account.label || id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(event) => setAutoSync(event.target.checked)}
              disabled={busy || environmentId === null}
            />{" "}
            Sync automatically
          </label>
          <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">
            This repository may be public. Automatic sync can publish portable conversations,
            observations, decisions, work history, and evidence. Known credentials are filtered, but
            user-entered text may still be sensitive. Review its records before sharing.
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={publicAcknowledged}
                onChange={(event) => setPublicAcknowledged(event.target.checked)}
                disabled={busy || environmentId === null}
              />
              I understand this repository may expose shared records publicly.
            </label>
          </div>
          <Button
            type="submit"
            disabled={busy || environmentId === null || !repository.trim() || !publicAcknowledged}
          >
            {busy ? "Loading…" : "Load Organization"}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardPanel>
    </Card>
  );
}

import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  OrganizationMemoryMutationId,
  OrganizationMemoryRecordId,
  type Organization,
  type OrganizationMemoryContent,
  type OrganizationMemoryRecord,
} from "@t3tools/contracts";
import { ArchiveIcon, RefreshCwIcon } from "lucide-react";
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
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const MEMORY_KINDS = [
  "architecture",
  "standard",
  "decision",
  "finding",
  "incident",
  "rejected-approach",
  "question",
  "source-reference",
  "outcome",
  "other",
] as const satisfies ReadonlyArray<OrganizationMemoryContent["kind"]>;
const SELECT_CLASS =
  "min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

function formatTime(value: string) {
  return new Date(value).toLocaleString();
}

function localDateTime(value: string | null) {
  if (value === null) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoDateTime(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function statusLabel(record: OrganizationMemoryRecord) {
  if (record.status === "archived") return "Archived";
  if (record.status === "superseded") return "Superseded";
  return "Active";
}

export function OrganizationMemoryAndDecisions({
  organization,
  offline,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const activeBindings = organization.bindings.filter((binding) => binding.detachedAt === null);
  const historicalBindings = organization.bindings.filter(
    (binding, index, bindings) =>
      bindings.findIndex((candidate) => candidate.projectId === binding.projectId) === index,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [recordOffset, setRecordOffset] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const selectedBinding = historicalBindings.find(
    (binding) => binding.projectId === selectedProjectId,
  );
  const scopeProjectId = selectedBinding?.projectId ?? null;
  const scopeLabel = selectedBinding
    ? (projects.find((project) => project.id === selectedBinding.projectId)?.title ??
      selectedBinding.projectId)
    : "Organization-wide";
  const scopeInput = {
    organizationId: organization.id,
    projectId: scopeProjectId,
    offset: recordOffset,
  };
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.memoryList({ environmentId, input: scopeInput }),
  );
  const [historyRecordId, setHistoryRecordId] = useState<string | null>(null);
  const historyRecord = (list.data?.records ?? []).find((record) => record.id === historyRecordId);
  const history = useEnvironmentQuery(
    environmentId === null || !historyRecord
      ? null
      : organizationEnvironment.memoryHistory({
          environmentId,
          input: {
            organizationId: organization.id,
            recordId: historyRecord.id,
            projectId: scopeProjectId,
            offset: historyOffset,
          },
        }),
  );
  const createRecord = useAtomCommand(organizationEnvironment.memoryCreate, {
    reportFailure: false,
  });
  const correctRecord = useAtomCommand(organizationEnvironment.memoryCorrect, {
    reportFailure: false,
  });
  const supersedeRecord = useAtomCommand(organizationEnvironment.memorySupersede, {
    reportFailure: false,
  });
  const archiveRecord = useAtomCommand(organizationEnvironment.memoryArchive, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState<OrganizationMemoryRecord | null>(null);
  const [kind, setKind] = useState<OrganizationMemoryContent["kind"]>("decision");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [provenanceKind, setProvenanceKind] =
    useState<OrganizationMemoryContent["provenance"]["kind"]>("user");
  const [reference, setReference] = useState("");
  const [provenanceNote, setProvenanceNote] = useState("");
  const [reviewedAt, setReviewedAt] = useState("");
  const [staleAt, setStaleAt] = useState("");
  const [retainUntil, setRetainUntil] = useState("");
  const [archiveTargetId, setArchiveTargetId] = useState<string | null>(null);
  const [supersedeTargetId, setSupersedeTargetId] = useState<string | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wasOffline = useRef(offline);
  const disabled =
    offline ||
    environmentId === null ||
    organization.lifecycle === "archived" ||
    busy ||
    (scopeProjectId !== null &&
      !activeBindings.some((binding) => binding.projectId === scopeProjectId));
  const records = list.data?.records ?? [];
  const now = Date.now();
  const valid =
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    (provenanceKind !== "explicit-reference" || reference.trim().length > 0);

  useEffect(() => {
    if (wasOffline.current && !offline) {
      list.refresh();
      history.refresh();
    }
    wasOffline.current = offline;
  }, [offline, list.refresh, history.refresh]);

  function resetEditor() {
    setEditing(null);
    setKind("decision");
    setTitle("");
    setBody("");
    setProvenanceKind("user");
    setReference("");
    setProvenanceNote("");
    setReviewedAt("");
    setStaleAt("");
    setRetainUntil("");
  }

  function beginCorrection(record: OrganizationMemoryRecord) {
    setEditing(record);
    setKind(record.content.kind);
    setTitle(record.content.title);
    setBody(record.content.body);
    setProvenanceKind(record.content.provenance.kind);
    setReference(record.content.provenance.reference ?? "");
    setProvenanceNote(record.content.provenance.note ?? "");
    setReviewedAt(localDateTime(record.content.reviewedAt));
    setStaleAt(localDateTime(record.content.staleAt));
    setRetainUntil(localDateTime(record.content.retainUntil));
    setError(null);
    setNotice(null);
  }

  function checkResult<E>(result: AtomCommandResult<OrganizationMemoryRecord, E>) {
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice(null);
      list.refresh();
      history.refresh();
      return null;
    }
    setError(null);
    list.refresh();
    history.refresh();
    return result.value;
  }

  function content(): OrganizationMemoryContent {
    return {
      kind,
      title: title.trim(),
      body: body.trim(),
      provenance: {
        kind: provenanceKind,
        reference: provenanceKind === "explicit-reference" ? reference.trim() : null,
        note: provenanceNote.trim() || null,
      },
      reviewedAt: isoDateTime(reviewedAt),
      staleAt: isoDateTime(staleAt),
      retainUntil: isoDateTime(retainUntil),
    };
  }

  async function save() {
    if (disabled || !valid || environmentId === null) return;
    if (editing && editing.projectId !== scopeProjectId) {
      setError("The record scope changed. Select the original scope and reopen the correction.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = editing
        ? await correctRecord({
            environmentId,
            input: {
              organizationId: organization.id,
              recordId: editing.id,
              expectedVersion: editing.version,
              mutationId: OrganizationMemoryMutationId.make(randomUUID()),
              content: content(),
            },
          })
        : await createRecord({
            environmentId,
            input: {
              organizationId: organization.id,
              projectId: scopeProjectId,
              recordId: OrganizationMemoryRecordId.make(randomUUID()),
              mutationId: OrganizationMemoryMutationId.make(randomUUID()),
              content: content(),
            },
          });
      const saved = checkResult(result);
      if (!saved) return;
      setNotice(editing ? "Correction saved as a new revision." : "Memory record created.");
      resetEditor();
    } finally {
      setBusy(false);
    }
  }

  async function archive(record: OrganizationMemoryRecord) {
    if (disabled || environmentId === null || record.projectId !== scopeProjectId) return;
    setBusy(true);
    try {
      const saved = checkResult(
        await archiveRecord({
          environmentId,
          input: {
            organizationId: organization.id,
            recordId: record.id,
            expectedVersion: record.version,
            mutationId: OrganizationMemoryMutationId.make(randomUUID()),
          },
        }),
      );
      if (saved) setNotice("Record archived. Its revision history remains available.");
      setArchiveTargetId(null);
    } finally {
      setBusy(false);
    }
  }

  async function supersede(record: OrganizationMemoryRecord) {
    const replacement = records.find((candidate) => candidate.id === replacementId);
    if (
      disabled ||
      environmentId === null ||
      !replacement ||
      replacement.id === record.id ||
      replacement.status !== "active" ||
      replacement.projectId !== record.projectId ||
      record.projectId !== scopeProjectId
    )
      return;
    setBusy(true);
    try {
      const saved = checkResult(
        await supersedeRecord({
          environmentId,
          input: {
            organizationId: organization.id,
            recordId: record.id,
            expectedVersion: record.version,
            replacementRecordId: replacement.id,
            mutationId: OrganizationMemoryMutationId.make(randomUUID()),
          },
        }),
      );
      if (saved) setNotice(`Record superseded by ${replacement.content.title}.`);
      setSupersedeTargetId(null);
      setReplacementId("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-5">
      <Card>
        <CardPanel className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Memory & Decisions</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                People enter and revise these records. Scope, provenance, and revision history stay
                visible.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={environmentId === null}
              onClick={() => {
                list.refresh();
                history.refresh();
              }}
            >
              <RefreshCwIcon /> Refresh
            </Button>
          </div>
          <label className="block max-w-md space-y-1.5 text-sm font-medium">
            <span>Scope</span>
            <select
              className={SELECT_CLASS}
              value={scopeProjectId ?? ""}
              onChange={(event) => {
                setSelectedProjectId(event.currentTarget.value);
                setRecordOffset(0);
                setHistoryOffset(0);
                setHistoryRecordId(null);
                setArchiveTargetId(null);
                setSupersedeTargetId(null);
                resetEditor();
              }}
            >
              <option value="">Organization-wide</option>
              {historicalBindings.map((binding) => (
                <option key={binding.id} value={binding.projectId}>
                  {projects.find((project) => project.id === binding.projectId)?.title ??
                    binding.projectId}
                  {activeBindings.some((active) => active.projectId === binding.projectId)
                    ? ""
                    : " (detached · read only)"}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm text-muted-foreground">
            Showing {scopeLabel} records only. Historical Project records remain readable after
            detachment; an active binding is required for changes. Up to 100 recently updated
            records are returned per page.
          </p>
          {offline ? (
            <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
              Offline. Saved records may be out of date; changes are unavailable.
            </p>
          ) : null}
          {organization.lifecycle === "archived" ? (
            <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
              This Organization is archived. Memory can be read but not changed.
            </p>
          ) : null}
          {list.error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              Could not load memory: {list.error}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              Change was not saved: {error} Refresh and review the current version.
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </CardPanel>
      </Card>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <section aria-label={`${scopeLabel} memory records`} className="min-w-0 space-y-3">
          {list.isPending && !list.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading memory records…
            </p>
          ) : null}
          {!list.isPending && !list.data && !list.error ? (
            <p className="text-sm text-muted-foreground">No cached records are available yet.</p>
          ) : null}
          {list.data && records.length === 0 ? (
            <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
              No memory records in this scope yet.
            </p>
          ) : null}
          {records.map((record) => {
            const stale =
              record.content.staleAt !== null && Date.parse(record.content.staleAt) <= now;
            const pastRetention =
              record.content.retainUntil !== null && Date.parse(record.content.retainUntil) <= now;
            const replacements = records.filter(
              (candidate) => candidate.id !== record.id && candidate.status === "active",
            );
            return (
              <Card key={record.id}>
                <CardPanel className="min-w-0 space-y-3 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="min-w-0 break-words font-semibold">{record.content.title}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline">{record.content.kind}</Badge>
                      <Badge variant={record.status === "active" ? "success" : "outline"}>
                        {statusLabel(record)}
                      </Badge>
                      {stale ? <Badge variant="warning">Review due</Badge> : null}
                      {pastRetention ? (
                        <Badge variant="warning">Retention date passed</Badge>
                      ) : null}
                    </div>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{record.content.body}</p>
                  <dl className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                    <div>
                      <dt className="font-medium text-foreground">Provenance</dt>
                      <dd>
                        {record.content.provenance.kind === "user"
                          ? "User entry"
                          : "Explicit reference"}
                        {record.content.provenance.reference
                          ? `: ${record.content.provenance.reference}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-foreground">Revision</dt>
                      <dd>
                        Version {record.version}; created by {record.createdBy}
                      </dd>
                      <dd className="break-all font-mono text-xs">Record ID: {record.id}</dd>
                    </div>
                    {record.content.provenance.note ? (
                      <div className="sm:col-span-2">
                        <dt className="font-medium text-foreground">Provenance note</dt>
                        <dd className="whitespace-pre-wrap break-words">
                          {record.content.provenance.note}
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt className="font-medium text-foreground">Reviewed</dt>
                      <dd>
                        {record.content.reviewedAt
                          ? formatTime(record.content.reviewedAt)
                          : "Not recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-foreground">Review due</dt>
                      <dd>
                        {record.content.staleAt ? formatTime(record.content.staleAt) : "Not set"}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-foreground">Retain until</dt>
                      <dd>
                        {record.content.retainUntil
                          ? formatTime(record.content.retainUntil)
                          : "Not set"}
                      </dd>
                    </div>
                    {record.supersededById ? (
                      <div>
                        <dt className="font-medium text-foreground">Replaced by</dt>
                        <dd className="break-all font-mono">{record.supersededById}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <p className="text-sm text-muted-foreground">
                    Created {formatTime(record.createdAt)}; updated {formatTime(record.updatedAt)}.
                    Retention dates are labels only.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setHistoryOffset(0);
                        setHistoryRecordId(historyRecordId === record.id ? null : record.id);
                      }}
                    >
                      {historyRecordId === record.id ? "Hide history" : "View history"}
                    </Button>
                    {record.status === "active" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => beginCorrection(record)}
                        >
                          Correct
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => {
                            setSupersedeTargetId(record.id);
                            setArchiveTargetId(null);
                            setReplacementId("");
                          }}
                        >
                          Supersede
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => {
                            setArchiveTargetId(record.id);
                            setSupersedeTargetId(null);
                          }}
                        >
                          <ArchiveIcon /> Archive
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {archiveTargetId === record.id ? (
                    <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                      <p>Archive this record? Its revision history stays available.</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="destructive-outline"
                          disabled={disabled}
                          onClick={() => void archive(record)}
                        >
                          Confirm archive
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setArchiveTargetId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {supersedeTargetId === record.id ? (
                    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                      <label className="block space-y-1.5 font-medium">
                        <span>Active replacement in {scopeLabel}</span>
                        <select
                          className={SELECT_CLASS}
                          value={replacementId}
                          onChange={(event) => setReplacementId(event.currentTarget.value)}
                          disabled={disabled}
                        >
                          <option value="">Choose a replacement</option>
                          {replacements.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.content.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block space-y-1.5 font-medium">
                        <span>Or enter an active replacement record ID from another page</span>
                        <Input
                          aria-label="Replacement record ID"
                          value={replacementId}
                          onValueChange={setReplacementId}
                          disabled={disabled}
                        />
                      </label>
                      {replacements.length === 0 ? (
                        <p className="text-muted-foreground">
                          No active replacement appears on this page. Choose another page or enter
                          its record ID above.
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled || !replacementId}
                          onClick={() => void supersede(record)}
                        >
                          Confirm supersession
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSupersedeTargetId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {historyRecordId === record.id ? (
                    <div className="space-y-2 border-t border-border pt-3">
                      <h4 className="text-sm font-semibold">Revision history</h4>
                      {history.isPending && !history.data ? (
                        <p role="status" className="text-sm text-muted-foreground">
                          Loading revisions…
                        </p>
                      ) : null}
                      {history.error ? (
                        <p role="alert" className="text-sm text-destructive-foreground">
                          Could not load revisions: {history.error}
                        </p>
                      ) : null}
                      {(history.data?.revisions ?? []).map((revision) => (
                        <details
                          key={revision.mutationId}
                          className="rounded-lg border border-border p-3 text-sm"
                        >
                          <summary className="cursor-pointer font-medium">
                            Version {revision.version}: {revision.action},{" "}
                            {formatTime(revision.createdAt)}
                          </summary>
                          <p className="mt-2 text-muted-foreground">By {revision.actorSubject}</p>
                          <p className="mt-2 font-medium">{revision.snapshot.content.title}</p>
                          <p className="mt-1 text-muted-foreground">
                            {revision.snapshot.content.kind}; {revision.snapshot.status};
                            provenance: {revision.snapshot.content.provenance.kind}
                            {revision.snapshot.content.provenance.reference
                              ? ` (${revision.snapshot.content.provenance.reference})`
                              : ""}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words">
                            {revision.snapshot.content.body}
                          </p>
                        </details>
                      ))}
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={historyOffset === 0}
                          onClick={() => setHistoryOffset(Math.max(0, historyOffset - 100))}
                        >
                          Newer revisions
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {historyOffset + 1}–
                          {historyOffset + (history.data?.revisions.length ?? 0)}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={(history.data?.revisions.length ?? 0) < 100}
                          onClick={() => setHistoryOffset(historyOffset + 100)}
                        >
                          Older revisions
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </CardPanel>
              </Card>
            );
          })}
          {list.data ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={recordOffset === 0}
                onClick={() => {
                  setHistoryRecordId(null);
                  setRecordOffset(Math.max(0, recordOffset - 100));
                }}
              >
                Newer records
              </Button>
              <span className="text-xs text-muted-foreground">
                {recordOffset + 1}–{recordOffset + records.length}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={records.length < 100}
                onClick={() => {
                  setHistoryRecordId(null);
                  setRecordOffset(recordOffset + 100);
                }}
              >
                Older records
              </Button>
            </div>
          ) : null}
        </section>

        <aside className="min-w-0" aria-label="Memory editor">
          <Card>
            <CardPanel className="space-y-4 p-4 sm:p-5">
              <div>
                <h2 className="text-lg font-semibold">
                  {editing ? "Correct memory" : "Add memory"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {editing
                    ? `Correcting version ${editing.version} in ${scopeLabel}. This creates a new revision.`
                    : `Creating a record in ${scopeLabel}.`}
                </p>
              </div>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Kind</span>
                  <select
                    className={SELECT_CLASS}
                    value={kind}
                    onChange={(event) => {
                      const choice = MEMORY_KINDS.find(
                        (candidate) => candidate === event.currentTarget.value,
                      );
                      if (choice) setKind(choice);
                    }}
                    disabled={disabled}
                  >
                    {MEMORY_KINDS.map((value) => (
                      <option key={value} value={value}>
                        {value.replaceAll("-", " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Title</span>
                  <Input
                    value={title}
                    onValueChange={setTitle}
                    maxLength={160}
                    disabled={disabled}
                  />
                </label>
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Record</span>
                  <Textarea
                    value={body}
                    onChange={(event) => setBody(event.currentTarget.value)}
                    maxLength={8_000}
                    disabled={disabled}
                  />
                </label>
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Provenance</span>
                  <select
                    className={SELECT_CLASS}
                    value={provenanceKind}
                    onChange={(event) =>
                      setProvenanceKind(
                        event.currentTarget.value === "explicit-reference"
                          ? "explicit-reference"
                          : "user",
                      )
                    }
                    disabled={disabled}
                  >
                    <option value="user">User entry</option>
                    <option value="explicit-reference">Explicit reference</option>
                  </select>
                </label>
                {provenanceKind === "explicit-reference" ? (
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Reference</span>
                    <Input
                      value={reference}
                      onValueChange={setReference}
                      maxLength={512}
                      placeholder="Source, document, or URL"
                      disabled={disabled}
                    />
                  </label>
                ) : null}
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>Provenance note (optional)</span>
                  <Textarea
                    value={provenanceNote}
                    onChange={(event) => setProvenanceNote(event.currentTarget.value)}
                    maxLength={1_000}
                    disabled={disabled}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Reviewed at (optional)</span>
                    <Input
                      type="datetime-local"
                      value={reviewedAt}
                      onValueChange={setReviewedAt}
                      disabled={disabled}
                    />
                  </label>
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Review due (optional)</span>
                    <Input
                      type="datetime-local"
                      value={staleAt}
                      onValueChange={setStaleAt}
                      disabled={disabled}
                    />
                  </label>
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Retain until (optional)</span>
                    <Input
                      type="datetime-local"
                      value={retainUntil}
                      onValueChange={setRetainUntil}
                      disabled={disabled}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={disabled || !valid}>
                    {busy ? "Saving…" : editing ? "Save correction" : "Add record"}
                  </Button>
                  {editing ? (
                    <Button type="button" variant="ghost" disabled={busy} onClick={resetEditor}>
                      Cancel correction
                    </Button>
                  ) : null}
                </div>
              </form>
            </CardPanel>
          </Card>
        </aside>
      </div>
    </div>
  );
}

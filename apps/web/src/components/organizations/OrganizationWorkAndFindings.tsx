import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  Organization,
  OrganizationObservation,
  OrganizationTentativeFinding,
  OrganizationWorkAttempt,
  OrganizationWorkDetail,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
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
import { OrganizationProposalList } from "./OrganizationProposalControls";

function RecordedTime({ value }: { readonly value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

function RecordField({
  label,
  value,
  reference = false,
}: {
  readonly label: string;
  readonly value: string | number | null;
  readonly reference?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium">
        {value === null ? (
          "None recorded"
        ) : reference ? (
          <code className="break-all font-mono font-normal">{value}</code>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function QueryMessage({
  pending,
  error,
  empty,
  loaded,
  offline,
}: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly empty: string;
  readonly loaded: boolean;
  readonly offline: boolean;
}) {
  if (error)
    return (
      <p
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        Could not load records: {error}
      </p>
    );
  if (pending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading records…
      </p>
    );
  if (!loaded)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {offline
          ? "No cached records are available while offline."
          : "Records are not available yet."}
      </p>
    );
  return <p className="text-sm text-muted-foreground">{empty}</p>;
}

function ObservationCard({
  observation,
  projectName,
}: {
  readonly observation: OrganizationObservation;
  readonly projectName: (id: string) => string;
}) {
  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold">{observation.title}</h3>
        <Badge variant="outline">Observed</Badge>
      </div>
      {observation.body ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {observation.body}
        </p>
      ) : null}
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <RecordField label="Observation ID" value={observation.id} reference />
        <RecordField label="Source ID" value={observation.sourceId} reference />
        <RecordField
          label="Project"
          value={observation.projectId ? projectName(observation.projectId) : "Organization scope"}
        />
        <RecordField label="External event ID" value={observation.externalEventId} reference />
      </dl>
      <p className="mt-3 text-sm text-muted-foreground">
        Occurred <RecordedTime value={observation.occurredAt} />; received{" "}
        <RecordedTime value={observation.receivedAt} />.
      </p>
    </li>
  );
}

function FindingCard({
  finding,
  observations,
}: {
  readonly finding: OrganizationTentativeFinding;
  readonly observations: ReadonlyArray<OrganizationObservation>;
}) {
  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold">{finding.title}</h3>
        <Badge variant="outline">Tentative</Badge>
      </div>
      {finding.summary ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {finding.summary}
        </p>
      ) : null}
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <RecordField label="Finding ID" value={finding.id} reference />
        <RecordField label="Anchor source ID" value={finding.sourceId} reference />
        <RecordField
          label="Project"
          value={finding.projectId ?? "Multiple or legacy scope"}
          reference
        />
      </dl>
      <div className="mt-3 space-y-1 text-sm">
        <p className="font-medium">Observation evidence</p>
        {finding.observationIds.length === 0 ? (
          <p className="text-muted-foreground">No observation references recorded.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {finding.evidence.map((ref) => {
              const observation = observations.find((record) => record.id === ref.observationId);
              return (
                <li key={ref.observationId} className="break-words">
                  {observation?.title ? `${observation.title} · ` : ""}
                  <code className="break-all font-mono">{ref.observationId}</code>
                  <span className="text-muted-foreground"> · Source {ref.sourceId}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Recorded <RecordedTime value={finding.createdAt} />.
      </p>
    </li>
  );
}

export function ReviewEvidence({
  work,
  attempt,
  offline,
  onDecision,
}: {
  readonly work: OrganizationWorkDetail["work"];
  readonly attempt: OrganizationWorkAttempt;
  readonly offline: boolean;
  readonly onDecision: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const decide = useAtomCommand(organizationEnvironment.decideWorkApproval, {
    reportFailure: false,
  });
  const [reason, setReason] = useState("");
  const [decisionPending, setDecisionPending] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);
  const request = useRef<{ readonly key: string; readonly id: string } | null>(null);
  const review = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.reviewWork({
          environmentId,
          input: { organizationId: work.organizationId, workId: work.id, attemptId: attempt.id },
        }),
  );
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) review.refresh();
    wasOffline.current = offline;
  }, [offline, review]);

  async function decideApproval(approved: boolean) {
    const evidence = review.data;
    const qa = evidence?.qa;
    const normalizedReason = reason.trim();
    if (
      decisionPending ||
      offline ||
      environmentId === null ||
      !evidence ||
      !qa?.accepted ||
      evidence.approval ||
      work.status !== "waiting-approval" ||
      attempt.status !== "qa-accepted" ||
      !normalizedReason ||
      (approved && !evidence.artifact.reviewComplete)
    )
      return;
    const key = [
      approved,
      normalizedReason,
      evidence.artifact.digest,
      qa.receiptDigest,
      evidence.projectRootDigest,
      work.codeRevision,
      work.bindingVersion,
    ].join(":");
    if (request.current?.key !== key) request.current = { key, id: randomUUID() };
    setDecisionPending(true);
    setDecisionError(null);
    setDecisionNotice(null);
    try {
      const result = await decide({
        environmentId,
        input: {
          organizationId: work.organizationId,
          workId: work.id,
          attemptId: attempt.id,
          requestId: request.current.id,
          approved,
          reason: normalizedReason,
          artifactDigest: evidence.artifact.digest,
          qaReceiptDigest: qa.receiptDigest,
          projectRootDigest: evidence.projectRootDigest,
          baseCodeRevision: work.codeRevision,
          bindingVersion: work.bindingVersion,
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setDecisionError(cause instanceof Error ? cause.message : String(cause));
      } else {
        setDecisionNotice(approved ? "Approval recorded." : "Rejection recorded.");
        onDecision();
        review.refresh();
      }
    } finally {
      setDecisionPending(false);
    }
  }

  const canDecide =
    work.status === "waiting-approval" &&
    attempt.status === "qa-accepted" &&
    review.data?.qa?.accepted === true &&
    review.data.approval === null;

  return (
    <div className="min-w-0 space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-sm font-semibold">Saved review evidence</h5>
        <Button
          variant="ghost"
          size="sm"
          disabled={offline || environmentId === null}
          onClick={review.refresh}
        >
          <RefreshCwIcon /> Refresh evidence
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Previews are capped and known credential patterns are redacted. Review the exact digest and
        current Project revision before any approval; this view cannot approve or integrate work.
      </p>
      {offline ? (
        <p role="status" className="text-xs text-muted-foreground">
          Offline. Cached evidence may be stale.
        </p>
      ) : null}
      {review.error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load review evidence: {review.error}
        </p>
      ) : null}
      {review.isPending && !review.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading review evidence…
        </p>
      ) : null}
      {review.data ? (
        <div className="min-w-0 space-y-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <RecordField
              label="Project target identity"
              value={review.data.projectRootDigest}
              reference
            />
            <RecordField
              label="Reviewed artifact digest"
              value={review.data.artifact.digest}
              reference
            />
            <RecordField
              label="Base code revision"
              value={review.data.artifact.baseCodeRevision}
              reference
            />
            <RecordField label="Source path" value={review.data.artifact.relativePath} reference />
            <RecordField label="Replacement bytes" value={review.data.artifact.replacementBytes} />
            <RecordField label="Scoped syntax exit" value={review.data.artifact.outcome.exitCode} />
          </dl>
          <p className="text-xs text-muted-foreground">
            The artifact receipt verifies captured bytes; the independent QA receipt below records
            the review decision.
          </p>
          <div className="min-w-0">
            <p className="text-sm font-medium">Artifact preview</p>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-background p-3 text-xs">
              {review.data.artifact.replacementPreview ?? "Preview unavailable for this artifact."}
            </pre>
            {review.data.artifact.previewTruncated ? (
              <p className="mt-1 text-xs text-muted-foreground">Preview truncated.</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              {review.data.artifact.reviewComplete
                ? "The complete replacement is visible above without redaction."
                : "This preview is incomplete or redacted. Approval requires a complete artifact review."}
            </p>
          </div>
          {review.data.qa ? (
            <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">Independent QA</p>
                <Badge variant="outline">{review.data.qa.accepted ? "Accepted" : "Rejected"}</Badge>
              </div>
              <dl className="grid gap-3 sm:grid-cols-2">
                <RecordField label="Reviewer" value={review.data.qa.reviewerSubject} reference />
                <RecordField
                  label="QA receipt digest"
                  value={review.data.qa.receiptDigest}
                  reference
                />
                <RecordField label="QA evidence bytes" value={review.data.qa.evidenceBytes} />
              </dl>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/30 p-3 text-xs">
                {review.data.qa.evidencePreview ?? "Preview unavailable for this receipt."}
              </pre>
              {review.data.qa.previewTruncated ? (
                <p className="text-xs text-muted-foreground">QA preview truncated.</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No QA receipt recorded for this attempt.
            </p>
          )}
          {review.data.approval ? (
            <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">Human decision</p>
                <Badge variant="outline">
                  {review.data.approval.approved ? "Approved" : "Rejected"}
                </Badge>
              </div>
              <dl className="grid gap-3 sm:grid-cols-2">
                <RecordField
                  label="Approver"
                  value={review.data.approval.approvalSubject}
                  reference
                />
                <RecordField
                  label="Approval receipt digest"
                  value={review.data.approval.receiptDigest}
                  reference
                />
                <RecordField
                  label="Approval evidence bytes"
                  value={review.data.approval.evidenceBytes}
                />
              </dl>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/30 p-3 text-xs">
                {review.data.approval.evidencePreview ?? "Preview unavailable for this receipt."}
              </pre>
              {review.data.approval.previewTruncated ? (
                <p className="text-xs text-muted-foreground">Decision preview truncated.</p>
              ) : null}
            </div>
          ) : null}
          {canDecide ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm font-medium">Human approval decision</p>
              <p className="text-xs text-muted-foreground">
                Your decision is pinned to the artifact and QA digests shown above. The server
                checks the current Project revision and binding again before recording it.
              </p>
              <label className="block space-y-1 text-sm">
                <span>Decision reason (do not include credentials)</span>
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={2_000}
                  disabled={decisionPending || offline}
                />
              </label>
              {decisionError ? (
                <p role="alert" className="text-sm text-destructive">
                  {decisionError}
                </p>
              ) : null}
              {decisionNotice ? (
                <p role="status" className="text-sm">
                  {decisionNotice}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={
                    decisionPending ||
                    offline ||
                    !reason.trim() ||
                    !review.data.artifact.reviewComplete
                  }
                  onClick={() => void decideApproval(true)}
                >
                  Approve exact artifact
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={decisionPending || offline || !reason.trim()}
                  onClick={() => void decideApproval(false)}
                >
                  Reject artifact
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AttemptCard({
  attempt,
  work,
  offline,
  onDecision,
}: {
  readonly attempt: OrganizationWorkAttempt;
  readonly work: OrganizationWorkDetail["work"];
  readonly offline: boolean;
  readonly onDecision: () => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const hasReviewableEvidence =
    attempt.artifactDigest !== null &&
    attempt.artifactRef !== null &&
    (attempt.status === "submitted" ||
      attempt.status === "qa-accepted" ||
      attempt.status === "qa-rejected");
  return (
    <li className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Attempt {attempt.number}</h4>
        <Badge variant="outline">{attempt.status}</Badge>
      </div>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <RecordField label="Attempt ID" value={attempt.id} reference />
        <RecordField label="Worker subject" value={attempt.workerSubject} reference />
        <RecordField label="Artifact reference" value={attempt.artifactRef} reference />
        <RecordField label="Artifact digest" value={attempt.artifactDigest} reference />
        <RecordField label="QA subject" value={attempt.qaSubject} reference />
        <RecordField label="QA evidence reference" value={attempt.qaEvidenceRef} reference />
        <RecordField label="Recorded lease end" value={attempt.leaseUntil} />
      </dl>
      <p className="mt-3 text-sm text-muted-foreground">
        Started <RecordedTime value={attempt.startedAt} />; last updated{" "}
        <RecordedTime value={attempt.updatedAt} />.
      </p>
      {hasReviewableEvidence ? (
        <Button
          className="mt-3"
          variant="outline"
          size="sm"
          disabled={offline && !showEvidence}
          aria-expanded={showEvidence}
          onClick={() => setShowEvidence((value) => !value)}
        >
          {showEvidence ? "Hide saved evidence" : "Inspect saved evidence"}
        </Button>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Review evidence becomes available after an artifact is submitted.
        </p>
      )}
      {hasReviewableEvidence && showEvidence ? (
        <div className="mt-3">
          <ReviewEvidence work={work} attempt={attempt} offline={offline} onDecision={onDecision} />
        </div>
      ) : null}
    </li>
  );
}

function WorkCard({
  detail,
  finding,
  projectName,
  offline,
  onDecision,
}: {
  readonly detail: OrganizationWorkDetail;
  readonly finding: OrganizationTentativeFinding | undefined;
  readonly projectName: (id: string) => string;
  readonly offline: boolean;
  readonly onDecision: () => void;
}) {
  const { work, attempts } = detail;
  return (
    <li>
      <Card>
        <CardPanel className="space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="break-words font-semibold">{finding?.title ?? "Work record"}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Saved status, last updated <RecordedTime value={work.updatedAt} />.
              </p>
            </div>
            <Badge variant="outline">{work.status}</Badge>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <RecordField label="Work ID" value={work.id} reference />
            <RecordField label="Finding ID" value={work.findingId} reference />
            <RecordField label="Project" value={projectName(work.projectId)} />
            <RecordField label="Workflow ID" value={work.workflowId} reference />
            <RecordField label="Workflow version" value={work.workflowVersion} />
            <RecordField label="Published revision" value={work.publishedRevision} />
            <RecordField label="Base code revision" value={work.codeRevision} reference />
            <RecordField label="Result code revision" value={work.resultCodeRevision} reference />
            <RecordField
              label="Attempt count / limit"
              value={`${work.attemptCount} / ${work.attemptLimit}`}
            />
            <RecordField label="Scope" value={work.scope} reference />
            <RecordField label="Binding ID" value={work.bindingId} reference />
            <RecordField label="Binding version" value={work.bindingVersion} />
            <RecordField label="Creator subject" value={work.creatorSubject} reference />
            <RecordField label="Approval subject" value={work.approvalSubject} reference />
            <RecordField
              label="Approval evidence reference"
              value={work.approvalEvidenceRef}
              reference
            />
            <RecordField label="Integration subject" value={work.integrationSubject} reference />
            <RecordField
              label="Integration receipt reference"
              value={work.integrationReceiptRef}
              reference
            />
          </dl>
          <div className="space-y-3 border-t border-border pt-4">
            <h4 className="font-semibold">Recorded attempts ({attempts.length})</h4>
            {attempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No attempts recorded for this work item.
              </p>
            ) : (
              <ol className="space-y-3">
                {attempts.map((attempt) => (
                  <AttemptCard
                    key={attempt.id}
                    attempt={attempt}
                    work={work}
                    offline={offline}
                    onDecision={onDecision}
                  />
                ))}
              </ol>
            )}
          </div>
        </CardPanel>
      </Card>
    </li>
  );
}

export function OrganizationWorkAndFindings({
  organization,
  offline,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectName = (id: string) => projects.find((project) => project.id === id)?.title ?? id;
  const input = { organizationId: organization.id };
  const observations = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listObservations({ environmentId, input }),
  );
  const findings = useEnvironmentQuery(
    environmentId === null ? null : organizationEnvironment.listFindings({ environmentId, input }),
  );
  const work = useEnvironmentQuery(
    environmentId === null ? null : organizationEnvironment.listWork({ environmentId, input }),
  );
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) {
      observations.refresh();
      findings.refresh();
      work.refresh();
    }
    wasOffline.current = offline;
  }, [offline, observations.refresh, findings.refresh, work.refresh]);

  function refresh() {
    observations.refresh();
    findings.refresh();
    work.refresh();
  }

  const observationItems = observations.data?.observations ?? [];
  const findingItems = findings.data?.findings ?? [];
  const workItems = work.data?.items ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold">Work and findings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Recorded observations, tentative findings, proposals, and persisted work states.
            Proposal decisions are saved here; this page does not start work or show a live
            operation stream.
          </p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={offline || environmentId === null}>
          <RefreshCwIcon /> Refresh records
        </Button>
      </div>
      {offline ? (
        <p role="status" className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          Offline. Shown records may be out of date. They will refresh when the connection returns.
        </p>
      ) : null}
      {environmentId === null ? (
        <p role="status" className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          Connect an environment to load these records.
        </p>
      ) : null}

      <OrganizationProposalList organization={organization} offline={offline} />

      <section aria-labelledby="work-records-heading" className="space-y-3">
        <div>
          <h2 id="work-records-heading" className="text-lg font-semibold">
            Saved work records
          </h2>
          <p className="text-sm text-muted-foreground">
            Statuses and attempts reflect stored records at their last update time.
          </p>
        </div>
        {workItems.length === 0 ? (
          <QueryMessage
            pending={work.isPending}
            error={work.error}
            loaded={work.data !== null}
            offline={offline}
            empty={
              offline
                ? "No work records in the last saved response."
                : "No work records have been persisted for this Organization. Work cannot be started from this page."
            }
          />
        ) : (
          <>
            {work.error ? (
              <QueryMessage pending={false} error={work.error} loaded offline={offline} empty="" />
            ) : null}
            <ul className="space-y-3">
              {workItems.map((detail) => (
                <WorkCard
                  key={detail.work.id}
                  detail={detail}
                  finding={findingItems.find((finding) => finding.id === detail.work.findingId)}
                  projectName={projectName}
                  offline={offline}
                  onDecision={work.refresh}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <section aria-labelledby="findings-heading" className="min-w-0 space-y-3">
          <div>
            <h2 id="findings-heading" className="text-lg font-semibold">
              Tentative findings
            </h2>
            <p className="text-sm text-muted-foreground">
              Findings summarize observations and remain tentative until separately reviewed.
            </p>
          </div>
          <Card>
            <CardPanel className="p-5">
              {findingItems.length === 0 ? (
                <QueryMessage
                  pending={findings.isPending}
                  error={findings.error}
                  loaded={findings.data !== null}
                  offline={offline}
                  empty={
                    offline
                      ? "No findings in the last saved response."
                      : "No tentative findings recorded."
                  }
                />
              ) : (
                <>
                  {findings.error ? (
                    <QueryMessage
                      pending={false}
                      error={findings.error}
                      loaded
                      offline={offline}
                      empty=""
                    />
                  ) : null}
                  <ul className="space-y-3">
                    {findingItems.map((finding) => (
                      <FindingCard
                        key={finding.id}
                        finding={finding}
                        observations={observationItems}
                      />
                    ))}
                  </ul>
                </>
              )}
            </CardPanel>
          </Card>
        </section>
        <section aria-labelledby="observations-heading" className="min-w-0 space-y-3">
          <div>
            <h2 id="observations-heading" className="text-lg font-semibold">
              Observations
            </h2>
            <p className="text-sm text-muted-foreground">
              Source reports are evidence, not authorization to perform work.
            </p>
          </div>
          <Card>
            <CardPanel className="p-5">
              {observationItems.length === 0 ? (
                <QueryMessage
                  pending={observations.isPending}
                  error={observations.error}
                  loaded={observations.data !== null}
                  offline={offline}
                  empty={
                    offline
                      ? "No observations in the last saved response."
                      : "No observations recorded."
                  }
                />
              ) : (
                <>
                  {observations.error ? (
                    <QueryMessage
                      pending={false}
                      error={observations.error}
                      loaded
                      offline={offline}
                      empty=""
                    />
                  ) : null}
                  <ul className="space-y-3">
                    {observationItems.map((observation) => (
                      <ObservationCard
                        key={observation.id}
                        observation={observation}
                        projectName={projectName}
                      />
                    ))}
                  </ul>
                </>
              )}
            </CardPanel>
          </Card>
        </section>
      </div>
    </div>
  );
}

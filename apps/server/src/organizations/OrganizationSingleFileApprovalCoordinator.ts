// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off - Approval evidence is exact versioned JSON; canonical root validation uses Node path semantics.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import { redactKnownCredentials } from "./CredentialRedaction.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import { OrganizationWorkApprovalReceiptStore } from "./OrganizationWorkApprovalReceiptStore.ts";
import { OrganizationWorkArtifactStore } from "./OrganizationWorkArtifactStore.ts";
import { OrganizationWorkQAReceiptStore } from "./OrganizationWorkQAReceiptStore.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";
import { OrganizationSingleFileApprovalRevisionGuard } from "./OrganizationSingleFileApprovalRevision.ts";

export class OrganizationSingleFileApprovalCoordinatorError extends Schema.TaggedError<OrganizationSingleFileApprovalCoordinatorError>()(
  "OrganizationSingleFileApprovalCoordinatorError",
  {
    code: Schema.Literals(["invalid", "forbidden", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationSingleFileApprovalCoordinatorError["code"], message: string) =>
  new OrganizationSingleFileApprovalCoordinatorError({ code, message });
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export interface OrganizationSingleFileApprovalRequest {
  readonly workId: OrganizationWorkId;
  readonly attemptId: OrganizationWorkAttemptId;
  readonly requestId: string;
  readonly reason: string;
  /** Resolved Project root pinned by a server-owned transport preflight. */
  readonly canonicalProjectRoot?: string;
}
export interface OrganizationSingleFileApprovalPolicyTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly baseCodeRevision: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly artifactDigest: string;
  readonly artifactRef: string;
  readonly qaReceiptDigest: string;
  readonly workerSubject: string;
  readonly qaSubject: string;
}
export interface OrganizationSingleFileApprovalPolicyDecision {
  readonly approvalSubject: string;
  readonly approved: boolean;
}
/** Implementations must authenticate an interactive human independently of request JSON. */
export class OrganizationSingleFileApprovalPolicy extends Context.Service<
  OrganizationSingleFileApprovalPolicy,
  {
    readonly decide: (
      target: OrganizationSingleFileApprovalPolicyTarget,
      request: Readonly<Pick<OrganizationSingleFileApprovalRequest, "requestId" | "reason">>,
    ) => Effect.Effect<
      OrganizationSingleFileApprovalPolicyDecision,
      OrganizationSingleFileApprovalCoordinatorError
    >;
  }
>()(
  "t3/organizations/OrganizationSingleFileApprovalCoordinator/OrganizationSingleFileApprovalPolicy",
) {}
export const OrganizationSingleFileApprovalPolicyDisabled = Layer.succeed(
  OrganizationSingleFileApprovalPolicy,
  { decide: () => Effect.fail(failure("forbidden", "Interactive human approval is disabled.")) },
);

const safeReason = (value: string): string => redactKnownCredentials(value.trim());

/** Disconnected: no UI, transport, runtime or live human-capture authority is mounted. */
export const runOrganizationSingleFileApproval = (input: OrganizationSingleFileApprovalRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workStore = yield* OrganizationWorkStore;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const qaReceipts = yield* OrganizationWorkQAReceiptStore;
    const approvals = yield* OrganizationWorkApprovalReceiptStore;
    const policy = yield* OrganizationSingleFileApprovalPolicy;
    const revisionGuard = yield* OrganizationSingleFileApprovalRevisionGuard;
    if (
      typeof input.requestId !== "string" ||
      !ID.test(input.requestId) ||
      typeof input.reason !== "string" ||
      Buffer.byteLength(input.reason, "utf8") > 2_000 ||
      input.reason.includes("\0")
    )
      return yield* failure("invalid", "Approval request or reason is invalid or oversized.");
    if (
      input.canonicalProjectRoot !== undefined &&
      (typeof input.canonicalProjectRoot !== "string" ||
        !NodePath.isAbsolute(input.canonicalProjectRoot) ||
        input.canonicalProjectRoot.includes("\0"))
    )
      return yield* failure("invalid", "Pinned Project root is invalid.");
    const rawReason = input.reason.trim();
    const reason = safeReason(input.reason);
    if (reason !== rawReason)
      return yield* failure("invalid", "Remove credential-like text from the approval reason.");
    if (!reason || Buffer.byteLength(reason, "utf8") > 2_000)
      return yield* failure("invalid", "Approval reason must be nonempty and bounded.");
    const detail = yield* workStore.getWork(input.workId);
    const work = detail.work;
    const attempt = detail.attempts.at(-1);
    if (
      !attempt ||
      attempt.id !== input.attemptId ||
      attempt.workId !== work.id ||
      attempt.status !== "qa-accepted" ||
      !attempt.artifactDigest ||
      !attempt.artifactRef ||
      !attempt.qaSubject ||
      !attempt.qaEvidenceRef
    )
      return yield* failure("conflict", "Approval requires the latest QA-accepted attempt.");
    const pending = work.status === "waiting-approval";
    const recorded = work.status === "blocked" || work.status === "canceled";
    if (!pending && !recorded)
      return yield* failure("conflict", "Approval requires a QA-accepted or recorded attempt.");
    if (work.scope !== null)
      return yield* failure(
        "forbidden",
        "Scoped Project paths are not yet reviewable for approval.",
      );
    const requireCurrentBinding = Effect.gen(function* () {
      const current = (yield* sql<{
        lifecycle: string;
        access: string;
        detached_at: string | null;
        updated_at: string;
        capabilities_json: string;
        scope: string | null;
      }>`SELECT o.lifecycle, b.access, b.detached_at, b.updated_at,
        b.capabilities_json, b.scope FROM organizations o
        JOIN organization_project_bindings b
          ON b.organization_id = o.organization_id AND b.binding_id = ${work.bindingId}
        JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
        WHERE o.organization_id = ${work.organizationId} AND b.project_id = ${work.projectId}`)[0];
      let capabilities: unknown;
      try {
        capabilities = current && JSON.parse(current.capabilities_json);
      } catch {
        /* Malformed authority fails closed. */
      }
      if (
        !current ||
        current.lifecycle !== "active" ||
        current.access !== "write" ||
        current.detached_at !== null ||
        current.updated_at !== work.bindingVersion ||
        current.scope !== work.scope ||
        !Array.isArray(capabilities) ||
        !["read-files", "write-files", "run-tests"].every((capability) =>
          capabilities.includes(capability),
        )
      )
        return yield* failure("forbidden", "Current Project approval binding is unavailable.");
    });
    yield* requireCurrentBinding;
    yield* revisionGuard.verifyCurrent({
      projectId: work.projectId,
      baseCommit: work.codeRevision,
    });
    const artifact = yield* artifacts.get(attempt.id);
    if (
      !artifact ||
      artifact.workId !== work.id ||
      artifact.projectId !== work.projectId ||
      artifact.baseCodeRevision !== work.codeRevision ||
      artifact.artifactDigest !== attempt.artifactDigest ||
      artifact.artifactRef !== attempt.artifactRef
    )
      return yield* failure("conflict", "Saved artifact does not match QA-accepted work.");
    yield* artifacts.verifySubmitted(artifact);
    let canonicalArtifact;
    try {
      canonicalArtifact = decodeOrganizationSingleFileArtifact(artifact.patchBytes);
    } catch {
      return yield* failure("invalid", "Approval artifact is not canonical single-file evidence.");
    }
    if (
      canonicalArtifact.baseCommit !== work.codeRevision ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/.test(canonicalArtifact.relativePath)
    )
      return yield* failure(
        "conflict",
        "Approval artifact path or base commit is outside this single-file scope.",
      );
    const qa = yield* qaReceipts.get(attempt.id);
    if (
      !qa ||
      !qa.accepted ||
      qa.workId !== work.id ||
      qa.projectId !== work.projectId ||
      qa.artifactDigest !== artifact.artifactDigest ||
      qa.artifactRef !== artifact.artifactRef ||
      qa.workerSubject !== attempt.workerSubject ||
      qa.reviewerSubject !== attempt.qaSubject ||
      qa.evidenceRef !== attempt.qaEvidenceRef
    )
      return yield* failure("conflict", "Accepted QA receipt does not match saved work.");
    yield* qaReceipts.verifyEvaluation(qa);
    const target: OrganizationSingleFileApprovalPolicyTarget = {
      organizationId: work.organizationId,
      projectId: work.projectId,
      bindingId: work.bindingId,
      bindingVersion: work.bindingVersion,
      baseCodeRevision: work.codeRevision,
      workId: work.id,
      attemptId: attempt.id,
      artifactDigest: artifact.artifactDigest,
      artifactRef: artifact.artifactRef,
      qaReceiptDigest: qa.receiptDigest,
      workerSubject: attempt.workerSubject,
      qaSubject: attempt.qaSubject,
    };
    const decision = yield* policy.decide(target, { requestId: input.requestId, reason });
    if (!decision || typeof decision !== "object")
      return yield* failure("forbidden", "Interactive approval decision is unavailable.");
    // Snapshot policy output before the next Effect yield; getter-backed or shared
    // decisions cannot change identity or verdict after the independence check.
    const approvalSubject = decision.approvalSubject;
    const approved = decision.approved;
    if (
      typeof approvalSubject !== "string" ||
      !ID.test(approvalSubject) ||
      typeof approved !== "boolean" ||
      approvalSubject === attempt.workerSubject ||
      approvalSubject === attempt.qaSubject
    )
      return yield* failure("forbidden", "Approval needs an independent authenticated human.");
    if (approved) {
      const replacement = canonicalArtifact.replacementBytes;
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(replacement),
        catch: () => failure("conflict", "Reviewed artifact text is invalid."),
      });
      if (replacement.byteLength > 4_096 || redactKnownCredentials(text) !== text)
        return yield* failure("conflict", "The complete unredacted artifact is not reviewable.");
    }
    const evidenceBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        requestId: input.requestId,
        reason,
        workId: work.id,
        attemptId: attempt.id,
        projectId: work.projectId,
        baseCodeRevision: work.codeRevision,
        ...(input.canonicalProjectRoot === undefined
          ? {}
          : { canonicalProjectRoot: input.canonicalProjectRoot }),
        artifactDigest: artifact.artifactDigest,
        artifactRef: artifact.artifactRef,
        qaReceiptDigest: qa.receiptDigest,
        workerSubject: attempt.workerSubject,
        qaSubject: attempt.qaSubject,
        approvalSubject,
        approved,
      }),
      "utf8",
    );
    const evidenceRef = `approval-${sha256(evidenceBytes)}`;
    const saved = yield* approvals.get(attempt.id);
    if (
      saved &&
      (saved.evidenceRef !== evidenceRef ||
        !Buffer.from(saved.evidenceBytes).equals(evidenceBytes) ||
        saved.approved !== approved ||
        saved.approvalSubject !== approvalSubject)
    )
      return yield* failure("conflict", "Saved approval receipt belongs to another decision.");
    if (
      recorded &&
      (!saved ||
        work.approvalSubject !== approvalSubject ||
        work.approvalEvidenceRef !== evidenceRef ||
        work.status !== (approved ? "blocked" : "canceled"))
    )
      return yield* failure("conflict", "Recorded approval transition differs from this request.");
    yield* requireCurrentBinding;
    yield* revisionGuard.verifyCurrent({
      projectId: work.projectId,
      baseCommit: work.codeRevision,
    });
    if (saved) yield* approvals.verifyApproval(saved);
    if (!saved)
      yield* approvals.capture({
        workId: work.id,
        attemptId: attempt.id,
        projectId: work.projectId,
        baseCodeRevision: work.codeRevision,
        artifactDigest: artifact.artifactDigest,
        artifactRef: artifact.artifactRef,
        workerSubject: attempt.workerSubject,
        qaSubject: attempt.qaSubject,
        approvalSubject,
        approved,
        evidenceRef,
        evidenceBytes,
      });
    return yield* workStore.recordApproval(
      {
        workId: work.id,
        attemptId: attempt.id,
        transitionId: `approval-${attempt.id}`,
        artifactDigest: artifact.artifactDigest,
        approved,
        evidenceRef,
      },
      { subject: approvalSubject },
    );
  });

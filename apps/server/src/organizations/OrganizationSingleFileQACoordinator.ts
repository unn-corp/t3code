// @effect-diagnostics preferSchemaOverJson:off - Persisted capability and evaluator evidence JSON have existing wire formats.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import { OrganizationWorkArtifactStore } from "./OrganizationWorkArtifactStore.ts";
import { OrganizationWorkQAReceiptStore } from "./OrganizationWorkQAReceiptStore.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";
import {
  type OrganizationSingleFileQAEvaluation,
  type OrganizationSingleFileQAEvaluationInput,
  type OrganizationSingleFileQAPlan,
} from "./OrganizationSingleFileQAEvaluator.ts";

export class OrganizationSingleFileQACoordinatorError extends Schema.TaggedError<OrganizationSingleFileQACoordinatorError>()(
  "OrganizationSingleFileQACoordinatorError",
  {
    code: Schema.Literals(["forbidden", "conflict", "invalid", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationSingleFileQACoordinatorError["code"], message: string) =>
  new OrganizationSingleFileQACoordinatorError({ code, message });
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export interface OrganizationSingleFileQAPolicyTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly artifactDigest: string;
  readonly artifactRef: string;
  readonly workerSubject: string;
}
export interface OrganizationSingleFileQAPolicyDecision {
  readonly plan: OrganizationSingleFileQAPlan;
  readonly reviewerSubject: string;
}
/** Only a trusted server policy can select the oracle and independent reviewer. */
export class OrganizationSingleFileQAPolicy extends Context.Service<
  OrganizationSingleFileQAPolicy,
  {
    readonly select: (
      target: OrganizationSingleFileQAPolicyTarget,
    ) => Effect.Effect<
      OrganizationSingleFileQAPolicyDecision,
      OrganizationSingleFileQACoordinatorError
    >;
  }
>()("t3/organizations/OrganizationSingleFileQACoordinator/OrganizationSingleFileQAPolicy") {}
export const OrganizationSingleFileQAPolicyDisabled = Layer.succeed(
  OrganizationSingleFileQAPolicy,
  {
    select: () => Effect.fail(failure("forbidden", "Independent QA policy is disabled.")),
  },
);

/** The coordinator cannot launch a QA scope without a reviewed host. */
export class OrganizationSingleFileQAHost extends Context.Service<
  OrganizationSingleFileQAHost,
  {
    readonly evaluate: (
      attemptId: string,
      input: OrganizationSingleFileQAEvaluationInput,
    ) => Promise<OrganizationSingleFileQAEvaluation>;
  }
>()("t3/organizations/OrganizationSingleFileQACoordinator/OrganizationSingleFileQAHost") {}
export const OrganizationSingleFileQAHostDisabled = Layer.succeed(OrganizationSingleFileQAHost, {
  evaluate: () => Promise.reject(failure("unavailable", "Scoped QA host is disabled.")),
});

export interface OrganizationSingleFileQARunInput {
  readonly workId: OrganizationWorkId;
  readonly attemptId: OrganizationWorkAttemptId;
}

export const runOrganizationSingleFileQA = (input: OrganizationSingleFileQARunInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workStore = yield* OrganizationWorkStore;
    const artifacts = yield* OrganizationWorkArtifactStore;
    const qa = yield* OrganizationWorkQAReceiptStore;
    const policy = yield* OrganizationSingleFileQAPolicy;
    const host = yield* OrganizationSingleFileQAHost;
    const detail = yield* workStore.getWork(input.workId);
    const work = detail.work;
    const attempt = detail.attempts.at(-1);
    if (
      !attempt ||
      attempt.id !== input.attemptId ||
      attempt.workId !== input.workId ||
      work.status !== "blocked" ||
      attempt.status !== "submitted" ||
      !attempt.artifactDigest ||
      !attempt.artifactRef
    )
      return yield* failure("conflict", "QA requires the latest submitted attempt.");
    const requireCurrentBinding = Effect.gen(function* () {
      const current = (yield* sql<{
        lifecycle: string;
        access: string;
        detached_at: string | null;
        updated_at: string;
        capabilities_json: string;
        scope: string | null;
        project_id: string;
      }>`SELECT o.lifecycle, b.access, b.detached_at, b.updated_at,
      b.capabilities_json, b.scope, b.project_id
      FROM organizations o JOIN organization_project_bindings b
        ON b.organization_id = o.organization_id AND b.binding_id = ${work.bindingId}
      JOIN projection_projects p ON p.project_id = b.project_id AND p.deleted_at IS NULL
      WHERE o.organization_id = ${work.organizationId} AND b.project_id = ${work.projectId}`)[0];
      let capabilities: unknown;
      try {
        capabilities = current && JSON.parse(current.capabilities_json);
      } catch {
        /* Invalid authority fails closed. */
      }
      if (
        !current ||
        current.lifecycle !== "active" ||
        current.access !== "write" ||
        current.detached_at !== null ||
        current.updated_at !== work.bindingVersion ||
        current.scope !== work.scope ||
        !Array.isArray(capabilities) ||
        !["read-files", "run-tests"].every((capability) => capabilities.includes(capability))
      )
        return yield* failure("forbidden", "Current Project QA binding is unavailable.");
    });
    yield* requireCurrentBinding;
    const artifact = yield* artifacts.get(input.attemptId);
    if (
      !artifact ||
      artifact.workId !== work.id ||
      artifact.projectId !== work.projectId ||
      artifact.baseCodeRevision !== work.codeRevision ||
      artifact.artifactDigest !== attempt.artifactDigest ||
      artifact.artifactRef !== attempt.artifactRef
    )
      return yield* failure("conflict", "Saved artifact identity does not match submitted work.");
    yield* artifacts.verifySubmitted(artifact);
    let canonical;
    try {
      canonical = decodeOrganizationSingleFileArtifact(artifact.patchBytes);
    } catch {
      return yield* failure("invalid", "Saved artifact is not canonical single-file evidence.");
    }
    if (canonical.baseCommit !== work.codeRevision)
      return yield* failure("conflict", "Saved artifact base commit does not match pinned work.");
    const target: OrganizationSingleFileQAPolicyTarget = {
      organizationId: work.organizationId,
      projectId: work.projectId,
      bindingId: work.bindingId,
      workId: work.id,
      attemptId: attempt.id,
      artifactDigest: artifact.artifactDigest,
      artifactRef: artifact.artifactRef,
      workerSubject: attempt.workerSubject,
    };
    const decision = yield* policy.select(target);
    if (
      !decision.reviewerSubject ||
      decision.reviewerSubject === attempt.workerSubject ||
      Buffer.byteLength(decision.reviewerSubject, "utf8") > 128
    )
      return yield* failure("forbidden", "QA reviewer must be independent of the worker.");
    let policyPlanSha256: string;
    let planSnapshot: OrganizationSingleFileQAPlan;
    try {
      // Capture the server-owned oracle exactly once. Policy objects may be shared
      // and mutable; hashing one version and evaluating another would mislabel QA.
      const serialized = JSON.stringify(decision.plan);
      if (Buffer.byteLength(serialized, "utf8") > 24 * 1024)
        return yield* failure("invalid", "Server QA plan exceeds its byte limit.");
      planSnapshot = JSON.parse(serialized);
      policyPlanSha256 = digest(Buffer.from(serialized));
    } catch {
      return yield* failure("invalid", "Server QA plan is not serializable.");
    }
    // An existing receipt is the durable retry point after capture and before transition.
    const saved = yield* qa.get(input.attemptId);
    const evaluation = saved
      ? null
      : yield* Effect.tryPromise({
          try: () =>
            host.evaluate(input.attemptId, {
              reviewedArtifactBytes: artifact.patchBytes,
              reviewedArtifactSha256: digest(artifact.patchBytes),
              plan: planSnapshot,
            }),
          catch: () => failure("unavailable", "Scoped independent QA could not complete."),
        });
    const evidenceBytes = evaluation
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            policyPlanSha256,
            evaluator: JSON.parse(Buffer.from(evaluation.evidenceBytes).toString("utf8")),
          }),
        )
      : null;
    const evidenceRef = saved?.evidenceRef ?? `qa-${digest(evidenceBytes!)}`;
    const accepted = saved?.accepted ?? evaluation!.accepted;
    let savedPlanSha256: string | undefined;
    if (saved) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(saved.evidenceBytes).toString("utf8"));
        if (
          parsed &&
          typeof parsed === "object" &&
          "policyPlanSha256" in parsed &&
          typeof parsed.policyPlanSha256 === "string"
        )
          savedPlanSha256 = parsed.policyPlanSha256;
      } catch {
        /* Invalid evidence fails closed. */
      }
    }
    if (
      saved &&
      (saved.reviewerSubject !== decision.reviewerSubject ||
        saved.artifactDigest !== artifact.artifactDigest ||
        saved.artifactRef !== artifact.artifactRef)
    )
      return yield* failure(
        "conflict",
        "Saved QA receipt does not match current policy and artifact.",
      );
    if (saved && savedPlanSha256 !== policyPlanSha256)
      return yield* failure("conflict", "Saved QA receipt belongs to a different test plan.");
    yield* requireCurrentBinding;
    if (!saved)
      yield* qa.capture({
        workId: work.id,
        attemptId: attempt.id,
        projectId: work.projectId,
        artifactDigest: artifact.artifactDigest,
        artifactRef: artifact.artifactRef,
        workerSubject: attempt.workerSubject,
        reviewerSubject: decision.reviewerSubject,
        accepted,
        evidenceRef,
        evidenceBytes: evidenceBytes!,
      });
    return yield* workStore.evaluateAttempt(
      {
        workId: work.id,
        attemptId: attempt.id,
        transitionId: `qa-evaluate-${attempt.id}`,
        artifactDigest: artifact.artifactDigest,
        accepted,
        evidenceRef,
      },
      { subject: decision.reviewerSubject },
    );
  });

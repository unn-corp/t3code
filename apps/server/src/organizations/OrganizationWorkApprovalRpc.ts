// @effect-diagnostics nodeBuiltinImport:off - Approval pins the host's canonical Project path through realpath.
import type { ServerAuthSessionMethod } from "../../../../packages/contracts/src/auth.ts";
import { OrganizationWorkError } from "../../../../packages/contracts/src/organizationWork.ts";
import type { OrganizationWorkApprovalDecisionInput } from "../../../../packages/contracts/src/organizationWorkApproval.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OrganizationWorkApprovalCaptureAuthority,
  OrganizationWorkApprovalReceiptStoreWithAuthority,
  OrganizationWorkApprovalVerifierFromReceipts,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import { OrganizationWorkArtifactStoreLive } from "./OrganizationWorkArtifactStore.ts";
import { OrganizationWorkQAReceiptStoreLive } from "./OrganizationWorkQAReceiptStore.ts";
import {
  OrganizationWorkArtifactVerifierDisabled,
  OrganizationWorkEvaluationVerifierDisabled,
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";
import {
  OrganizationSingleFileApprovalCoordinatorError,
  OrganizationSingleFileApprovalPolicy,
  runOrganizationSingleFileApproval,
} from "./OrganizationSingleFileApprovalCoordinator.ts";
import {
  organizationSingleFileApprovalProjectRootDigest,
  organizationSingleFileApprovalRevisionGuardForRoot,
} from "./OrganizationSingleFileApprovalRevision.ts";
import { isInteractiveOrganizationSession } from "../auth/OrganizationGovernanceAuthorization.ts";

const workError = (code: OrganizationWorkError["code"], message: string) =>
  new OrganizationWorkError({ code, message });
const isWorkError = Schema.is(OrganizationWorkError);
const mapError = (error: unknown): OrganizationWorkError => {
  if (isWorkError(error)) return error;
  if (
    Predicate.isObject(error) &&
    "code" in error &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    switch (error.code) {
      case "invalid":
      case "not_found":
      case "conflict":
      case "forbidden":
      case "unavailable":
        return workError(error.code, error.message);
    }
  }
  return workError("unavailable", "Organization approval is unavailable.");
};

type PinnedTarget = {
  readonly projectId: string;
  readonly bindingId: string;
  readonly scope: string | null;
  readonly qaSubject: string;
  readonly canonicalProjectRoot: string;
};

/** This layer exists only for one authenticated RPC request and one pinned target. */
const requestLayer = (
  subject: string,
  input: OrganizationWorkApprovalDecisionInput,
  pinned: PinnedTarget,
) => {
  const artifacts = OrganizationWorkArtifactStoreLive;
  const qa = OrganizationWorkQAReceiptStoreLive.pipe(Layer.provideMerge(artifacts));
  const approval = OrganizationWorkApprovalReceiptStoreWithAuthority.pipe(
    Layer.provide(
      Layer.succeed(OrganizationWorkApprovalCaptureAuthority, {
        permitsAuthenticatedHuman: (receipt, context) =>
          context.organizationId === input.organizationId &&
          context.projectId === pinned.projectId &&
          context.bindingId === pinned.bindingId &&
          context.workId === input.workId &&
          context.attemptId === input.attemptId &&
          receipt.approvalSubject === subject &&
          receipt.qaSubject === pinned.qaSubject &&
          receipt.approved === input.approved &&
          receipt.artifactDigest === input.artifactDigest &&
          receipt.baseCodeRevision === input.baseCodeRevision,
      }),
    ),
    Layer.provideMerge(qa),
  );
  const approvalVerifier = OrganizationWorkApprovalVerifierFromReceipts.pipe(
    Layer.provideMerge(approval),
  );
  const work = OrganizationWorkStoreLayer.pipe(
    Layer.provideMerge(approvalVerifier),
    Layer.provide(OrganizationWorkArtifactVerifierDisabled),
    Layer.provide(OrganizationWorkEvaluationVerifierDisabled),
    Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
    Layer.provide(
      Layer.succeed(OrganizationWorkExecutionAuthority, {
        permits: (action, principal, target) =>
          action === "approve" &&
          principal.subject === subject &&
          target.organizationId === input.organizationId &&
          target.projectId === pinned.projectId &&
          target.bindingId === pinned.bindingId &&
          target.scope === pinned.scope &&
          target.workId === input.workId,
      }),
    ),
  );
  const policy = Layer.succeed(OrganizationSingleFileApprovalPolicy, {
    decide: (target, request) =>
      target.organizationId === input.organizationId &&
      target.projectId === pinned.projectId &&
      target.bindingId === pinned.bindingId &&
      target.workId === input.workId &&
      target.attemptId === input.attemptId &&
      target.artifactDigest === input.artifactDigest &&
      target.qaReceiptDigest === input.qaReceiptDigest &&
      target.baseCodeRevision === input.baseCodeRevision &&
      target.bindingVersion === input.bindingVersion &&
      request.requestId === input.requestId
        ? Effect.succeed({ approvalSubject: subject, approved: input.approved })
        : Effect.fail(
            new OrganizationSingleFileApprovalCoordinatorError({
              code: "conflict",
              message: "Reviewed work evidence or binding has changed.",
            }),
          ),
  });
  return Layer.fresh(
    Layer.mergeAll(
      work,
      approval,
      qa,
      artifacts,
      policy,
      organizationSingleFileApprovalRevisionGuardForRoot(pinned.canonicalProjectRoot),
    ),
  );
};

export const decideOrganizationWorkApprovalForSession = (
  session: { readonly method: ServerAuthSessionMethod; readonly subject: string },
  input: OrganizationWorkApprovalDecisionInput,
) => {
  const actor = { method: session.method, subject: session.subject };
  const request = { ...input };
  if (!isInteractiveOrganizationSession(actor) || !actor.subject.trim())
    return Effect.fail(
      workError("forbidden", "Approval requires an authenticated interactive human."),
    );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql<{
      project_id: string;
      binding_id: string;
      scope: string | null;
      qa_subject: string | null;
      artifact_digest: string | null;
      code_revision: string;
      binding_version: string;
      qa_receipt_digest: string | null;
      workspace_root: string;
    }>`SELECT w.project_id, w.binding_id, w.scope, w.code_revision,
      w.binding_version, a.qa_subject, a.artifact_digest,
      q.receipt_digest AS qa_receipt_digest, p.workspace_root
      FROM organization_work_items w
      JOIN organization_work_attempts a ON a.work_id = w.work_id
      JOIN projection_projects p ON p.project_id = w.project_id AND p.deleted_at IS NULL
      LEFT JOIN organization_work_qa_receipts q ON q.attempt_id = a.attempt_id
      WHERE w.organization_id = ${request.organizationId} AND w.work_id = ${request.workId}
        AND a.attempt_id = ${request.attemptId} AND a.number = w.attempt_count`)[0];
    if (
      !row ||
      row.artifact_digest !== request.artifactDigest ||
      row.qa_receipt_digest !== request.qaReceiptDigest ||
      row.code_revision !== request.baseCodeRevision ||
      row.binding_version !== request.bindingVersion ||
      !row.qa_subject
    )
      return yield* workError("conflict", "Reviewed work evidence or revision has changed.");
    if (!NodePath.isAbsolute(row.workspace_root))
      return yield* workError("conflict", "Current Project root is unavailable.");
    const canonicalProjectRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(row.workspace_root),
      catch: () => workError("conflict", "Current Project root cannot be resolved."),
    });
    if (
      organizationSingleFileApprovalProjectRootDigest(canonicalProjectRoot) !==
      request.projectRootDigest
    )
      return yield* workError("conflict", "Project root differs from the reviewed target.");
    return yield* runOrganizationSingleFileApproval({
      workId: request.workId,
      attemptId: request.attemptId,
      requestId: request.requestId,
      reason: request.reason,
      canonicalProjectRoot,
    }).pipe(
      Effect.provide(
        requestLayer(actor.subject, request, {
          projectId: row.project_id,
          bindingId: row.binding_id,
          scope: row.scope,
          qaSubject: row.qa_subject,
          canonicalProjectRoot,
        }),
      ),
    );
  }).pipe(Effect.mapError(mapError));
};

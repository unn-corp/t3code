import { OrganizationWorkError, type OrganizationWorkId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OrganizationPatchSourceReaderLive } from "./OrganizationPatchSourceReader.ts";
import {
  OrganizationGitCandidateIntentStoreWithAuthority,
  OrganizationGitCandidateRetentionAuthority,
} from "./OrganizationGitCandidateIntentStore.ts";
import {
  OrganizationProviderBudgetAuthority,
  OrganizationProviderBudgetWithAuthority,
} from "./OrganizationProviderBudget.ts";
import {
  organizationSingleFileAttemptBrokerHost,
  organizationSingleFileQABrokerHost,
} from "./OrganizationScopedBrokerHosts.ts";
import { OrganizationSingleFileAttemptScopeVerifierFromHost } from "./OrganizationSingleFileAttemptCoordinator.ts";
import { OrganizationSingleFileProductionPolicies } from "./OrganizationSingleFileProductionPolicies.ts";
import {
  OrganizationWorkApprovalReceiptStoreLive,
  OrganizationWorkApprovalVerifierFromReceipts,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkArtifactCaptureAuthority,
  OrganizationWorkArtifactStoreWithAuthority,
  OrganizationWorkArtifactVerifierFromStore,
} from "./OrganizationWorkArtifactStore.ts";
import { OrganizationWorkLaunchPlannerLive } from "./OrganizationWorkLaunchPlanner.ts";
import { withOrganizationLiveWorkPhaseClaim } from "./OrganizationLiveWorkDrain.ts";
import {
  OrganizationWorkQAReceiptCaptureAuthority,
  OrganizationWorkQAReceiptStoreWithAuthority,
  OrganizationWorkEvaluationVerifierFromQAReceipts,
} from "./OrganizationWorkQAReceiptStore.ts";
import { OrganizationWorkScopeStoreLayer } from "./OrganizationWorkScopeStore.ts";
import {
  OrganizationWorkExecutionAuthority,
  OrganizationWorkIntegrationVerifierDisabled,
  OrganizationWorkStore,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";
import {
  OrganizationWorkIntentActivationReadiness,
  readOrganizationWorkIntentActivationByWorkId,
} from "./OrganizationWorkIntentActivation.ts";
import {
  makeOrganizationLiveWorkLoopLayer,
  OrganizationLiveWorkRuntimeReadiness,
  organizationLiveWorkActions,
} from "./OrganizationLiveWorkExecutor.ts";

const denied = () =>
  new OrganizationWorkError({
    code: "forbidden",
    message: "Live Project work authority is not ready for this activation.",
  });

/** Each phase receives a fresh, one-work layer; no mutation capability is process wide. */
export const makeOrganizationLiveWorkScopedActions = (baseDir: string) => ({
  proposeAndAttempt: (workId: OrganizationWorkId) =>
    withOrganizationLiveWorkPhaseClaim(
      workId,
      "attempt",
      Effect.gen(function* () {
        const scoped = yield* makeOrganizationLiveWorkScopedRuntimeLayer(workId, baseDir);
        yield* organizationLiveWorkActions.proposeAndAttempt(workId).pipe(Effect.provide(scoped));
      }),
    ),
  candidateAndQA: (workId: OrganizationWorkId, attemptId: string) =>
    withOrganizationLiveWorkPhaseClaim(
      workId,
      "qa",
      Effect.gen(function* () {
        const scoped = yield* makeOrganizationLiveWorkScopedRuntimeLayer(workId, baseDir);
        yield* organizationLiveWorkActions
          .candidateAndQA(workId, attemptId)
          .pipe(Effect.provide(scoped));
      }),
    ),
  integrateAndComplete: (workId: OrganizationWorkId, attemptId: string) =>
    withOrganizationLiveWorkPhaseClaim(
      workId,
      "integration",
      Effect.gen(function* () {
        const scoped = yield* makeOrganizationLiveWorkScopedRuntimeLayer(workId, baseDir);
        yield* organizationLiveWorkActions
          .integrateAndComplete(workId, attemptId)
          .pipe(Effect.provide(scoped));
      }),
    ),
});

/** Explicit production entry; the caller must still prove startup readiness before mounting. */
export const makeOrganizationLiveWorkProductionLoop = (baseDir: string) =>
  makeOrganizationLiveWorkLoopLayer(makeOrganizationLiveWorkScopedActions(baseDir));

/** Captures one validated immutable activation. The returned capabilities are request local. */
export const makeOrganizationLiveWorkScopedRuntimeLayer = (
  workId: OrganizationWorkId,
  baseDir: string,
) =>
  Effect.gen(function* () {
    const activation = yield* readOrganizationWorkIntentActivationByWorkId(workId);
    const workStore = yield* OrganizationWorkStore;
    const activationReadiness = yield* OrganizationWorkIntentActivationReadiness;
    const runtimeReadiness = yield* OrganizationLiveWorkRuntimeReadiness;
    const detail = yield* workStore.getWork(workId);
    const work = detail.work;
    const permits = () =>
      runtimeReadiness.status().ready &&
      activationReadiness.permits(activation.organizationId, activation.intentId);
    if (
      !permits() ||
      work.id !== workId ||
      work.organizationId !== activation.organizationId ||
      work.creatorSubject !== activation.activatedBy ||
      work.workflowId !== activation.selection.workflowId
    )
      return yield* denied();
    const worker = `system:organization-worker:${workId}`;
    const reviewer = `system:organization-qa:${workId}`;
    const sameWork = (candidate: { readonly workId: string; readonly projectId: string }) =>
      permits() && candidate.workId === workId && candidate.projectId === work.projectId;
    const execution = Layer.succeed(OrganizationWorkExecutionAuthority, {
      permits: (action, principal, target) =>
        sameWork(target) &&
        target.organizationId === work.organizationId &&
        target.bindingId === work.bindingId &&
        target.scope === work.scope &&
        ((["claim", "submit", "cancel"].includes(action) && principal.subject === worker) ||
          (action === "evaluate" && principal.subject === reviewer)),
    });

    const artifactAuthority = Layer.succeed(OrganizationWorkArtifactCaptureAuthority, {
      permits: (input) => sameWork(input) && input.baseCodeRevision === work.codeRevision,
    });
    const qaAuthority = Layer.succeed(OrganizationWorkQAReceiptCaptureAuthority, {
      permits: (input, context) =>
        sameWork(input) &&
        sameWork(context) &&
        context.organizationId === work.organizationId &&
        context.bindingId === work.bindingId &&
        context.attemptId === input.attemptId &&
        input.workerSubject === worker &&
        input.reviewerSubject === reviewer,
    });
    const candidateAuthority = Layer.succeed(OrganizationGitCandidateRetentionAuthority, {
      permits: ({ intent, resultCommit, refName }) =>
        sameWork(intent) &&
        intent.organizationId === work.organizationId &&
        intent.bindingId === work.bindingId &&
        intent.bindingVersion === work.bindingVersion &&
        intent.baseCommit === work.codeRevision &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resultCommit) &&
        intent.refName === refName &&
        intent.relativePath === activation.selection.fileName,
    });
    const model = activation.selection.modelSelection;
    const budgetRecord = (record: {
      readonly requestId: string;
      readonly organizationId: string;
      readonly projectId: string;
      readonly providerInstanceId: string;
      readonly modelId: string;
    }) =>
      permits() &&
      /^org-proposal:[a-f0-9]{64}$/.test(record.requestId) &&
      record.organizationId === work.organizationId &&
      record.projectId === work.projectId &&
      record.providerInstanceId === model.instanceId &&
      record.modelId === model.model;
    const budgetAuthority = Layer.succeed(OrganizationProviderBudgetAuthority, {
      permitsReserve: (input) => budgetRecord(input) && input.estimatedTokens === 140_000,
      permitsTransition: (action, record) =>
        (action === "dispatch" || action === "expire") && budgetRecord(record),
      permitsReconcile: (input, record) =>
        input.requestId === record.requestId &&
        input.disposition === "completed" &&
        budgetRecord(record),
    });
    const host = organizationSingleFileAttemptBrokerHost(baseDir);
    const artifact = OrganizationWorkArtifactStoreWithAuthority.pipe(
      Layer.provide(artifactAuthority),
    );
    const qa = OrganizationWorkQAReceiptStoreWithAuthority.pipe(
      Layer.provide(qaAuthority),
      Layer.provideMerge(artifact),
    );
    const approval = OrganizationWorkApprovalReceiptStoreLive.pipe(
      Layer.provideMerge(qa),
      Layer.provide(artifact),
    );
    const workLayer = OrganizationWorkStoreLayer.pipe(
      Layer.provide(execution),
      Layer.provideMerge(
        OrganizationWorkArtifactVerifierFromStore.pipe(Layer.provideMerge(artifact)),
      ),
      Layer.provideMerge(
        OrganizationWorkEvaluationVerifierFromQAReceipts.pipe(Layer.provideMerge(qa)),
      ),
      Layer.provideMerge(
        OrganizationWorkApprovalVerifierFromReceipts.pipe(Layer.provideMerge(approval)),
      ),
      Layer.provide(OrganizationWorkIntegrationVerifierDisabled),
    );
    const scope = OrganizationWorkScopeStoreLayer.pipe(
      Layer.provide(
        OrganizationSingleFileAttemptScopeVerifierFromHost.pipe(Layer.provideMerge(host)),
      ),
    );
    const candidate = OrganizationGitCandidateIntentStoreWithAuthority.pipe(
      Layer.provide(candidateAuthority),
      Layer.provideMerge(artifact),
    );
    const budget = OrganizationProviderBudgetWithAuthority.pipe(Layer.provide(budgetAuthority));
    const planner = OrganizationWorkLaunchPlannerLive.pipe(Layer.provideMerge(workLayer));
    return Layer.fresh(
      Layer.mergeAll(
        workLayer,
        artifact,
        qa,
        approval,
        scope,
        candidate,
        budget,
        planner,
        host,
        organizationSingleFileQABrokerHost(baseDir),
        OrganizationPatchSourceReaderLive,
        OrganizationSingleFileProductionPolicies,
      ),
    );
  });

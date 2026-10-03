// @effect-diagnostics preferSchemaOverJson:off tryCatchInEffectGen:off - Persisted capability and request identity use bounded JSON.
import * as NodeCrypto from "node:crypto";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  OrganizationWorkAttemptId,
  OrganizationWorkId,
} from "../../../../packages/contracts/src/organizationWork.ts";
import {
  OrganizationSingleFileAttemptPolicy,
  OrganizationSingleFileAttemptError,
  type OrganizationSingleFileAttemptTarget,
} from "./OrganizationSingleFileAttemptCoordinator.ts";
import {
  OrganizationSingleFileProposalPolicy,
  OrganizationSingleFileProposalCoordinatorError,
  proposeOrganizationSingleFileArtifact,
  type OrganizationSingleFileProposalPolicyTarget,
} from "./OrganizationSingleFileProposalCoordinator.ts";
import {
  OrganizationSingleFileQAPolicy,
  OrganizationSingleFileQACoordinatorError,
  type OrganizationSingleFileQAPolicyTarget,
} from "./OrganizationSingleFileQACoordinator.ts";
import {
  OrganizationWorkIntentActivationReadiness,
  readOrganizationWorkIntentActivationByWorkId,
} from "./OrganizationWorkIntentActivation.ts";
import { OrganizationProviderBudget } from "./OrganizationProviderBudget.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";

type PolicyTarget = {
  readonly workId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
};

type BoundRow = {
  work_id: string;
  organization_id: string;
  project_id: string;
  binding_id: string;
  binding_version: string;
  workflow_id: string;
  code_revision: string;
  creator_subject: string;
  published_revision: number;
  scope: string | null;
  lifecycle: string;
  current_published_revision: number | null;
  binding_organization_id: string;
  binding_project_id: string;
  access: string;
  capabilities_json: string;
  detached_at: string | null;
  current_binding_version: string;
};

const workerSubject = (workId: string) => `system:organization-worker:${workId}`;
const reviewerSubject = (workId: string) => `system:organization-qa:${workId}`;
const boundedText = (value: string, maxBytes: number) => {
  let result = "";
  let bytes = 0;
  for (const character of value.replaceAll("\0", "")) {
    const length = Buffer.byteLength(character, "utf8");
    if (bytes + length > maxBytes) break;
    result += character;
    bytes += length;
  }
  return result;
};
const findingContext = (title: string, summary: string) => ({
  title: boundedText(title, 512),
  summary: boundedText(summary, 2_048),
});

/** A selection is useful only while its exact work and current authority still match. */
const readBoundActivation = (target: PolicyTarget) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const readiness = yield* OrganizationWorkIntentActivationReadiness;
    const rows = yield* sql<BoundRow>`SELECT w.work_id, w.organization_id, w.project_id,
      w.binding_id, w.binding_version, w.workflow_id, w.code_revision,
      w.creator_subject, w.published_revision, w.scope, o.lifecycle,
      o.published_revision AS current_published_revision,
      b.organization_id AS binding_organization_id, b.project_id AS binding_project_id,
      b.access, b.capabilities_json, b.detached_at,
      b.updated_at AS current_binding_version
      FROM organization_work_items w
      JOIN organizations o ON o.organization_id = w.organization_id
      JOIN organization_project_bindings b ON b.binding_id = w.binding_id
      JOIN projection_projects p ON p.project_id = w.project_id AND p.deleted_at IS NULL
      WHERE w.work_id = ${target.workId}`;
    const row = rows[0];
    let capabilities: unknown;
    try {
      capabilities = row && JSON.parse(row.capabilities_json);
    } catch {
      /* Invalid stored authority fails closed. */
    }
    if (
      !row ||
      row.work_id !== target.workId ||
      row.organization_id !== target.organizationId ||
      row.project_id !== target.projectId ||
      row.binding_id !== target.bindingId ||
      row.binding_organization_id !== target.organizationId ||
      row.binding_project_id !== target.projectId ||
      row.lifecycle !== "active" ||
      row.current_published_revision !== row.published_revision ||
      row.access !== "write" ||
      row.detached_at !== null ||
      row.current_binding_version !== row.binding_version ||
      row.scope !== null ||
      !Array.isArray(capabilities) ||
      !["read-files", "write-files", "run-tests"].every((capability) =>
        capabilities.includes(capability),
      )
    )
      return null;
    const activation = yield* readOrganizationWorkIntentActivationByWorkId(
      OrganizationWorkId.make(target.workId),
    ).pipe(Effect.orElseSucceed(() => null));
    if (
      !activation ||
      !readiness.permits(row.organization_id, activation.intentId) ||
      activation.workId !== row.work_id ||
      activation.organizationId !== row.organization_id ||
      activation.activatedBy !== row.creator_subject ||
      activation.selection.workflowId !== row.workflow_id ||
      activation.activatedBy === workerSubject(row.work_id) ||
      activation.activatedBy === reviewerSubject(row.work_id)
    )
      return null;
    return { row, activation };
  });

/** Mount only together with reviewed WorkStore, host, budget, and recovery authorities. */
const boundReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readiness = yield* OrganizationWorkIntentActivationReadiness;
  return (target: PolicyTarget) =>
    readBoundActivation(target).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(OrganizationWorkIntentActivationReadiness, readiness),
    );
});

export const OrganizationSingleFileProductionProposalPolicy = Layer.effect(
  OrganizationSingleFileProposalPolicy,
  Effect.map(boundReader, (read) => ({
    select: (target: OrganizationSingleFileProposalPolicyTarget) =>
      Effect.gen(function* () {
        const bound = yield* read(target).pipe(
          Effect.mapError(
            () =>
              new OrganizationSingleFileProposalCoordinatorError({
                code: "unavailable",
                message: "Project work authority could not be checked.",
              }),
          ),
        );
        if (!bound || target.baseCommit !== bound.row.code_revision)
          return yield* new OrganizationSingleFileProposalCoordinatorError({
            code: "forbidden",
            message: "Human-selected Project work is unavailable or its authority changed.",
          });
        return {
          fileName: bound.activation.selection.fileName,
          taskText: bound.activation.selection.taskText,
          modelSelection: bound.activation.selection.modelSelection,
          findingContext: findingContext(target.findingTitle, target.findingSummary),
        };
      }),
  })),
);

export const OrganizationSingleFileProductionAttemptPolicy = Layer.effect(
  OrganizationSingleFileAttemptPolicy,
  Effect.map(boundReader, (read) => ({
    select: (target: OrganizationSingleFileAttemptTarget) =>
      Effect.gen(function* () {
        const bound = yield* read(target).pipe(
          Effect.mapError(
            () =>
              new OrganizationSingleFileAttemptError({
                code: "unavailable",
                message: "Project work authority could not be checked.",
              }),
          ),
        );
        if (!bound || !/^[a-f0-9]{64}$/.test(target.artifactSha256))
          return yield* new OrganizationSingleFileAttemptError({
            code: "forbidden",
            message: "Human-selected Project work is unavailable or its authority changed.",
          });
        return {
          attemptId: OrganizationWorkAttemptId.make(`org-attempt:${NodeCrypto.randomUUID()}`),
          workerSubject: workerSubject(bound.row.work_id),
        };
      }),
  })),
);

export const OrganizationSingleFileProductionQAPolicy = Layer.effect(
  OrganizationSingleFileQAPolicy,
  Effect.map(boundReader, (read) => ({
    select: (target: OrganizationSingleFileQAPolicyTarget) =>
      Effect.gen(function* () {
        const bound = yield* read(target).pipe(
          Effect.mapError(
            () =>
              new OrganizationSingleFileQACoordinatorError({
                code: "unavailable",
                message: "Project QA authority could not be checked.",
              }),
          ),
        );
        if (
          !bound ||
          target.workerSubject !== workerSubject(bound.row.work_id) ||
          !/^[a-f0-9]{64}$/.test(target.artifactDigest) ||
          !target.artifactRef.trim()
        )
          return yield* new OrganizationSingleFileQACoordinatorError({
            code: "forbidden",
            message: "Independent Project QA is unavailable or its authority changed.",
          });
        return {
          plan: bound.activation.selection.qaPlan,
          reviewerSubject: reviewerSubject(bound.row.work_id),
        };
      }),
  })),
);

/** Long-lived worker policies. Proposal authority is installed only for one budgeted call. */
export const OrganizationSingleFileProductionPolicies = Layer.mergeAll(
  OrganizationSingleFileProductionAttemptPolicy,
  OrganizationSingleFileProductionQAPolicy,
);

/** Captures the trusted services once and returns a call surface that cannot bypass admission. */
export const makeOrganizationBudgetedPatchGenerator = (workId: OrganizationWorkId) =>
  Effect.gen(function* () {
    const read = yield* boundReader;
    const works = yield* OrganizationWorkStore;
    const budget = yield* OrganizationProviderBudget;
    const generation = yield* TextGeneration;
    const sql = yield* SqlClient.SqlClient;
    return (
      input: Parameters<NonNullable<typeof generation.generateOrganizationPatchProposal>>[0],
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const detail = yield* works.getWork(workId).pipe(
            Effect.mapError(
              () =>
                new TextGenerationError({
                  operation: "generateOrganizationPatchProposal",
                  detail: "Activated Project work is unavailable.",
                }),
            ),
          );
          const work = detail.work;
          const bound = yield* read({
            workId,
            organizationId: work.organizationId,
            projectId: work.projectId,
            bindingId: work.bindingId,
          }).pipe(
            Effect.mapError(
              () =>
                new TextGenerationError({
                  operation: "generateOrganizationPatchProposal",
                  detail: "Project work authority could not be checked.",
                }),
            ),
          );
          const finding = (yield* sql<{ title: string; summary: string }>`
          SELECT title, summary FROM organization_intake_findings
          WHERE finding_id = ${work.findingId} AND organization_id = ${work.organizationId}
            AND project_id = ${work.projectId} AND state = 'tentative'`.pipe(
            Effect.mapError(
              () =>
                new TextGenerationError({
                  operation: "generateOrganizationPatchProposal",
                  detail: "Scoped finding could not be checked.",
                }),
            ),
          ))[0];
          if (
            !bound ||
            !finding ||
            bound.activation.selection.fileName !== input.fileName ||
            bound.activation.selection.taskText !== input.taskText ||
            JSON.stringify(findingContext(finding.title, finding.summary)) !==
              JSON.stringify(input.findingContext) ||
            JSON.stringify(bound.activation.selection.modelSelection) !==
              JSON.stringify(input.modelSelection)
          )
            return yield* new TextGenerationError({
              operation: "generateOrganizationPatchProposal",
              detail: "Provider request differs from the human-selected Project work.",
            });
          const requestId = `org-proposal:${NodeCrypto.createHash("sha256")
            .update(JSON.stringify({ workId, input }))
            .digest("hex")}`;
          const admitted = yield* budget
            .reserve({
              requestId,
              organizationId: work.organizationId,
              projectId: work.projectId,
              providerInstanceId: input.modelSelection.instanceId,
              modelId: input.modelSelection.model,
              // 64 KiB source + 64 KiB replacement, bounded task and protocol overhead.
              estimatedTokens: 140_000,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new TextGenerationError({
                    operation: "generateOrganizationPatchProposal",
                    detail: `Provider admission denied: ${error.message}`,
                    cause: error,
                  }),
              ),
            );
          if (admitted.state !== "reserved")
            return yield* new TextGenerationError({
              operation: "generateOrganizationPatchProposal",
              detail: "Provider request was already dispatched or reconciled.",
            });
          yield* budget.markDispatched(requestId).pipe(
            Effect.mapError(
              (error) =>
                new TextGenerationError({
                  operation: "generateOrganizationPatchProposal",
                  detail: `Provider dispatch denied: ${error.message}`,
                  cause: error,
                }),
            ),
          );
          const result = yield* Effect.exit(
            restore(
              generation.generateOrganizationPatchProposal
                ? generation.generateOrganizationPatchProposal(input)
                : Effect.fail(
                    new TextGenerationError({
                      operation: "generateOrganizationPatchProposal",
                      detail: "Selected provider does not support patch generation.",
                    }),
                  ),
            ),
          );
          if (Exit.isFailure(result)) {
            yield* budget.markUncertain(requestId).pipe(Effect.ignore);
            return yield* result;
          }
          yield* budget.reconcile({ requestId, disposition: "completed" }).pipe(
            Effect.mapError(
              (error) =>
                new TextGenerationError({
                  operation: "generateOrganizationPatchProposal",
                  detail: `Provider completion could not be recorded: ${error.message}`,
                  cause: error,
                }),
            ),
          );
          return result.value;
        }),
      );
  });

/** The only proposal entry point for a live runner. A dispatch cannot occur without
 * a durable, three-scope admission. Unknown provider outcomes keep capacity held.
 */
export const proposeOrganizationSingleFileArtifactWithBudget = (workId: OrganizationWorkId) =>
  Effect.gen(function* () {
    const generation = yield* TextGeneration;
    const budgetedGenerate = yield* makeOrganizationBudgetedPatchGenerator(workId);
    const guarded = {
      ...generation,
      generateOrganizationPatchProposal: budgetedGenerate,
    } satisfies typeof generation;
    return yield* proposeOrganizationSingleFileArtifact(workId).pipe(
      Effect.provideService(TextGeneration, guarded),
      Effect.provide(OrganizationSingleFileProductionProposalPolicy),
    );
  });

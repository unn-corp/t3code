import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  AgentDashboardError,
  type AuthEnvironmentScope,
  OrganizationIntakeError,
  OrganizationArchitectError,
  OrganizationError,
  OrganizationWorkError,
  OrganizationId,
  OrganizationProviderBudgetReadError,
  OrganizationProviderBudgetConfigurationRpcError,
  OrganizationLiveWorkFailuresError,
  ProjectId,
  EnvironmentAuthorizationError,
  WS_METHODS,
} from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import {
  AgentDashboardSnapshotReadError,
  loadAgentDashboardSnapshot,
} from "./agentDashboard/AgentDashboardSnapshot.ts";
import * as AgentDashboardStore from "./agentDashboard/AgentDashboardStore.ts";
import * as AgentDashboardCollectors from "./agentDashboard/AgentDashboardCollectors.ts";
import * as AgentDashboardContinuousImprovement from "./agentDashboard/AgentDashboardContinuousImprovement.ts";
import * as AgentDashboardRunHistory from "./agentDashboard/AgentDashboardRunHistory.ts";
import * as AgentDashboardReviewJobService from "./agentDashboard/AgentDashboardReviewJobService.ts";
import * as AgentDashboardReviewRunner from "./agentDashboard/AgentDashboardReviewRunner.ts";
import * as AgentDashboardReviewScheduler from "./agentDashboard/AgentDashboardReviewScheduler.ts";
import {
  architectGenerationFailureMessage,
  completedArchitectTranscript,
} from "./organizations/OrganizationArchitectContext.ts";
import * as OrganizationStore from "./organizations/OrganizationStore.ts";
import * as OrganizationIntakeStore from "./organizations/OrganizationIntakeStore.ts";
import * as OrganizationWorkStore from "./organizations/OrganizationWorkStore.ts";
import * as OrganizationWorkIntentStore from "./organizations/OrganizationWorkIntentStore.ts";
import {
  listOrganizationLiveWorkFailures,
  readOrganizationLiveWorkRuntimeStatus,
} from "./organizations/OrganizationLiveWorkExecutor.ts";
import { activateOrganizationWorkIntent } from "./organizations/OrganizationWorkIntentActivation.ts";
import {
  createOrganizationStandingWorkAuthorization,
  listOrganizationStandingWorkAuthorizations,
  revokeOrganizationStandingWorkAuthorization,
} from "./organizations/OrganizationStandingWorkAuthorization.ts";
import {
  cancelActivatedOrganizationWork,
  resumePausedOrganization,
} from "./organizations/OrganizationLiveWorkLifecycle.ts";
import {
  readOrganizationWorkDrain,
  requestOrganizationWorkDrain,
} from "./organizations/OrganizationLiveWorkDrain.ts";
import {
  readOrganizationEmergencyStop,
  requestOrganizationEmergencyStop,
  stopAndVerifyOrganizationEmergencyScopes,
} from "./organizations/OrganizationLiveWorkEmergencyStop.ts";
import { organizationScopeLaunchBrokerClient } from "./organizations/OrganizationScopeLaunchBroker.ts";
import * as OrganizationProviderBudgetConfiguration from "./organizations/OrganizationProviderBudgetConfiguration.ts";
import {
  readLinkedBudgetProjectPage,
  providerBudgetReadAuthority,
} from "./organizations/OrganizationProviderBudgetRead.ts";
import {
  OrganizationWorkIntentListResult,
  OrganizationWorkIntentReadError,
} from "../../../packages/contracts/src/organizationWorkIntents.ts";
import * as OrganizationWorkReviewStore from "./organizations/OrganizationWorkReviewStore.ts";
import { decideOrganizationWorkApprovalForSession } from "./organizations/OrganizationWorkApprovalRpc.ts";
import * as OrganizationArchitectTranscriptStore from "./organizations/OrganizationArchitectTranscriptStore.ts";
import * as OrganizationMemoryStore from "./organizations/OrganizationMemoryStore.ts";
import * as OrganizationCorrelationCoordinator from "./organizations/OrganizationCorrelationCoordinator.ts";
import * as OrganizationCorrelationRecovery from "./organizations/OrganizationCorrelationRecovery.ts";
import * as OrganizationProposalStore from "./organizations/OrganizationProposalStore.ts";
import * as OrganizationDirectorStore from "./organizations/OrganizationDirectorStore.ts";
import * as OrganizationRepositoryStore from "./organizations/OrganizationRepositoryStore.ts";
import { correlateRecordedIntake } from "./organizations/OrganizationIntakeCorrelation.ts";
import {
  isInteractiveOrganizationSession,
  requireInteractiveOrganizationSession,
} from "./auth/OrganizationGovernanceAuthorization.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectionSnapshotQuery from "./agentDashboard/AutomationSnapshotQuery.ts";
import { observeRpcEffect as instrumentRpcEffect } from "./observability/RpcInstrumentation.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import { ForkWsRpcGroup as ForkRpcGroup } from "@t3tools/contracts";
const decodeWorkIntentPage = Schema.decodeEffect(OrganizationWorkIntentListResult);
const isOrganizationWorkError = Schema.is(OrganizationWorkError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
export const makeForkWsRpcLayer = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  ForkRpcGroup.toLayer(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const providerInstances = yield* ProviderInstanceRegistry;
      const config = yield* ServerConfig.ServerConfig;
      const dashboardStore = AgentDashboardStore.getStore(config.stateDir);
      const organizationStore = yield* OrganizationStore.OrganizationStore;
      const organizationIntakeStore = yield* OrganizationIntakeStore.OrganizationIntakeStore;
      const organizationWorkStore = yield* OrganizationWorkStore.OrganizationWorkStore;
      const organizationWorkIntentStore =
        yield* OrganizationWorkIntentStore.OrganizationWorkIntentStore;
      const organizationWorkReviewStore =
        yield* OrganizationWorkReviewStore.OrganizationWorkReviewStore;
      const organizationArchitectTranscriptStore =
        yield* OrganizationArchitectTranscriptStore.OrganizationArchitectTranscriptStore;
      const organizationMemoryStore = yield* OrganizationMemoryStore.OrganizationMemoryStore;
      const organizationCorrelationCoordinator =
        yield* OrganizationCorrelationCoordinator.OrganizationCorrelationCoordinator;
      const organizationCorrelationRecovery =
        yield* OrganizationCorrelationRecovery.OrganizationCorrelationRecovery;
      const organizationProposalStore = yield* OrganizationProposalStore.OrganizationProposalStore;
      const organizationDirectorStore = yield* OrganizationDirectorStore.OrganizationDirectorStore;
      const organizationRepositoryStore =
        yield* OrganizationRepositoryStore.OrganizationRepositoryStore;
      const budgetConfigurationFor = (
        organizationId: string,
        scope: OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetScope,
      ) =>
        Effect.gen(function* () {
          if (!isInteractiveOrganizationSession(currentSession))
            return yield* new OrganizationProviderBudgetConfigurationRpcError({
              code: "forbidden",
              message: "Provider capacity changes require an interactive human session.",
            });
          const organization = yield* organizationStore
            .get({ organizationId: OrganizationId.make(organizationId) })
            .pipe(
              Effect.mapError(
                (error) =>
                  new OrganizationProviderBudgetConfigurationRpcError({
                    code: error.code === "not_found" ? "not_found" : "unavailable",
                    message: error.message,
                  }),
              ),
            );
          const allowed =
            scope.kind === "global" ||
            (scope.kind === "organization" && scope.organizationId === organization.id) ||
            (scope.kind === "project" &&
              organization.bindings.some(
                (binding) => binding.projectId === scope.projectId && binding.detachedAt === null,
              ));
          if (!allowed)
            return yield* new OrganizationProviderBudgetConfigurationRpcError({
              code: "forbidden",
              message: "Provider capacity scope is not linked to this Organization.",
            });
          const sameScope = (
            candidate: OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetScope,
          ) =>
            candidate.kind === scope.kind &&
            (candidate.kind === "global" ||
              (candidate.kind === "organization" &&
                scope.kind === "organization" &&
                candidate.organizationId === scope.organizationId) ||
              (candidate.kind === "project" &&
                scope.kind === "project" &&
                candidate.projectId === scope.projectId));
          const authority = Layer.succeed(
            OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetConfigurationAuthority,
            {
              authenticatedHumanId: currentSession.subject,
              projectOrganizationId: scope.kind === "project" ? organization.id : null,
              permitsRead: sameScope,
              permitsGlobalUpdate: (
                request: OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetConfigurationUpdate,
              ) =>
                currentSession.method === "bearer-access-token" &&
                currentSession.subject === "desktop-bootstrap" &&
                scope.kind === "global" &&
                sameScope(request.scope),
              permitsScopedUpdate: (
                request: OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetConfigurationUpdate,
              ) => scope.kind !== "global" && sameScope(request.scope),
            },
          );
          return yield* OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetConfiguration.pipe(
            Effect.provide(
              OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetConfigurationWithAuthority.pipe(
                Layer.provide(authority),
                Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
              ),
            ),
          );
        });
      const requireInteractiveIntakeSession = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | OrganizationIntakeError, R> =>
        isInteractiveOrganizationSession(currentSession)
          ? effect
          : Effect.fail(
              new OrganizationIntakeError({
                code: "forbidden",
                message: "Organization intake changes require an interactive session.",
              }),
            );
      const reviewJobService = yield* AgentDashboardReviewJobService.AgentDashboardReviewJobService;
      const runtimeContext = yield* Effect.context<never>();
      const continuousImprovement = Context.getOption(
        runtimeContext,
        AgentDashboardContinuousImprovement.AgentDashboardContinuousImprovement,
      );
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const path = yield* Path.Path;
      const runAgentDashboardInvestigation = (projectId?: ProjectId | null) =>
        reviewJobService
          .enqueueReview({
            trigger: "manual",
            ...(projectId ? { projectId } : {}),
            idempotencyKey: projectId ? `manual:${String(projectId)}` : "manual:repository-review",
          })
          .pipe(Effect.asVoid);
      const appliedMutation = (targetId: string | null = null) =>
        ({
          ok: true as const,
          outcome: "applied" as const,
          message: null,
          targetId,
          targetUrl: null,
        }) as const;
      return ForkRpcGroup.of({
        [WS_METHODS.organizationsList]: (_input) =>
          observeRpcEffect(WS_METHODS.organizationsList, organizationStore.list(), {
            "rpc.aggregate": "organizations",
          }),
        [WS_METHODS.organizationsCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsCreate,
            requireInteractiveOrganizationSession(
              currentSession,
              organizationStore.create({ ...input, actor: "user" }),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsGet]: (input) =>
          observeRpcEffect(WS_METHODS.organizationsGet, organizationStore.get(input), {
            "rpc.aggregate": "organizations",
          }),
        [WS_METHODS.organizationsGetPublishedConfig]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsGetPublishedConfig,
            organizationStore.getPublishedConfig(input),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsReadProviderBudgets]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsReadProviderBudgets,
            Effect.gen(function* () {
              if (!isInteractiveOrganizationSession(currentSession))
                return yield* new OrganizationProviderBudgetReadError({
                  code: "forbidden",
                  message: "Provider budget ceilings require an authenticated human session.",
                });
              const organization = yield* organizationStore.get(input).pipe(
                Effect.mapError(
                  (error) =>
                    new OrganizationProviderBudgetReadError({
                      code: error.code === "not_found" ? "not_found" : "unavailable",
                      message: error.message,
                    }),
                ),
              );
              const scopedAuthority = Layer.succeed(
                OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetConfigurationAuthority,
                providerBudgetReadAuthority(currentSession.subject, organization.id),
              );
              const budgetConfiguration =
                yield* OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetConfiguration.pipe(
                  Effect.provide(
                    OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetConfigurationWithAuthority.pipe(
                      Layer.provide(scopedAuthority),
                      Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
                    ),
                  ),
                );
              const readCeiling = (
                scope: OrganizationProviderBudgetConfiguration.OrganizationProviderBudgetScope,
              ) =>
                budgetConfiguration.get(scope).pipe(
                  Effect.map((record) =>
                    record === null
                      ? null
                      : {
                          maxConcurrent: record.maxConcurrent,
                          maxDailyCalls: record.maxDailyCalls,
                          maxDailyEstimatedTokens: record.maxDailyEstimatedTokens,
                        },
                  ),
                  Effect.mapError(
                    (error) =>
                      new OrganizationProviderBudgetReadError({
                        code: error.code === "forbidden" ? "forbidden" : "unavailable",
                        message: error.message,
                      }),
                  ),
                );
              const global = yield* readCeiling({ kind: "global" });
              if (global === null)
                return yield* new OrganizationProviderBudgetReadError({
                  code: "unavailable",
                  message: "Global provider budget ceiling is unavailable.",
                });
              const organizationCeiling = yield* readCeiling({
                kind: "organization",
                organizationId: organization.id,
              });
              const projectPage = yield* readLinkedBudgetProjectPage(
                organization.id,
                input.afterProjectId,
              ).pipe(
                Effect.mapError(
                  () =>
                    new OrganizationProviderBudgetReadError({
                      code: "unavailable",
                      message: "Linked Project provider ceilings are unavailable.",
                    }),
                ),
              );
              return {
                global,
                organization: organizationCeiling,
                ...projectPage,
              };
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsGetProviderBudget]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsGetProviderBudget,
            Effect.gen(function* () {
              const configuration = yield* budgetConfigurationFor(
                input.organizationId,
                input.scope,
              );
              const record = yield* configuration.get(input.scope).pipe(
                Effect.mapError(
                  (error) =>
                    new OrganizationProviderBudgetConfigurationRpcError({
                      code: error.code,
                      message: error.message,
                    }),
                ),
              );
              return {
                record:
                  record === null
                    ? null
                    : {
                        scope: input.scope,
                        revision: record.revision,
                        limits: {
                          maxConcurrent: record.maxConcurrent,
                          maxDailyCalls: record.maxDailyCalls,
                          maxDailyEstimatedTokens: record.maxDailyEstimatedTokens,
                        },
                      },
              };
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsUpdateProviderBudget]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsUpdateProviderBudget,
            Effect.gen(function* () {
              const configuration = yield* budgetConfigurationFor(
                input.organizationId,
                input.scope,
              );
              const record = yield* configuration.update(input).pipe(
                Effect.mapError(
                  (error) =>
                    new OrganizationProviderBudgetConfigurationRpcError({
                      code: error.code,
                      message: error.message,
                    }),
                ),
              );
              return { scope: input.scope, revision: record.revision, limits: input.limits };
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsMutate]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsMutate,
            requireInteractiveOrganizationSession(
              currentSession,
              organizationStore.mutate({ ...input, actor: "user" }),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsBindProject]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsBindProject,
            requireInteractiveOrganizationSession(
              currentSession,
              organizationStore.bindProject({ ...input, actor: "user" }),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsDetachProject]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsDetachProject,
            requireInteractiveOrganizationSession(
              currentSession,
              organizationStore.detachProject({ ...input, actor: "user" }),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsPublish]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsPublish,
            requireInteractiveOrganizationSession(
              currentSession,
              organizationStore.publish({ ...input, actor: "user" }),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsSetLifecycle]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsSetLifecycle,
            input.lifecycle === "active"
              ? resumePausedOrganization(
                  { ...input, actor: "user" },
                  {
                    subject: currentSession.subject,
                    interactive: isInteractiveOrganizationSession(currentSession),
                  },
                ).pipe(
                  Effect.mapError(
                    (error) => new OrganizationError({ code: error.code, message: error.message }),
                  ),
                )
              : requireInteractiveOrganizationSession(
                  currentSession,
                  organizationStore.setLifecycle({ ...input, actor: "user" }),
                ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListAudit]: (input) =>
          observeRpcEffect(WS_METHODS.organizationsListAudit, organizationStore.listAudit(input), {
            "rpc.aggregate": "organizations",
          }),
        [WS_METHODS.organizationsRepositoryPreview]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRepositoryPreview,
            organizationRepositoryStore.preview(input),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRepositoryLink]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRepositoryLink,
            organizationRepositoryStore.link(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRepositoryLoad]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRepositoryLoad,
            organizationRepositoryStore.load(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRepositorySync]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRepositorySync,
            organizationRepositoryStore.sync(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRepositoryStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRepositoryStatus,
            organizationRepositoryStore.status(input),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRepositoryListRecords]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRepositoryListRecords,
            organizationRepositoryStore.listRecords(input),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRepositoryResolveConflict]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRepositoryResolveConflict,
            organizationRepositoryStore.resolveConflict(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsArchitectApplyBatch]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsArchitectApplyBatch,
            requireInteractiveOrganizationSession(
              currentSession,
              organizationStore.applyArchitectBatch(input),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsArchitectList]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsArchitectList,
            organizationArchitectTranscriptStore.list(input),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsArchitectSend]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsArchitectSend,
            !isInteractiveOrganizationSession(currentSession)
              ? Effect.fail(
                  new OrganizationArchitectError({
                    code: "forbidden",
                    message: "Architect messages require an interactive session.",
                  }),
                )
              : Effect.gen(function* () {
                  const principal = { subject: currentSession.subject };
                  const begun = yield* organizationArchitectTranscriptStore.begin(input, principal);
                  if (!begun.shouldGenerate) {
                    if (begun.result !== null) return begun.result;
                    return yield* new OrganizationArchitectError({
                      code: "conflict",
                      message:
                        begun.status === "pending"
                          ? "This Architect request is still pending. Refresh the conversation."
                          : "This Architect request failed. Send a new message to retry.",
                    });
                  }
                  return yield* Effect.gen(function* () {
                    const organization = yield* organizationStore.get(input).pipe(
                      Effect.mapError(
                        () =>
                          new OrganizationArchitectError({
                            code: "unavailable",
                            message: "Organization configuration is unavailable to the Architect.",
                          }),
                      ),
                    );
                    if (organization.draftRevision !== input.baseRevision) {
                      return yield* new OrganizationArchitectError({
                        code: "conflict",
                        message: "Organization draft changed before Architect generation.",
                      });
                    }
                    const conversation = yield* organizationArchitectTranscriptStore.list(input);
                    const currentMessage = conversation.messages.find(
                      (message) => message.id === input.messageId && message.role === "user",
                    );
                    if (currentMessage === undefined) {
                      return yield* new OrganizationArchitectError({
                        code: "unavailable",
                        message: "Architect message is unavailable.",
                      });
                    }
                    const instance = yield* providerInstances.getInstance(
                      input.modelSelection.instanceId,
                    );
                    const generate = instance?.enabled
                      ? instance.textGeneration.generateOrganizationArchitectTurn
                      : undefined;
                    if (generate === undefined) {
                      return yield* new OrganizationArchitectError({
                        code: "unavailable",
                        message:
                          "The selected provider does not support tool-free Architect conversation.",
                      });
                    }
                    const transcript = completedArchitectTranscript(conversation, input.messageId);
                    const output = yield* generate({
                      modelSelection: input.modelSelection,
                      organization,
                      setupState: {
                        lifecycle: organization.lifecycle,
                        publishedRevision: organization.publishedRevision,
                        linkedProjectCount: organization.bindings.filter(
                          (binding) => binding.detachedAt === null,
                        ).length,
                        writeCapableProjectCount: organization.bindings.filter(
                          (binding) => binding.detachedAt === null && binding.access === "write",
                        ).length,
                      },
                      transcript,
                      userText: currentMessage.text,
                    }).pipe(
                      Effect.mapError(
                        (cause) =>
                          new OrganizationArchitectError({
                            code: "unavailable",
                            message: architectGenerationFailureMessage(cause),
                          }),
                      ),
                    );
                    return yield* organizationArchitectTranscriptStore.complete(
                      { organizationId: input.organizationId, messageId: input.messageId, output },
                      principal,
                    );
                  }).pipe(
                    Effect.catch((error) =>
                      organizationArchitectTranscriptStore
                        .fail(
                          {
                            organizationId: input.organizationId,
                            messageId: input.messageId,
                            ...(Schema.is(OrganizationArchitectError)(error)
                              ? { failureMessage: error.message }
                              : {}),
                          },
                          principal,
                        )
                        .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
                    ),
                  );
                }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsMemoryList]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsMemoryList,
            organizationMemoryStore.list(input).pipe(Effect.map((records) => ({ records }))),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsMemoryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsMemoryHistory,
            organizationMemoryStore.history(input).pipe(Effect.map((revisions) => ({ revisions }))),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsMemoryCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsMemoryCreate,
            organizationMemoryStore.create(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsMemoryCorrect]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsMemoryCorrect,
            organizationMemoryStore.correct(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsMemorySupersede]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsMemorySupersede,
            organizationMemoryStore.supersede(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsMemoryArchive]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsMemoryArchive,
            organizationMemoryStore.archive(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRegisterSource]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRegisterSource,
            requireInteractiveIntakeSession(
              organizationIntakeStore.registerSource(
                { ...input, ingestSubject: currentSession.subject },
                { subject: currentSession.subject, canManageSources: true },
              ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRotateSourceSecret]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRotateSourceSecret,
            requireInteractiveIntakeSession(
              organizationIntakeStore.rotateSourceSecret(input.organizationId, input.sourceId, {
                subject: currentSession.subject,
                canManageSources: true,
              }),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsSetSourceEnabled]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsSetSourceEnabled,
            requireInteractiveIntakeSession(
              organizationIntakeStore.setSourceEnabled(
                input.organizationId,
                input.sourceId,
                input.enabled,
                { subject: currentSession.subject, canManageSources: true },
              ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListSources]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListSources,
            organizationIntakeStore
              .listSources(input.organizationId)
              .pipe(Effect.map((sources) => ({ sources }))),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsIngestManual]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsIngestManual,
            requireInteractiveIntakeSession(
              organizationIntakeStore
                .ingest(input, {
                  kind: "interactive-user",
                  subject: currentSession.subject,
                })
                .pipe(
                  Effect.flatMap((result) =>
                    correlateRecordedIntake(
                      organizationCorrelationCoordinator,
                      result,
                      organizationCorrelationRecovery,
                    ),
                  ),
                ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRetryCorrelation]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRetryCorrelation,
            requireInteractiveIntakeSession(
              organizationIntakeStore
                .getObservation(input.organizationId, input.observationId)
                .pipe(
                  Effect.flatMap((observation) =>
                    correlateRecordedIntake(
                      organizationCorrelationCoordinator,
                      {
                        outcome: "duplicate",
                        observation,
                      },
                      organizationCorrelationRecovery,
                      true,
                    ),
                  ),
                  Effect.map((result) => result.correlation!),
                ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListObservations]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListObservations,
            organizationIntakeStore
              .listObservations(input.organizationId)
              .pipe(Effect.map((observations) => ({ observations }))),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListCorrelationJobs]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListCorrelationJobs,
            organizationIntakeStore
              .listCorrelationJobs(input.organizationId)
              .pipe(Effect.map((jobs) => ({ jobs }))),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListFindings]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListFindings,
            organizationIntakeStore
              .listTentativeFindings(input.organizationId)
              .pipe(Effect.map((findings) => ({ findings }))),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListIntakeAudit]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListIntakeAudit,
            organizationIntakeStore
              .listAudit(input.organizationId)
              .pipe(Effect.map((entries) => ({ entries }))),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListWork]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListWork,
            organizationWorkStore
              .listWork(input.organizationId)
              .pipe(Effect.map((items) => ({ items }))),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListWorkIntents]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListWorkIntents,
            Effect.gen(function* () {
              // The session supplies read authority; the client supplies only the scope key.
              yield* organizationStore.get({ organizationId: input.organizationId }).pipe(
                Effect.mapError(
                  (error) =>
                    new OrganizationWorkIntentReadError({
                      code: error.code === "not_found" ? "not_found" : "unavailable",
                      message: error.message,
                    }),
                ),
              );
              const intents = yield* organizationWorkIntentStore
                .list(input.organizationId, input.afterIntentId, input.limit)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new OrganizationWorkIntentReadError({
                        code: error.code,
                        message: error.message,
                      }),
                  ),
                );
              return yield* decodeWorkIntentPage({
                intents,
                nextCursor: intents.length === input.limit ? (intents.at(-1)?.id ?? null) : null,
              }).pipe(
                Effect.mapError(
                  () =>
                    new OrganizationWorkIntentReadError({
                      code: "unavailable",
                      message: "Saved work intent page is invalid.",
                    }),
                ),
              );
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListWorkFailures]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListWorkFailures,
            Effect.gen(function* () {
              yield* organizationStore.get({ organizationId: input.organizationId }).pipe(
                Effect.mapError(
                  (error) =>
                    new OrganizationLiveWorkFailuresError({
                      code: error.code === "not_found" ? "not_found" : "unavailable",
                      message: error.message,
                    }),
                ),
              );
              const failures = yield* listOrganizationLiveWorkFailures(input.organizationId).pipe(
                Effect.mapError(
                  () =>
                    new OrganizationLiveWorkFailuresError({
                      code: "unavailable",
                      message: "Saved Project work failures are unavailable.",
                    }),
                ),
              );
              return { failures };
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsGetWorkRuntimeStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsGetWorkRuntimeStatus,
            Effect.gen(function* () {
              yield* organizationStore.get({ organizationId: input.organizationId }).pipe(
                Effect.mapError(
                  (error) =>
                    new OrganizationLiveWorkFailuresError({
                      code: error.code === "not_found" ? "not_found" : "unavailable",
                      message: error.message,
                    }),
                ),
              );
              return yield* readOrganizationLiveWorkRuntimeStatus;
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsActivateWorkIntent]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsActivateWorkIntent,
            activateOrganizationWorkIntent(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsCreateStandingWorkAuthorization]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsCreateStandingWorkAuthorization,
            createOrganizationStandingWorkAuthorization(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsListStandingWorkAuthorizations]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsListStandingWorkAuthorizations,
            listOrganizationStandingWorkAuthorizations(input.organizationId),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRevokeStandingWorkAuthorization]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRevokeStandingWorkAuthorization,
            revokeOrganizationStandingWorkAuthorization(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsCancelWork]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsCancelWork,
            cancelActivatedOrganizationWork(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }).pipe(
              Effect.mapError(
                (error) => new OrganizationWorkError({ code: error.code, message: error.message }),
              ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRequestWorkDrain]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRequestWorkDrain,
            requestOrganizationWorkDrain(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }).pipe(
              Effect.mapError((error) =>
                isOrganizationWorkError(error)
                  ? error
                  : new OrganizationWorkError({
                      code: "unavailable",
                      message: "Organization drain is unavailable.",
                    }),
              ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsGetWorkDrainStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsGetWorkDrainStatus,
            readOrganizationWorkDrain(input.organizationId).pipe(
              Effect.mapError((error) =>
                isOrganizationWorkError(error)
                  ? error
                  : new OrganizationWorkError({
                      code: "unavailable",
                      message: "Organization drain status is unavailable.",
                    }),
              ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsRequestEmergencyStop]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsRequestEmergencyStop,
            requestOrganizationEmergencyStop(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }).pipe(
              Effect.tap(() =>
                stopAndVerifyOrganizationEmergencyScopes(
                  input.organizationId,
                  organizationScopeLaunchBrokerClient(config.baseDir),
                ).pipe(Effect.ignoreCause({ log: true })),
              ),
              Effect.flatMap(() => readOrganizationEmergencyStop(input.organizationId)),
              Effect.mapError((error) =>
                isOrganizationWorkError(error)
                  ? error
                  : new OrganizationWorkError({
                      code: "unavailable",
                      message: "Emergency stop status is unavailable.",
                    }),
              ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsGetEmergencyStopStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsGetEmergencyStopStatus,
            readOrganizationEmergencyStop(input.organizationId).pipe(
              Effect.mapError((error) =>
                isOrganizationWorkError(error)
                  ? error
                  : new OrganizationWorkError({
                      code: "unavailable",
                      message: "Emergency stop status is unavailable.",
                    }),
              ),
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsReviewWork]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsReviewWork,
            OrganizationWorkReviewStore.reviewOrganizationWorkForSession(
              currentSession,
              organizationWorkReviewStore,
              input,
            ),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsDecideWorkApproval]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsDecideWorkApproval,
            decideOrganizationWorkApprovalForSession(currentSession, input),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsProposalList]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsProposalList,
            organizationProposalStore.list(input),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsProposalDecide]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsProposalDecide,
            organizationProposalStore.decide(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsObservationModeGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsObservationModeGet,
            organizationProposalStore.getObservationMode(input.organizationId),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsObservationModeSet]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsObservationModeSet,
            organizationProposalStore.setObservationMode(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsDirectorList]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsDirectorList,
            organizationDirectorStore.list(input),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.organizationsDirectorAsk]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsDirectorAsk,
            organizationDirectorStore.ask(input, {
              subject: currentSession.subject,
              interactive: isInteractiveOrganizationSession(currentSession),
            }),
            { "rpc.aggregate": "organizations" },
          ),
        [WS_METHODS.agentDashboardGetSnapshot]: (_input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardGetSnapshot,
            Effect.gen(function* () {
              const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentDashboardError({
                      message: "Failed to load the Agent Dashboard project snapshot.",
                      cause,
                    }),
                ),
              );
              const activities = yield* (
                projectionSnapshotQuery.getRecentActivitySummaries?.(100) ?? Effect.succeed([])
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentDashboardError({
                      message: "Failed to load the Agent Dashboard activity feed.",
                      cause,
                    }),
                ),
              );

              const nativeSnapshot = yield* loadAgentDashboardSnapshot({
                shellSnapshot,
                activities,
                observedAt: yield* nowIso,
                readers: {
                  readStatus: (cwd) =>
                    vcsStatusBroadcaster.getStatus({ cwd }).pipe(
                      Effect.catch(() => gitWorkflow.localStatus({ cwd })),
                      Effect.mapError(
                        (cause) =>
                          new AgentDashboardSnapshotReadError({
                            operation: "readStatus",
                            message: "Failed to read VCS status for an Agent Dashboard project.",
                            cause,
                          }),
                      ),
                    ),
                  listRefs: (input) =>
                    gitWorkflow.listRefs(input).pipe(
                      Effect.mapError(
                        (cause) =>
                          new AgentDashboardSnapshotReadError({
                            operation: "listRefs",
                            message: "Failed to read VCS refs for an Agent Dashboard project.",
                            cause,
                          }),
                      ),
                    ),
                },
              });
              const migrated = yield* Effect.all({
                externalFeed: dashboardStore.readFeed,
                researchFindings: dashboardStore.readResearchFindings,
                reviewSuggestions: dashboardStore.readReviewSuggestions,
                findings: dashboardStore.readFindings,
                repositoryPolicies: dashboardStore.readRepositoryPolicies,
                repositoryCoverage: dashboardStore.readRepositoryCoverage,
                externalActions: dashboardStore.readExternalActions,
                collectorStates: dashboardStore.readCollectorStates,
              }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to read migrated Agent Dashboard records", {
                    cause,
                  }).pipe(
                    Effect.as({
                      externalFeed: [],
                      researchFindings: [],
                      reviewSuggestions: [],
                      findings: [],
                      repositoryPolicies: [],
                      repositoryCoverage: [],
                      externalActions: [],
                      collectorStates: [],
                    }),
                  ),
                ),
              );
              const policyByRepository = new Map(
                migrated.repositoryPolicies.map((policy) => [
                  String(policy.repository.projectId),
                  policy,
                ]),
              );
              const coverageByRepository = new Map(
                migrated.repositoryCoverage.map((coverage) => [
                  String(coverage.repository.projectId),
                  coverage,
                ]),
              );
              const repositoryPolicies = nativeSnapshot.repositories.map(
                (repository) =>
                  policyByRepository.get(String(repository.projectId)) ?? {
                    repository: { projectId: repository.projectId },
                    enabled: true,
                    enabledAutomations: [
                      "repository-review" as const,
                      "continuous-improvement" as const,
                      "pull-request-rollup" as const,
                      "inactive-worktree-cleanup" as const,
                    ],
                    disabledAutomations: [],
                    cadenceMinutes: AgentDashboardReviewRunner.REVIEW_INTERVAL_MINUTES,
                    priority: 0,
                    riskTier: "low" as const,
                    branch: repository.vcs.branch,
                    owner: null,
                    enabledChecks: ["repository-review"],
                    model: null,
                    budgetMinutes: null,
                    maxConcurrentRuns: 1,
                    exclusions: [],
                    updatedAt: nativeSnapshot.observedAt,
                  },
              );
              const repositoryCoverage = nativeSnapshot.repositories.map((repository) => {
                const stored = coverageByRepository.get(String(repository.projectId));
                if (stored) return stored;
                const isRepo = repository.vcs.isRepo && repository.vcs.availability === "available";
                return {
                  repository: { projectId: repository.projectId },
                  status: isRepo ? ("never" as const) : ("stale" as const),
                  lastAttemptedAt: null,
                  lastSucceededAt: null,
                  nextDueAt: null,
                  consecutiveFailures: 0,
                  lastError: isRepo ? null : "Repository VCS state is unavailable.",
                  lastRunId: null,
                  observedAt: nativeSnapshot.observedAt,
                };
              });
              const automationRuns = yield* AgentDashboardRunHistory.readPersistedRuns(
                config.stateDir,
              );
              const activeRuns = automationRuns.filter(
                (run) =>
                  run.status === "queued" || run.status === "running" || run.status === "ingesting",
              );
              const observedAtMs = Date.parse(nativeSnapshot.observedAt);
              const openFindings = migrated.findings.filter(
                (finding) =>
                  finding.disposition.state !== "dismissed" &&
                  finding.disposition.state !== "blocked" &&
                  finding.disposition.state !== "done" &&
                  !(
                    finding.disposition.state === "snoozed" &&
                    finding.disposition.snoozeUntil !== null &&
                    Date.parse(finding.disposition.snoozeUntil) > observedAtMs
                  ),
              );
              const attentionRepositories = new Set(
                repositoryCoverage
                  .filter((coverage) =>
                    ["due", "overdue", "stale", "failing"].includes(coverage.status),
                  )
                  .map((coverage) => String(coverage.repository.projectId)),
              );
              for (const finding of openFindings)
                attentionRepositories.add(String(finding.repository.projectId));
              const classifiedRepositories = nativeSnapshot.repositories.map((repository) => {
                const projectId = String(repository.projectId);
                const coverage = repositoryCoverage.find(
                  (item) => String(item.repository.projectId) === projectId,
                );
                if (attentionRepositories.has(projectId)) return "attention" as const;
                if (!coverage || coverage.lastSucceededAt === null || coverage.status === "never") {
                  return "unassessed" as const;
                }
                return "healthy" as const;
              });
              const lastRunAt =
                automationRuns
                  .map((run) => run.updatedAt)
                  .toSorted()
                  .at(-1) ?? null;
              const findingsSchedule = yield* AgentDashboardReviewScheduler.readPersistedStatus(
                config.stateDir,
              );
              return {
                ...nativeSnapshot,
                externalFeed: migrated.externalFeed,
                researchFindings: migrated.researchFindings,
                reviewSuggestions: migrated.reviewSuggestions,
                reviewSchedule: findingsSchedule,
                findingsSchedule,
                automationRuns,
                findings: migrated.findings,
                repositoryPolicies,
                repositoryCoverage,
                externalActions: migrated.externalActions,
                collectorStates: migrated.collectorStates,
                portfolioHealth: {
                  repositoryCount: nativeSnapshot.repositories.length,
                  healthyRepositoryCount: classifiedRepositories.filter(
                    (state) => state === "healthy",
                  ).length,
                  attentionRepositoryCount: classifiedRepositories.filter(
                    (state) => state === "attention",
                  ).length,
                  unassessedRepositoryCount: classifiedRepositories.filter(
                    (state) => state === "unassessed",
                  ).length,
                  staleRepositoryCount: repositoryCoverage.filter(
                    (coverage) => coverage.status === "stale",
                  ).length,
                  openFindingCount: openFindings.length,
                  criticalFindingCount: openFindings.filter(
                    (finding) => finding.severity === "critical",
                  ).length,
                  activeRunCount: activeRuns.length,
                  lastRunAt,
                  observedAt: nativeSnapshot.observedAt,
                },
              };
            }),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardDismissFeedCard]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardDismissFeedCard,
            dashboardStore.dismissFeedCard(input.id).pipe(
              Effect.map((changed) =>
                changed
                  ? appliedMutation(String(input.id))
                  : {
                      ok: false as const,
                      outcome: "not-found" as const,
                      message: "Feed card not found.",
                      targetId: String(input.id),
                      targetUrl: null,
                    },
              ),
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to dismiss the Agent Dashboard feed card.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardClearFeed]: (_input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardClearFeed,
            dashboardStore.clearFeed.pipe(
              Effect.map(() => appliedMutation()),
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to clear the Agent Dashboard feed.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardReviewSuggestion]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardReviewSuggestion,
            dashboardStore.reviewSuggestion(input.id, input.action).pipe(
              Effect.map((changed) =>
                changed
                  ? appliedMutation(input.id)
                  : {
                      ok: false as const,
                      outcome: "not-found" as const,
                      message: "Review suggestion not found.",
                      targetId: input.id,
                      targetUrl: null,
                    },
              ),
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to update the Agent Dashboard review suggestion.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardRunInvestigation]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardRunInvestigation,
            runAgentDashboardInvestigation(input.projectId).pipe(
              Effect.map(() => appliedMutation()),
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to start the Agent Dashboard repository investigation.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardRetryRun]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardRetryRun,
            Effect.gen(function* () {
              const existing = (yield* AgentDashboardRunHistory.readPersistedRuns(
                config.stateDir,
              )).find((run) => run.id === input.id);
              const retried =
                existing?.kind ===
                AgentDashboardContinuousImprovement.CONTINUOUS_IMPROVEMENT_RUN_KIND
                  ? Option.isSome(continuousImprovement)
                    ? yield* continuousImprovement.value.retryRun(input.id)
                    : yield* new AgentDashboardError({
                        message: "Continuous Improvement retry is unavailable.",
                      })
                  : yield* reviewJobService.retryRun(input.id);
              if (retried === null) {
                return {
                  ok: false as const,
                  outcome: "noop" as const,
                  message: "The finding was claimed before the retry could start.",
                  targetId: input.id,
                  targetUrl: null,
                };
              }
              const retriedId = "id" in retried ? retried.id : String(retried.threadId);
              const retryCount = "retryCount" in retried ? retried.retryCount : null;
              const occurredAt =
                "createdAt" in retried
                  ? retried.createdAt
                  : DateTime.formatIso(yield* DateTime.now);
              yield* dashboardStore
                .appendExternalAction({
                  id: `action:retry-run:${retriedId}`,
                  kind: "run-investigation",
                  status: "succeeded",
                  actor: "dashboard",
                  targetId: retriedId,
                  targetUrl: null,
                  findingId: null,
                  runId: retriedId,
                  result: retryCount === null ? "implementation-retry" : `retry-${retryCount}`,
                  occurredAt,
                })
                .pipe(Effect.orElseSucceed(() => undefined));
              return appliedMutation(retriedId);
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to retry the Agent Dashboard automation run.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardCreateGithubIssue]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardCreateGithubIssue,
            Effect.gen(function* () {
              const canonical = (yield* dashboardStore.readFindings).find(
                (finding) =>
                  finding.id === input.id ||
                  finding.id === input.id.replace(/^t3-review-/, "finding:"),
              );
              const legacy = canonical
                ? null
                : (yield* dashboardStore.readReviewSuggestions).find(
                    (suggestion) =>
                      suggestion.id === input.id ||
                      suggestion.id === input.id.replace(/^finding:/, "t3-review-"),
                  );
              const project = canonical
                ? yield* projectionSnapshotQuery.getProjectShellById(canonical.repository.projectId)
                : legacy
                  ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
                      legacy.repository.path,
                    )
                  : Option.none();
              const githubRepository = Option.isSome(project)
                ? parseGitHubRepositoryNameWithOwnerFromRemoteUrl(
                    project.value.repositoryIdentity?.locator.remoteUrl ?? null,
                  )
                : null;
              let githubEnvironment: NodeJS.ProcessEnv | undefined;
              if (Option.isSome(project) && project.value.githubAccountId) {
                const account = yield* serverSettings.getGitHubAccountEnvironment(
                  project.value.githubAccountId,
                );
                if (!account.environment) {
                  return yield* new AgentDashboardError({
                    message: "The selected GitHub account is not configured with a PAT.",
                  });
                }
                githubEnvironment = account.environment;
              }
              return yield* dashboardStore.createGithubIssue(
                input.id,
                githubRepository,
                githubEnvironment,
              );
            }).pipe(
              Effect.map((changed) =>
                changed
                  ? appliedMutation(input.id)
                  : {
                      ok: false as const,
                      outcome: "not-found" as const,
                      message: "Finding not found.",
                      targetId: input.id,
                      targetUrl: null,
                    },
              ),
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to create the GitHub issue for this finding.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardListProjectPullRequests]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardListProjectPullRequests,
            Effect.gen(function* () {
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(input.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AgentDashboardError({
                        message: "Failed to load the project for pull request discovery.",
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AgentDashboardError({ message: "Project not found." });
              }
              const repository = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(
                project.value.repositoryIdentity?.locator.remoteUrl ?? null,
              );
              if (!repository) {
                return yield* new AgentDashboardError({
                  message: "This project does not have a GitHub remote configured.",
                });
              }
              const pullRequests = yield* sourceControlRepositories.listProjectPullRequests({
                cwd: project.value.workspaceRoot,
                repository,
                ...(project.value.githubAccountId
                  ? { githubAccountId: project.value.githubAccountId }
                  : {}),
                limit: 50,
              });
              return {
                projectId: input.projectId,
                provider: "github" as const,
                repository,
                pullRequests,
              };
            }),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardMergeProjectPullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardMergeProjectPullRequest,
            Effect.gen(function* () {
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(input.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AgentDashboardError({
                        message: "Failed to load the project for pull request merge.",
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AgentDashboardError({ message: "Project not found." });
              }
              const repository = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(
                project.value.repositoryIdentity?.locator.remoteUrl ?? null,
              );
              if (!repository) {
                return yield* new AgentDashboardError({
                  message: "This project does not have a GitHub remote configured.",
                });
              }
              yield* sourceControlRepositories.mergeProjectPullRequest({
                cwd: project.value.workspaceRoot,
                repository,
                ...(project.value.githubAccountId
                  ? { githubAccountId: project.value.githubAccountId }
                  : {}),
                number: input.number,
                expectedHeadOid: input.expectedHeadOid,
                method: input.method,
              });
              const occurredAt = DateTime.formatIso(yield* DateTime.now);
              yield* dashboardStore
                .appendExternalAction({
                  id: `action:merge-pr:${input.projectId}:${input.number}:${occurredAt}`,
                  kind: "merge-pull-request",
                  status: "succeeded",
                  actor: "dashboard",
                  targetId: `pr:${repository}:${input.number}`,
                  targetUrl: `https://github.com/${repository}/pull/${input.number}`,
                  findingId: null,
                  runId: null,
                  result: `merge-submitted:${input.method}`,
                  occurredAt,
                })
                .pipe(Effect.orElseSucceed(() => undefined));
              return {
                projectId: input.projectId,
                number: input.number,
                method: input.method,
                submitted: true,
              };
            }),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardApplyFindingAction]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardApplyFindingAction,
            dashboardStore.applyFindingAction(input).pipe(
              Effect.map((outcome) =>
                outcome === "not-found"
                  ? {
                      ok: false as const,
                      outcome: "not-found" as const,
                      message: "Finding not found.",
                      targetId: input.id,
                      targetUrl: null,
                    }
                  : {
                      ok: true as const,
                      outcome,
                      message: outcome === "noop" ? "Finding was already in that state." : null,
                      targetId: input.id,
                      targetUrl: null,
                    },
              ),
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to update the Agent Dashboard finding.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardLinkFindingThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardLinkFindingThread,
            dashboardStore.linkFindingThread(input).pipe(
              Effect.map((outcome) =>
                outcome === "not-found"
                  ? {
                      ok: false as const,
                      outcome: "not-found" as const,
                      message: "Finding not found.",
                      targetId: input.id,
                      targetUrl: null,
                    }
                  : {
                      ok: true as const,
                      outcome,
                      message:
                        outcome === "noop" ? "Finding is already linked to that chat." : null,
                      targetId: input.id,
                      targetUrl: null,
                    },
              ),
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to link the Agent Dashboard finding to its chat.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardUpdateRepositoryPolicy]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardUpdateRepositoryPolicy,
            Effect.gen(function* () {
              const policies = yield* dashboardStore.readRepositoryPolicies;
              const existing = policies.find(
                (policy) =>
                  String(policy.repository.projectId) === String(input.repository.projectId),
              );
              yield* dashboardStore.writeRepositoryPolicy(
                AgentDashboardStore.mergeRepositoryPolicyInput(input, existing),
              );
              return appliedMutation(String(input.repository.projectId));
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to save the repository dashboard policy.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardCollect]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardCollect,
            Effect.gen(function* () {
              const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentDashboardError({
                      message: "Failed to load repositories for collection.",
                      cause,
                    }),
                ),
              );
              const collected = yield* Effect.tryPromise({
                try: () =>
                  AgentDashboardCollectors.collectAgentDashboardData({
                    stateDir: config.stateDir,
                    projects: shellSnapshot.projects,
                    kind: input.kind,
                    ...(input.projectId ? { projectId: input.projectId } : {}),
                  }),
                catch: (cause) =>
                  new AgentDashboardError({
                    message: "The Agent Dashboard collector failed.",
                    cause,
                  }),
              });
              const findingCount = yield* dashboardStore.appendFindings(collected.findings);
              yield* Effect.forEach(
                collected.states,
                (state) => dashboardStore.writeCollectorState(state),
                {
                  concurrency: 1,
                  discard: true,
                },
              );
              if (input.kind === "all") {
                yield* runAgentDashboardInvestigation(input.projectId);
              }
              return {
                ok: true as const,
                outcome:
                  findingCount > 0 || collected.states.length > 0
                    ? ("applied" as const)
                    : ("noop" as const),
                message:
                  input.kind === "all"
                    ? `Portfolio collection stored ${findingCount} local finding${findingCount === 1 ? "" : "s"} and started a deep review.`
                    : `Collection completed with ${findingCount} finding${findingCount === 1 ? "" : "s"}.`,
                targetId: input.projectId ? String(input.projectId) : null,
                targetUrl: null,
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to persist Agent Dashboard collector results.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
        [WS_METHODS.agentDashboardAddResearchWatchItem]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentDashboardAddResearchWatchItem,
            dashboardStore.upsertResearchWatchItem(input).pipe(
              Effect.map((changed) => ({
                ok: true as const,
                outcome: changed ? ("applied" as const) : ("noop" as const),
                message: changed
                  ? "Research source saved."
                  : "That research source is already configured.",
                targetId: String(input.projectId),
                targetUrl: null,
              })),
              Effect.mapError(
                (cause) =>
                  new AgentDashboardError({
                    message: "Failed to save the research source.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "agent-dashboard" },
          ),
      });
    }),
  );

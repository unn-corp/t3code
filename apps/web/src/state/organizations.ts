import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";

/** Organizations belong to an environment and can exist without a Project. */
export const organizationEnvironment = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:list",
    tag: WS_METHODS.organizationsList,
    staleTimeMs: 5_000,
  }),
  get: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:get",
    tag: WS_METHODS.organizationsGet,
    staleTimeMs: 5_000,
  }),
  getPublishedConfig: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:published-config",
    tag: WS_METHODS.organizationsGetPublishedConfig,
    staleTimeMs: 5_000,
  }),
  listAudit: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:audit",
    tag: WS_METHODS.organizationsListAudit,
    staleTimeMs: 5_000,
  }),
  readProviderBudgets: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:provider-budgets",
    tag: WS_METHODS.organizationsReadProviderBudgets,
    staleTimeMs: 5_000,
  }),
  getProviderBudget: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:provider-budget",
    tag: WS_METHODS.organizationsGetProviderBudget,
    staleTimeMs: 5_000,
  }),
  updateProviderBudget: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:provider-budget-update",
    tag: WS_METHODS.organizationsUpdateProviderBudget,
  }),
  repositoryPreview: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:repository-preview",
    tag: WS_METHODS.organizationsRepositoryPreview,
    staleTimeMs: 5_000,
  }),
  repositoryStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:repository-status",
    tag: WS_METHODS.organizationsRepositoryStatus,
    staleTimeMs: 5_000,
  }),
  repositoryListRecords: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:repository-records",
    tag: WS_METHODS.organizationsRepositoryListRecords,
    staleTimeMs: 5_000,
  }),
  repositoryLink: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:repository-link",
    tag: WS_METHODS.organizationsRepositoryLink,
  }),
  repositoryLoad: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:repository-load",
    tag: WS_METHODS.organizationsRepositoryLoad,
  }),
  repositorySync: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:repository-sync",
    tag: WS_METHODS.organizationsRepositorySync,
  }),
  repositoryResolveConflict: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:repository-resolve-conflict",
    tag: WS_METHODS.organizationsRepositoryResolveConflict,
  }),
  listSources: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:sources",
    tag: WS_METHODS.organizationsListSources,
    staleTimeMs: 5_000,
  }),
  listObservations: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:observations",
    tag: WS_METHODS.organizationsListObservations,
    staleTimeMs: 5_000,
  }),
  listCorrelationJobs: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:correlation-jobs",
    tag: WS_METHODS.organizationsListCorrelationJobs,
    staleTimeMs: 5_000,
  }),
  listFindings: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:findings",
    tag: WS_METHODS.organizationsListFindings,
    staleTimeMs: 5_000,
  }),
  listIntakeAudit: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:intake-audit",
    tag: WS_METHODS.organizationsListIntakeAudit,
    staleTimeMs: 5_000,
  }),
  listWork: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:work",
    tag: WS_METHODS.organizationsListWork,
    staleTimeMs: 5_000,
  }),
  listWorkIntents: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:work-intents",
    tag: WS_METHODS.organizationsListWorkIntents,
    staleTimeMs: 5_000,
  }),
  listWorkFailures: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:work-failures",
    tag: WS_METHODS.organizationsListWorkFailures,
    staleTimeMs: 5_000,
  }),
  getWorkRuntimeStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:work-runtime-status",
    tag: WS_METHODS.organizationsGetWorkRuntimeStatus,
    staleTimeMs: 5_000,
  }),
  activateWorkIntent: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:work-intent-activate",
    tag: WS_METHODS.organizationsActivateWorkIntent,
  }),
  cancelWork: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:work-cancel",
    tag: WS_METHODS.organizationsCancelWork,
  }),
  requestWorkDrain: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:work-drain",
    tag: WS_METHODS.organizationsRequestWorkDrain,
  }),
  getWorkDrainStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:work-drain-status",
    tag: WS_METHODS.organizationsGetWorkDrainStatus,
    staleTimeMs: 5_000,
  }),
  requestEmergencyStop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:work-emergency-stop",
    tag: WS_METHODS.organizationsRequestEmergencyStop,
  }),
  getEmergencyStopStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:work-emergency-stop-status",
    tag: WS_METHODS.organizationsGetEmergencyStopStatus,
    staleTimeMs: 5_000,
  }),
  createStandingWorkAuthorization: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:standing-work-create",
    tag: WS_METHODS.organizationsCreateStandingWorkAuthorization,
  }),
  listStandingWorkAuthorizations: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:standing-work-list",
    tag: WS_METHODS.organizationsListStandingWorkAuthorizations,
    staleTimeMs: 5_000,
  }),
  revokeStandingWorkAuthorization: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:standing-work-revoke",
    tag: WS_METHODS.organizationsRevokeStandingWorkAuthorization,
  }),
  reviewWork: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:work-review",
    tag: WS_METHODS.organizationsReviewWork,
    staleTimeMs: 5_000,
  }),
  decideWorkApproval: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:work-approval",
    tag: WS_METHODS.organizationsDecideWorkApproval,
  }),
  proposalList: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:proposals",
    tag: WS_METHODS.organizationsProposalList,
    staleTimeMs: 5_000,
  }),
  proposalDecide: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:proposal-decide",
    tag: WS_METHODS.organizationsProposalDecide,
  }),
  observationModeGet: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:observation-mode",
    tag: WS_METHODS.organizationsObservationModeGet,
    staleTimeMs: 5_000,
  }),
  observationModeSet: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:observation-mode-set",
    tag: WS_METHODS.organizationsObservationModeSet,
  }),
  directorList: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:director-transcript",
    tag: WS_METHODS.organizationsDirectorList,
    staleTimeMs: 5_000,
  }),
  directorAsk: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:director-ask",
    tag: WS_METHODS.organizationsDirectorAsk,
  }),
  architectList: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:architect-transcript",
    tag: WS_METHODS.organizationsArchitectList,
    staleTimeMs: 5_000,
  }),
  architectSend: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:architect-send",
    tag: WS_METHODS.organizationsArchitectSend,
  }),
  architectApplyBatch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:architect-apply-batch",
    tag: WS_METHODS.organizationsArchitectApplyBatch,
  }),
  memoryList: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:memory-list",
    tag: WS_METHODS.organizationsMemoryList,
    staleTimeMs: 5_000,
  }),
  memoryHistory: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:organizations:memory-history",
    tag: WS_METHODS.organizationsMemoryHistory,
    staleTimeMs: 5_000,
  }),
  memoryCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:memory-create",
    tag: WS_METHODS.organizationsMemoryCreate,
  }),
  memoryCorrect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:memory-correct",
    tag: WS_METHODS.organizationsMemoryCorrect,
  }),
  memorySupersede: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:memory-supersede",
    tag: WS_METHODS.organizationsMemorySupersede,
  }),
  memoryArchive: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:memory-archive",
    tag: WS_METHODS.organizationsMemoryArchive,
  }),
  registerSource: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:register-source",
    tag: WS_METHODS.organizationsRegisterSource,
  }),
  rotateSourceSecret: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:rotate-source-secret",
    tag: WS_METHODS.organizationsRotateSourceSecret,
  }),
  setSourceEnabled: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:set-source-enabled",
    tag: WS_METHODS.organizationsSetSourceEnabled,
  }),
  ingestManual: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:ingest-manual",
    tag: WS_METHODS.organizationsIngestManual,
  }),
  retryCorrelation: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:retry-correlation",
    tag: WS_METHODS.organizationsRetryCorrelation,
  }),
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:create",
    tag: WS_METHODS.organizationsCreate,
  }),
  mutate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:mutate",
    tag: WS_METHODS.organizationsMutate,
  }),
  bindProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:bind-project",
    tag: WS_METHODS.organizationsBindProject,
  }),
  detachProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:detach-project",
    tag: WS_METHODS.organizationsDetachProject,
  }),
  publish: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:publish",
    tag: WS_METHODS.organizationsPublish,
  }),
  setLifecycle: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:organizations:set-lifecycle",
    tag: WS_METHODS.organizationsSetLifecycle,
  }),
};

export function useOrganizations() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : organizationEnvironment.list({ environmentId, input: {} }),
  );
  return { environmentId, ...query };
}

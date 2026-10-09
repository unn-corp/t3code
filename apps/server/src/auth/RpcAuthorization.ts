import {
  CLIENT_GUARDED_RPC_SCOPES,
  type DeviceListInput,
  clientRpcRequiredScopes,
  authScopeRequiredResponse,
  AssetCreateUrlInput,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  ServerSettingsPatch,
  ProviderInstanceMutation,
  requiredScopesForServerSettingsPatch,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ForkMaintenanceError, type ForkMaintenanceActionInput } from "@t3tools/contracts";
import { assertAdmitting, MaintenanceWorkHeld, withWork } from "../maintenance/WorkAdmission.ts";
import * as Layer from "effect/Layer";
import type * as RpcGroup from "effect/rpc/RpcGroup";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

const FORK_RPC_REQUIRED_SCOPES = {
  [WS_METHODS.organizationsList]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsGet]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsGetPublishedConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsListAudit]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsReadProviderBudgets]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsGetProviderBudget]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsUpdateProviderBudget]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsRepositoryPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsRepositoryStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsRepositoryListRecords]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsRepositoryLink]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsRepositoryLoad]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsRepositorySync]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsRepositoryResolveConflict]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsListSources]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsListObservations]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsListCorrelationJobs]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsListFindings]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsListIntakeAudit]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsListWork]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsListWorkIntents]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsListWorkFailures]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsGetWorkRuntimeStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsActivateWorkIntent]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsCancelWork]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsRequestWorkDrain]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsGetWorkDrainStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsRequestEmergencyStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsGetEmergencyStopStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsCreateStandingWorkAuthorization]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsListStandingWorkAuthorizations]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsRevokeStandingWorkAuthorization]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsReviewWork]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsDecideWorkApproval]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsArchitectList]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsArchitectSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsArchitectApplyBatch]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsMemoryList]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsMemoryHistory]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsMemoryCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsMemoryCorrect]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsMemorySupersede]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsMemoryArchive]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsProposalList]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsProposalDecide]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsObservationModeGet]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsObservationModeSet]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsDirectorList]: AuthOrchestrationReadScope,
  [WS_METHODS.organizationsDirectorAsk]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsRegisterSource]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsRotateSourceSecret]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsSetSourceEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsIngestManual]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsRetryCorrelation]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsBindProject]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsDetachProject]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsPublish]: AuthOrchestrationOperateScope,
  [WS_METHODS.organizationsSetLifecycle]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardGetSnapshot]: AuthOrchestrationReadScope,
  [WS_METHODS.agentDashboardDismissFeedCard]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardClearFeed]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardReviewSuggestion]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardRunInvestigation]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardRetryRun]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardCreateGithubIssue]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardApplyFindingAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardLinkFindingThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardUpdateRepositoryPolicy]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardCollect]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardAddResearchWatchItem]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentDashboardListProjectPullRequests]: AuthOrchestrationReadScope,
  [WS_METHODS.agentDashboardMergeProjectPullRequest]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getMessageReplyChain]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateProvider]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerAuthStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerConsumeResetCredit]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerAuthComplete]: AuthOrchestrationOperateScope,
  [WS_METHODS.chatGptReconnectProfile]: AuthOrchestrationOperateScope,
  [WS_METHODS.chatGptImportProfile]: AuthOrchestrationOperateScope,
  [WS_METHODS.chatGptHandoffSubscribe]: AuthOrchestrationOperateScope,
  [WS_METHODS.codexAuthCallbackSubscribe]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerAuthRespond]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerAuthCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerAuthLogout]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerAuthSubscribe]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerInstallStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerInstallCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerInstallSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.providerInstallRemove]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateServer]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverCommitDesktopUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetMaintenanceStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateMaintenancePolicy]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunMaintenanceAction]: AuthOrchestrationOperateScope,
  // Restoring older data is destructive device administration, not ordinary operation.
  [WS_METHODS.serverRecoverMaintenance]: AuthAccessWriteScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverSearchAcpRegistry]: AuthOrchestrationReadScope,
  [WS_METHODS.serverPrepareAcpRegistryAgent]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListAcpRegistrySessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverImportAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListAcpRegistryProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSetAcpRegistryProvider]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDisableAcpRegistryProvider]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverLogoutAcpRegistry]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetHostResources]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetUsageSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshUsageRates]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSignalProcess]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportHostPowerState]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetBackgroundPolicy]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksList]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRouting]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRoutingIdentity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsStack]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilesViewed]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  // Read scope like the reads it un-caches: refreshing is part of reading, and a read-only
  // client pressing refresh must not be told it may not look again.
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeRefreshes]: AuthOrchestrationReadScope,
  // The candidate list is a read like the detail beside it; asking somebody for a review is a
  // write like every other one.
  [WS_METHODS.pullRequestsReviewerCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsLabelCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.subscribeProjectClones]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsReadFile]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsSearchContents]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsWriteFile]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateNew]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthOrchestrationReadScope,
  [WS_METHODS.threadExport]: AuthOrchestrationReadScope,
  [WS_METHODS.codexSessionsList]: AuthOrchestrationReadScope,
  [WS_METHODS.codexSessionsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentSessionsScan]: AuthOrchestrationReadScope,
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsPersistChatAttachments]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerUploadFeedback]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeWorktreeSetup]: AuthOrchestrationReadScope,
  [WS_METHODS.worktreeSetupCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsWorktreeStorageUsage]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalOperateScope,
  [WS_METHODS.previewOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewNavigate]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewResize]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewRefresh]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewReportStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAttach]: AuthOrchestrationReadScope,
  // Publishing frames and driving input both act on the page, so they sit with
  // the operate scope rather than read.
  [WS_METHODS.previewPublishFrame]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewInput]: AuthOrchestrationOperateScope,
  // Reads page content through a rendering host, so it carries the same
  // authority as driving that page rather than a read of server state.
  [WS_METHODS.previewPickElement]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationConnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationRespond]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationFocusHost]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceConfigure]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceTestHost]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceList]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceShutdown]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeDeviceState]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
  [WS_METHODS.subscribeBackgroundPolicy]: AuthOrchestrationReadScope,
} as const satisfies Partial<Record<WsRpcMethod, AuthEnvironmentScope>>;

/**
 * Keep authorization coverage coupled to the RPC group itself. Adding an RPC to
 * `WsRpcGroup` without choosing a scope is a type error instead of a production
 * runtime failure.
 */
export const RPC_REQUIRED_SCOPES = {
  ...CLIENT_GUARDED_RPC_SCOPES,
  ...FORK_RPC_REQUIRED_SCOPES,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getMessageReplyChain]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateProvider]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.providerConsumeResetCredit]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.chatGptReconnectProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptImportProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptHandoffSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.codexAuthCallbackSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRespond]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthLogout]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallStart]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.providerInstallRemove]: AuthProvidersManageScope,
  [WS_METHODS.serverUpdateServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCommitDesktopUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverGetMaintenanceStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateMaintenancePolicy]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunMaintenanceAction]: AuthOrchestrationOperateScope,
  // Recovery restores older data and therefore requires explicit device administration.
  [WS_METHODS.serverRecoverMaintenance]: AuthAccessWriteScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.serverSearchAcpRegistry]: AuthOrchestrationReadScope,
  [WS_METHODS.serverPrepareAcpRegistryAgent]: AuthProvidersManageScope,
  [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: AuthProvidersManageScope,
  [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: AuthProvidersManageScope,
  [WS_METHODS.serverListAcpRegistrySessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverImportAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListAcpRegistryProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSetAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverDisableAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverLogoutAcpRegistry]: AuthProvidersManageScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthDiagnosticsReadScope,
  // Load-balancing new threads reads host load; that is part of operating
  // threads, not of inspecting diagnostics.
  [WS_METHODS.serverGetHostResources]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetUsageSummary]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRefreshUsageRates]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverSignalProcess]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportHostPowerState]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverGetBackgroundPolicy]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksList]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  // Delivery logs hold request bodies, so they need the same scope as the URL.
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRouting]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRoutingIdentity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsStack]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilesViewed]: AuthOrchestrationReadScope,
  // Read scope like the reads it un-caches: refreshing is part of reading, and a read-only
  // client pressing refresh must not be told it may not look again.
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeRefreshes]: AuthOrchestrationReadScope,
  // The candidate list is a read like the detail beside it; asking somebody for a review is a
  // write like every other one.
  [WS_METHODS.pullRequestsReviewerCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLabelCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeProjectClones]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchContents]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsWriteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateNew]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthFilesystemReadScope,
  [WS_METHODS.agentSessionsScan]: AuthOrchestrationReadScope,
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsPersistChatAttachments]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerUploadFeedback]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeWorktreeSetup]: AuthOrchestrationReadScope,
  [WS_METHODS.worktreeSetupCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthFilesystemReadScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalObserve]: AuthTerminalReadScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalReadScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalReadScope,
  [WS_METHODS.previewOpen]: AuthPreviewOperateScope,
  [WS_METHODS.previewNavigate]: AuthPreviewOperateScope,
  [WS_METHODS.previewResize]: AuthPreviewOperateScope,
  [WS_METHODS.previewAdjust]: AuthPreviewOperateScope,
  [WS_METHODS.previewRefresh]: AuthPreviewOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewClearProfile]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportStatus]: AuthPreviewOperateScope,
  [WS_METHODS.previewAttach]: AuthOrchestrationReadScope,
  [WS_METHODS.previewPublishFrame]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewInput]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewPickElement]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationConnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationRespond]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationFocusHost]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.deviceTestHost]: AuthSettingsWriteScope,
  [WS_METHODS.deviceList]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceShutdown]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeDeviceState]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
  [WS_METHODS.subscribeBackgroundPolicy]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>;

export function requiredScopeForRpcMethod(method: string): AuthEnvironmentScope {
  if (!Object.hasOwn(RPC_REQUIRED_SCOPES, method)) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  const requiredScope = RPC_REQUIRED_SCOPES[method as WsRpcMethod];
  if (requiredScope === undefined) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  return requiredScope;
}

export const rpcAuthorizationError = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    ...authScopeRequiredResponse(requiredScope),
  });

/** Actions that lift a safety hold are administration (`access:write`); check, install and cancel are ordinary operation. */
export const maintenanceActionNeedsAdministration = (input: ForkMaintenanceActionInput): boolean =>
  input.action === "confirm-bootstrap" || input.action === "acknowledge-automation-review";

const READ_SCOPES: ReadonlySet<AuthEnvironmentScope> = new Set([
  AuthOrchestrationReadScope,
  AuthAccessReadScope,
  AuthFilesystemReadScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
  AuthRelayReadScope,
  AuthFilesystemReadScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
]);

/**
 * Methods that must keep working while a transaction holds the fence, because they are how the
 * transaction is observed, advanced, or recovered. Everything else with a non-read scope writes
 * outside the coordinator's view (settings, files, terminals, uploads, git, schedules) and is held.
 */
const MAINTENANCE_EXEMPT_METHODS: ReadonlySet<string> = new Set([
  WS_METHODS.serverGetMaintenanceStatus,
  WS_METHODS.serverUpdateMaintenancePolicy,
  WS_METHODS.serverRunMaintenanceAction,
  WS_METHODS.serverRecoverMaintenance,
  WS_METHODS.serverUpdateServer,
  WS_METHODS.serverUpdateServerWithProgress,
  WS_METHODS.serverCommitDesktopUpdate,
]);

/** Operate-scoped state observers and host registrations whose lifetime is the RPC stream. */
const NON_LEASED_OPERATE_SUBSCRIPTIONS: ReadonlySet<string> = new Set([
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeTerminalMetadata,
  WS_METHODS.previewAutomationConnect,
  WS_METHODS.providerAuthSubscribe,
]);
const isMaintenanceWorkHeld = Schema.is(MaintenanceWorkHeld);

/** Whether a method writes outside the orchestrator and so needs device admission. Derived from the scope table, so new methods are covered by default. */
export const rpcMethodNeedsWorkAdmission = (method: string): boolean =>
  !READ_SCOPES.has(requiredScopeForRpcMethod(method)) &&
  !MAINTENANCE_EXEMPT_METHODS.has(method) &&
  !NON_LEASED_OPERATE_SUBSCRIPTIONS.has(method);

/** Applies the method's work lease decision to RPC groups outside the main server middleware. */
export const withRpcWorkAdmission = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ForkMaintenanceError, R> => {
  const maintenanceError = <A2, E2, R2>(
    admitted: Effect.Effect<A2, E2 | MaintenanceWorkHeld, R2>,
  ): Effect.Effect<A2, E2 | ForkMaintenanceError, R2> =>
    Effect.mapError(admitted, (error) =>
      isMaintenanceWorkHeld(error) ? new ForkMaintenanceError({ reason: error.message }) : error,
    );
  if (NON_LEASED_OPERATE_SUBSCRIPTIONS.has(method))
    return maintenanceError(assertAdmitting.pipe(Effect.andThen(effect)));
  return rpcMethodNeedsWorkAdmission(method) ? maintenanceError(withWork(effect)) : effect;
};

/**
 * Authorizes every RPC on one connection against that connection's session scopes. Mutations and
 * active flows hold leases for their full operation; passive long-lived observers only check that
 * admission is open when they attach.
 */
export const rpcScopeAuthorizationLayer = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.succeed(RpcScopeAuthorization)((effect, { rpc }) => {
    const requiredScope = requiredScopeForRpcMethod(rpc._tag);
    if (!scopes.includes(requiredScope)) return Effect.fail(rpcAuthorizationError(requiredScope));
    return withRpcWorkAdmission(rpc._tag, effect);
  });

const SettingsUpdate = Schema.Struct({
  patch: ServerSettingsPatch,
  providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
});

const requiredScopesForSettingsUpdate = (payload: unknown) => {
  const input = Schema.decodeUnknownSync(SettingsUpdate)(payload);
  const scopes = requiredScopesForServerSettingsPatch(input.patch);
  if (input.providerInstanceMutation === undefined) return scopes;
  // An atomic provider mutation carries an empty patch unless it also changes settings.
  return Object.values(input.patch).every((value) => value === undefined)
    ? [AuthProvidersManageScope]
    : [...new Set([...scopes, AuthProvidersManageScope])];
};

const requiredScopesForRpcCall = (
  method: string,
  payload: unknown,
): ReadonlyArray<AuthEnvironmentScope> => {
  if (method === WS_METHODS.serverRetryResourceTelemetry) {
    return [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope];
  }
  if (method === WS_METHODS.assetsCreateUrl) {
    const { resource } = Schema.decodeUnknownSync(AssetCreateUrlInput)(payload);
    return [
      resource._tag === "workspace-file" ||
      resource._tag === "media-file" ||
      resource._tag === "draft-workspace-file"
        ? AuthFilesystemReadScope
        : AuthOrchestrationReadScope,
    ];
  }
  if (method === WS_METHODS.serverUpdateSettings) return requiredScopesForSettingsUpdate(payload);
  const guarded = clientRpcRequiredScopes(method, payload);
  if (guarded.length > 0) return guarded;
  return [requiredScopeForRpcMethod(method)];
};

/** Authorizes every RPC on one connection against that connection's session scopes. */
export const layer = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.succeed(RpcScopeAuthorization)((effect, { rpc, payload }) => {
    const requiredScopes = requiredScopesForRpcCall(rpc._tag, payload);
    const requiredScope = requiredScopes.find((scope) => !scopes.includes(scope));
    if (requiredScope !== undefined) return Effect.fail(rpcAuthorizationError(requiredScope));
    return withRpcWorkAdmission(rpc._tag, effect);
  });

/** Retrying can install or restart tools even though ordinary listing is readable. */
export const requiredScopeForDeviceList = (input: DeviceListInput): AuthEnvironmentScope =>
  input.retryHostId || input.updateTool
    ? AuthOrchestrationOperateScope
    : AuthOrchestrationReadScope;

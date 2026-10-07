import { ThreadExportInput, ThreadExportResult, ThreadExportError } from "./threadExport.ts";
import { OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";
import {
  ChatGptReconnectProfileInput,
  ChatGptReconnectProfile,
  ChatGptImportProfileInput,
  ChatGptHandoffInput,
  ChatGptHandoffState,
} from "./providerSetup.ts";
import {
  ForkMaintenanceActionInput,
  ForkMaintenanceError,
  ForkRecoveryRequest,
  ForkUpdatePolicyPatch,
  ForkUpdateStatus,
} from "./maintenance.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CodexAuthCallbackInput,
  CodexAuthCallbackState,
  ProviderAuthCancelInput,
  ProviderAuthCompleteInput,
  ProviderAuthState,
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderInstallCancelInput,
  ProviderInstallState,
  ProviderSetupError,
  ProviderSetupInput,
} from "./providerSetup.ts";

import {
  AcpRegistryAcceptUrlAuthInput,
  AcpRegistryAcceptUrlAuthResult,
  AcpRegistryDeleteSessionInput,
  AcpRegistryDeleteSessionResult,
  AcpRegistryDisableProviderInput,
  AcpRegistryDisableProviderResult,
  AcpRegistryImportSessionInput,
  AcpRegistryImportSessionResult,
  AcpRegistryListSessionsInput,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersInput,
  AcpRegistryListProvidersResult,
  AcpRegistryLogoutInput,
  AcpRegistryLogoutResult,
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  AcpRegistryOperationError,
  AcpRegistryPrepareInput,
  AcpRegistryPrepareResult,
  AcpRegistrySearchInput,
  AcpRegistrySearchResult,
  AcpRegistrySetProviderInput,
  AcpRegistrySetProviderResult,
} from "./acpRegistry.ts";
import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AgentDashboardError,
  AgentDashboardCollectInput,
  AgentDashboardFeedCardIdInput,
  AgentDashboardGetSnapshotInput,
  AgentDashboardMutationResult,
  AgentDashboardFindingActionInput,
  AgentDashboardLinkFindingThreadInput,
  AgentDashboardRepositoryPolicyInput,
  AgentDashboardResearchWatchItemInput,
  AgentDashboardRetryRunInput,
  AgentDashboardReviewSuggestionIdInput,
  AgentDashboardReviewSuggestionActionInput,
  AgentDashboardRunInvestigationInput,
  AgentDashboardSnapshot,
} from "./agentDashboard.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  CodexSessionsListInput,
  CodexSessionsListResult,
  CodexSessionsResumeInput,
  NativeSessionResumeError,
  CodexSessionsResumeResult,
} from "./codexSessions.ts";
import {
  AgentSessionImportInput,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportResult,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionScanError,
} from "./agentSessions.ts";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  AttachmentUploadSigningKeyError,
} from "./assets.ts";
import {
  PersistChatAttachmentsError,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
} from "./chatAttachment.ts";
import {
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetTurnDiffError,
} from "./checkpointDiff.ts";
import {
  WorktreeSetupCancelInput,
  WorktreeSetupCancelResult,
  WorktreeSetupStreamEvent,
  WorktreeSetupSubscribeInput,
} from "./worktreeSetup.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  WorktreeStorageUsage,
  VcsStatusInput,
  VcsRefreshStatusInput,
  VcsStatusSubscriptionInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";
import {
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "./provider.ts";
import { ProviderInstanceId, ProviderInstanceMutation } from "./providerInstance.ts";
import {
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestPreview,
  PullRequestChecks,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestFilesViewedResult,
  PullRequestInvalidateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestRoutingResult,
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestStack,
  PullRequestLinkedThreadsResult,
  PullRequestSummary,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestLabelCandidateList,
  PullRequestLabelChangeInput,
  PullRequestSetFilesViewedInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
  PullRequestUpdateInput,
} from "./pullRequest.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationGetWorkflowScriptError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadLaunchError,
} from "./orchestrationV2.ts";
import {
  ProjectCreateNewInput,
  ProjectCreateNewResult,
  ProjectEnsureScratchResult,
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalObserveInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  PreviewAttachInput,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewFrameStreamEvent,
  PreviewInputInput,
  PreviewPickElementInput,
  PreviewPickElementResult,
  PreviewListInput,
  PreviewListResult,
  PreviewClearProfileError,
  PreviewClearProfileInput,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewPublishFrameInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewAdjustInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceDetailInput,
  DeviceError,
  DeviceListInput,
  SshDeviceHostConfig,
  DeviceHostSummary,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
} from "./device.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  DesktopUpdateCommitInput,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  HostResourcesSnapshot,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import {
  UsageLimitSourceError,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
} from "./providerUsageLimits.ts";
import { UsagePricing, UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  ScheduledTaskDeleteInput,
  ScheduledTaskDeleteResult,
  ScheduledTaskError,
  ScheduledTaskListInput,
  ScheduledTaskListResult,
  ScheduledTaskRunNowInput,
  ScheduledTaskRotateWebhookTokenInput,
  ScheduledTaskListWebhookDeliveriesInput,
  ScheduledTaskListWebhookDeliveriesResult,
  ScheduledTaskGetWebhookDeliveryInput,
  ScheduledTaskGetWebhookDeliveryResult,
  ScheduledTaskRunNowResult,
  ScheduledTaskSetEnabledInput,
  ScheduledTaskUpsertInput,
  ScheduledTaskMutationResult,
} from "./scheduledTask.ts";
import { SecretRequestAnswerInput, SecretRequestError } from "./secretRequest.ts";
import {
  ProjectCloneActionInput,
  ProjectCloneActionResult,
  ProjectCloneListEvent,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectCloneSubscribeInput,
} from "./projectClone.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlMergeProjectPullRequestInput,
  SourceControlMergeProjectPullRequestResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlProjectPullRequestsInput,
  SourceControlProjectPullRequestsResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import {
  Organization,
  OrganizationId,
  OrganizationAuditListInput,
  OrganizationAuditListResult,
  OrganizationBindProjectInput,
  OrganizationCreateInput,
  OrganizationDetachProjectInput,
  OrganizationError,
  OrganizationGetInput,
  OrganizationPublishedConfig,
  OrganizationPublishedConfigGetInput,
  OrganizationLifecycleInput,
  OrganizationListInput,
  OrganizationListResult,
  OrganizationMutationInput,
  OrganizationPublishInput,
} from "./organizations.ts";
import {
  OrganizationIntakeAuditEntry,
  OrganizationIntakeError,
  OrganizationIntakeEventInput,
  OrganizationIntakeCorrelationStatus,
  OrganizationCorrelationJobStatus,
  OrganizationIntakeRegisterSourceInput,
  OrganizationIntakeResult,
  OrganizationIntakeSource,
  OrganizationIntakeSourceId,
  OrganizationIntakeSourceRegistration,
  OrganizationObservation,
  OrganizationObservationId,
  OrganizationTentativeFinding,
} from "./organizationIntake.ts";
import {
  OrganizationWorkCancelInput,
  OrganizationWorkDetail,
  OrganizationWorkError,
} from "./organizationWork.ts";
import {
  OrganizationWorkDrainInput,
  OrganizationWorkDrainStatusInput,
  OrganizationWorkDrainStatus,
} from "./organizationWorkDrain.ts";
import {
  OrganizationEmergencyStopRequestInput,
  OrganizationEmergencyStopStatusInput,
  OrganizationEmergencyStopStatus,
} from "./organizationEmergencyStop.ts";
import {
  OrganizationStandingWorkAuthorization,
  OrganizationStandingWorkAuthorizationCreateInput,
  OrganizationStandingWorkAuthorizationError,
  OrganizationStandingWorkAuthorizationListInput,
  OrganizationStandingWorkAuthorizationListResult,
  OrganizationStandingWorkAuthorizationRevokeInput,
} from "./organizationStandingWorkAuthorization.ts";
import {
  OrganizationWorkReviewInput,
  OrganizationWorkReviewResult,
} from "./organizationWorkReview.ts";
import { OrganizationWorkApprovalDecisionInput } from "./organizationWorkApproval.ts";
import {
  OrganizationArchitectError,
  OrganizationArchitectListInput,
  OrganizationArchitectListResult,
  OrganizationArchitectSendInput,
  OrganizationArchitectSendResult,
  OrganizationArchitectApplyBatchInput,
} from "./organizationArchitect.ts";
import {
  OrganizationMemoryArchiveInput,
  OrganizationMemoryCorrectInput,
  OrganizationMemoryCreateInput,
  OrganizationMemoryError,
  OrganizationMemoryHistoryInput,
  OrganizationMemoryListInput,
  OrganizationMemoryRecord,
  OrganizationMemoryRevision,
  OrganizationMemorySupersedeInput,
} from "./organizationMemory.ts";
import {
  OrganizationObservationMode,
  OrganizationObservationModeGetInput,
  OrganizationObservationModeSetInput,
  OrganizationProposalDecisionInput,
  OrganizationProposalError,
  OrganizationProposalListInput,
  OrganizationProposalListResult,
  OrganizationWorkProposal,
} from "./organizationProposals.ts";
import {
  OrganizationDirectorAskInput,
  OrganizationDirectorAskResult,
  OrganizationDirectorError,
  OrganizationDirectorListInput,
  OrganizationDirectorListResult,
} from "./organizationDirector.ts";
import {
  OrganizationWorkIntentActivationError,
  OrganizationWorkIntentActivationInput,
  OrganizationWorkIntentActivationResult,
  OrganizationWorkIntentListInput,
  OrganizationWorkIntentListResult,
  OrganizationWorkIntentReadError,
} from "./organizationWorkIntents.ts";
import {
  OrganizationLiveWorkFailuresError,
  OrganizationLiveWorkFailuresInput,
  OrganizationLiveWorkFailuresResult,
  OrganizationLiveWorkRuntimeStatusInput,
  OrganizationLiveWorkRuntimeStatusResult,
} from "./organizationWorkFailures.ts";
import {
  OrganizationProviderBudgetConfigurationRecord,
  OrganizationProviderBudgetConfigurationRpcError,
  OrganizationProviderBudgetGetInput,
  OrganizationProviderBudgetGetResult,
  OrganizationProviderBudgetReadInput,
  OrganizationProviderBudgetReadResult,
  OrganizationProviderBudgetReadError,
  OrganizationProviderBudgetUpdateInput,
} from "./organizationProviderBudgets.ts";
import {
  OrganizationRepositoryError,
  OrganizationRepositoryLinkInput,
  OrganizationRepositoryListInput,
  OrganizationRepositoryListResult,
  OrganizationRepositoryLoadInput,
  OrganizationRepositoryPreview,
  OrganizationRepositoryPreviewInput,
  OrganizationRepositoryResolveInput,
  OrganizationRepositoryStatus,
  OrganizationRepositorySyncInput,
} from "./organizationRepository.ts";
import { Project, ProjectMutation, ProjectMutationError } from "./project.ts";

export const WS_METHODS = {
  // Project registry methods
  organizationsList: "organizations.list",
  organizationsCreate: "organizations.create",
  organizationsGet: "organizations.get",
  organizationsGetPublishedConfig: "organizations.getPublishedConfig",
  organizationsMutate: "organizations.mutate",
  organizationsBindProject: "organizations.bindProject",
  organizationsDetachProject: "organizations.detachProject",
  organizationsPublish: "organizations.publish",
  organizationsSetLifecycle: "organizations.setLifecycle",
  organizationsListAudit: "organizations.listAudit",
  organizationsReadProviderBudgets: "organizations.providerBudgets.read",
  organizationsGetProviderBudget: "organizations.providerBudgets.get",
  organizationsUpdateProviderBudget: "organizations.providerBudgets.update",
  organizationsRepositoryPreview: "organizations.repository.preview",
  organizationsRepositoryLink: "organizations.repository.link",
  organizationsRepositoryLoad: "organizations.repository.load",
  organizationsRepositorySync: "organizations.repository.sync",
  organizationsRepositoryStatus: "organizations.repository.status",
  organizationsRepositoryListRecords: "organizations.repository.listRecords",
  organizationsRepositoryResolveConflict: "organizations.repository.resolveConflict",
  organizationsRegisterSource: "organizations.registerSource",
  organizationsRotateSourceSecret: "organizations.rotateSourceSecret",
  organizationsSetSourceEnabled: "organizations.setSourceEnabled",
  organizationsListSources: "organizations.listSources",
  organizationsIngestManual: "organizations.ingestManual",
  organizationsRetryCorrelation: "organizations.intake.retryCorrelation",
  organizationsListObservations: "organizations.listObservations",
  organizationsListCorrelationJobs: "organizations.intake.listCorrelationJobs",
  organizationsListFindings: "organizations.listFindings",
  organizationsListIntakeAudit: "organizations.listIntakeAudit",
  organizationsListWork: "organizations.listWork",
  organizationsListWorkIntents: "organizations.workIntents.list",
  organizationsListWorkFailures: "organizations.workFailures.list",
  organizationsGetWorkRuntimeStatus: "organizations.workRuntime.status",
  organizationsActivateWorkIntent: "organizations.workIntents.activate",
  organizationsCancelWork: "organizations.work.cancel",
  organizationsRequestWorkDrain: "organizations.work.drain",
  organizationsGetWorkDrainStatus: "organizations.work.drainStatus",
  organizationsRequestEmergencyStop: "organizations.work.emergencyStop",
  organizationsGetEmergencyStopStatus: "organizations.work.emergencyStopStatus",
  organizationsCreateStandingWorkAuthorization: "organizations.standingWork.create",
  organizationsListStandingWorkAuthorizations: "organizations.standingWork.list",
  organizationsRevokeStandingWorkAuthorization: "organizations.standingWork.revoke",
  organizationsReviewWork: "organizations.reviewWork",
  organizationsDecideWorkApproval: "organizations.decideWorkApproval",
  organizationsArchitectList: "organizations.architect.list",
  organizationsArchitectSend: "organizations.architect.send",
  organizationsArchitectApplyBatch: "organizations.architect.applyBatch",
  organizationsMemoryList: "organizations.memory.list",
  organizationsMemoryHistory: "organizations.memory.history",
  organizationsMemoryCreate: "organizations.memory.create",
  organizationsMemoryCorrect: "organizations.memory.correct",
  organizationsMemorySupersede: "organizations.memory.supersede",
  organizationsMemoryArchive: "organizations.memory.archive",
  organizationsProposalList: "organizations.proposals.list",
  organizationsProposalDecide: "organizations.proposals.decide",
  organizationsObservationModeGet: "organizations.observationMode.get",
  organizationsObservationModeSet: "organizations.observationMode.set",
  organizationsDirectorList: "organizations.director.list",
  organizationsDirectorAsk: "organizations.director.ask",
  agentDashboardGetSnapshot: "agentDashboard.getSnapshot",
  agentDashboardDismissFeedCard: "agentDashboard.dismissFeedCard",
  agentDashboardClearFeed: "agentDashboard.clearFeed",
  agentDashboardReviewSuggestion: "agentDashboard.reviewSuggestion",
  agentDashboardRunInvestigation: "agentDashboard.runInvestigation",
  agentDashboardRetryRun: "agentDashboard.retryRun",
  agentDashboardCreateGithubIssue: "agentDashboard.createGithubIssue",
  agentDashboardApplyFindingAction: "agentDashboard.applyFindingAction",
  agentDashboardLinkFindingThread: "agentDashboard.linkFindingThread",
  agentDashboardUpdateRepositoryPolicy: "agentDashboard.updateRepositoryPolicy",
  agentDashboardCollect: "agentDashboard.collect",
  agentDashboardAddResearchWatchItem: "agentDashboard.addResearchWatchItem",
  agentDashboardListProjectPullRequests: "agentDashboard.listProjectPullRequests",
  agentDashboardMergeProjectPullRequest: "agentDashboard.mergeProjectPullRequest",
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsMutate: "projects.mutate",
  projectsEnsureScratch: "projects.ensureScratch",
  projectsCreateNew: "projects.createNew",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  // Codex session discovery (resuming conversations started outside the app)
  threadExport: "thread.export",
  codexSessionsList: "codexSessions.list",
  codexSessionsResume: "codexSessions.resume",
  agentSessionsScan: "agentSessions.scan",
  agentSessionsImport: "agentSessions.import",
  assetsCreateUrl: "assets.createUrl",
  assetsPersistChatAttachments: "assets.persistChatAttachments",
  attachmentsCreateUploadUrl: "attachments.createUploadUrl",
  attachmentsDelete: "attachments.delete",

  // Provider methods
  providerUploadFeedback: "provider.uploadFeedback",
  providerAuthStart: "provider.auth.start",
  providerConsumeResetCredit: "provider.consumeResetCredit",
  providerAuthComplete: "provider.auth.complete",
  chatGptReconnectProfile: "provider.chatgpt.reconnect-profile",
  chatGptImportProfile: "provider.chatgpt.import-profile",
  chatGptHandoffSubscribe: "provider.chatgpt.handoff.subscribe",
  codexAuthCallbackSubscribe: "provider.codex.auth-callback.subscribe",
  providerAuthRespond: "provider.auth.respond",
  providerAuthCancel: "provider.auth.cancel",
  providerAuthLogout: "provider.auth.logout",
  providerAuthSubscribe: "provider.auth.subscribe",
  providerInstallStart: "provider.install.start",
  providerInstallCancel: "provider.install.cancel",
  providerInstallSubscribe: "provider.install.subscribe",
  providerInstallRemove: "provider.install.remove",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsWorktreeStorageUsage: "vcs.worktreeStorageUsage",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalObserve: "terminal.observe",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewAdjust: "preview.adjust",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewClearProfile: "preview.clearProfile",
  previewReportStatus: "preview.reportStatus",
  previewAttach: "preview.attach",
  previewPublishFrame: "preview.publishFrame",
  previewInput: "preview.input",
  previewPickElement: "preview.pickElement",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Device methods
  deviceConfigure: "device.configure",
  deviceList: "device.list",
  deviceTestHost: "device.testHost",
  deviceOpen: "device.open",
  deviceClose: "device.close",
  deviceShutdown: "device.shutdown",
  deviceDetail: "device.detail",
  deviceAction: "device.action",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverCommitDesktopUpdate: "server.commitDesktopUpdate",
  serverGetMaintenanceStatus: "server.getMaintenanceStatus",
  serverUpdateMaintenancePolicy: "server.updateMaintenancePolicy",
  serverRunMaintenanceAction: "server.runMaintenanceAction",
  serverRecoverMaintenance: "server.recoverMaintenance",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverSearchAcpRegistry: "server.searchAcpRegistry",
  serverPrepareAcpRegistryAgent: "server.prepareAcpRegistryAgent",
  serverUninstallAcpRegistryManagedBinary: "server.uninstallAcpRegistryManagedBinary",
  serverAcceptAcpRegistryUrlAuth: "server.acceptAcpRegistryUrlAuth",
  serverListAcpRegistrySessions: "server.listAcpRegistrySessions",
  serverImportAcpRegistrySession: "server.importAcpRegistrySession",
  serverDeleteAcpRegistrySession: "server.deleteAcpRegistrySession",
  serverListAcpRegistryProviders: "server.listAcpRegistryProviders",
  serverSetAcpRegistryProvider: "server.setAcpRegistryProvider",
  serverDisableAcpRegistryProvider: "server.disableAcpRegistryProvider",
  serverLogoutAcpRegistry: "server.logoutAcpRegistry",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetHostResources: "server.getHostResources",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",
  serverGetUsageSummary: "server.getUsageSummary",
  serverRefreshUsageRates: "server.refreshUsageRates",

  // Scheduled tasks
  scheduledTasksList: "scheduledTasks.list",
  scheduledTasksSubscribe: "scheduledTasks.subscribe",
  scheduledTasksUpsert: "scheduledTasks.upsert",
  scheduledTasksSetEnabled: "scheduledTasks.setEnabled",
  scheduledTasksDelete: "scheduledTasks.delete",
  scheduledTasksRunNow: "scheduledTasks.runNow",
  scheduledTasksRotateWebhookToken: "scheduledTasks.rotateWebhookToken",
  secretsAnswerRequest: "secrets.answerRequest",
  scheduledTasksListWebhookDeliveries: "scheduledTasks.listWebhookDeliveries",
  scheduledTasksGetWebhookDelivery: "scheduledTasks.getWebhookDelivery",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Pull request methods
  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsSummary: "pullRequests.summary",
  pullRequestsRouting: "pullRequests.routing",
  pullRequestsRoutingIdentity: "pullRequests.routingIdentity",
  pullRequestsStack: "pullRequests.stack",
  pullRequestsLinkedThreads: "pullRequests.linkedThreads",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsPreview: "pullRequests.preview",
  pullRequestsChecks: "pullRequests.checks",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsThreadComments: "pullRequests.threadComments",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsFilesViewed: "pullRequests.filesViewed",
  pullRequestsSetFilesViewed: "pullRequests.setFilesViewed",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsSubscribeRefreshes: "pullRequests.subscribeRefreshes",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",
  pullRequestsLabelCandidates: "pullRequests.labelCandidates",
  pullRequestsSetLabels: "pullRequests.setLabels",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",
  projectCloneStart: "projectClone.start",
  projectCloneCancel: "projectClone.cancel",
  projectCloneRetry: "projectClone.retry",
  subscribeProjectClones: "subscribeProjectClones",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeWorktreeSetup: "subscribeWorktreeSetup",
  worktreeSetupCancel: "worktreeSetup.cancel",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeDeviceState: "subscribeDeviceState",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const organizationRpcError = Schema.Union([OrganizationError, EnvironmentAuthorizationError]);

export const WsOrganizationsListRpc = Rpc.make(WS_METHODS.organizationsList, {
  payload: OrganizationListInput,
  success: OrganizationListResult,
  error: organizationRpcError,
});
export const WsOrganizationsCreateRpc = Rpc.make(WS_METHODS.organizationsCreate, {
  payload: OrganizationCreateInput,
  success: Organization,
  error: organizationRpcError,
});
export const WsOrganizationsGetRpc = Rpc.make(WS_METHODS.organizationsGet, {
  payload: OrganizationGetInput,
  success: Organization,
  error: organizationRpcError,
});
export const WsOrganizationsGetPublishedConfigRpc = Rpc.make(
  WS_METHODS.organizationsGetPublishedConfig,
  {
    payload: OrganizationPublishedConfigGetInput,
    success: OrganizationPublishedConfig,
    error: organizationRpcError,
  },
);
export const WsOrganizationsMutateRpc = Rpc.make(WS_METHODS.organizationsMutate, {
  payload: OrganizationMutationInput,
  success: Organization,
  error: organizationRpcError,
});
export const WsOrganizationsBindProjectRpc = Rpc.make(WS_METHODS.organizationsBindProject, {
  payload: OrganizationBindProjectInput,
  success: Organization,
  error: organizationRpcError,
});
export const WsOrganizationsDetachProjectRpc = Rpc.make(WS_METHODS.organizationsDetachProject, {
  payload: OrganizationDetachProjectInput,
  success: Organization,
  error: organizationRpcError,
});
export const WsOrganizationsPublishRpc = Rpc.make(WS_METHODS.organizationsPublish, {
  payload: OrganizationPublishInput,
  success: Organization,
  error: organizationRpcError,
});
export const WsOrganizationsSetLifecycleRpc = Rpc.make(WS_METHODS.organizationsSetLifecycle, {
  payload: OrganizationLifecycleInput,
  success: Organization,
  error: organizationRpcError,
});
export const WsOrganizationsListAuditRpc = Rpc.make(WS_METHODS.organizationsListAudit, {
  payload: OrganizationAuditListInput,
  success: OrganizationAuditListResult,
  error: organizationRpcError,
});
export const WsOrganizationsReadProviderBudgetsRpc = Rpc.make(
  WS_METHODS.organizationsReadProviderBudgets,
  {
    payload: OrganizationProviderBudgetReadInput,
    success: OrganizationProviderBudgetReadResult,
    error: Schema.Union([OrganizationProviderBudgetReadError, EnvironmentAuthorizationError]),
  },
);
export const WsOrganizationsGetProviderBudgetRpc = Rpc.make(
  WS_METHODS.organizationsGetProviderBudget,
  {
    payload: OrganizationProviderBudgetGetInput,
    success: OrganizationProviderBudgetGetResult,
    error: Schema.Union([
      OrganizationProviderBudgetConfigurationRpcError,
      EnvironmentAuthorizationError,
    ]),
  },
);
export const WsOrganizationsUpdateProviderBudgetRpc = Rpc.make(
  WS_METHODS.organizationsUpdateProviderBudget,
  {
    payload: OrganizationProviderBudgetUpdateInput,
    success: OrganizationProviderBudgetConfigurationRecord,
    error: Schema.Union([
      OrganizationProviderBudgetConfigurationRpcError,
      EnvironmentAuthorizationError,
    ]),
  },
);

const organizationRepositoryRpcError = Schema.Union([
  OrganizationRepositoryError,
  EnvironmentAuthorizationError,
]);
export const WsOrganizationsRepositoryPreviewRpc = Rpc.make(
  WS_METHODS.organizationsRepositoryPreview,
  {
    payload: OrganizationRepositoryPreviewInput,
    success: OrganizationRepositoryPreview,
    error: organizationRepositoryRpcError,
  },
);
export const WsOrganizationsRepositoryLinkRpc = Rpc.make(WS_METHODS.organizationsRepositoryLink, {
  payload: OrganizationRepositoryLinkInput,
  success: OrganizationRepositoryStatus,
  error: organizationRepositoryRpcError,
});
export const WsOrganizationsRepositoryLoadRpc = Rpc.make(WS_METHODS.organizationsRepositoryLoad, {
  payload: OrganizationRepositoryLoadInput,
  success: OrganizationRepositoryStatus,
  error: organizationRepositoryRpcError,
});
export const WsOrganizationsRepositorySyncRpc = Rpc.make(WS_METHODS.organizationsRepositorySync, {
  payload: OrganizationRepositorySyncInput,
  success: OrganizationRepositoryStatus,
  error: organizationRepositoryRpcError,
});
export const WsOrganizationsRepositoryStatusRpc = Rpc.make(
  WS_METHODS.organizationsRepositoryStatus,
  {
    payload: OrganizationRepositorySyncInput,
    success: OrganizationRepositoryStatus,
    error: organizationRepositoryRpcError,
  },
);
export const WsOrganizationsRepositoryListRecordsRpc = Rpc.make(
  WS_METHODS.organizationsRepositoryListRecords,
  {
    payload: OrganizationRepositoryListInput,
    success: OrganizationRepositoryListResult,
    error: organizationRepositoryRpcError,
  },
);
export const WsOrganizationsRepositoryResolveConflictRpc = Rpc.make(
  WS_METHODS.organizationsRepositoryResolveConflict,
  {
    payload: OrganizationRepositoryResolveInput,
    success: OrganizationRepositoryStatus,
    error: organizationRepositoryRpcError,
  },
);

const organizationIntakeRpcError = Schema.Union([
  OrganizationIntakeError,
  EnvironmentAuthorizationError,
]);
const organizationSourceInput = Schema.Struct({
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
});
export const WsOrganizationsRegisterSourceRpc = Rpc.make(WS_METHODS.organizationsRegisterSource, {
  payload: OrganizationIntakeRegisterSourceInput,
  success: OrganizationIntakeSourceRegistration,
  error: organizationIntakeRpcError,
});
export const WsOrganizationsRotateSourceSecretRpc = Rpc.make(
  WS_METHODS.organizationsRotateSourceSecret,
  {
    payload: organizationSourceInput,
    success: OrganizationIntakeSourceRegistration,
    error: organizationIntakeRpcError,
  },
);
export const WsOrganizationsSetSourceEnabledRpc = Rpc.make(
  WS_METHODS.organizationsSetSourceEnabled,
  {
    payload: Schema.Struct({ ...organizationSourceInput.fields, enabled: Schema.Boolean }),
    success: OrganizationIntakeSource,
    error: organizationIntakeRpcError,
  },
);
export const WsOrganizationsListSourcesRpc = Rpc.make(WS_METHODS.organizationsListSources, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ sources: Schema.Array(OrganizationIntakeSource) }),
  error: organizationIntakeRpcError,
});
export const WsOrganizationsIngestManualRpc = Rpc.make(WS_METHODS.organizationsIngestManual, {
  payload: OrganizationIntakeEventInput,
  success: OrganizationIntakeResult,
  error: organizationIntakeRpcError,
});
export const WsOrganizationsRetryCorrelationRpc = Rpc.make(
  WS_METHODS.organizationsRetryCorrelation,
  {
    payload: Schema.Struct({
      organizationId: OrganizationId,
      observationId: OrganizationObservationId,
    }),
    success: OrganizationIntakeCorrelationStatus,
    error: organizationIntakeRpcError,
  },
);
export const WsOrganizationsListObservationsRpc = Rpc.make(
  WS_METHODS.organizationsListObservations,
  {
    payload: OrganizationGetInput,
    success: Schema.Struct({ observations: Schema.Array(OrganizationObservation) }),
    error: organizationIntakeRpcError,
  },
);
export const WsOrganizationsListCorrelationJobsRpc = Rpc.make(
  WS_METHODS.organizationsListCorrelationJobs,
  {
    payload: OrganizationGetInput,
    success: Schema.Struct({ jobs: Schema.Array(OrganizationCorrelationJobStatus) }),
    error: organizationIntakeRpcError,
  },
);
export const WsOrganizationsListFindingsRpc = Rpc.make(WS_METHODS.organizationsListFindings, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ findings: Schema.Array(OrganizationTentativeFinding) }),
  error: organizationIntakeRpcError,
});
export const WsOrganizationsListIntakeAuditRpc = Rpc.make(WS_METHODS.organizationsListIntakeAudit, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ entries: Schema.Array(OrganizationIntakeAuditEntry) }),
  error: organizationIntakeRpcError,
});
export const WsOrganizationsListWorkRpc = Rpc.make(WS_METHODS.organizationsListWork, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ items: Schema.Array(OrganizationWorkDetail) }),
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
export const WsOrganizationsListWorkIntentsRpc = Rpc.make(WS_METHODS.organizationsListWorkIntents, {
  payload: OrganizationWorkIntentListInput,
  success: OrganizationWorkIntentListResult,
  error: Schema.Union([OrganizationWorkIntentReadError, EnvironmentAuthorizationError]),
});
export const WsOrganizationsListWorkFailuresRpc = Rpc.make(
  WS_METHODS.organizationsListWorkFailures,
  {
    payload: OrganizationLiveWorkFailuresInput,
    success: OrganizationLiveWorkFailuresResult,
    error: Schema.Union([OrganizationLiveWorkFailuresError, EnvironmentAuthorizationError]),
  },
);
export const WsOrganizationsGetWorkRuntimeStatusRpc = Rpc.make(
  WS_METHODS.organizationsGetWorkRuntimeStatus,
  {
    payload: OrganizationLiveWorkRuntimeStatusInput,
    success: OrganizationLiveWorkRuntimeStatusResult,
    error: Schema.Union([OrganizationLiveWorkFailuresError, EnvironmentAuthorizationError]),
  },
);
export const WsOrganizationsActivateWorkIntentRpc = Rpc.make(
  WS_METHODS.organizationsActivateWorkIntent,
  {
    payload: OrganizationWorkIntentActivationInput,
    success: OrganizationWorkIntentActivationResult,
    error: Schema.Union([OrganizationWorkIntentActivationError, EnvironmentAuthorizationError]),
  },
);
export const WsOrganizationsCancelWorkRpc = Rpc.make(WS_METHODS.organizationsCancelWork, {
  payload: OrganizationWorkCancelInput,
  success: OrganizationWorkDetail,
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
export const WsOrganizationsRequestWorkDrainRpc = Rpc.make(
  WS_METHODS.organizationsRequestWorkDrain,
  {
    payload: OrganizationWorkDrainInput,
    success: OrganizationWorkDrainStatus,
    error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
  },
);
export const WsOrganizationsGetWorkDrainStatusRpc = Rpc.make(
  WS_METHODS.organizationsGetWorkDrainStatus,
  {
    payload: OrganizationWorkDrainStatusInput,
    success: OrganizationWorkDrainStatus,
    error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
  },
);
export const WsOrganizationsRequestEmergencyStopRpc = Rpc.make(
  WS_METHODS.organizationsRequestEmergencyStop,
  {
    payload: OrganizationEmergencyStopRequestInput,
    success: OrganizationEmergencyStopStatus,
    error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
  },
);
export const WsOrganizationsGetEmergencyStopStatusRpc = Rpc.make(
  WS_METHODS.organizationsGetEmergencyStopStatus,
  {
    payload: OrganizationEmergencyStopStatusInput,
    success: OrganizationEmergencyStopStatus,
    error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
  },
);
export const WsOrganizationsCreateStandingWorkAuthorizationRpc = Rpc.make(
  WS_METHODS.organizationsCreateStandingWorkAuthorization,
  {
    payload: OrganizationStandingWorkAuthorizationCreateInput,
    success: OrganizationStandingWorkAuthorization,
    error: Schema.Union([
      OrganizationStandingWorkAuthorizationError,
      EnvironmentAuthorizationError,
    ]),
  },
);
export const WsOrganizationsListStandingWorkAuthorizationsRpc = Rpc.make(
  WS_METHODS.organizationsListStandingWorkAuthorizations,
  {
    payload: OrganizationStandingWorkAuthorizationListInput,
    success: OrganizationStandingWorkAuthorizationListResult,
    error: Schema.Union([
      OrganizationStandingWorkAuthorizationError,
      EnvironmentAuthorizationError,
    ]),
  },
);
export const WsOrganizationsRevokeStandingWorkAuthorizationRpc = Rpc.make(
  WS_METHODS.organizationsRevokeStandingWorkAuthorization,
  {
    payload: OrganizationStandingWorkAuthorizationRevokeInput,
    success: OrganizationStandingWorkAuthorization,
    error: Schema.Union([
      OrganizationStandingWorkAuthorizationError,
      EnvironmentAuthorizationError,
    ]),
  },
);
export const WsOrganizationsReviewWorkRpc = Rpc.make(WS_METHODS.organizationsReviewWork, {
  payload: OrganizationWorkReviewInput,
  success: OrganizationWorkReviewResult,
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
export const WsOrganizationsDecideWorkApprovalRpc = Rpc.make(
  WS_METHODS.organizationsDecideWorkApproval,
  {
    payload: OrganizationWorkApprovalDecisionInput,
    success: OrganizationWorkDetail,
    error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
  },
);
const organizationArchitectRpcError = Schema.Union([
  OrganizationArchitectError,
  EnvironmentAuthorizationError,
]);
export const WsOrganizationsArchitectListRpc = Rpc.make(WS_METHODS.organizationsArchitectList, {
  payload: OrganizationArchitectListInput,
  success: OrganizationArchitectListResult,
  error: organizationArchitectRpcError,
});
export const WsOrganizationsArchitectSendRpc = Rpc.make(WS_METHODS.organizationsArchitectSend, {
  payload: OrganizationArchitectSendInput,
  success: OrganizationArchitectSendResult,
  error: organizationArchitectRpcError,
});
export const WsOrganizationsArchitectApplyBatchRpc = Rpc.make(
  WS_METHODS.organizationsArchitectApplyBatch,
  {
    payload: OrganizationArchitectApplyBatchInput,
    success: Organization,
    error: organizationRpcError,
  },
);
const organizationMemoryRpcError = Schema.Union([
  OrganizationMemoryError,
  EnvironmentAuthorizationError,
]);
export const WsOrganizationsMemoryListRpc = Rpc.make(WS_METHODS.organizationsMemoryList, {
  payload: OrganizationMemoryListInput,
  success: Schema.Struct({ records: Schema.Array(OrganizationMemoryRecord) }),
  error: organizationMemoryRpcError,
});
export const WsOrganizationsMemoryHistoryRpc = Rpc.make(WS_METHODS.organizationsMemoryHistory, {
  payload: OrganizationMemoryHistoryInput,
  success: Schema.Struct({ revisions: Schema.Array(OrganizationMemoryRevision) }),
  error: organizationMemoryRpcError,
});
export const WsOrganizationsMemoryCreateRpc = Rpc.make(WS_METHODS.organizationsMemoryCreate, {
  payload: OrganizationMemoryCreateInput,
  success: OrganizationMemoryRecord,
  error: organizationMemoryRpcError,
});
export const WsOrganizationsMemoryCorrectRpc = Rpc.make(WS_METHODS.organizationsMemoryCorrect, {
  payload: OrganizationMemoryCorrectInput,
  success: OrganizationMemoryRecord,
  error: organizationMemoryRpcError,
});
export const WsOrganizationsMemorySupersedeRpc = Rpc.make(WS_METHODS.organizationsMemorySupersede, {
  payload: OrganizationMemorySupersedeInput,
  success: OrganizationMemoryRecord,
  error: organizationMemoryRpcError,
});
export const WsOrganizationsMemoryArchiveRpc = Rpc.make(WS_METHODS.organizationsMemoryArchive, {
  payload: OrganizationMemoryArchiveInput,
  success: OrganizationMemoryRecord,
  error: organizationMemoryRpcError,
});
const organizationProposalRpcError = Schema.Union([
  OrganizationProposalError,
  EnvironmentAuthorizationError,
]);
export const WsOrganizationsProposalListRpc = Rpc.make(WS_METHODS.organizationsProposalList, {
  payload: OrganizationProposalListInput,
  success: OrganizationProposalListResult,
  error: organizationProposalRpcError,
});
export const WsOrganizationsProposalDecideRpc = Rpc.make(WS_METHODS.organizationsProposalDecide, {
  payload: OrganizationProposalDecisionInput,
  success: OrganizationWorkProposal,
  error: organizationProposalRpcError,
});
export const WsOrganizationsObservationModeGetRpc = Rpc.make(
  WS_METHODS.organizationsObservationModeGet,
  {
    payload: OrganizationObservationModeGetInput,
    success: OrganizationObservationMode,
    error: organizationProposalRpcError,
  },
);
export const WsOrganizationsObservationModeSetRpc = Rpc.make(
  WS_METHODS.organizationsObservationModeSet,
  {
    payload: OrganizationObservationModeSetInput,
    success: OrganizationObservationMode,
    error: organizationProposalRpcError,
  },
);
const organizationDirectorRpcError = Schema.Union([
  OrganizationDirectorError,
  EnvironmentAuthorizationError,
]);
export const WsOrganizationsDirectorListRpc = Rpc.make(WS_METHODS.organizationsDirectorList, {
  payload: OrganizationDirectorListInput,
  success: OrganizationDirectorListResult,
  error: organizationDirectorRpcError,
});
export const WsOrganizationsDirectorAskRpc = Rpc.make(WS_METHODS.organizationsDirectorAsk, {
  payload: OrganizationDirectorAskInput,
  success: OrganizationDirectorAskResult,
  error: organizationDirectorRpcError,
});

export const WsAgentDashboardGetSnapshotRpc = Rpc.make(WS_METHODS.agentDashboardGetSnapshot, {
  payload: AgentDashboardGetSnapshotInput,
  success: AgentDashboardSnapshot,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

export const WsAgentDashboardDismissFeedCardRpc = Rpc.make(
  WS_METHODS.agentDashboardDismissFeedCard,
  {
    payload: AgentDashboardFeedCardIdInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

export const WsAgentDashboardClearFeedRpc = Rpc.make(WS_METHODS.agentDashboardClearFeed, {
  payload: Schema.Struct({}),
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

export const WsAgentDashboardReviewSuggestionRpc = Rpc.make(
  WS_METHODS.agentDashboardReviewSuggestion,
  {
    payload: AgentDashboardReviewSuggestionActionInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

export const WsAgentDashboardRunInvestigationRpc = Rpc.make(
  WS_METHODS.agentDashboardRunInvestigation,
  {
    payload: AgentDashboardRunInvestigationInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

export const WsAgentDashboardRetryRunRpc = Rpc.make(WS_METHODS.agentDashboardRetryRun, {
  payload: AgentDashboardRetryRunInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

export const WsAgentDashboardApplyFindingActionRpc = Rpc.make(
  WS_METHODS.agentDashboardApplyFindingAction,
  {
    payload: AgentDashboardFindingActionInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

export const WsAgentDashboardLinkFindingThreadRpc = Rpc.make(
  WS_METHODS.agentDashboardLinkFindingThread,
  {
    payload: AgentDashboardLinkFindingThreadInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

export const WsAgentDashboardUpdateRepositoryPolicyRpc = Rpc.make(
  WS_METHODS.agentDashboardUpdateRepositoryPolicy,
  {
    payload: AgentDashboardRepositoryPolicyInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

export const WsAgentDashboardCollectRpc = Rpc.make(WS_METHODS.agentDashboardCollect, {
  payload: AgentDashboardCollectInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

export const WsAgentDashboardAddResearchWatchItemRpc = Rpc.make(
  WS_METHODS.agentDashboardAddResearchWatchItem,
  {
    payload: AgentDashboardResearchWatchItemInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

export const WsAgentDashboardCreateGithubIssueRpc = Rpc.make(
  WS_METHODS.agentDashboardCreateGithubIssue,
  {
    payload: AgentDashboardReviewSuggestionIdInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

export const WsAgentDashboardListProjectPullRequestsRpc = Rpc.make(
  WS_METHODS.agentDashboardListProjectPullRequests,
  {
    payload: SourceControlProjectPullRequestsInput,
    success: SourceControlProjectPullRequestsResult,
    error: Schema.Union([
      SourceControlRepositoryError,
      AgentDashboardError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsAgentDashboardMergeProjectPullRequestRpc = Rpc.make(
  WS_METHODS.agentDashboardMergeProjectPullRequest,
  {
    payload: SourceControlMergeProjectPullRequestInput,
    success: SourceControlMergeProjectPullRequestResult,
    error: Schema.Union([
      SourceControlRepositoryError,
      AgentDashboardError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
    cwd: Schema.optional(TrimmedNonEmptyString),
    /** With `instanceId` and `cwd`: rescan the workspace's skills and slash
     * commands even when a snapshot for that cwd already exists. */
    fresh: Schema.optional(Schema.Boolean),
    /** Explicit user request: bypass T3-owned caches and rediscover models.
     * Background status refreshes must not open agent sessions. */
    refreshModels: Schema.optional(Schema.Boolean),
  }),
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([EnvironmentAuthorizationError, ProviderSetupError]),
});

const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

const ProviderSetupRpcError = Schema.Union([ProviderSetupError, EnvironmentAuthorizationError]);

const WsProviderConsumeResetCreditRpc = Rpc.make(WS_METHODS.providerConsumeResetCredit, {
  payload: ProviderConsumeResetCreditInput,
  success: ProviderConsumeResetCreditResult,
  error: Schema.Union([ProviderSetupError, UsageLimitSourceError, EnvironmentAuthorizationError]),
});

const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderAuthStartInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthRespondRpc = Rpc.make(WS_METHODS.providerAuthRespond, {
  payload: ProviderAuthRespondInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthCompleteRpc = Rpc.make(WS_METHODS.providerAuthComplete, {
  payload: ProviderAuthCompleteInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsChatGptReconnectProfileRpc = Rpc.make(WS_METHODS.chatGptReconnectProfile, {
  payload: ChatGptReconnectProfileInput,
  success: Schema.NullOr(ChatGptReconnectProfile),
  error: ProviderSetupRpcError,
});
const WsChatGptImportProfileRpc = Rpc.make(WS_METHODS.chatGptImportProfile, {
  payload: ChatGptImportProfileInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});
const WsChatGptHandoffSubscribeRpc = Rpc.make(WS_METHODS.chatGptHandoffSubscribe, {
  payload: ChatGptHandoffInput,
  success: ChatGptHandoffState,
  error: ProviderSetupRpcError,
  stream: true,
});
const WsCodexAuthCallbackSubscribeRpc = Rpc.make(WS_METHODS.codexAuthCallbackSubscribe, {
  payload: CodexAuthCallbackInput,
  success: CodexAuthCallbackState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderAuthCancelRpc = Rpc.make(WS_METHODS.providerAuthCancel, {
  payload: ProviderAuthCancelInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthLogoutRpc = Rpc.make(WS_METHODS.providerAuthLogout, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthSubscribeRpc = Rpc.make(WS_METHODS.providerAuthSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallStartRpc = Rpc.make(WS_METHODS.providerInstallStart, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallCancelRpc = Rpc.make(WS_METHODS.providerInstallCancel, {
  payload: ProviderInstallCancelInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallSubscribeRpc = Rpc.make(WS_METHODS.providerInstallSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallRemoveRpc = Rpc.make(WS_METHODS.providerInstallRemove, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerUpdateServerWithProgressRpc = Rpc.make(WS_METHODS.serverUpdateServerWithProgress, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateProgressEvent,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerCommitDesktopUpdateRpc = Rpc.make(WS_METHODS.serverCommitDesktopUpdate, {
  payload: DesktopUpdateCommitInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerGetMaintenanceStatusRpc = Rpc.make(WS_METHODS.serverGetMaintenanceStatus, {
  payload: Schema.Struct({}),
  success: ForkUpdateStatus,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsServerUpdateMaintenancePolicyRpc = Rpc.make(WS_METHODS.serverUpdateMaintenancePolicy, {
  payload: ForkUpdatePolicyPatch,
  success: ForkUpdateStatus,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsServerRunMaintenanceActionRpc = Rpc.make(WS_METHODS.serverRunMaintenanceAction, {
  payload: ForkMaintenanceActionInput,
  success: ForkUpdateStatus,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsServerRecoverMaintenanceRpc = Rpc.make(WS_METHODS.serverRecoverMaintenance, {
  payload: ForkRecoveryRequest,
  success: ForkUpdateStatus,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({
    patch: ServerSettingsPatch,
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerSearchAcpRegistryRpc = Rpc.make(WS_METHODS.serverSearchAcpRegistry, {
  payload: AcpRegistrySearchInput,
  success: AcpRegistrySearchResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerPrepareAcpRegistryAgentRpc = Rpc.make(WS_METHODS.serverPrepareAcpRegistryAgent, {
  payload: AcpRegistryPrepareInput,
  success: AcpRegistryPrepareResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerUninstallAcpRegistryManagedBinaryRpc = Rpc.make(
  WS_METHODS.serverUninstallAcpRegistryManagedBinary,
  {
    payload: AcpRegistryManagedBinaryUninstallInput,
    success: AcpRegistryManagedBinaryUninstallResult,
    error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
  },
);

const WsServerAcceptAcpRegistryUrlAuthRpc = Rpc.make(WS_METHODS.serverAcceptAcpRegistryUrlAuth, {
  payload: AcpRegistryAcceptUrlAuthInput,
  success: AcpRegistryAcceptUrlAuthResult,
  error: EnvironmentAuthorizationError,
});

const WsServerListAcpRegistrySessionsRpc = Rpc.make(WS_METHODS.serverListAcpRegistrySessions, {
  payload: AcpRegistryListSessionsInput,
  success: AcpRegistryListSessionsResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerImportAcpRegistrySessionRpc = Rpc.make(WS_METHODS.serverImportAcpRegistrySession, {
  payload: AcpRegistryImportSessionInput,
  success: AcpRegistryImportSessionResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerDeleteAcpRegistrySessionRpc = Rpc.make(WS_METHODS.serverDeleteAcpRegistrySession, {
  payload: AcpRegistryDeleteSessionInput,
  success: AcpRegistryDeleteSessionResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerListAcpRegistryProvidersRpc = Rpc.make(WS_METHODS.serverListAcpRegistryProviders, {
  payload: AcpRegistryListProvidersInput,
  success: AcpRegistryListProvidersResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerSetAcpRegistryProviderRpc = Rpc.make(WS_METHODS.serverSetAcpRegistryProvider, {
  payload: AcpRegistrySetProviderInput,
  success: AcpRegistrySetProviderResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerDisableAcpRegistryProviderRpc = Rpc.make(
  WS_METHODS.serverDisableAcpRegistryProvider,
  {
    payload: AcpRegistryDisableProviderInput,
    success: AcpRegistryDisableProviderResult,
    error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
  },
);

const WsServerLogoutAcpRegistryRpc = Rpc.make(WS_METHODS.serverLogoutAcpRegistry, {
  payload: AcpRegistryLogoutInput,
  success: AcpRegistryLogoutResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetHostResourcesRpc = Rpc.make(WS_METHODS.serverGetHostResources, {
  payload: Schema.Struct({}),
  success: HostResourcesSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessResourceHistoryRpc = Rpc.make(WS_METHODS.serverGetProcessResourceHistory, {
  payload: ServerProcessResourceHistoryInput,
  success: ServerProcessResourceHistoryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

/**
 * Refetches the model rate table ahead of its daily TTL, so a model released
 * since the last fetch gets priced. The next usage summary uses the new table.
 */
const WsServerRefreshUsageRatesRpc = Rpc.make(WS_METHODS.serverRefreshUsageRates, {
  payload: Schema.Struct({}),
  success: UsagePricing,
  error: EnvironmentAuthorizationError,
});

const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

const PullRequestRpcError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

/**
 * The line counts for rows already on the page. Its own call because on GitHub the pair costs
 * 40-60% of the listing read that answers everything else on the row, so the rows arrive first
 * and their stats a moment later.
 */
const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingRpc = Rpc.make(WS_METHODS.pullRequestsRouting, {
  payload: PullRequestRef,
  success: PullRequestRoutingResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingIdentityRpc = Rpc.make(WS_METHODS.pullRequestsRoutingIdentity, {
  payload: PullRequestRoutingIdentityInput,
  success: PullRequestRoutingIdentityResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSummaryRpc = Rpc.make(WS_METHODS.pullRequestsSummary, {
  payload: PullRequestRef,
  success: PullRequestSummary,
  error: PullRequestRpcError,
});

const WsPullRequestsStackRpc = Rpc.make(WS_METHODS.pullRequestsStack, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestStack),
  error: PullRequestRpcError,
});

const WsPullRequestsLinkedThreadsRpc = Rpc.make(WS_METHODS.pullRequestsLinkedThreads, {
  payload: PullRequestRef,
  success: PullRequestLinkedThreadsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

const WsPullRequestsPreviewRpc = Rpc.make(WS_METHODS.pullRequestsPreview, {
  payload: PullRequestRef,
  success: PullRequestPreview,
  error: PullRequestRpcError,
});

const WsPullRequestsChecksRpc = Rpc.make(WS_METHODS.pullRequestsChecks, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestChecks),
  error: PullRequestRpcError,
});

const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

const WsPullRequestsThreadCommentsRpc = Rpc.make(WS_METHODS.pullRequestsThreadComments, {
  payload: PullRequestThreadCommentsInput,
  success: PullRequestThreadCommentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsFilesViewed, {
  payload: PullRequestRef,
  success: PullRequestFilesViewedResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSetFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsSetFilesViewed, {
  payload: PullRequestSetFilesViewedInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetThreadResolutionRpc = Rpc.make(WS_METHODS.pullRequestsSetThreadResolution, {
  payload: PullRequestThreadResolutionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubscribeRefreshesRpc = Rpc.make(WS_METHODS.pullRequestsSubscribeRefreshes, {
  payload: Schema.Struct({}),
  success: NonNegativeInt,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Read on its own rather than as part of the detail: the people who may be asked are only wanted
 * once somebody opens the menu, and reading them with every change request would spend a request
 * per host on a list nobody looked at.
 */
const WsPullRequestsReviewerCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsReviewerCandidates, {
  payload: PullRequestRef,
  success: PullRequestReviewerCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

/** Read when the label menu opens, for the same reason the reviewer candidates are. */
const WsPullRequestsLabelCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsLabelCandidates, {
  payload: PullRequestRef,
  success: PullRequestLabelCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsSetLabelsRpc = Rpc.make(WS_METHODS.pullRequestsSetLabels, {
  payload: PullRequestLabelChangeInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsSourceControlLookupRepositoryRpc = Rpc.make(WS_METHODS.sourceControlLookupRepository, {
  payload: SourceControlRepositoryLookupInput,
  success: SourceControlRepositoryInfo,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

// Clone-backed project creation. `start` returns once the project exists and
// the clone is running; progress arrives on the subscription.
const WsProjectCloneStartRpc = Rpc.make(WS_METHODS.projectCloneStart, {
  payload: ProjectCloneStartInput,
  success: ProjectCloneStartResult,
  error: Schema.Union([
    SourceControlRepositoryError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsProjectCloneCancelRpc = Rpc.make(WS_METHODS.projectCloneCancel, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: EnvironmentAuthorizationError,
});

const WsProjectCloneRetryRpc = Rpc.make(WS_METHODS.projectCloneRetry, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSubscribeProjectClonesRpc = Rpc.make(WS_METHODS.subscribeProjectClones, {
  payload: ProjectCloneSubscribeInput,
  success: ProjectCloneListEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSourceControlPublishRepositoryRpc = Rpc.make(WS_METHODS.sourceControlPublishRepository, {
  payload: SourceControlPublishRepositoryInput,
  success: SourceControlPublishRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

const WsProjectsMutateRpc = Rpc.make(WS_METHODS.projectsMutate, {
  payload: ProjectMutation,
  success: Project,
  error: Schema.Union([ProjectMutationError, EnvironmentAuthorizationError]),
});

// Finds or creates the Scratch project rooted at ServerConfig.scratchWorkspaceRoot.
const WsProjectsEnsureScratchRpc = Rpc.make(WS_METHODS.projectsEnsureScratch, {
  payload: Schema.Struct({}),
  success: ProjectEnsureScratchResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

// Makes a folder under ServerConfig.newProjectsRoot with a first commit, then the project.
const WsProjectsCreateNewRpc = Rpc.make(WS_METHODS.projectsCreateNew, {
  payload: ProjectCreateNewInput,
  success: ProjectCreateNewResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsCodexSessionsListRpc = Rpc.make(WS_METHODS.codexSessionsList, {
  payload: CodexSessionsListInput,
  success: CodexSessionsListResult,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

export const WsCodexSessionsResumeRpc = Rpc.make(WS_METHODS.codexSessionsResume, {
  payload: CodexSessionsResumeInput,
  success: CodexSessionsResumeResult,
  error: Schema.Union([
    ForkMaintenanceError,
    EnvironmentAuthorizationError,
    NativeSessionResumeError,
  ]),
});

const WsAgentSessionsScanRpc = Rpc.make(WS_METHODS.agentSessionsScan, {
  payload: AgentSessionScanInput,
  success: AgentSessionScanResult,
  error: Schema.Union([AgentSessionScanError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsImportRpc = Rpc.make(WS_METHODS.agentSessionsImport, {
  payload: AgentSessionImportInput,
  success: AgentSessionImportResult,
  error: Schema.Union([
    AgentSessionImportProjectChangedError,
    AgentSessionImportProjectNotFoundError,
    AgentSessionScanError,
    EnvironmentAuthorizationError,
  ]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

const WsAssetsPersistChatAttachmentsRpc = Rpc.make(WS_METHODS.assetsPersistChatAttachments, {
  payload: PersistChatAttachmentsInput,
  success: PersistChatAttachmentsResult,
  error: Schema.Union([PersistChatAttachmentsError, EnvironmentAuthorizationError]),
});

const WsAttachmentsCreateUploadUrlRpc = Rpc.make(WS_METHODS.attachmentsCreateUploadUrl, {
  payload: AttachmentCreateUploadUrlInput,
  success: AttachmentCreateUploadUrlResult,
  error: Schema.Union([AttachmentUploadSigningKeyError, EnvironmentAuthorizationError]),
});

const WsAttachmentsDeleteRpc = Rpc.make(WS_METHODS.attachmentsDelete, {
  payload: AttachmentDeleteInput,
  error: EnvironmentAuthorizationError,
});

const WsProviderUploadFeedbackRpc = Rpc.make(WS_METHODS.providerUploadFeedback, {
  payload: ProviderUploadFeedbackInput,
  success: ProviderUploadFeedbackResult,
  error: Schema.Union([ProviderUploadFeedbackError, EnvironmentAuthorizationError]),
});

const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusSubscriptionInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsWorktreeStorageUsageRpc = Rpc.make(WS_METHODS.vcsWorktreeStorageUsage, {
  payload: VcsStatusInput,
  success: Schema.NullOr(WorktreeStorageUsage),
  error: EnvironmentAuthorizationError,
});

const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsRefreshStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsSubscribeWorktreeSetupRpc = Rpc.make(WS_METHODS.subscribeWorktreeSetup, {
  payload: WorktreeSetupSubscribeInput,
  success: WorktreeSetupStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsWorktreeSetupCancelRpc = Rpc.make(WS_METHODS.worktreeSetupCancel, {
  payload: WorktreeSetupCancelInput,
  success: WorktreeSetupCancelResult,
  error: EnvironmentAuthorizationError,
});

const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalObserveRpc = Rpc.make(WS_METHODS.terminalObserve, {
  payload: TerminalObserveInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewAdjustRpc = Rpc.make(WS_METHODS.previewAdjust, {
  payload: PreviewAdjustInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

const WsPreviewClearProfileRpc = Rpc.make(WS_METHODS.previewClearProfile, {
  payload: PreviewClearProfileInput,
  error: Schema.Union([PreviewClearProfileError, EnvironmentAuthorizationError]),
});

const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

/**
 * Viewers that cannot render their own webview attach here. Errors stay on the
 * stream as `unavailable` events rather than failing the call, so a viewer that
 * attaches before a host connects just waits.
 */
export const WsPreviewAttachRpc = Rpc.make(WS_METHODS.previewAttach, {
  payload: PreviewAttachInput,
  success: PreviewFrameStreamEvent,
  error: Schema.Union([ForkMaintenanceError, PreviewError, EnvironmentAuthorizationError]),
  stream: true,
});

/** Host to server. Fire and forget: a dropped frame is always recoverable. */
export const WsPreviewPublishFrameRpc = Rpc.make(WS_METHODS.previewPublishFrame, {
  payload: PreviewPublishFrameInput,
  error: Schema.Union([ForkMaintenanceError, PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewInputRpc = Rpc.make(WS_METHODS.previewInput, {
  payload: PreviewInputInput,
  error: Schema.Union([
    ForkMaintenanceError,
    PreviewError,
    PreviewAutomationError,
    EnvironmentAuthorizationError,
  ]),
});

/** Resolves the element under a point for a viewer with no page to pick in. */
export const WsPreviewPickElementRpc = Rpc.make(WS_METHODS.previewPickElement, {
  payload: PreviewPickElementInput,
  success: PreviewPickElementResult,
  error: Schema.Union([
    ForkMaintenanceError,
    PreviewError,
    PreviewAutomationError,
    EnvironmentAuthorizationError,
  ]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(WS_METHODS.subscribeDiscoveredLocalServers, {
  payload: Schema.Struct({
    configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
  }),
  success: DiscoveredLocalServerList,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsDeviceTestHostRpc = Rpc.make(WS_METHODS.deviceTestHost, {
  payload: SshDeviceHostConfig,
  success: DeviceHostSummary,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceListRpc = Rpc.make(WS_METHODS.deviceList, {
  payload: DeviceListInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceConfigureRpc = Rpc.make(WS_METHODS.deviceConfigure, {
  payload: DeviceConfigureInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceOpenRpc = Rpc.make(WS_METHODS.deviceOpen, {
  payload: DeviceOpenInput,
  success: DeviceSession,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceCloseRpc = Rpc.make(WS_METHODS.deviceClose, {
  payload: DeviceCloseInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceShutdownRpc = Rpc.make(WS_METHODS.deviceShutdown, {
  payload: DeviceShutdownInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceDetailRpc = Rpc.make(WS_METHODS.deviceDetail, {
  payload: DeviceDetailInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceActionRpc = Rpc.make(WS_METHODS.deviceAction, {
  payload: DeviceActionInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsSubscribeDeviceStateRpc = Rpc.make(WS_METHODS.subscribeDeviceState, {
  payload: Schema.Struct({}),
  success: DeviceServiceState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsOrchestrationV2DispatchCommandRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
  payload: OrchestrationV2RpcSchemas.dispatchCommand.input,
  success: OrchestrationV2RpcSchemas.dispatchCommand.output,
  error: Schema.Union([OrchestrationV2DispatchCommandError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetTurnDiffRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnDiff, {
  payload: OrchestrationV2RpcSchemas.getTurnDiff.input,
  success: OrchestrationV2RpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationV2RpcSchemas.getFullThreadDiff.input,
    success: OrchestrationV2RpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2SearchThreadsRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationSearchThreadsResult,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetThreadProjectionRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  {
    payload: OrchestrationV2RpcSchemas.getThreadProjection.input,
    success: OrchestrationV2RpcSchemas.getThreadProjection.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationV2RpcSchemas.getWorkflowScript.input,
    success: OrchestrationV2RpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetTurnItemRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
  payload: OrchestrationV2RpcSchemas.getTurnItem.input,
  success: OrchestrationV2RpcSchemas.getTurnItem.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2LaunchThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
  payload: OrchestrationV2RpcSchemas.launchThread.input,
  success: OrchestrationV2RpcSchemas.launchThread.output,
  error: Schema.Union([OrchestrationV2ThreadLaunchError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2SubscribeArchivedShellRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
  {
    payload: OrchestrationV2RpcSchemas.subscribeArchivedShell.input,
    success: OrchestrationV2RpcSchemas.subscribeArchivedShell.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsOrchestrationV2SubscribeShellRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
  payload: OrchestrationV2RpcSchemas.subscribeShell.input,
  success: OrchestrationV2RpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
  payload: OrchestrationV2RpcSchemas.subscribeThread.input,
  success: OrchestrationV2RpcSchemas.subscribeThread.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({
    /**
     * Whether this client understands `environmentThemesUpdated` events.
     * Already-shipped clients decode the stream against the old event union
     * and would die on an unknown member, so the server emits the theme
     * stream only to subscribers that ask for it. Absent on old clients;
     * dropped by old servers.
     */
    environmentThemes: Schema.optional(Schema.Boolean),
    /** Whether this client understands `usageLimitSourcesUpdated` events. */
    usageLimitSources: Schema.optional(Schema.Boolean),
    /**
     * Whether this client answers `/usage-limits` itself. The server injects
     * that command into provider catalogs only for such clients; an older
     * client would send it to the provider as an ordinary prompt.
     */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
  }),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsScheduledTasksListRpc = Rpc.make(WS_METHODS.scheduledTasksList, {
  payload: ScheduledTaskListInput,
  success: ScheduledTaskListResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

/** Streams the full scheduled-task list: one snapshot on subscribe, then a fresh list after every change. */
const WsScheduledTasksSubscribeRpc = Rpc.make(WS_METHODS.scheduledTasksSubscribe, {
  payload: ScheduledTaskListInput,
  success: ScheduledTaskListResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsScheduledTasksUpsertRpc = Rpc.make(WS_METHODS.scheduledTasksUpsert, {
  payload: ScheduledTaskUpsertInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksSetEnabledRpc = Rpc.make(WS_METHODS.scheduledTasksSetEnabled, {
  payload: ScheduledTaskSetEnabledInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksDeleteRpc = Rpc.make(WS_METHODS.scheduledTasksDelete, {
  payload: ScheduledTaskDeleteInput,
  success: ScheduledTaskDeleteResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRunNowRpc = Rpc.make(WS_METHODS.scheduledTasksRunNow, {
  payload: ScheduledTaskRunNowInput,
  success: ScheduledTaskRunNowResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRotateWebhookTokenRpc = Rpc.make(
  WS_METHODS.scheduledTasksRotateWebhookToken,
  {
    payload: ScheduledTaskRotateWebhookTokenInput,
    success: ScheduledTaskMutationResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsSecretsAnswerRequestRpc = Rpc.make(WS_METHODS.secretsAnswerRequest, {
  payload: SecretRequestAnswerInput,
  error: Schema.Union([SecretRequestError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksListWebhookDeliveriesRpc = Rpc.make(
  WS_METHODS.scheduledTasksListWebhookDeliveries,
  {
    payload: ScheduledTaskListWebhookDeliveriesInput,
    success: ScheduledTaskListWebhookDeliveriesResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsScheduledTasksGetWebhookDeliveryRpc = Rpc.make(
  WS_METHODS.scheduledTasksGetWebhookDelivery,
  {
    payload: ScheduledTaskGetWebhookDeliveryInput,
    success: ScheduledTaskGetWebhookDeliveryResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Checks the connection's scopes against the scope each RPC declares, before
 * the handler runs. Every RPC in `WsRpcGroup` carries it, so a handler cannot
 * be added without authorization.
 */
export class RpcScopeAuthorization extends RpcMiddleware.Service<RpcScopeAuthorization>()(
  "t3/contracts/RpcScopeAuthorization",
  // Held work is reported as a maintenance error: the token is fine, the device is mid-update.
  { error: Schema.Union([EnvironmentAuthorizationError, ForkMaintenanceError]) },
) {}

const WsThreadExportRpc = Rpc.make(WS_METHODS.threadExport, {
  payload: ThreadExportInput,
  success: ThreadExportResult,
  error: Schema.Union([ForkMaintenanceError, ThreadExportError, EnvironmentAuthorizationError]),
});

export const WsRpcGroup = RpcGroup.make(
  WsThreadExportRpc,
  WsOrganizationsListRpc,
  WsOrganizationsCreateRpc,
  WsOrganizationsGetRpc,
  WsOrganizationsGetPublishedConfigRpc,
  WsOrganizationsMutateRpc,
  WsOrganizationsBindProjectRpc,
  WsOrganizationsDetachProjectRpc,
  WsOrganizationsPublishRpc,
  WsOrganizationsSetLifecycleRpc,
  WsOrganizationsListAuditRpc,
  WsOrganizationsReadProviderBudgetsRpc,
  WsOrganizationsGetProviderBudgetRpc,
  WsOrganizationsUpdateProviderBudgetRpc,
  WsOrganizationsRepositoryPreviewRpc,
  WsOrganizationsRepositoryLinkRpc,
  WsOrganizationsRepositoryLoadRpc,
  WsOrganizationsRepositorySyncRpc,
  WsOrganizationsRepositoryStatusRpc,
  WsOrganizationsRepositoryListRecordsRpc,
  WsOrganizationsRepositoryResolveConflictRpc,
  WsOrganizationsRegisterSourceRpc,
  WsOrganizationsRotateSourceSecretRpc,
  WsOrganizationsSetSourceEnabledRpc,
  WsOrganizationsListSourcesRpc,
  WsOrganizationsIngestManualRpc,
  WsOrganizationsRetryCorrelationRpc,
  WsOrganizationsListObservationsRpc,
  WsOrganizationsListCorrelationJobsRpc,
  WsOrganizationsListFindingsRpc,
  WsOrganizationsListIntakeAuditRpc,
  WsOrganizationsListWorkRpc,
  WsOrganizationsListWorkIntentsRpc,
  WsOrganizationsListWorkFailuresRpc,
  WsOrganizationsGetWorkRuntimeStatusRpc,
  WsOrganizationsActivateWorkIntentRpc,
  WsOrganizationsCancelWorkRpc,
  WsOrganizationsRequestWorkDrainRpc,
  WsOrganizationsGetWorkDrainStatusRpc,
  WsOrganizationsRequestEmergencyStopRpc,
  WsOrganizationsGetEmergencyStopStatusRpc,
  WsOrganizationsCreateStandingWorkAuthorizationRpc,
  WsOrganizationsListStandingWorkAuthorizationsRpc,
  WsOrganizationsRevokeStandingWorkAuthorizationRpc,
  WsOrganizationsReviewWorkRpc,
  WsOrganizationsDecideWorkApprovalRpc,
  WsOrganizationsArchitectListRpc,
  WsOrganizationsArchitectSendRpc,
  WsOrganizationsArchitectApplyBatchRpc,
  WsOrganizationsMemoryListRpc,
  WsOrganizationsMemoryHistoryRpc,
  WsOrganizationsMemoryCreateRpc,
  WsOrganizationsMemoryCorrectRpc,
  WsOrganizationsMemorySupersedeRpc,
  WsOrganizationsMemoryArchiveRpc,
  WsOrganizationsProposalListRpc,
  WsOrganizationsProposalDecideRpc,
  WsOrganizationsObservationModeGetRpc,
  WsOrganizationsObservationModeSetRpc,
  WsOrganizationsDirectorListRpc,
  WsOrganizationsDirectorAskRpc,
  WsAgentDashboardGetSnapshotRpc,
  WsAgentDashboardDismissFeedCardRpc,
  WsAgentDashboardClearFeedRpc,
  WsAgentDashboardReviewSuggestionRpc,
  WsAgentDashboardRunInvestigationRpc,
  WsAgentDashboardRetryRunRpc,
  WsAgentDashboardCreateGithubIssueRpc,
  WsAgentDashboardListProjectPullRequestsRpc,
  WsAgentDashboardMergeProjectPullRequestRpc,
  WsAgentDashboardApplyFindingActionRpc,
  WsAgentDashboardLinkFindingThreadRpc,
  WsAgentDashboardUpdateRepositoryPolicyRpc,
  WsAgentDashboardCollectRpc,
  WsAgentDashboardAddResearchWatchItemRpc,
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsProviderConsumeResetCreditRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthCompleteRpc,
  WsChatGptReconnectProfileRpc,
  WsChatGptImportProfileRpc,
  WsChatGptHandoffSubscribeRpc,
  WsCodexAuthCallbackSubscribeRpc,
  WsProviderAuthRespondRpc,
  WsProviderAuthCancelRpc,
  WsProviderAuthLogoutRpc,
  WsProviderAuthSubscribeRpc,
  WsProviderInstallStartRpc,
  WsProviderInstallCancelRpc,
  WsProviderInstallSubscribeRpc,
  WsProviderInstallRemoveRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerCommitDesktopUpdateRpc,
  WsServerGetMaintenanceStatusRpc,
  WsServerUpdateMaintenancePolicyRpc,
  WsServerRunMaintenanceActionRpc,
  WsServerRecoverMaintenanceRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerSearchAcpRegistryRpc,
  WsServerPrepareAcpRegistryAgentRpc,
  WsServerUninstallAcpRegistryManagedBinaryRpc,
  WsServerAcceptAcpRegistryUrlAuthRpc,
  WsServerListAcpRegistrySessionsRpc,
  WsServerImportAcpRegistrySessionRpc,
  WsServerDeleteAcpRegistrySessionRpc,
  WsServerListAcpRegistryProvidersRpc,
  WsServerSetAcpRegistryProviderRpc,
  WsServerDisableAcpRegistryProviderRpc,
  WsServerLogoutAcpRegistryRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetHostResourcesRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshUsageRatesRpc,
  WsServerSignalProcessRpc,
  WsScheduledTasksListRpc,
  WsScheduledTasksSubscribeRpc,
  WsScheduledTasksUpsertRpc,
  WsScheduledTasksSetEnabledRpc,
  WsScheduledTasksDeleteRpc,
  WsScheduledTasksRunNowRpc,
  WsScheduledTasksRotateWebhookTokenRpc,
  WsSecretsAnswerRequestRpc,
  WsScheduledTasksListWebhookDeliveriesRpc,
  WsScheduledTasksGetWebhookDeliveryRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsSummaryRpc,
  WsPullRequestsRoutingRpc,
  WsPullRequestsRoutingIdentityRpc,
  WsPullRequestsStackRpc,
  WsPullRequestsLinkedThreadsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsPreviewRpc,
  WsPullRequestsChecksRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsThreadCommentsRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsFilesViewedRpc,
  WsPullRequestsSetFilesViewedRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsSubscribeRefreshesRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsPullRequestsLabelCandidatesRpc,
  WsPullRequestsSetLabelsRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectCloneStartRpc,
  WsProjectCloneCancelRpc,
  WsProjectCloneRetryRpc,
  WsSubscribeProjectClonesRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsEnsureScratchRpc,
  WsProjectsCreateNewRpc,
  WsProjectsWriteFileRpc,
  WsProjectsMutateRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsCodexSessionsListRpc,
  WsCodexSessionsResumeRpc,
  WsAgentSessionsScanRpc,
  WsAgentSessionsImportRpc,
  WsAssetsCreateUrlRpc,
  WsAssetsPersistChatAttachmentsRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsProviderUploadFeedbackRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
  WsWorktreeSetupCancelRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsVcsWorktreeStorageUsageRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalObserveRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewAdjustRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewClearProfileRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAttachRpc,
  WsPreviewPublishFrameRpc,
  WsPreviewInputRpc,
  WsPreviewPickElementRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsDeviceConfigureRpc,
  WsDeviceListRpc,
  WsDeviceTestHostRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceShutdownRpc,
  WsDeviceDetailRpc,
  WsDeviceActionRpc,
  WsSubscribeDeviceStateRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationV2DispatchCommandRpc,
  WsOrchestrationV2GetWorkflowScriptRpc,
  WsOrchestrationV2GetTurnItemRpc,
  WsOrchestrationV2GetTurnDiffRpc,
  WsOrchestrationV2GetFullThreadDiffRpc,
  WsOrchestrationV2SearchThreadsRpc,
  WsOrchestrationV2GetArchivedShellSnapshotRpc,
  WsOrchestrationV2GetThreadProjectionRpc,
  WsOrchestrationV2LaunchThreadRpc,
  WsOrchestrationV2SubscribeArchivedShellRpc,
  WsOrchestrationV2SubscribeShellRpc,
  WsOrchestrationV2SubscribeThreadRpc,
).middleware(RpcScopeAuthorization);

export const ForkWsRpcGroup = RpcGroup.make(
  WsOrganizationsListRpc,
  WsOrganizationsCreateRpc,
  WsOrganizationsGetRpc,
  WsOrganizationsGetPublishedConfigRpc,
  WsOrganizationsMutateRpc,
  WsOrganizationsBindProjectRpc,
  WsOrganizationsDetachProjectRpc,
  WsOrganizationsPublishRpc,
  WsOrganizationsSetLifecycleRpc,
  WsOrganizationsListAuditRpc,
  WsOrganizationsReadProviderBudgetsRpc,
  WsOrganizationsGetProviderBudgetRpc,
  WsOrganizationsUpdateProviderBudgetRpc,
  WsOrganizationsRepositoryPreviewRpc,
  WsOrganizationsRepositoryLinkRpc,
  WsOrganizationsRepositoryLoadRpc,
  WsOrganizationsRepositorySyncRpc,
  WsOrganizationsRepositoryStatusRpc,
  WsOrganizationsRepositoryListRecordsRpc,
  WsOrganizationsRepositoryResolveConflictRpc,
  WsOrganizationsRegisterSourceRpc,
  WsOrganizationsRotateSourceSecretRpc,
  WsOrganizationsSetSourceEnabledRpc,
  WsOrganizationsListSourcesRpc,
  WsOrganizationsIngestManualRpc,
  WsOrganizationsRetryCorrelationRpc,
  WsOrganizationsListObservationsRpc,
  WsOrganizationsListCorrelationJobsRpc,
  WsOrganizationsListFindingsRpc,
  WsOrganizationsListIntakeAuditRpc,
  WsOrganizationsListWorkRpc,
  WsOrganizationsListWorkIntentsRpc,
  WsOrganizationsListWorkFailuresRpc,
  WsOrganizationsGetWorkRuntimeStatusRpc,
  WsOrganizationsActivateWorkIntentRpc,
  WsOrganizationsCancelWorkRpc,
  WsOrganizationsRequestWorkDrainRpc,
  WsOrganizationsGetWorkDrainStatusRpc,
  WsOrganizationsRequestEmergencyStopRpc,
  WsOrganizationsGetEmergencyStopStatusRpc,
  WsOrganizationsCreateStandingWorkAuthorizationRpc,
  WsOrganizationsListStandingWorkAuthorizationsRpc,
  WsOrganizationsRevokeStandingWorkAuthorizationRpc,
  WsOrganizationsReviewWorkRpc,
  WsOrganizationsDecideWorkApprovalRpc,
  WsOrganizationsArchitectListRpc,
  WsOrganizationsArchitectSendRpc,
  WsOrganizationsArchitectApplyBatchRpc,
  WsOrganizationsMemoryListRpc,
  WsOrganizationsMemoryHistoryRpc,
  WsOrganizationsMemoryCreateRpc,
  WsOrganizationsMemoryCorrectRpc,
  WsOrganizationsMemorySupersedeRpc,
  WsOrganizationsMemoryArchiveRpc,
  WsOrganizationsProposalListRpc,
  WsOrganizationsProposalDecideRpc,
  WsOrganizationsObservationModeGetRpc,
  WsOrganizationsObservationModeSetRpc,
  WsOrganizationsDirectorListRpc,
  WsOrganizationsDirectorAskRpc,
  WsAgentDashboardGetSnapshotRpc,
  WsAgentDashboardDismissFeedCardRpc,
  WsAgentDashboardClearFeedRpc,
  WsAgentDashboardReviewSuggestionRpc,
  WsAgentDashboardRunInvestigationRpc,
  WsAgentDashboardRetryRunRpc,
  WsAgentDashboardCreateGithubIssueRpc,
  WsAgentDashboardListProjectPullRequestsRpc,
  WsAgentDashboardMergeProjectPullRequestRpc,
  WsAgentDashboardApplyFindingActionRpc,
  WsAgentDashboardLinkFindingThreadRpc,
  WsAgentDashboardUpdateRepositoryPolicyRpc,
  WsAgentDashboardCollectRpc,
  WsAgentDashboardAddResearchWatchItemRpc,
).middleware(RpcScopeAuthorization);

export const ForkExtraWsRpcGroup = RpcGroup.make(
  WsThreadExportRpc,
  WsCodexSessionsListRpc,
  WsCodexSessionsResumeRpc,
  WsPreviewAttachRpc,
  WsPreviewPublishFrameRpc,
  WsPreviewInputRpc,
  WsPreviewPickElementRpc,
).middleware(RpcScopeAuthorization);

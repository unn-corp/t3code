/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_DiscordBridge.ts";
import Migration0037 from "./Migrations/037_BackfillProjectionThreadsLatestTurn.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinned.ts";
import Migration0039 from "./Migrations/039_CanonicalizeLegacyReviewRuntimeMode.ts";
import Migration0040 from "./Migrations/040_ProjectionTurnsKeysetIndex.ts";
import Migration0041 from "./Migrations/041_ProjectionThreadsPinOrderKey.ts";
import Migration0042 from "./Migrations/042_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0043 from "./Migrations/043_ProjectionProjectFaviconPath.ts";
import Migration0044 from "./Migrations/044_AuthSessionClientConnection.ts";
import Migration0045 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0046 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectGitHubAccount.ts";
import Migration0048 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0049 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0050 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0051 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0052 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0053 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0054 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0055 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0056 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0057 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0058 from "./Migrations/058_ProjectionThreadActivitiesKindIndex.ts";
import Migration0059 from "./Migrations/059_Organizations.ts";
import Migration0060 from "./Migrations/060_OrganizationWorkflows.ts";
import Migration0061 from "./Migrations/061_OrganizationIntake.ts";
import Migration0062 from "./Migrations/062_OrganizationWork.ts";
import Migration0063 from "./Migrations/063_OrganizationFindingEvidence.ts";
import Migration0064 from "./Migrations/064_OrganizationArchitectTranscript.ts";
import Migration0065 from "./Migrations/065_OrganizationArchitectTranscriptCompatibility.ts";
import Migration0066 from "./Migrations/066_OrganizationMemory.ts";
import Migration0067 from "./Migrations/067_OrganizationCorrelationRecovery.ts";
import Migration0068 from "./Migrations/068_OrganizationProposals.ts";
import Migration0069 from "./Migrations/069_OrganizationDirectorTranscript.ts";
import Migration0070 from "./Migrations/070_OrganizationResourcePermits.ts";
import Migration0071 from "./Migrations/071_OrganizationWorkScopes.ts";
import Migration0072 from "./Migrations/072_OrganizationWorkArtifacts.ts";
import Migration0073 from "./Migrations/073_OrganizationWorkQAReceipts.ts";
import Migration0074 from "./Migrations/074_OrganizationWorkApprovalReceipts.ts";
import Migration0075 from "./Migrations/075_OrganizationWorkIntegrationReceipts.ts";
import Migration0076 from "./Migrations/076_OrganizationGitCandidateIntents.ts";
import Migration0077 from "./Migrations/077_OrganizationScopePreparation.ts";
import Migration0078 from "./Migrations/078_OrganizationReservedScopeUnits.ts";
import Migration0079 from "./Migrations/079_OrganizationGitIntegrationIntents.ts";
import Migration0080 from "./Migrations/080_OrganizationScopeReservationCompatibility.ts";
import Migration0081 from "./Migrations/081_OrganizationProviderBudgets.ts";
import Migration0082 from "./Migrations/082_OrganizationWorkIntents.ts";
import Migration0083 from "./Migrations/083_OrganizationProviderBudgetAudit.ts";
import Migration0084 from "./Migrations/084_OrganizationScopeLaunchRequested.ts";
import Migration0085 from "./Migrations/085_OrganizationRepositories.ts";
import Migration0086 from "./Migrations/086_OrganizationScopeRecoveryReceipts.ts";
import Migration0087 from "./Migrations/087_OrganizationWorkIntentActivations.ts";
import Migration0088 from "./Migrations/088_OrganizationLiveWorkFailures.ts";
import Migration0089 from "./Migrations/089_OrganizationLiveWorkDrains.ts";
import Migration0090 from "./Migrations/090_OrganizationEmergencyStops.ts";
import Migration0091 from "./Migrations/091_OrganizationStandingWorkAuthorizations.ts";
import Migration0092 from "./Migrations/092_OrganizationEmergencyProcessRecovery.ts";
import Migration0093 from "./Migrations/093_OrganizationProviderLaunchMarkers.ts";
import Migration0094 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

import Migration0095 from "./Migrations/055_OrchestrationV2.ts";
import Migration0096 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0097 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0098 from "./Migrations/058_WebhookRelayDeliveries.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "DiscordBridge", Migration0036],
  [37, "BackfillProjectionThreadsLatestTurn", Migration0037],
  [38, "ProjectionThreadsPinned", Migration0038],
  [39, "CanonicalizeLegacyReviewRuntimeMode", Migration0039],
  [40, "ProjectionTurnsKeysetIndex", Migration0040],
  [41, "ProjectionThreadsPinOrderKey", Migration0041],
  [42, "ProjectionProjectsDefaultThreadEnvMode", Migration0042],
  [43, "ProjectionProjectFaviconPath", Migration0043],
  [44, "AuthSessionClientConnection", Migration0044],
  [45, "ProjectionThreadLinkedPullRequest", Migration0045],
  [46, "ProjectionThreadsUnsettledAt", Migration0046],
  [47, "ProjectionProjectGitHubAccount", Migration0047],
  [48, "ClearAutomaticProjectModelDefaults", Migration0048],
  [49, "ProjectionProjectsAutoPull", Migration0049],
  [50, "RepairAutomaticSettlementTimestamps", Migration0050],
  [51, "ProjectionProjectIcon", Migration0051],
  [52, "ProjectionThreadBranchPullRequest", Migration0052],
  [53, "ProjectionThreadsActiveOrderKey", Migration0053],
  [54, "ProjectionThreadPullRequests", Migration0054],
  [55, "ProjectionThreadMessageContext", Migration0055],
  [56, "ProjectionThreadTitleState", Migration0056],
  [57, "PullRequestFilesViewed", Migration0057],
  [58, "ProjectionThreadActivitiesKindIndex", Migration0058],
  [59, "Organizations", Migration0059],
  [60, "OrganizationWorkflows", Migration0060],
  [61, "OrganizationIntake", Migration0061],
  [62, "OrganizationWork", Migration0062],
  [63, "OrganizationFindingEvidence", Migration0063],
  [64, "OrganizationArchitectTranscript", Migration0064],
  [65, "OrganizationArchitectTranscriptCompatibility", Migration0065],
  [66, "OrganizationMemory", Migration0066],
  [67, "OrganizationCorrelationRecovery", Migration0067],
  [68, "OrganizationProposals", Migration0068],
  [69, "OrganizationDirectorTranscript", Migration0069],
  [70, "OrganizationResourcePermits", Migration0070],
  [71, "OrganizationWorkScopes", Migration0071],
  [72, "OrganizationWorkArtifacts", Migration0072],
  [73, "OrganizationWorkQAReceipts", Migration0073],
  [74, "OrganizationWorkApprovalReceipts", Migration0074],
  [75, "OrganizationWorkIntegrationReceipts", Migration0075],
  [76, "OrganizationGitCandidateIntents", Migration0076],
  [77, "OrganizationScopePreparation", Migration0077],
  [78, "OrganizationReservedScopeUnits", Migration0078],
  [79, "OrganizationGitIntegrationIntents", Migration0079],
  [80, "OrganizationScopeReservationCompatibility", Migration0080],
  [81, "OrganizationProviderBudgets", Migration0081],
  [82, "OrganizationWorkIntents", Migration0082],
  [83, "OrganizationProviderBudgetAudit", Migration0083],
  [84, "OrganizationScopeLaunchRequested", Migration0084],
  [85, "OrganizationRepositories", Migration0085],
  [86, "OrganizationScopeRecoveryReceipts", Migration0086],
  [87, "OrganizationWorkIntentActivations", Migration0087],
  [88, "OrganizationLiveWorkFailures", Migration0088],
  [89, "OrganizationLiveWorkDrains", Migration0089],
  [90, "OrganizationEmergencyStops", Migration0090],
  [91, "OrganizationStandingWorkAuthorizations", Migration0091],
  [92, "OrganizationEmergencyProcessRecovery", Migration0092],
  [93, "OrganizationProviderLaunchMarkers", Migration0093],
  [94, "ProjectionThreadsAutoSettleDisabledAt", Migration0094],
  [95, "OrchestrationV2", Migration0095],
  [96, "RemoveRedundantProjectionIndexes", Migration0096],
  [97, "ScheduledTaskWebhooks", Migration0097],
  [98, "WebhookRelayDeliveries", Migration0098],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const previewMigrations =
    toMigrationInclusive === undefined ? yield* reconcileV2PreviewMigration(migrationEntries) : [];
  const executedMigrations = [
    ...previewMigrations,
    ...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })),
  ];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  // The migrator keys on migration_id: a database that recorded a different
  // migration under a shared id (local or fork builds) keeps that id and
  // silently skips this build's migration at it. Surface the divergence so the
  // skipped schema change is diagnosable.
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});

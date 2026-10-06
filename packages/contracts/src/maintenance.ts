import * as Schema from "effect/Schema";

/** Additive fork protocol. Absence means manual bootstrap, never legacy installation. */
export const FORK_MAINTENANCE_PROTOCOL = 1;
export const ForkUpdateChannel = Schema.Literals(["stable", "nightly"]);
export type ForkUpdateChannel = typeof ForkUpdateChannel.Type;
export const ForkUpdatePhase = Schema.Literals([
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "staged",
  "waiting",
  "installing",
  "verifying",
  "completed",
  "failed",
  "recovery",
  "pinned",
]);
export const ForkWaitingReason = Schema.Literals([
  "active-agents",
  "background-work",
  "commands",
  "unknown-participant",
  "idle-window",
  "input-active",
  "uploads",
  "storage",
  "launcher",
  "authorization",
  "offline",
  "transaction",
  "bootstrap",
  "automation-review",
]);
export const ForkBuildIdentity = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  channel: ForkUpdateChannel,
  artifactSha256: Schema.String,
  installationSequence: Schema.optionalKey(Schema.Int),
});
export type ForkBuildIdentity = typeof ForkBuildIdentity.Type;
export const ForkMaintenanceCapability = Schema.Struct({
  protocol: Schema.Literal(FORK_MAINTENANCE_PROTOCOL),
  coordinatorId: Schema.String,
  participantId: Schema.String,
  admission: Schema.Boolean,
  recovery: Schema.Boolean,
});
export type ForkMaintenanceCapability = typeof ForkMaintenanceCapability.Type;
export const ForkUpdatePolicy = Schema.Struct({
  channel: ForkUpdateChannel,
  automaticInstallation: Schema.Boolean,
  pinnedBuild: Schema.NullOr(Schema.String),
});
export type ForkUpdatePolicy = typeof ForkUpdatePolicy.Type;
export const ForkActivityBlocker = Schema.Struct({
  participantId: Schema.String,
  reason: ForkWaitingReason,
  threadId: Schema.optionalKey(Schema.String),
  label: Schema.String,
});
export type ForkActivityBlocker = typeof ForkActivityBlocker.Type;
export const ForkRecoveryHome = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  restoreTimestamp: Schema.String,
  binaryCompatible: Schema.Boolean,
  additionalBytes: Schema.Number,
  requiresPairing: Schema.Boolean,
});
export const ForkRecoveryOption = Schema.Struct({
  id: Schema.String,
  transactionId: Schema.String,
  build: ForkBuildIdentity,
  homes: Schema.Array(ForkRecoveryHome),
  requiresDataRestore: Schema.Boolean,
});
export type ForkRecoveryOption = typeof ForkRecoveryOption.Type;
/** A data home the update would replace. Only authoritative update targets appear: check-only runtimes never do. */
export const ForkAffectedHome = Schema.Struct({ id: Schema.String, label: Schema.String });
export type ForkAffectedHome = typeof ForkAffectedHome.Type;
export const ForkUpdateCountdown = Schema.Struct({
  startedAt: Schema.Number,
  installsAt: Schema.Number,
  targetArtifactSha256: Schema.String,
});
export type ForkUpdateCountdown = typeof ForkUpdateCountdown.Type;

export const ForkUpdateStatus = Schema.Struct({
  coordinatorId: Schema.String,
  /** Identifies one replacement target within a device coordinator; shared by its host aliases. */
  controllerId: Schema.optionalKey(Schema.String),
  phase: ForkUpdatePhase,
  policy: ForkUpdatePolicy,
  currentBuild: ForkBuildIdentity,
  targetBuild: Schema.NullOr(ForkBuildIdentity),
  blockers: Schema.Array(ForkActivityBlocker),
  recoveryOptions: Schema.Array(ForkRecoveryOption),
  transactionId: Schema.NullOr(Schema.String),
  automationReviewRequired: Schema.Boolean,
  nextCheckAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  countdown: Schema.optionalKey(Schema.NullOr(ForkUpdateCountdown)),
  lastError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  installable: Schema.optionalKey(Schema.Boolean),
  /** Homes (Windows and each WSL distribution, or this host's home) that installation snapshots and replaces. */
  affectedHomes: Schema.optionalKey(Schema.Array(ForkAffectedHome)),
});
export type ForkUpdateStatus = typeof ForkUpdateStatus.Type;

/** Automatic installation shows a cancellable countdown for this long before it begins. */
export const FORK_AUTOMATIC_INSTALL_COUNTDOWN_MS = 15_000;

export const ForkUpdatePolicyPatch = Schema.Struct({
  channel: Schema.optionalKey(ForkUpdateChannel),
  automaticInstallation: Schema.optionalKey(Schema.Boolean),
  /** Artifact digest of the build to hold, or null to resume updates. */
  pinnedBuild: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ForkUpdatePolicyPatch = typeof ForkUpdatePolicyPatch.Type;

/** Renderer-observed interaction that delays automatic installation. */
export const ForkMaintenanceInteraction = Schema.Struct({
  inputActiveAt: Schema.NullOr(Schema.Number),
  uploadsInFlight: Schema.Int,
});
export type ForkMaintenanceInteraction = typeof ForkMaintenanceInteraction.Type;

/** Bound to the exact build the person reviewed. A newer release never inherits the confirmation. */
export const ForkMaintenanceActionInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("check") }),
  Schema.Struct({ action: Schema.Literal("install"), targetArtifactSha256: Schema.String }),
  Schema.Struct({ action: Schema.Literal("cancel-countdown") }),
  /** The person confirms every fork installation on this device is registered. Lifts the `bootstrap` blocker. */
  Schema.Struct({ action: Schema.Literal("confirm-bootstrap") }),
  /** The person reviewed restored schedules and queues. Separate from resuming updates. */
  Schema.Struct({ action: Schema.Literal("acknowledge-automation-review") }),
]);
export type ForkMaintenanceActionInput = typeof ForkMaintenanceActionInput.Type;

/**
 * Names recorded identifiers only. Paths are never accepted. Every home's restore
 * timestamp must be echoed back so a changed snapshot set invalidates the confirmation.
 */
export const ForkRecoveryRequest = Schema.Struct({
  optionId: Schema.String,
  transactionId: Schema.String,
  restoreTimestamps: Schema.Record(Schema.String, Schema.String),
  /** Required when the option restores data or loses pairing. */
  acknowledgeDataRestore: Schema.Boolean,
});
export type ForkRecoveryRequest = typeof ForkRecoveryRequest.Type;

export class ForkMaintenanceError extends Schema.TaggedError<ForkMaintenanceError>()(
  "ForkMaintenanceError",
  {
    reason: Schema.String,
    blockers: Schema.optionalKey(Schema.Array(ForkActivityBlocker)),
  },
) {
  override get message() {
    return `Device maintenance: ${this.reason}`;
  }
}

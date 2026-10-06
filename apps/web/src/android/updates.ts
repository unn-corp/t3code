import type {
  ForkActivityBlocker,
  ForkBuildIdentity,
  ForkUpdateChannel,
  ForkUpdateStatus,
} from "@t3tools/contracts";
import { isAndroidPwa } from "../env";

/**
 * Adapter for the APK's native updater (`NativeUpdateController`). The native side owns release
 * discovery, verification, installation, recovery, and persisted pins; this module only relays
 * origin-restricted messages and reports phone activity that must hold an installation.
 */
export const ANDROID_UPDATER_COORDINATOR_ID = "android-native-updater";
export const ANDROID_UPDATER_PARTICIPANT_ID = "android-phone";

export type AndroidUpdateBlockerReason =
  | "unknown-participant"
  | "idle-window"
  | "commands"
  | "uploads"
  | "input-active"
  | "authorization"
  | "offline"
  | "transaction"
  | "bootstrap"
  | "launcher";

export interface AndroidUpdateBuild {
  readonly version: string;
  readonly commit: string;
  readonly versionCode: number;
  readonly channel: ForkUpdateChannel;
  readonly artifactSha256: string;
  readonly installationSequence?: number;
  readonly recovery?: boolean;
  readonly tag?: string;
}
export interface AndroidUpdatePin {
  readonly versionCode: number;
  readonly version: string;
  readonly commit: string;
  readonly reason: "rollback" | "manual";
  /** Digest of the held build, the identifier ForkUpdatePolicy.pinnedBuild carries. */
  readonly artifactSha256?: string;
}
/** A person's recorded request. It waits for the install guard and never changes the policy. */
export interface AndroidInstallRequest {
  readonly kind: "update" | "rollback";
  readonly targetArtifactSha256: string;
  readonly transactionId: string;
  readonly requestedAt: string;
}
export interface AndroidUpdateBlocker {
  readonly reason: AndroidUpdateBlockerReason;
  readonly label: string;
  /** Milliseconds until a time-based hold (the 2 minute background window) clears. */
  readonly retryAfterMs?: number;
}
export interface AndroidRecoveryBuild {
  readonly versionCode: number;
  readonly version: string;
  readonly commit: string;
  readonly sha256: string;
  /** Recorded with the option; native rejects it if the installed build has since changed. */
  readonly transactionId: string;
}
export interface AndroidUpdateStatus {
  readonly protocol: 1;
  /** False below Android 9 (API 28): signer inspection of downloaded APKs is unavailable. */
  readonly supported: boolean;
  readonly unsupportedReason: string | null;
  readonly phase: ForkUpdateStatus["phase"];
  readonly current: AndroidUpdateBuild;
  readonly policy: {
    readonly channel: ForkUpdateChannel;
    readonly automaticInstallation: boolean;
    readonly pin: AndroidUpdatePin | null;
  };
  readonly target: AndroidUpdateBuild | null;
  readonly blockers: ReadonlyArray<AndroidUpdateBlocker>;
  readonly recovery: {
    readonly ready: boolean;
    readonly cached: ReadonlyArray<AndroidRecoveryBuild>;
  };
  readonly installPermission: "granted" | "needed";
  /** True when Android lets this app replace itself without a confirmation sheet. */
  readonly silentInstall: boolean;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
  readonly transactionId: string | null;
  readonly confirmationPending: boolean;
  /** Present while an Install or Recovery request is waiting for the guard. */
  readonly installRequest: AndroidInstallRequest | null;
}

export type AndroidUpdateAction =
  | "status"
  | "check"
  | "configure"
  | "pin"
  | "resume"
  | "install"
  | "cancel"
  | "installPermission"
  | "confirmationPermission"
  | "recovery"
  | "openRecovery"
  | "healthy"
  | "operations";

interface UpdateBridge {
  postMessage(message: string): void;
  onmessage: ((event: { readonly data: string }) => void) | null;
}
declare global {
  interface Window {
    t3Updates?: UpdateBridge;
  }
}

const pending = new Map<
  string,
  { resolve: (value: AndroidUpdateStatus) => void; reject: (error: Error) => void }
>();
const listeners = new Set<(status: AndroidUpdateStatus) => void>();
let attached: UpdateBridge | undefined;
let sequence = 0;

export function supportsAndroidUpdates(): boolean {
  return isAndroidPwa && typeof window.t3Updates?.postMessage === "function";
}

function attach(bridge: UpdateBridge) {
  if (attached === bridge) return;
  attached = bridge;
  // AndroidX exposes one onmessage callback on its injected object.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  bridge.onmessage = ({ data }) => {
    try {
      const response: {
        id?: string;
        result?: AndroidUpdateStatus;
        error?: string;
        event?: AndroidUpdateStatus;
      } = JSON.parse(data);
      if (response.event) {
        for (const listener of listeners) listener(response.event);
        return;
      }
      const request = response.id ? pending.get(response.id) : undefined;
      if (!request || !response.id) return;
      pending.delete(response.id);
      if (response.error || !response.result)
        request.reject(new Error(response.error ?? "Invalid Android update response."));
      else request.resolve(response.result);
    } catch {
      /* A malformed or unrelated reply cannot settle a pending request. */
    }
  };
}

export function androidUpdateRequest(
  action: AndroidUpdateAction,
  payload: unknown = {},
  timeoutMs = 60_000,
): Promise<AndroidUpdateStatus> {
  const bridge = window.t3Updates;
  if (!supportsAndroidUpdates() || !bridge)
    return Promise.reject(new Error("In-app updates are unavailable in this Android build."));
  attach(bridge);
  const id = `${Date.now()}:${++sequence}`;
  return new Promise<AndroidUpdateStatus>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("The Android updater did not respond. Try again."));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => {
        window.clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    });
    try {
      // The native listener limits messages to the bundled app's main frame.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      bridge.postMessage(JSON.stringify({ id, action, payload }));
    } catch (error) {
      pending.delete(id);
      window.clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error("Could not contact the Android updater."));
    }
  });
}

export const getAndroidUpdateStatus = () => androidUpdateRequest("status");
/** Reads GitHub, never installs. Safe to call from a manual "Check now" button. */
export const checkAndroidUpdates = () => androidUpdateRequest("check", {}, 120_000);
export const configureAndroidUpdates = (change: {
  channel?: ForkUpdateChannel;
  automaticInstallation?: boolean;
}) => androidUpdateRequest("configure", change);
/** Holds the installed build: nothing installs until `resumeAndroidUpdates`. */
export const pinAndroidBuild = () => androidUpdateRequest("pin");
export const resumeAndroidUpdates = () => androidUpdateRequest("resume");
/**
 * Records a request to install the exact build the person reviewed. Native rejects a digest that is
 * no longer the verified target, and returns a waiting status: the install itself starts only after
 * the app has been backgrounded for two minutes and phone work has finished, whatever the
 * automatic-installation policy says. It never throws for those ordinary blockers.
 */
export const installAndroidUpdate = (targetArtifactSha256: string) =>
  androidUpdateRequest("install", { action: "install", targetArtifactSha256 });
/** Withdraws a waiting Install or Recovery request. */
export const cancelAndroidInstallRequest = () => androidUpdateRequest("cancel");
export const openAndroidUpdateConfirmationPermission = () =>
  androidUpdateRequest("confirmationPermission");
export const openAndroidInstallPermission = () => androidUpdateRequest("installPermission");
/** Opens the native recovery screen. */
export const openAndroidRecovery = () => androidUpdateRequest("openRecovery");
/** Requests the recorded recovery option; it waits like an install and never selects another build. */
export const requestAndroidRecovery = (optionId: string, transactionId: string) =>
  androidUpdateRequest("recovery", { optionId, transactionId });
/** Call once the shell has rendered; repeated launches without it enter native recovery. */
export const markAndroidShellHealthy = () => androidUpdateRequest("healthy");

export function subscribeAndroidUpdates(listener: (status: AndroidUpdateStatus) => void) {
  if (window.t3Updates) attach(window.t3Updates);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reports in-flight web uploads so an installation cannot replace the app mid-transfer. The hold
 * fails closed: a missing heartbeat never releases it, because it does not prove the transfer
 * stopped. Native drops it only when the count is reported as zero or the shell page is replaced
 * or destroyed (which cancels the transfer), and the process dying clears it. The heartbeat only
 * re-sends the count. Returns the release function; call it in `finally`, after the request has
 * actually ended. Without the bridge this is a no-op, so callers need no platform checks.
 */
export const UPLOAD_HEARTBEAT_MS = 30_000;
let activeUploads = 0;
let heartbeat: number | undefined;
function reportUploads() {
  if (!supportsAndroidUpdates()) return;
  void androidUpdateRequest("operations", { uploads: activeUploads }, 10_000).catch(() => {
    /* A missed reply never clears the native hold; the next heartbeat retries. */
  });
}
export function beginAndroidUpload(): (() => void) | Promise<() => void> {
  if (!supportsAndroidUpdates()) return () => undefined;
  return (async () => {
    activeUploads += 1;
    // The transfer cannot start until native has registered it against the installation fence.
    // A lost/rejected reply fails closed; callers have not sent any bytes yet.
    try {
      await androidUpdateRequest("operations", { uploads: activeUploads }, 10_000);
    } catch (error) {
      activeUploads = Math.max(0, activeUploads - 1);
      reportUploads();
      throw error;
    }
    heartbeat ??= window.setInterval(reportUploads, UPLOAD_HEARTBEAT_MS);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeUploads = Math.max(0, activeUploads - 1);
      reportUploads();
      if (activeUploads === 0 && heartbeat !== undefined) {
        window.clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
  })();
}

const COMMIT = /^[a-f0-9]{40}$/;
function toBuildIdentity(build: AndroidUpdateBuild): ForkBuildIdentity {
  return {
    version: build.version,
    commit: COMMIT.test(build.commit) ? build.commit : build.commit || "unknown",
    channel: build.channel,
    artifactSha256: build.artifactSha256,
    ...(build.installationSequence === undefined
      ? {}
      : { installationSequence: build.installationSequence }),
  };
}

/** Maps native state into the shared maintenance status the Settings UI renders for every host. */
export function toForkUpdateStatus(status: AndroidUpdateStatus): ForkUpdateStatus {
  const blockers: ForkActivityBlocker[] = status.blockers.map((blocker) => ({
    participantId: ANDROID_UPDATER_PARTICIPANT_ID,
    reason: blocker.reason,
    label: blocker.label,
  }));
  return {
    coordinatorId: ANDROID_UPDATER_COORDINATOR_ID,
    phase: status.phase,
    policy: {
      channel: status.policy.channel,
      automaticInstallation: status.policy.automaticInstallation,
      pinnedBuild: status.policy.pin
        ? status.policy.pin.artifactSha256 || status.policy.pin.version
        : null,
    },
    currentBuild: toBuildIdentity(status.current),
    targetBuild: status.target ? toBuildIdentity(status.target) : null,
    blockers: status.supported
      ? blockers
      : [
          {
            participantId: ANDROID_UPDATER_PARTICIPANT_ID,
            reason: "bootstrap",
            label: status.unsupportedReason ?? "In-app updates are unavailable.",
          },
        ],
    installable: status.supported && !!status.target && status.recovery.ready,
    lastError: status.lastError,
    // Native recovery restores code only; the APK's data is app-private and never rewritten.
    recoveryOptions: status.recovery.cached.map((build) => ({
      id: build.sha256,
      transactionId: build.transactionId,
      build: {
        version: build.version,
        commit: build.commit,
        channel: status.current.channel,
        artifactSha256: build.sha256,
      },
      homes: [],
      requiresDataRestore: false,
    })),
    transactionId: status.transactionId,
    automationReviewRequired: false,
  };
}

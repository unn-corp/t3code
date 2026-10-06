/**
 * Device-side policy for fork releases, shared by the server, the desktop app, and
 * client runtimes. Pure: no network, filesystem, or clock access.
 *
 * Eligibility mirrors the publisher's `classifyRelease` in scripts/fork-release-policy.ts.
 * forkMaintenance.parity.test.ts compares the two so they cannot drift.
 */
import {
  FORK_AUTOMATIC_INSTALL_COUNTDOWN_MS,
  type ForkActivityBlocker,
  type ForkReleaseManifest,
  type ForkUpdateChannel,
  type ForkUpdateCountdown,
} from "@t3tools/contracts";

export { FORK_AUTOMATIC_INSTALL_COUNTDOWN_MS };

export const FORK_TAG_PREFIX = "fork-v";
export const FORK_MANIFEST_ASSET = "fork-release.json";
export const FORK_RELEASES_API = "https://api.github.com/repos/unn-corp/t3code/releases";
export const FORK_RELEASE_DOWNLOAD_ORIGIN = "https://github.com/unn-corp/t3code/releases/download/";
/** Managed hosts check at this cadence. The desktop keeps its existing check cadence. */
export const FORK_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Desktop and standalone hosts install only after this much input and upload inactivity. */
export const FORK_DESKTOP_INPUT_IDLE_MS = 5 * 60 * 1000;
/** Android installs wait for this long in the background with no phone-side operation. */
export const FORK_ANDROID_BACKGROUND_IDLE_MS = 2 * 60 * 1000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = FORK_CHECK_INTERVAL_MS;

const STABLE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NIGHTLY_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(\d{8})\.([1-9]\d*)$/;

export interface ForkVersion {
  readonly raw: string;
  readonly channel: ForkUpdateChannel;
  readonly core: readonly [number, number, number];
  readonly date: string | null;
  readonly run: number | null;
}

export function parseForkVersion(raw: string): ForkVersion | null {
  const stable = STABLE_PATTERN.exec(raw);
  if (stable)
    return {
      raw,
      channel: "stable",
      core: [Number(stable[1]), Number(stable[2]), Number(stable[3])],
      date: null,
      run: null,
    };
  const nightly = NIGHTLY_PATTERN.exec(raw);
  if (nightly) {
    return {
      raw,
      channel: "nightly",
      core: [Number(nightly[1]), Number(nightly[2]), Number(nightly[3])],
      date: nightly[4]!,
      run: Number(nightly[5]),
    };
  }
  return null;
}

/** SemVer precedence: a stable release outranks every nightly of the same core version. Throws on a foreign version. */
export function compareForkVersions(left: string, right: string): number {
  const a = parseForkVersion(left);
  const b = parseForkVersion(right);
  if (a === null || b === null)
    throw new Error(`'${a === null ? left : right}' is not a fork release version.`);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (a.channel !== b.channel) return a.channel === "stable" ? 1 : -1;
  if (a.channel === "stable") return 0;
  if (a.date !== b.date) return a.date! < b.date! ? -1 : 1;
  return Math.sign(a.run! - b.run!);
}

export const forkVersionFromTag = (tag: string): string | null => {
  if (!tag.startsWith(FORK_TAG_PREFIX)) return null;
  const version = tag.slice(FORK_TAG_PREFIX.length);
  return parseForkVersion(version) ? version : null;
};

/** Existing installations follow nightlies so the owner's devices exercise builds first; fresh installs start on stable. */
export const defaultForkChannel = (input: {
  readonly existingInstallation: boolean;
}): ForkUpdateChannel => (input.existingInstallation ? "nightly" : "stable");

export type ForkPlatformKey = "windows-x64" | "linux-x64";
export function forkPlatformKey(platform: string, arch: string): ForkPlatformKey | null {
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return null;
}

/** A GitHub release as the device sees it, with its decoded fork manifest when present. */
export interface ForkReleaseRecord {
  readonly id: number;
  readonly tagName: string;
  readonly draft: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly assets: ReadonlyArray<{ readonly name: string; readonly size: number }>;
  readonly manifest: ForkReleaseManifest | null;
  readonly manifestError?: string;
}

const WITHDRAWN_PATTERN = /^<!-- t3-fork-release:withdrawn\b[^>]*-->/m;
const REQUIRED_CHECKS = ["build", "install", "update", "recovery"] as const;
export const isWithdrawn = (record: Pick<ForkReleaseRecord, "body">): boolean =>
  WITHDRAWN_PATTERN.test(record.body);

export type ForkExclusionReason =
  | "draft"
  | "withdrawn"
  | "invalid-manifest"
  | "partial"
  | "checks-incomplete"
  | "duplicate"
  | "duplicate-recovery";

export function classifyForkRelease(
  record: ForkReleaseRecord,
  all: ReadonlyArray<ForkReleaseRecord>,
): { readonly eligible: boolean; readonly reasons: ReadonlyArray<ForkExclusionReason> } {
  const reasons: ForkExclusionReason[] = [];
  if (record.draft) reasons.push("draft");
  if (isWithdrawn(record)) reasons.push("withdrawn");
  const manifest = record.manifest;
  if (manifest === null) {
    reasons.push(record.manifestError === undefined ? "partial" : "invalid-manifest");
    return { eligible: false, reasons };
  }
  if (
    manifest.version !== forkVersionFromTag(record.tagName) ||
    parseForkVersion(manifest.version)?.channel !== manifest.channel
  )
    reasons.push("invalid-manifest");
  const present = new Map(record.assets.map((asset) => [asset.name, asset.size]));
  const complete =
    manifest.assets.length > 0 &&
    manifest.assets.every((asset) => present.get(asset.name) === asset.bytes) &&
    present.has(FORK_MANIFEST_ASSET) &&
    [manifest.android.normal.asset, manifest.android.recovery.asset].every((name) =>
      manifest.assets.some((asset) => asset.name === name),
    );
  if (!complete) reasons.push("partial");
  if (!REQUIRED_CHECKS.every((check) => manifest.checks[check])) reasons.push("checks-incomplete");
  const { normal, recovery } = manifest.android;
  if (
    normal.asset === recovery.asset ||
    recovery.sourceCommit === normal.sourceCommit ||
    recovery.versionCode <= normal.versionCode ||
    normal.signerSha256 !== recovery.signerSha256 ||
    normal.sourceCommit !== manifest.commit ||
    normal.sourceVersion !== manifest.version
  ) {
    reasons.push("duplicate-recovery");
  }
  const rank = (candidate: ForkReleaseRecord) => candidate.publishedAt ?? candidate.createdAt;
  const duplicateOf = all.some(
    (other) =>
      other.id !== record.id &&
      !other.draft &&
      !isWithdrawn(other) &&
      other.manifest !== null &&
      (other.manifest.version === manifest.version ||
        (other.manifest.commit === manifest.commit &&
          other.manifest.channel === manifest.channel)) &&
      (rank(other) < rank(record) || (rank(other) === rank(record) && other.id < record.id)),
  );
  if (duplicateOf) reasons.push("duplicate");
  return { eligible: reasons.length === 0, reasons };
}

/** Failure state a device carries between checks. Digests, never versions: a rebuilt release is a different target. */
export interface ForkTargetMemory {
  readonly failedArtifactSha256: ReadonlyArray<string>;
}

export interface ForkTargetSelection {
  readonly record: ForkReleaseRecord;
  readonly manifest: ForkReleaseManifest;
}

/**
 * The newest eligible release this device may move to. Never selects a downgrade.
 * A pinned build holds the device where it is; a target whose install failed on
 * this device is never chosen again automatically.
 */
export function selectForkTarget(input: {
  readonly channel: ForkUpdateChannel;
  readonly installedVersion: string;
  readonly releases: ReadonlyArray<ForkReleaseRecord>;
  readonly pinnedBuild: string | null;
  readonly memory?: ForkTargetMemory;
  /** Artifact digest the device would download, for the failed-target check. */
  readonly artifactSha256: (manifest: ForkReleaseManifest) => string | null;
}): ForkTargetSelection | null {
  if (input.pinnedBuild !== null) return null;
  let best: ForkTargetSelection | null = null;
  for (const record of input.releases) {
    if (!classifyForkRelease(record, input.releases).eligible) continue;
    const manifest = record.manifest!;
    if (input.channel === "stable" && manifest.channel !== "stable") continue;
    if (compareForkVersions(manifest.version, input.installedVersion) <= 0) continue;
    const digest = input.artifactSha256(manifest);
    if (digest === null) continue;
    if (input.memory?.failedArtifactSha256.includes(digest)) continue;
    if (best === null || compareForkVersions(manifest.version, best.manifest.version) > 0)
      best = { record, manifest };
  }
  return best;
}

export type ForkArtifactKind = "desktop" | "server" | "recovery-helper" | "feed";
/**
 * How this installation is packaged. A Debian install must never be offered an AppImage (or the
 * reverse) just because both are linux-x64 desktop payloads: replacing one with the other would
 * leave two installs and break the system integration.
 */
export type ForkPackaging = "nsis" | "appimage" | "deb" | "service";
const PACKAGING_SUFFIX: Record<Exclude<ForkPackaging, "service">, string> = {
  nsis: ".exe",
  appimage: ".AppImage",
  deb: ".deb",
};

export function detectForkPackaging(input: {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly installedByDpkg: boolean;
}): ForkPackaging | null {
  if (input.platform === "win32") return "nsis";
  if (input.platform !== "linux") return null;
  // The AppImage runtime exports APPIMAGE for the mounted image; a dpkg-owned executable is a Debian install.
  if (input.env.APPIMAGE !== undefined && input.env.APPIMAGE !== "") return "appimage";
  return input.installedByDpkg ? "deb" : null;
}

/** The one desktop payload for this platform and packaging, matched by exact suffix. Ambiguity is treated as absent. */
export function forkDesktopAssetFor(
  manifest: ForkReleaseManifest,
  platform: ForkPlatformKey,
  packaging: Exclude<ForkPackaging, "service">,
): ForkReleaseManifest["assets"][number] | null {
  const suffix = PACKAGING_SUFFIX[packaging];
  const matches = manifest.assets.filter(
    (asset) =>
      asset.kind === "desktop" && asset.platform === platform && asset.name.endsWith(suffix),
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Recovery ships as two assets per platform, both of kind "recovery-helper": the bundled helper
 * script and the Node runtime that runs it, so recovery never depends on a system Node or on the
 * (possibly broken) main app. They are told apart by exact name, never by kind alone.
 */
export const RECOVERY_NODE_ASSET: Record<ForkPlatformKey, string> = {
  "linux-x64": "t3-recovery-node-linux-x64",
  "windows-x64": "t3-recovery-node-windows-x64.exe",
};
export const RECOVERY_HELPER_ASSET: Record<ForkPlatformKey, string> = {
  "linux-x64": "t3-recovery-helper-linux-x64.mjs",
  "windows-x64": "t3-recovery-helper-windows-x64.mjs",
};

/** Both recovery assets for a platform, or null when either is missing, duplicated, or on the wrong platform. */
export function forkRecoveryAssetsFor(
  manifest: ForkReleaseManifest,
  platform: ForkPlatformKey,
): {
  readonly helper: ForkReleaseManifest["assets"][number];
  readonly node: ForkReleaseManifest["assets"][number];
} | null {
  const pick = (name: string) => {
    const matches = manifest.assets.filter(
      (asset) =>
        asset.kind === "recovery-helper" && asset.platform === platform && asset.name === name,
    );
    return matches.length === 1 ? matches[0]! : null;
  };
  const helper = pick(RECOVERY_HELPER_ASSET[platform]);
  const node = pick(RECOVERY_NODE_ASSET[platform]);
  return helper === null || node === null ? null : { helper, node };
}

/** The payload a given installation downloads: desktop packaging-aware, or the service archive. */
export function forkInstallAssetFor(
  manifest: ForkReleaseManifest,
  platform: ForkPlatformKey,
  packaging: ForkPackaging,
): ForkReleaseManifest["assets"][number] | null {
  return packaging === "service"
    ? forkAssetFor(manifest, "server", platform)
    : forkDesktopAssetFor(manifest, platform, packaging);
}
/** The one asset of a kind for a platform, or null. Ambiguity (two assets) is treated as absent: it cannot be trusted. */
export function forkAssetFor(
  manifest: ForkReleaseManifest,
  kind: ForkArtifactKind,
  platform: ForkPlatformKey,
): ForkReleaseManifest["assets"][number] | null {
  const matches = manifest.assets.filter(
    (asset) => asset.kind === kind && (asset.platform === platform || asset.platform === "shared"),
  );
  return matches.length === 1 ? matches[0]! : null;
}

/** Only the fork's own GitHub release origin may serve an update payload. */
export function forkAssetUrl(tagName: string, assetName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(assetName) || forkVersionFromTag(tagName) === null)
    throw new Error("Unsupported release asset.");
  return `${FORK_RELEASE_DOWNLOAD_ORIGIN}${tagName}/${assetName}`;
}
export const isForkReleaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      value.startsWith(FORK_RELEASE_DOWNLOAD_ORIGIN) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

/** Exponential backoff on network failure; the next check is never earlier than the regular cadence after success. */
export function forkCheckBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return FORK_CHECK_INTERVAL_MS;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 12));
}

export interface ForkInstallGateInput {
  readonly now: number;
  /** Hard blockers from the device coordinator. Any one prevents installation, manual or automatic. */
  readonly blockers: ReadonlyArray<ForkActivityBlocker>;
  readonly automaticInstallation: boolean;
  readonly targetArtifactSha256: string | null;
  /** Renderer-observed interaction. Null when this runtime has no interactive surface. */
  readonly interaction: {
    readonly inputActiveAt: number | null;
    readonly uploadsInFlight: number;
  } | null;
  readonly countdown: ForkUpdateCountdown | null;
  readonly automationReviewRequired: boolean;
  /** Set when the person cancelled the countdown for this digest. It stays cancelled until a different target appears. */
  readonly cancelledTargetSha256?: string | null;
  readonly inputIdleMs?: number;
}
export type ForkInstallGate =
  | { readonly state: "blocked"; readonly blockers: ReadonlyArray<ForkActivityBlocker> }
  | { readonly state: "idle" }
  | { readonly state: "waiting"; readonly blockers: ReadonlyArray<ForkActivityBlocker> }
  | { readonly state: "countdown"; readonly countdown: ForkUpdateCountdown }
  | { readonly state: "install" };

/**
 * Automatic installation: agents (coordinator blockers) hard-block; then input and
 * uploads must be quiet; then a cancellable 15 second countdown precedes install.
 * Manual installation is bound to a digest by its caller and uses `hardBlockers` only.
 */
export function evaluateAutomaticInstall(input: ForkInstallGateInput): ForkInstallGate {
  if (!input.automaticInstallation || input.targetArtifactSha256 === null) return { state: "idle" };
  if (input.cancelledTargetSha256 === input.targetArtifactSha256) return { state: "idle" };
  const label = (reason: ForkActivityBlocker["reason"], text: string): ForkActivityBlocker => ({
    participantId: "interaction",
    reason,
    label: text,
  });
  if (input.automationReviewRequired)
    return {
      state: "waiting",
      blockers: [
        label("automation-review", "Review restored automation before automatic updates resume."),
      ],
    };
  if (input.blockers.length > 0) return { state: "blocked", blockers: input.blockers };
  const idleMs = input.inputIdleMs ?? FORK_DESKTOP_INPUT_IDLE_MS;
  const waiting: ForkActivityBlocker[] = [];
  if (input.interaction !== null) {
    if (input.interaction.uploadsInFlight > 0)
      waiting.push(label("uploads", "An upload is still finishing."));
    if (
      input.interaction.inputActiveAt !== null &&
      input.now - input.interaction.inputActiveAt < idleMs
    )
      waiting.push(label("input-active", "Waiting for input to be idle."));
  }
  if (waiting.length > 0) return { state: "waiting", blockers: waiting };
  const countdown = input.countdown;
  if (countdown === null || countdown.targetArtifactSha256 !== input.targetArtifactSha256) {
    return {
      state: "countdown",
      countdown: {
        startedAt: input.now,
        installsAt: input.now + FORK_AUTOMATIC_INSTALL_COUNTDOWN_MS,
        targetArtifactSha256: input.targetArtifactSha256,
      },
    };
  }
  return input.now >= countdown.installsAt
    ? { state: "install" }
    : { state: "countdown", countdown };
}

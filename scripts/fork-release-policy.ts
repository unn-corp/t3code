// Pure release policy for unn-corp/t3code fork releases: versions, candidate selection,
// release eligibility, and Android installation-code allocation. Nothing here touches the
// network or the filesystem, so every rule is covered by fork-release-policy.test.ts.
import { FORK_RELEASE_MANIFEST_ASSET, type ForkReleaseManifest } from "./fork-release-contract.ts";

export type ForkChannel = "stable" | "nightly";

export const FORK_FIRST_STABLE_VERSION = "1.0.0";
export const FORK_TAG_PREFIX = "fork-v";
export const FORK_MANIFEST_ASSET = FORK_RELEASE_MANIFEST_ASSET;
export const FORK_CHECKSUMS_ASSET = "SHA256SUMS";
/** Matches the installation code of the APK already installed on the owner's phone. */
export const ANDROID_BASELINE_VERSION_CODE = 29_853_678;
export const ANDROID_MAX_VERSION_CODE = 2_147_483_647;
export const ANDROID_CODE_TAG_PREFIX = "fork-android-code-";
export const STABLE_MIN_NIGHTLY_AGE_MS = 24 * 60 * 60 * 1000;

const STABLE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NIGHTLY_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(\d{8})\.([1-9]\d*)$/;

export interface ForkVersion {
  readonly raw: string;
  readonly channel: ForkChannel;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly date: string | null;
  readonly run: number | null;
}

export const parseForkVersion = (raw: string): ForkVersion | null => {
  const stable = STABLE_PATTERN.exec(raw);
  if (stable) {
    return {
      raw,
      channel: "stable",
      major: Number(stable[1]),
      minor: Number(stable[2]),
      patch: Number(stable[3]),
      date: null,
      run: null,
    };
  }
  const nightly = NIGHTLY_PATTERN.exec(raw);
  if (nightly) {
    return {
      raw,
      channel: "nightly",
      major: Number(nightly[1]),
      minor: Number(nightly[2]),
      patch: Number(nightly[3]),
      date: nightly[4]!,
      run: Number(nightly[5]),
    };
  }
  return null;
};

const requireVersion = (raw: string): ForkVersion => {
  const parsed = parseForkVersion(raw);
  if (!parsed) throw new Error(`'${raw}' is not a fork release version.`);
  return parsed;
};

/** Semver precedence: a stable release outranks every nightly of the same core version. */
export const compareForkVersions = (left: string, right: string): number => {
  const a = requireVersion(left);
  const b = requireVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.channel !== b.channel) return a.channel === "stable" ? 1 : -1;
  if (a.channel === "stable") return 0;
  if (a.date !== b.date) return a.date! < b.date! ? -1 : 1;
  return Math.sign(a.run! - b.run!);
};

export const forkTagForVersion = (version: string): string =>
  `${FORK_TAG_PREFIX}${requireVersion(version).raw}`;

export const forkVersionFromTag = (tag: string): string | null => {
  if (!tag.startsWith(FORK_TAG_PREFIX)) return null;
  const version = tag.slice(FORK_TAG_PREFIX.length);
  return parseForkVersion(version) ? version : null;
};

// ---------------------------------------------------------------------------------------------
// Release records
// ---------------------------------------------------------------------------------------------

export interface ReleaseAssetRecord {
  readonly id: number;
  readonly name: string;
  readonly size: number;
}

export interface ReleaseRecord {
  readonly id: number;
  readonly tagName: string;
  readonly draft: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly assets: ReadonlyArray<ReleaseAssetRecord>;
  /** The decoded fork-release.json, or null when the release has none. */
  readonly manifest: ForkReleaseManifest | null;
  /** Why a present fork-release.json could not be decoded. */
  readonly manifestError?: string;
}

const WITHDRAWN_PATTERN = /^<!-- t3-fork-release:withdrawn\b[^>]*-->/m;
const CANDIDATE_PATTERN =
  /^<!-- t3-fork-release:candidate commit=([0-9a-f]{40}) channel=(stable|nightly) -->/m;
const COMMISSIONING_PATTERN =
  /^<!-- t3-fork-release:commissioning source-tag=(\S+) source-version=(\S+) source-commit=([0-9a-f]{40}) -->/m;

/** Withdrawal changes only the release notes; the tag and every asset stay untouched. */
export const withdrawalMarker = (reason: string, at: string): string =>
  `<!-- t3-fork-release:withdrawn at=${at} reason=${reason.replace(/[\r\n>-]+/g, " ").trim()} -->`;

export const candidateMarker = (commit: string, channel: ForkChannel): string =>
  `<!-- t3-fork-release:candidate commit=${commit} channel=${channel} -->`;

export interface CommissioningSource {
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
}

export const commissioningMarker = (source: CommissioningSource): string =>
  `<!-- t3-fork-release:commissioning source-tag=${source.tag} source-version=${source.version} source-commit=${source.commit} -->`;

const commissioningSourceMarker = (
  record: Pick<ReleaseRecord, "body">,
): CommissioningSource | null => {
  const match = COMMISSIONING_PATTERN.exec(record.body);
  if (!match) return null;
  return { tag: match[1]!, version: match[2]!, commit: match[3]! };
};

export const isWithdrawn = (record: Pick<ReleaseRecord, "body">): boolean =>
  WITHDRAWN_PATTERN.test(record.body);

export const withWithdrawal = (body: string, reason: string, at: string): string =>
  isWithdrawn({ body }) ? body : `${withdrawalMarker(reason, at)}\n${body}`;

export const withoutWithdrawal = (body: string): string =>
  body.replace(/^<!-- t3-fork-release:withdrawn\b[^>]*-->\r?\n?/m, "");

/** The commit a release was built from, from its manifest or, for a draft, its candidate marker. */
export const recordedCommit = (record: ReleaseRecord): string | null =>
  record.manifest?.commit ?? CANDIDATE_PATTERN.exec(record.body)?.[1] ?? null;

export const recordedChannel = (record: ReleaseRecord): ForkChannel | null => {
  if (record.manifest) return record.manifest.channel;
  const marked = CANDIDATE_PATTERN.exec(record.body)?.[2];
  if (marked === "stable" || marked === "nightly") return marked;
  const version = forkVersionFromTag(record.tagName);
  return version ? requireVersion(version).channel : null;
};

const eligibleCommissioningSource = (
  record: ReleaseRecord,
  all: ReadonlyArray<ReleaseRecord>,
): CommissioningSource | null => {
  const marker = commissioningSourceMarker(record);
  const manifest = record.manifest;
  if (!marker || !manifest || manifest.channel !== "nightly") return null;
  const source = all.find((candidate) => candidate.tagName === marker.tag);
  if (
    !source ||
    source.draft ||
    isWithdrawn(source) ||
    !source.manifest ||
    source.manifest.version !== marker.version ||
    source.manifest.commit !== marker.commit ||
    source.manifest.channel !== "nightly" ||
    source.manifest.commit !== manifest.commit ||
    compareForkVersions(source.manifest.version, manifest.version) >= 0 ||
    !classifyRelease(source, all).eligible
  )
    return null;
  return marker;
};

export type ExclusionReason =
  | "draft"
  | "withdrawn"
  | "invalid-manifest"
  | "partial"
  | "checks-incomplete"
  | "duplicate"
  | "duplicate-recovery";

export interface Classification {
  readonly eligible: boolean;
  readonly reasons: ReadonlyArray<ExclusionReason>;
}

const REQUIRED_CHECKS = ["build", "install", "update", "recovery"] as const;
const sameAndroidArtifact = (
  left: ForkReleaseManifest["android"]["recovery"],
  right: ForkReleaseManifest["android"]["recovery"],
) =>
  left.asset === right.asset &&
  left.versionCode === right.versionCode &&
  left.sourceVersion === right.sourceVersion &&
  left.sourceCommit === right.sourceCommit &&
  left.packageName === right.packageName &&
  left.signerSha256 === right.signerSha256 &&
  left.updaterProtocol === right.updaterProtocol;

/** Drafts and withdrawn releases are never targets; neither are incomplete or duplicate ones. */
export const classifyRelease = (
  record: ReleaseRecord,
  all: ReadonlyArray<ReleaseRecord>,
): Classification => {
  const reasons: ExclusionReason[] = [];
  if (record.draft) reasons.push("draft");
  if (isWithdrawn(record)) reasons.push("withdrawn");

  const manifest = record.manifest;
  if (!manifest) {
    reasons.push(record.manifestError ? "invalid-manifest" : "partial");
    return { eligible: false, reasons };
  }

  if (
    manifest.version !== forkVersionFromTag(record.tagName) ||
    parseForkVersion(manifest.version)?.channel !== manifest.channel
  ) {
    reasons.push("invalid-manifest");
  }

  const present = new Map(record.assets.map((asset) => [asset.name, asset.size]));
  const listedAssets = new Map(manifest.assets.map((asset) => [asset.name, asset]));
  const complete =
    manifest.assets.length > 0 &&
    manifest.assets.every((asset) => present.get(asset.name) === asset.bytes) &&
    present.has(FORK_MANIFEST_ASSET) &&
    [
      manifest.android.normal.asset,
      manifest.android.recovery.asset,
      ...(manifest.android.recoveries ?? []).map((recovery) => recovery.asset),
    ].every((name, index) => {
      const matches = manifest.assets.filter((asset) => asset.name === name);
      const asset = matches[0];
      const expectedKind = index === 0 ? "android" : "android-recovery";
      return matches.length === 1 && asset?.kind === expectedKind && asset.platform === "android";
    });
  if (!complete) reasons.push("partial");

  if (!REQUIRED_CHECKS.every((check) => manifest.checks[check])) reasons.push("checks-incomplete");

  const { normal, recovery } = manifest.android;
  if (
    normal.asset === recovery.asset ||
    (recovery.sourceCommit === normal.sourceCommit &&
      recovery.sourceVersion === normal.sourceVersion) ||
    recovery.versionCode <= normal.versionCode ||
    normal.signerSha256 !== recovery.signerSha256 ||
    normal.sourceCommit !== manifest.commit ||
    normal.sourceVersion !== manifest.version ||
    normal.versionCode > ANDROID_MAX_VERSION_CODE ||
    recovery.versionCode > ANDROID_MAX_VERSION_CODE
  ) {
    reasons.push("duplicate-recovery");
  }
  if (manifest.android.recoveries !== undefined) {
    const recoveries = manifest.android.recoveries;
    const codes = new Set<number>();
    const identities = new Set<string>();
    const assets = new Set<string>();
    if (!sameAndroidArtifact(recoveries[0]!, recovery)) reasons.push("duplicate-recovery");
    for (const candidate of recoveries) {
      const identity = `${candidate.sourceVersion}\0${candidate.sourceCommit}`;
      if (
        candidate.versionCode <= normal.versionCode ||
        candidate.versionCode > ANDROID_MAX_VERSION_CODE ||
        candidate.signerSha256 !== normal.signerSha256 ||
        candidate.packageName !== normal.packageName ||
        candidate.updaterProtocol !== normal.updaterProtocol ||
        (candidate.sourceVersion === normal.sourceVersion &&
          candidate.sourceCommit === normal.sourceCommit) ||
        codes.has(candidate.versionCode) ||
        identities.has(identity) ||
        assets.has(candidate.asset) ||
        candidate.asset === normal.asset
      )
        reasons.push("duplicate-recovery");
      const payloadAsset = listedAssets.get(candidate.asset);
      if (!payloadAsset) reasons.push("partial");
      const payloadMatches = manifest.assets.filter((asset) => asset.name === candidate.asset);
      if (
        payloadMatches.length !== 1 ||
        payloadAsset?.kind !== "android-recovery" ||
        payloadAsset.platform !== "android"
      )
        reasons.push("duplicate-recovery");
      codes.add(candidate.versionCode);
      identities.add(identity);
      assets.add(candidate.asset);
    }
  }

  // Keep the earliest of releases that claim the same version or the same commit and channel.
  const rank = (candidate: ReleaseRecord) => candidate.publishedAt ?? candidate.createdAt;
  const commissionSource = eligibleCommissioningSource(record, all);
  const duplicateOf = all.some((other) => {
    if (
      other.id === record.id ||
      other.draft ||
      isWithdrawn(other) ||
      !other.manifest ||
      !(rank(other) < rank(record) || (rank(other) === rank(record) && other.id < record.id))
    )
      return false;
    if (other.manifest.version === manifest.version) return true;
    if (other.manifest.commit === manifest.commit && other.manifest.channel === manifest.channel) {
      return !(
        commissionSource &&
        compareForkVersions(other.manifest.version, commissionSource.version) <= 0 &&
        classifyRelease(other, all).eligible
      );
    }
    return false;
  });
  if (duplicateOf) reasons.push("duplicate");

  return { eligible: reasons.length === 0, reasons };
};

export const eligibleReleases = (all: ReadonlyArray<ReleaseRecord>): ReleaseRecord[] =>
  all.filter((record) => classifyRelease(record, all).eligible);

/** The newest-by-version eligible release a device may move to. Never selects a downgrade. */
export const selectUpdateCandidate = (input: {
  readonly channel: ForkChannel;
  readonly installedVersion: string;
  readonly releases: ReadonlyArray<ReleaseRecord>;
}): ReleaseRecord | null => {
  let best: ReleaseRecord | null = null;
  for (const record of eligibleReleases(input.releases)) {
    const manifest = record.manifest!;
    // Stable devices ignore nightlies. Nightly devices follow nightlies but take a stable
    // release once it outranks them, which semver precedence already expresses.
    if (input.channel === "stable" && manifest.channel !== "stable") continue;
    if (compareForkVersions(manifest.version, input.installedVersion) <= 0) continue;
    if (!best || compareForkVersions(manifest.version, best.manifest!.version) > 0) best = record;
  }
  return best;
};

// ---------------------------------------------------------------------------------------------
// Version and candidate planning
// ---------------------------------------------------------------------------------------------

const everyVersionUsed = (all: ReadonlyArray<ReleaseRecord>): string[] =>
  all.flatMap((record) => {
    const fromTag = forkVersionFromTag(record.tagName);
    const versions = [fromTag, record.manifest?.version ?? null];
    return versions.filter((version): version is string => version !== null);
  });

/**
 * Stable versions start at 1.0.0 and then take the next patch. Drafts and withdrawn releases
 * still consume their version, so a number is never published twice.
 */
export const nextStableVersion = (
  all: ReadonlyArray<ReleaseRecord>,
  baselineVersion?: string,
): string => {
  let highest: ForkVersion | null = null;
  const baselineFloor =
    baselineVersion &&
    parseForkVersion(baselineVersion)?.channel === "stable" &&
    compareForkVersions(baselineVersion, FORK_FIRST_STABLE_VERSION) >= 0
      ? [baselineVersion]
      : [];
  for (const raw of [...everyVersionUsed(all), ...baselineFloor]) {
    const parsed = parseForkVersion(raw);
    if (parsed?.channel !== "stable") continue;
    if (!highest || compareForkVersions(parsed.raw, highest.raw) > 0) highest = parsed;
  }
  return highest
    ? `${highest.major}.${highest.minor}.${highest.patch + 1}`
    : FORK_FIRST_STABLE_VERSION;
};

export const nightlyVersionFor = (
  all: ReadonlyArray<ReleaseRecord>,
  date: Date,
  runNumber: number,
  baselineVersion?: string,
): string => {
  if (!Number.isInteger(runNumber) || runNumber < 1) {
    throw new Error("A nightly version needs a positive workflow run number.");
  }
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${nextStableVersion(all, baselineVersion)}-nightly.${day}.${runNumber}`;
};

export interface Predecessor {
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
  /** True for the hand-installed baseline, used only until a pipeline release is eligible. */
  readonly baseline?: true;
}

/**
 * The newest eligible release built from a different commit. A recovery APK from the same source
 * would restore nothing, so releases of the candidate's own commit never qualify.
 */
export const selectPredecessor = (
  all: ReadonlyArray<ReleaseRecord>,
  candidateCommit: string,
): Predecessor | null => {
  let best: ReleaseRecord | null = null;
  for (const record of eligibleReleases(all)) {
    if (record.manifest!.commit === candidateCommit) continue;
    if (!best || compareForkVersions(record.manifest!.version, best.manifest!.version) > 0) {
      best = record;
    }
  }
  return best
    ? {
        tag: best.tagName,
        version: best.manifest!.version,
        commit: best.manifest!.commit,
      }
    : null;
};

export type PlanOutcome<T> =
  | { readonly kind: "release"; readonly plan: T }
  | { readonly kind: "skip"; readonly reason: string };

export interface ReleasePlan {
  readonly channel: ForkChannel;
  readonly version: string;
  readonly tag: string;
  /** Full 40-character SHA every later job builds and verifies. */
  readonly commit: string;
  /** The nightly a stable release was promoted from. */
  readonly source: {
    readonly tag: string;
    readonly version: string;
    readonly releasedAt: string;
  } | null;
  /** Exact eligible same-source nightly used to commission a higher-version rebuild. */
  readonly commissioningSource?: CommissioningSource;
}

const assertFullSha = (commit: string): void => {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`'${commit}' is not a full commit SHA.`);
};

export const planNightly = (input: {
  readonly commit: string;
  readonly now: Date;
  readonly runNumber: number;
  readonly releases: ReadonlyArray<ReleaseRecord>;
  readonly baselineVersion?: string;
}): PlanOutcome<ReleasePlan> => {
  assertFullSha(input.commit);
  const sameCommit = input.releases.find(
    (record) => recordedCommit(record) === input.commit && recordedChannel(record) === "nightly",
  );
  if (sameCommit) {
    return {
      kind: "skip",
      reason: `Commit ${input.commit} already has nightly ${sameCommit.tagName}.`,
    };
  }
  const version = nightlyVersionFor(
    input.releases,
    input.now,
    input.runNumber,
    input.baselineVersion,
  );
  return {
    kind: "release",
    plan: {
      channel: "nightly",
      version,
      tag: forkTagForVersion(version),
      commit: input.commit,
      source: null,
    },
  };
};

/**
 * Selects the newest eligible nightly built from this exact source. Every same-source record
 * must be a complete eligible published release; drafts and damaged or withdrawn attempts block
 * commissioning rather than being silently skipped.
 */
export const selectCommissioningSource = (
  releases: ReadonlyArray<ReleaseRecord>,
  commit: string,
): ReleaseRecord | null => {
  assertFullSha(commit);
  const sameSource = releases.filter(
    (record) => recordedCommit(record) === commit && recordedChannel(record) === "nightly",
  );
  if (sameSource.length === 0) return null;
  const invalid = sameSource.find((record) => !classifyRelease(record, releases).eligible);
  if (invalid)
    throw new Error(
      `Commissioning source ${invalid.tagName} is not eligible (${classifyRelease(invalid, releases).reasons.join(", ")}).`,
    );
  return sameSource.toSorted((left, right) =>
    compareForkVersions(right.manifest!.version, left.manifest!.version),
  )[0]!;
};

/**
 * Stable promotes the newest nightly that completed every required check at least 24 hours ago
 * and is newer than the nightly the previous stable was built from. Age is the time the nightly
 * finished validation, never a measure of telemetry.
 */
export const selectStableSource = (input: {
  readonly now: Date;
  readonly releases: ReadonlyArray<ReleaseRecord>;
}): ReleaseRecord | null => {
  const cutoff = input.now.getTime() - STABLE_MIN_NIGHTLY_AGE_MS;
  const all = input.releases;
  const stableCommits = new Set(
    all
      .filter((record) => recordedChannel(record) === "stable")
      .map(recordedCommit)
      .filter((commit): commit is string => commit !== null),
  );
  const newestStable = eligibleReleases(all)
    .filter((record) => record.manifest!.channel === "stable")
    .reduce<ReleaseRecord | null>(
      (best, record) =>
        !best || compareForkVersions(record.manifest!.version, best.manifest!.version) > 0
          ? record
          : best,
      null,
    );
  const previousBase = newestStable
    ? eligibleReleases(all).find(
        (record) =>
          record.manifest!.channel === "nightly" &&
          record.manifest!.commit === newestStable.manifest!.commit,
      )
    : undefined;

  let best: ReleaseRecord | null = null;
  for (const record of eligibleReleases(all)) {
    const manifest = record.manifest!;
    if (manifest.channel !== "nightly" || stableCommits.has(manifest.commit)) continue;
    const completedAt = Date.parse(manifest.releasedAt);
    if (!Number.isFinite(completedAt) || completedAt > cutoff) continue;
    if (previousBase && completedAt <= Date.parse(previousBase.manifest!.releasedAt)) continue;
    if (!best || compareForkVersions(manifest.version, best.manifest!.version) > 0) best = record;
  }
  return best;
};

export const planStable = (input: {
  readonly now: Date;
  readonly releases: ReadonlyArray<ReleaseRecord>;
  readonly baselineVersion?: string;
}): PlanOutcome<ReleasePlan> => {
  const source = selectStableSource(input);
  if (!source) {
    return {
      kind: "skip",
      reason: "No eligible nightly has completed every required check at least 24 hours ago.",
    };
  }
  const version = nextStableVersion(input.releases, input.baselineVersion);
  return {
    kind: "release",
    plan: {
      channel: "stable",
      version,
      tag: forkTagForVersion(version),
      commit: source.manifest!.commit,
      source: {
        tag: source.tagName,
        version: source.manifest!.version,
        releasedAt: source.manifest!.releasedAt,
      },
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Android installation codes
// ---------------------------------------------------------------------------------------------

export const androidCodeTag = (code: number): string => `${ANDROID_CODE_TAG_PREFIX}${code}`;
export const androidCodeRangeTag = (start: number, end: number): string =>
  `${ANDROID_CODE_TAG_PREFIX}range-${start}-${end}`;

/** A reservation tag claims its code and the one after it (normal, then recovery). */
export const codeFromReservationTag = (tag: string): number | null => {
  if (!tag.startsWith(ANDROID_CODE_TAG_PREFIX)) return null;
  const suffix = tag.slice(ANDROID_CODE_TAG_PREFIX.length);
  return /^[1-9]\d*$/.test(suffix) ? Number(suffix) : null;
};

/** End of the permanently reserved range encoded by either a legacy pair tag or a range tag. */
export const reservedAndroidCodeEnd = (tag: string): number | null => {
  if (!tag.startsWith(ANDROID_CODE_TAG_PREFIX)) return null;
  const suffix = tag.slice(ANDROID_CODE_TAG_PREFIX.length);
  const range = /^range-([1-9]\d*)-([1-9]\d*)$/.exec(suffix);
  if (!range) {
    const legacy = codeFromReservationTag(tag);
    return legacy === null ? null : legacy + 1;
  }
  const start = Number(range[1]);
  const end = Number(range[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start ? end : null;
};

export const highestUsedAndroidCode = (input: {
  readonly releases: ReadonlyArray<ReleaseRecord>;
  readonly reservationTags: ReadonlyArray<string>;
}): number => {
  const used: number[] = [ANDROID_BASELINE_VERSION_CODE];
  for (const record of input.releases) {
    if (!record.manifest) continue;
    used.push(
      record.manifest.android.normal.versionCode,
      record.manifest.android.recovery.versionCode,
      ...(record.manifest.android.recoveries ?? []).map((recovery) => recovery.versionCode),
    );
  }
  for (const tag of input.reservationTags) {
    const code = reservedAndroidCodeEnd(tag);
    if (code !== null) used.push(code);
  }
  return Math.max(...used);
};

export interface AndroidCodePair {
  readonly normal: number;
  readonly recovery: number;
}

export interface AndroidCodeAllocation extends AndroidCodePair {
  readonly recoveries: ReadonlyArray<number>;
  readonly reservedThrough: number;
}

/**
 * The normal APK takes the next free code and its recovery APK the one above, so a device on
 * the normal build can always install the recovery build of an older source.
 */
export const nextAndroidCodePair = (highestUsed: number): AndroidCodePair => {
  const normal = highestUsed + 1;
  const recovery = normal + 1;
  if (!Number.isSafeInteger(normal) || recovery > ANDROID_MAX_VERSION_CODE) {
    throw new Error(`Android installation codes are exhausted above ${highestUsed}.`);
  }
  return { normal, recovery };
};

/** Allocates one normal code followed by one distinct recovery code per frozen source identity. */
export const nextAndroidCodeAllocation = (
  highestUsed: number,
  recoveryCount: number,
): AndroidCodeAllocation => {
  if (!Number.isSafeInteger(recoveryCount) || recoveryCount < 1)
    throw new Error("At least one recovery APK is required.");
  const normal = highestUsed + 1;
  const reservedThrough = normal + recoveryCount;
  if (!Number.isSafeInteger(normal) || reservedThrough > ANDROID_MAX_VERSION_CODE)
    throw new Error(`Android installation codes are exhausted above ${highestUsed}.`);
  const recoveries = Array.from({ length: recoveryCount }, (_, index) => normal + index + 1);
  return { normal, recovery: recoveries[0]!, recoveries, reservedThrough };
};

// ---------------------------------------------------------------------------------------------
// Whole-run planning
// ---------------------------------------------------------------------------------------------

export interface PlannedRelease extends ReleasePlan {
  /** The release whose source the recovery APK is rebuilt from. */
  readonly predecessor: Predecessor;
  /** Frozen, bounded set of exact normal-build identities for which recovery APKs are shipped. */
  readonly recoverySources: ReadonlyArray<RecoverySource>;
}

export interface RecoverySource extends Predecessor {
  readonly channel: ForkChannel | null;
  readonly asset: string;
}

const RECENT_ANDROID_SOURCES_PER_CHANNEL = 3;

/** Optional, bounded recovery coverage for older builds still installed on commissioned devices. */
export const parseRequiredAndroidRecoveryTags = (raw: string): ReadonlyArray<string> => {
  const tags: unknown = JSON.parse(raw);
  if (
    !Array.isArray(tags) ||
    tags.length > 8 ||
    tags.some((tag) => typeof tag !== "string" || forkVersionFromTag(tag) === null)
  )
    throw new Error(
      "Android recovery tags must be a JSON array of at most eight fork release tags.",
    );
  return [...new Set(tags as string[])];
};

/**
 * Fixes every identity a run needs before anything is built: version, tag, commit, and the
 * recovery predecessor. Later jobs read this and never re-select. Refuses to plan without a
 * predecessor because recovery and update validation have nothing to start from.
 */
export const buildPlan = (input: {
  readonly channel: ForkChannel;
  /** Required for nightly; stable takes the commit of the nightly it promotes. */
  readonly commit?: string;
  readonly now: Date;
  readonly runNumber: number;
  readonly releases: ReadonlyArray<ReleaseRecord>;
  /** Verified manual baseline: the first predecessor and a retained Android recovery source. */
  readonly baseline?: Omit<Predecessor, "baseline"> | null;
  /** Explicit commissioning rebuild. Ordinary runs keep duplicate commit suppression. */
  readonly commission?: boolean;
  /** Additional eligible published tags needed by known older Android installations. */
  readonly requiredAndroidRecoveryTags?: ReadonlyArray<string>;
}): PlanOutcome<PlannedRelease> => {
  let outcome: PlanOutcome<ReleasePlan>;
  const commissioningSource = input.commission
    ? (() => {
        if (input.channel !== "nightly" || !input.commit)
          throw new Error("Commissioning rebuilds require a pinned nightly commit.");
        return selectCommissioningSource(input.releases, input.commit);
      })()
    : null;
  if (input.channel === "nightly") {
    if (!input.commit) throw new Error("A nightly plan needs the pinned commit.");
    if (input.commission && commissioningSource) {
      const version = nightlyVersionFor(
        input.releases,
        input.now,
        input.runNumber,
        input.baseline?.version,
      );
      const tag = forkTagForVersion(version);
      if (
        input.releases.some(
          (record) => record.tagName === tag || record.manifest?.version === version,
        )
      )
        return {
          kind: "skip",
          reason: `${tag} already exists; use a new workflow run for commissioning.`,
        };
      outcome = {
        kind: "release",
        plan: {
          channel: "nightly",
          version,
          tag,
          commit: input.commit,
          source: null,
          commissioningSource: {
            tag: commissioningSource.tagName,
            version: commissioningSource.manifest!.version,
            commit: commissioningSource.manifest!.commit,
          },
        },
      };
    } else {
      outcome = planNightly({
        commit: input.commit,
        now: input.now,
        runNumber: input.runNumber,
        releases: input.releases,
        ...(input.baseline ? { baselineVersion: input.baseline.version } : {}),
      });
    }
  } else {
    outcome = planStable({
      now: input.now,
      releases: input.releases,
      ...(input.baseline ? { baselineVersion: input.baseline.version } : {}),
    });
  }
  if (outcome.kind === "skip") return outcome;

  const predecessor =
    (commissioningSource
      ? {
          tag: commissioningSource.tagName,
          version: commissioningSource.manifest!.version,
          commit: commissioningSource.manifest!.commit,
        }
      : selectPredecessor(input.releases, outcome.plan.commit)) ??
    (input.baseline && input.baseline.commit !== outcome.plan.commit
      ? { ...input.baseline, baseline: true as const }
      : null);
  if (!predecessor) {
    throw new Error(
      "No eligible updater-equipped fork release exists to recover to. Publish the baseline release " +
        "first (see docs/operations/fork-releases.md, Baseline).",
    );
  }
  const eligible = eligibleReleases(input.releases);
  const requiredTags = parseRequiredAndroidRecoveryTags(
    JSON.stringify(input.requiredAndroidRecoveryTags ?? []),
  );
  const required = requiredTags.map((tag) => {
    const record = eligible.find((record) => record.tagName === tag);
    if (!record) throw new Error(`Required Android recovery source is not eligible: ${tag}`);
    return record;
  });
  const recoverySources: RecoverySource[] = [];
  const seen = new Set<string>();
  const add = (source: RecoverySource) => {
    if (source.version === outcome.plan.version && source.commit === outcome.plan.commit) return;
    const identity = `${source.version}\0${source.commit}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    recoverySources.push(source);
  };
  // Preserve the historical pair as the first item for old clients.
  add({
    ...predecessor,
    asset: "",
    channel: predecessor.baseline
      ? null
      : (eligible.find((record) => record.tagName === predecessor.tag)?.manifest?.channel ?? null),
  });
  // Keep a fixed recent normal-source window for each lane. Older cached recovery identities may
  // need a guarded intermediate recovery or manual bootstrap before they can resume updates.
  for (const channel of ["stable", "nightly"] as const) {
    const recent = eligible
      .filter((record) => record.manifest!.channel === channel)
      .toSorted((left, right) =>
        compareForkVersions(right.manifest!.version, left.manifest!.version),
      )
      .slice(0, RECENT_ANDROID_SOURCES_PER_CHANNEL);
    for (const record of recent)
      add({
        tag: record.tagName,
        version: record.manifest!.android.normal.sourceVersion,
        commit: record.manifest!.android.normal.sourceCommit,
        channel,
        asset: "",
      });
  }
  // A phone restored to the updater baseline must still be able to resume in-product updates.
  // Native staging requires recovery for its exact installed source, even after ordinary releases exist.
  if (input.baseline) add({ ...input.baseline, channel: null, asset: "" });
  // An older phone cannot stage the newest candidate without recovery for its exact source.
  // Explicitly requested sources still pass normal eligibility, pinned rebuild and artifact proof.
  for (const record of required)
    add({
      tag: record.tagName,
      version: record.manifest!.android.normal.sourceVersion,
      commit: record.manifest!.android.normal.sourceCommit,
      channel: record.manifest!.channel,
      asset: "",
    });
  // Stable promotion changes the version identity while keeping the promoted source commit.
  if (outcome.plan.source) {
    const promoted = eligible.find((record) => record.tagName === outcome.plan.source!.tag);
    if (promoted)
      add({
        tag: promoted.tagName,
        version: promoted.manifest!.android.normal.sourceVersion,
        commit: promoted.manifest!.android.normal.sourceCommit,
        channel: promoted.manifest!.channel,
        asset: "",
      });
  }
  const namedRecoverySources = recoverySources.map((source, index) => ({
    ...source,
    asset:
      index === 0
        ? `t3-code-android-recovery-${outcome.plan.version}.apk`
        : `t3-code-android-recovery-${outcome.plan.version}-from-${source.version}-${source.commit.slice(0, 12)}.apk`,
  }));
  return {
    kind: "release",
    plan: {
      ...outcome.plan,
      predecessor,
      recoverySources: namedRecoverySources,
    },
  };
};

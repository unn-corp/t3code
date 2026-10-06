export const ANDROID_PWA_PACKAGE = "com.devotek.t3code.pwa";
/** Updater wire/storage protocol carried by every APK; recovery builds are built under the same one. */
export const ANDROID_UPDATER_PROTOCOL = 1;
/** Sidecar written beside each release APK. The release workflow cross-checks it against the APK. */
export const ANDROID_METADATA_FILE = "metadata.json";
/** Android rejects codes above this; recovery takes the code after its normal build. */
export const ANDROID_MAX_VERSION_CODE = 2_147_483_647;

export type AndroidBuildKind = "normal" | "recovery";

const VERSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const isSourceCommit = (value: string): boolean => COMMIT.test(value);
export const isSha256 = (value: string): boolean => SHA256.test(value);

/** Shown whenever a recovery build is requested without an updater-equipped predecessor. */
export const MANUAL_BASELINE_GUIDANCE = [
  "No updater-equipped predecessor is available, so no recovery build can be produced.",
  "The first updater-equipped build is a manual baseline: build it as a normal APK, install it yourself",
  "over the existing app with the same signing key (adb install -r, never uninstall), and record its identity.",
  "Do not publish it as an automatically eligible release. The next release rebuilds that baseline's source",
  "as its recovery APK (--kind recovery --source-dir <checkout of the baseline commit>).",
].join(" ");

export interface AndroidBuildPlan {
  readonly kind: AndroidBuildKind;
  readonly versionName: string;
  readonly versionCode: number;
  /** Full commit of the source being compiled, or "unknown" for a local build that is not a release. */
  readonly sourceCommit: string;
  readonly recovery: boolean;
  /** The tree compiled: this repository for normal builds, the predecessor checkout for recovery. */
  readonly sourceDir: string;
  /** Release metadata is only meaningful for a build of a known, committed source. */
  readonly emitsReleaseMetadata: boolean;
}

export interface AndroidBuildInput {
  readonly kind: AndroidBuildKind;
  readonly versionName: string;
  readonly versionCode: number | null;
  /** Required for recovery: the paired normal build's code. Recovery always takes the next one. */
  readonly normalVersionCode: number | null;
  readonly sourceCommit: string | null;
  readonly sourceDir: string | null;
  readonly repoRoot: string;
  readonly nowMs: number;
}

const invalidCode = (label: string, value: number, max: number) =>
  new Error(`${label} must be an integer from 1 to ${max}; received ${value}.`);

/**
 * Validates one APK build request. A normal build reserves the code above its own for the recovery
 * build, and a recovery build must name the normal code it follows, so the pair stays adjacent and
 * Android will always accept the recovery build over the normal one.
 */
export const planAndroidBuild = (input: AndroidBuildInput): AndroidBuildPlan => {
  if (!VERSION_NAME.test(input.versionName)) {
    throw new Error(
      "version-name must be a plain version such as 1.0.1 or 1.0.1-nightly.20261006.1.",
    );
  }
  if (
    input.sourceCommit !== null &&
    input.sourceCommit !== "unknown" &&
    !COMMIT.test(input.sourceCommit)
  ) {
    throw new Error("source-commit must be a full 40-character lowercase commit.");
  }
  if (input.kind === "recovery") {
    if (input.sourceDir === null) throw new Error(MANUAL_BASELINE_GUIDANCE);
    if (input.normalVersionCode === null) {
      throw new Error(
        "A recovery build needs --normal-version-code, the code of the normal build it follows.",
      );
    }
    const normal = input.normalVersionCode;
    if (!Number.isInteger(normal) || normal < 1 || normal + 1 > ANDROID_MAX_VERSION_CODE) {
      throw invalidCode("normal-version-code", normal, ANDROID_MAX_VERSION_CODE - 1);
    }
    if (input.versionCode !== null && input.versionCode !== normal + 1) {
      throw new Error(
        `A recovery build's code is its normal code plus one (${normal + 1}), not ${input.versionCode}.`,
      );
    }
    if (input.sourceCommit === null || input.sourceCommit === "unknown") {
      throw new Error(
        "A recovery build must be built from a committed predecessor; pass its --source-commit.",
      );
    }
    return {
      kind: "recovery",
      versionName: input.versionName,
      versionCode: normal + 1,
      sourceCommit: input.sourceCommit,
      recovery: true,
      sourceDir: input.sourceDir,
      emitsReleaseMetadata: true,
    };
  }
  const code = input.versionCode ?? Math.floor(input.nowMs / 60_000);
  if (!Number.isInteger(code) || code < 1 || code + 1 > ANDROID_MAX_VERSION_CODE) {
    throw invalidCode("version-code", code, ANDROID_MAX_VERSION_CODE - 1);
  }
  if (input.normalVersionCode !== null)
    throw new Error("--normal-version-code only applies to --kind recovery.");
  const commit = input.sourceCommit ?? "unknown";
  return {
    kind: "normal",
    versionName: input.versionName,
    versionCode: code,
    sourceCommit: commit,
    recovery: false,
    sourceDir: input.sourceDir ?? input.repoRoot,
    emitsReleaseMetadata: commit !== "unknown",
  };
};

/** The files that prove a checkout carries the updater and understands the build properties we pass. */
export const UPDATER_MARKERS = {
  controller:
    "apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NativeUpdateController.java",
  gradle: "apps/android-pwa/app/build.gradle",
} as const;

/**
 * A recovery build recompiles an older source. That source must itself be updater-equipped,
 * otherwise the rolled-back app could never update again. Returns the reasons it is not.
 */
export const predecessorProblems = (
  readFile: (relativePath: string) => string | null,
): string[] => {
  const problems: string[] = [];
  if (readFile(UPDATER_MARKERS.controller) === null) {
    problems.push("the predecessor has no native updater (NativeUpdateController.java is missing)");
  }
  const gradle = readFile(UPDATER_MARKERS.gradle);
  if (gradle === null) problems.push("the predecessor has no Android build.gradle");
  else {
    for (const property of ["pwaSourceCommit", "pwaRecovery"]) {
      if (!gradle.includes(property))
        problems.push(`the predecessor build does not accept -P${property}`);
    }
  }
  return problems;
};

export interface AndroidBuildMetadata {
  readonly format: 1;
  readonly packageName: typeof ANDROID_PWA_PACKAGE;
  readonly versionName: string;
  readonly versionCode: number;
  readonly sourceCommit: string;
  readonly signerSha256: string;
  readonly updaterProtocol: typeof ANDROID_UPDATER_PROTOCOL;
  readonly apkSha256: string;
  readonly kind: AndroidBuildKind;
  readonly assetName: string;
  readonly bytes: number;
}

/** Per-APK identity for the release workflow: a claim it re-verifies against the APK, never proof. */
export const androidBuildMetadata = (input: {
  readonly plan: AndroidBuildPlan;
  readonly signerSha256: string;
  readonly apkSha256: string;
  readonly assetName: string;
  readonly bytes: number;
}): AndroidBuildMetadata => {
  if (!input.plan.emitsReleaseMetadata)
    throw new Error("A build of an unknown source has no release identity.");
  if (!isSha256(input.signerSha256) || !isSha256(input.apkSha256))
    throw new Error("Digests must be lowercase SHA-256.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(input.assetName)) throw new Error("Invalid asset name.");
  return {
    format: 1,
    packageName: ANDROID_PWA_PACKAGE,
    versionName: input.plan.versionName,
    versionCode: input.plan.versionCode,
    sourceCommit: input.plan.sourceCommit,
    signerSha256: input.signerSha256,
    updaterProtocol: ANDROID_UPDATER_PROTOCOL,
    apkSha256: input.apkSha256,
    kind: input.plan.kind,
    assetName: input.assetName,
    bytes: input.bytes,
  };
};

/** `apksigner verify --print-certs` must identify one pinned signing certificate. */
export const singleSignerDigest = (output: string): string => {
  const digests: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("certificate SHA-256 digest:")) continue;
    const match =
      /^[ \t]*Signer(?: #\d+ \(minSdkVersion=\d+, maxSdkVersion=\d+\)| #\d+| \(minSdkVersion=\d+, maxSdkVersion=\d+\)) certificate SHA-256 digest: ([0-9a-fA-F]{64})[ \t]*$/.exec(
        line,
      );
    if (!match)
      throw new Error(`Unrecognized apksigner certificate SHA-256 output: ${line.slice(0, 180)}`);
    digests.push(match[1]!.toLowerCase());
  }
  const identities = [...new Set(digests)];
  if (identities.length !== 1)
    throw new Error(`Expected exactly one APK signer certificate, found ${identities.length}.`);
  return identities[0]!;
};

export interface AaptFacts {
  readonly packageName: string;
  readonly versionCode: number;
  readonly versionName: string;
  readonly debuggable: boolean;
}

/** Reads `aapt2 dump badging` output. */
export const parseBadging = (output: string): AaptFacts => {
  const line = /^package: (.+)$/m.exec(output)?.[1] ?? "";
  const field = (key: string) => new RegExp(`${key}='([^']*)'`).exec(line)?.[1];
  const packageName = field("name");
  const versionCode = Number(field("versionCode"));
  const versionName = field("versionName");
  if (!packageName || !Number.isInteger(versionCode) || !versionName) {
    throw new Error("aapt2 badging has no package name, versionCode, and versionName.");
  }
  return {
    packageName,
    versionCode,
    versionName,
    debuggable: /^application-debuggable\b/m.test(output),
  };
};

/** Throws if the compiled APK is not the build the plan asked for. */
export const verifyBuiltApk = (plan: AndroidBuildPlan, facts: AaptFacts): void => {
  if (facts.packageName !== ANDROID_PWA_PACKAGE)
    throw new Error(`The APK package is ${facts.packageName}.`);
  if (facts.debuggable) throw new Error("The APK is debuggable.");
  if (facts.versionCode !== plan.versionCode) {
    throw new Error(`The APK versionCode is ${facts.versionCode}, expected ${plan.versionCode}.`);
  }
  if (facts.versionName !== plan.versionName) {
    throw new Error(`The APK versionName is ${facts.versionName}, expected ${plan.versionName}.`);
  }
};

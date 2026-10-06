// @effect-diagnostics nodeBuiltinImport:off globalDate:off - release tooling hashes and reads files synchronously.
// Candidate asset discovery and verification for fork releases. Everything here works on files
// already downloaded into a directory, so it runs unchanged against real build output and
// against the fixture trees in fork-release-assets.test.ts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseUpdateManifest } from "./lib/update-manifest.ts";
import {
  FORK_ANDROID_PACKAGE,
  decodeForkReleaseManifest,
  type ForkReleaseManifest,
} from "./fork-release-contract.ts";
import {
  PACKAGE_VALIDATION,
  REQUIRED_SUITES,
  SUITES,
  VALIDATION_CHECKS,
  VALIDATION_TARGETS,
  suiteReceiptCounts,
  type SuiteReceipt,
  type ValidationCheck,
  type ValidationTarget,
} from "./fork-release-suites.ts";
import {
  FORK_CHECKSUMS_ASSET,
  FORK_MANIFEST_ASSET,
  type ForkChannel,
} from "./fork-release-policy.ts";
import { singleSignerDigest } from "./lib/android-pwa-config.ts";

export type AssetKind = ForkReleaseManifest["assets"][number]["kind"];
export type AssetPlatform = ForkReleaseManifest["assets"][number]["platform"];

export interface CandidateAsset {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: AssetKind;
  readonly platform: AssetPlatform;
}

export const sha256Bytes = (data: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

export const sha256File = (file: string): string => {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = NodeFS.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest("hex");
};

const sha512Base64 = (file: string): string => {
  const hash = NodeCrypto.createHash("sha512");
  hash.update(NodeFS.readFileSync(file));
  return hash.digest("base64");
};

// ---------------------------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------------------------

export interface AndroidFacts {
  readonly packageName: string;
  readonly versionCode: number;
  readonly versionName: string;
  readonly debuggable: boolean;
}

/** Reads `aapt2 dump badging` output. */
export const parseAaptBadging = (output: string): AndroidFacts => {
  const line = /^package: (.+)$/m.exec(output)?.[1];
  const field = (key: string) => new RegExp(`${key}='([^']*)'`).exec(line ?? "")?.[1];
  const packageName = field("name");
  const versionCode = Number(field("versionCode"));
  const versionName = field("versionName");
  if (!packageName || !Number.isInteger(versionCode) || !versionName) {
    throw new Error("aapt2 badging output has no package name, versionCode, and versionName.");
  }
  return {
    packageName,
    versionCode,
    versionName,
    debuggable: /^application-debuggable\b/m.test(output),
  };
};

/** Reads `apksigner verify --print-certs`; a release must carry exactly one signer. */
export const parseApksignerCerts = singleSignerDigest;

/**
 * Sidecar the Android build helper writes beside each APK. It is a claim, never proof: every
 * field except `updaterProtocol` is compared against what the APK itself reports.
 */
export interface AndroidBuildMetadata {
  readonly format: 1;
  readonly packageName: string;
  readonly versionName: string;
  readonly versionCode: number;
  readonly sourceCommit: string;
  readonly signerSha256: string;
  readonly updaterProtocol: number;
  readonly apkSha256: string;
  /** Written by scripts/build-android-pwa.ts; checked when present. */
  readonly kind?: "normal" | "recovery";
  readonly assetName?: string;
  readonly bytes?: number;
}

export const parseAndroidBuildMetadata = (raw: unknown): AndroidBuildMetadata => {
  const value = raw as Record<string, unknown> | null;
  const isHex = (input: unknown, length: number) =>
    typeof input === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(input);
  if (
    !value ||
    value.format !== 1 ||
    typeof value.packageName !== "string" ||
    typeof value.versionName !== "string" ||
    !Number.isInteger(value.versionCode) ||
    !isHex(value.sourceCommit, 40) ||
    !isHex(value.signerSha256, 64) ||
    !Number.isInteger(value.updaterProtocol) ||
    !isHex(value.apkSha256, 64) ||
    (value.kind !== undefined && value.kind !== "normal" && value.kind !== "recovery") ||
    (value.assetName !== undefined && typeof value.assetName !== "string") ||
    (value.bytes !== undefined && !Number.isInteger(value.bytes))
  ) {
    throw new Error("Android build metadata does not match format 1.");
  }
  return value as unknown as AndroidBuildMetadata;
};

export interface VerifiedAndroidApk {
  readonly asset: string;
  readonly versionCode: number;
  readonly sourceVersion: string;
  readonly sourceCommit: string;
  readonly packageName: typeof FORK_ANDROID_PACKAGE;
  readonly signerSha256: string;
  readonly updaterProtocol: 1;
  readonly apkSha256: string;
}

/** Compares what the APK reports with what the release expects; throws on the first mismatch. */
export const verifyAndroidApk = (input: {
  readonly assetName: string;
  readonly apkSha256: string;
  readonly facts: AndroidFacts;
  readonly signerSha256: string;
  readonly metadata: AndroidBuildMetadata;
  readonly expectVersionCode: number;
  readonly expectVersion: string;
  readonly expectCommit: string;
  readonly expectSignerSha256: string | null;
  readonly expectKind?: "normal" | "recovery";
  readonly apkBytes?: number;
}): VerifiedAndroidApk => {
  const { facts, metadata } = input;
  const fail = (message: string): never => {
    throw new Error(`${input.assetName}: ${message}`);
  };
  if (facts.packageName !== FORK_ANDROID_PACKAGE) {
    fail(`package is ${facts.packageName}, expected ${FORK_ANDROID_PACKAGE}.`);
  }
  if (facts.debuggable) fail("the APK is debuggable.");
  if (facts.versionCode !== input.expectVersionCode) {
    fail(`versionCode is ${facts.versionCode}, expected ${input.expectVersionCode}.`);
  }
  if (facts.versionName !== input.expectVersion) {
    fail(`versionName is ${facts.versionName}, expected ${input.expectVersion}.`);
  }
  if (input.expectSignerSha256 !== null && input.signerSha256 !== input.expectSignerSha256) {
    fail("the signing certificate is not the pinned release identity.");
  }
  if (metadata.packageName !== facts.packageName) fail("metadata package differs from the APK.");
  if (metadata.versionCode !== facts.versionCode)
    fail("metadata versionCode differs from the APK.");
  if (metadata.versionName !== facts.versionName)
    fail("metadata versionName differs from the APK.");
  if (metadata.signerSha256 !== input.signerSha256) fail("metadata signer differs from the APK.");
  if (metadata.apkSha256 !== input.apkSha256) fail("metadata digest differs from the APK bytes.");
  if (metadata.sourceCommit !== input.expectCommit) {
    fail(`built from ${metadata.sourceCommit}, expected ${input.expectCommit}.`);
  }
  if (metadata.updaterProtocol !== 1) fail("the APK does not carry updater protocol 1.");
  if (input.expectKind && metadata.kind !== undefined && metadata.kind !== input.expectKind) {
    fail(`metadata describes a ${metadata.kind} build, expected ${input.expectKind}.`);
  }
  if (metadata.assetName !== undefined && metadata.assetName !== input.assetName) {
    fail(`metadata names the asset ${metadata.assetName}.`);
  }
  if (
    metadata.bytes !== undefined &&
    input.apkBytes !== undefined &&
    metadata.bytes !== input.apkBytes
  ) {
    fail("metadata size differs from the APK.");
  }
  return {
    asset: input.assetName,
    versionCode: facts.versionCode,
    sourceVersion: facts.versionName,
    sourceCommit: metadata.sourceCommit,
    packageName: FORK_ANDROID_PACKAGE,
    signerSha256: input.signerSha256,
    updaterProtocol: 1,
    apkSha256: input.apkSha256,
  };
};

// ---------------------------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------------------------

/** Artifact directories the build jobs upload, as downloaded into one input tree. */
export const ARTIFACT_DIRS = {
  windowsDesktop: "desktop-win-x64",
  linuxDesktop: "desktop-linux-x64",
  windowsServer: "cli-win-x64",
  linuxServer: "cli-linux-x64",
  androidNormal: "android-normal",
  androidRecovery: "android-recovery",
  wslEmbedded: "wsl-embedded-x64",
} as const;
export const ANDROID_METADATA_FILE = "metadata.json";
export const WSL_EMBEDDED_FILE = "wsl-embedded.json";
/** electron-builder's configuration dump: never a feed and never published. */
const IGNORED_DESKTOP_FILES = new Set(["builder-debug.yml"]);

/**
 * Linux ships both packagings as `desktop` assets for the same platform. Devices tell them apart
 * by exact suffix (`.AppImage` or `.deb`, see forkDesktopAssetFor in packages/shared), so each
 * release carries exactly one of each and any other desktop file is an extra asset.
 */

export interface HelperAssetSpec {
  readonly name: string;
  readonly platform: Exclude<AssetPlatform, "android">;
}

export interface DiscoveryInput {
  readonly inputDir: string;
  readonly version: string;
  readonly channel: ForkChannel;
  readonly helperAssets: ReadonlyArray<HelperAssetSpec>;
}

export interface Discovery {
  readonly assets: ReadonlyArray<CandidateAsset>;
  readonly problems: ReadonlyArray<string>;
}

const listFiles = (dir: string): string[] =>
  NodeFS.existsSync(dir)
    ? NodeFS.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];

export const feedBaseName = (channel: ForkChannel): string =>
  channel === "nightly" ? "nightly" : "latest";

/** Finds every asset a release must carry, reporting each missing, duplicated, or extra file. */
export const discoverCandidateAssets = (input: DiscoveryInput): Discovery => {
  const problems: string[] = [];
  const assets: CandidateAsset[] = [];
  const names = new Set<string>();
  const feed = feedBaseName(input.channel);

  const add = (
    dir: string,
    name: string,
    kind: AssetKind,
    platform: AssetPlatform,
    publishedAs: string = name,
  ) => {
    const file = NodePath.join(input.inputDir, dir, name);
    if (names.has(publishedAs)) {
      problems.push(`${dir}/${name}: asset name ${publishedAs} is produced twice.`);
      return;
    }
    const bytes = NodeFS.statSync(file).size;
    if (bytes === 0) {
      problems.push(`${dir}/${name}: file is empty.`);
      return;
    }
    names.add(publishedAs);
    assets.push({ name: publishedAs, path: file, sha256: sha256File(file), bytes, kind, platform });
  };

  // One directory, an exact list of expected files; anything else is an extra asset.
  const claim = (
    dir: string,
    expected: ReadonlyArray<{
      readonly file: string;
      readonly kind: AssetKind;
      readonly platform: AssetPlatform;
      readonly publishedAs?: string;
      readonly optional?: boolean;
    }>,
    ignored: ReadonlySet<string> = new Set(),
  ) => {
    const present = listFiles(NodePath.join(input.inputDir, dir));
    const known = new Set(expected.map((entry) => entry.file));
    for (const entry of expected) {
      if (present.includes(entry.file)) {
        add(dir, entry.file, entry.kind, entry.platform, entry.publishedAs);
      } else if (!entry.optional) {
        problems.push(`${dir}: missing ${entry.file}.`);
      }
    }
    for (const file of present) {
      if (!known.has(file) && !ignored.has(file))
        problems.push(`${dir}/${file}: unexpected asset.`);
    }
  };

  const only = (dir: string, extension: string): string | null => {
    const matches = listFiles(NodePath.join(input.inputDir, dir)).filter(
      (file) => file.endsWith(extension) && file.startsWith("T3-Code-"),
    );
    if (matches.length !== 1) {
      problems.push(`${dir}: expected exactly one *${extension}, found ${matches.length}.`);
      return null;
    }
    return matches[0]!;
  };

  const windowsInstaller = only(ARTIFACT_DIRS.windowsDesktop, ".exe");
  if (windowsInstaller) {
    claim(
      ARTIFACT_DIRS.windowsDesktop,
      [
        { file: windowsInstaller, kind: "desktop", platform: "windows-x64" },
        { file: `${windowsInstaller}.blockmap`, kind: "blockmap", platform: "windows-x64" },
        {
          file: `${feed}-win-x64.yml`,
          kind: "feed",
          platform: "windows-x64",
          publishedAs: `${feed}.yml`,
        },
      ],
      IGNORED_DESKTOP_FILES,
    );
  }

  const appImage = only(ARTIFACT_DIRS.linuxDesktop, ".AppImage");
  const deb = only(ARTIFACT_DIRS.linuxDesktop, ".deb");
  if (appImage && deb) {
    claim(
      ARTIFACT_DIRS.linuxDesktop,
      [
        { file: appImage, kind: "desktop", platform: "linux-x64" },
        { file: deb, kind: "desktop", platform: "linux-x64" },
        { file: `${appImage}.blockmap`, kind: "blockmap", platform: "linux-x64", optional: true },
        { file: `${feed}-linux.yml`, kind: "feed", platform: "linux-x64" },
      ],
      IGNORED_DESKTOP_FILES,
    );
  }

  claim(ARTIFACT_DIRS.linuxServer, [
    { file: `t3-${input.version}-linux-x64.tar.gz`, kind: "server", platform: "linux-x64" },
  ]);
  claim(ARTIFACT_DIRS.windowsServer, [
    { file: `t3-${input.version}-win32-x64.zip`, kind: "server", platform: "windows-x64" },
  ]);
  claim(
    ARTIFACT_DIRS.androidNormal,
    [{ file: `t3-code-android-${input.version}.apk`, kind: "android", platform: "android" }],
    new Set([ANDROID_METADATA_FILE]),
  );
  claim(
    ARTIFACT_DIRS.androidRecovery,
    [
      {
        file: `t3-code-android-recovery-${input.version}.apk`,
        kind: "android-recovery",
        platform: "android",
      },
    ],
    new Set([ANDROID_METADATA_FILE]),
  );

  if (input.helperAssets.length === 0) {
    problems.push("The recovery helper assets are not configured, so none can be validated.");
  }
  // Both the helper and its retained runtime are required for recovery without the app.
  for (const platform of ["linux-x64", "windows-x64"] as const) {
    const helpers = input.helperAssets.filter((helper) => helper.platform === platform);
    const names = new Set(helpers.map((helper) => helper.name));
    const required = [
      `t3-recovery-helper-${platform}.mjs`,
      `t3-recovery-node-${platform}${platform === "windows-x64" ? ".exe" : ""}`,
    ];
    if (helpers.length !== 2 || names.size !== 2 || required.some((name) => !names.has(name))) {
      problems.push(
        `Exactly one helper and one recovery runtime are required for ${platform}, found ${helpers.length}.`,
      );
    }
    claim(
      `recovery-helper-${platform}`,
      helpers.map((helper) => ({ file: helper.name, kind: "recovery-helper" as const, platform })),
    );
  }

  return { assets, problems };
};

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

/** Checks a feed: right version, and every referenced file present with its recorded size and digest. */
export const verifyFeed = (input: {
  readonly feed: CandidateAsset;
  readonly installers: ReadonlyArray<string>;
  readonly version: string;
  readonly assets: ReadonlyArray<CandidateAsset>;
}): string[] => {
  const problems: string[] = [];
  let parsed;
  try {
    parsed = parseUpdateManifest(
      NodeFS.readFileSync(input.feed.path, "utf8"),
      input.feed.name,
      input.feed.platform,
    );
  } catch (cause) {
    return [`${input.feed.name}: ${cause instanceof Error ? cause.message : String(cause)}`];
  }
  if (parsed.version !== input.version) {
    problems.push(`${input.feed.name}: feed version ${parsed.version} is not ${input.version}.`);
  }
  const byName = new Map(input.assets.map((asset) => [asset.name, asset]));
  const referenced = new Set<string>();
  const check = (rawUrl: string, sha512: string | null, size: number | null) => {
    const name = decodeURIComponent(rawUrl);
    referenced.add(name);
    const asset = byName.get(name);
    if (!asset) {
      problems.push(`${input.feed.name}: references ${name}, which is not a release asset.`);
      return;
    }
    if (size !== null && size !== asset.bytes) {
      problems.push(`${input.feed.name}: ${name} is ${asset.bytes} bytes, feed says ${size}.`);
    }
    if (sha512 !== null && sha512 !== sha512Base64(asset.path)) {
      problems.push(`${input.feed.name}: ${name} does not match the feed's sha512.`);
    }
  };
  for (const file of parsed.files) check(file.url, file.sha512, file.size);
  if (typeof parsed.extras.path === "string") check(parsed.extras.path, null, null);
  for (const installer of input.installers) {
    if (!referenced.has(installer)) {
      problems.push(`${input.feed.name}: does not reference installer ${installer}.`);
    }
  }
  return problems;
};

export interface WslEmbeddedReceipt {
  readonly archive: string;
  readonly sha256: string;
}

export interface BuildVerificationInput extends DiscoveryInput {
  readonly android: {
    readonly normal: VerifiedAndroidApk | null;
    readonly recovery: VerifiedAndroidApk | null;
  };
  readonly wslEmbedded: WslEmbeddedReceipt | null;
}

export interface BuildVerification {
  readonly assets: ReadonlyArray<CandidateAsset>;
  readonly problems: ReadonlyArray<string>;
}

/** Everything the `build` check means: complete assets, honest feeds, exact embedded WSL bytes. */
export const verifyBuild = (input: BuildVerificationInput): BuildVerification => {
  const discovery = discoverCandidateAssets(input);
  const problems = [...discovery.problems];
  const assets = discovery.assets;

  for (const feed of assets.filter((asset) => asset.kind === "feed")) {
    const installers = assets
      .filter(
        (asset) =>
          asset.platform === feed.platform &&
          asset.kind === "desktop" &&
          (feed.platform === "windows-x64" || asset.name.endsWith(".AppImage")),
      )
      .map((asset) => asset.name);
    problems.push(...verifyFeed({ feed, installers, version: input.version, assets }));
  }

  const linuxServer = assets.find(
    (asset) => asset.kind === "server" && asset.platform === "linux-x64",
  );
  if (!input.wslEmbedded) {
    problems.push("The Windows installer produced no embedded WSL runtime receipt.");
  } else if (
    !linuxServer ||
    input.wslEmbedded.archive !== linuxServer.name ||
    input.wslEmbedded.sha256 !== linuxServer.sha256
  ) {
    problems.push(
      "The WSL runtime embedded in the Windows installer is not byte-identical to the Linux server archive.",
    );
  }

  for (const role of ["normal", "recovery"] as const) {
    const verified = input.android[role];
    const asset = assets.find(
      (entry) => entry.kind === (role === "normal" ? "android" : "android-recovery"),
    );
    if (!verified) {
      problems.push(`The ${role} Android APK has no verified metadata.`);
    } else if (!asset || asset.name !== verified.asset || asset.sha256 !== verified.apkSha256) {
      problems.push(`The ${role} Android APK differs from the bytes that were verified.`);
    }
  }
  if (input.android.normal && input.android.recovery) {
    if (input.android.normal.signerSha256 !== input.android.recovery.signerSha256) {
      problems.push("The normal and recovery APKs are signed by different keys.");
    }
    if (input.android.normal.versionCode >= input.android.recovery.versionCode) {
      problems.push("The recovery APK must have a higher installation code than the normal APK.");
    }
    if (input.android.normal.sourceCommit === input.android.recovery.sourceCommit) {
      problems.push("The recovery APK is built from the same source as the normal APK.");
    }
  }

  return { assets, problems };
};

/** The `sha256sum`-format file installers verify server archives against. */
export const renderChecksums = (assets: ReadonlyArray<CandidateAsset>): string =>
  assets
    .filter((asset) => asset.kind === "server")
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join("");

/** One digest for the whole payload; receipts bind to it so a test cannot vouch for other bytes. */
export const candidateDigest = (assets: ReadonlyArray<{ name: string; sha256: string }>): string =>
  sha256Bytes(
    Buffer.from(
      assets
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((asset) => `${asset.sha256}  ${asset.name}\n`)
        .join(""),
    ),
  );

// ---------------------------------------------------------------------------------------------
// Validation receipts
// ---------------------------------------------------------------------------------------------

export { VALIDATION_CHECKS, VALIDATION_TARGETS };
export type { ValidationCheck, ValidationTarget };

export interface CheckReceipt {
  readonly format: 1;
  readonly check: ValidationCheck;
  readonly target: ValidationTarget;
  readonly version: string;
  readonly commit: string;
  readonly channel: ForkChannel;
  readonly candidateDigest: string;
  readonly predecessorDigest: string | null;
  readonly command: ReadonlyArray<string> | null;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runner: string;
  readonly runUrl: string;
}

export const parseCheckReceipt = (raw: unknown): CheckReceipt | null => {
  const value = raw as Partial<CheckReceipt> | null;
  if (
    !value ||
    value.format !== 1 ||
    !VALIDATION_CHECKS.includes(value.check as ValidationCheck) ||
    !VALIDATION_TARGETS.includes(value.target as ValidationTarget) ||
    typeof value.version !== "string" ||
    typeof value.commit !== "string" ||
    typeof value.candidateDigest !== "string" ||
    !Number.isInteger(value.exitCode) ||
    typeof value.passed !== "boolean"
  ) {
    return null;
  }
  return value as CheckReceipt;
};

export interface ChecksExpectation {
  readonly version: string;
  readonly commit: string;
  readonly channel: ForkChannel;
  readonly candidateDigest: string;
  readonly predecessorDigest: string | null;
}

const sameCommand = (command: ReadonlyArray<string> | null) =>
  command !== null &&
  command.length === PACKAGE_VALIDATION.run.length &&
  command.every((part, index) => part === PACKAGE_VALIDATION.run[index]);

/**
 * A check is true only when two kinds of evidence both exist for exactly this candidate.
 *
 * Package receipts: every target ran the package validation command defined in code, against this
 * artifact payload, with a zero exit. Update and recovery also name the predecessor they ran from.
 *
 * Suite receipts: every safety suite that check depends on (coordinator, desktop and Android
 * updaters) passed on every target it covers, running exactly the specification defined in code,
 * from a clean checkout of the commit these artifacts were built from, bound to this payload.
 *
 * A missing, failing, substituted, or stale receipt of either kind makes the check false.
 */
export const evaluateChecks = (
  receipts: ReadonlyArray<CheckReceipt>,
  suiteReceipts: ReadonlyArray<SuiteReceipt>,
  expect: ChecksExpectation,
  build: boolean,
): ForkReleaseManifest["checks"] => {
  const packagePasses = (check: ValidationCheck) =>
    VALIDATION_TARGETS.every((target) =>
      receipts.some(
        (receipt) =>
          receipt.check === check &&
          receipt.target === target &&
          receipt.version === expect.version &&
          receipt.commit === expect.commit &&
          receipt.channel === expect.channel &&
          receipt.candidateDigest === expect.candidateDigest &&
          sameCommand(receipt.command) &&
          receipt.exitCode === 0 &&
          receipt.passed &&
          (check === "install" ||
            (expect.predecessorDigest !== null &&
              receipt.predecessorDigest === expect.predecessorDigest)),
      ),
    );
  const suitesPass = (check: ValidationCheck) =>
    REQUIRED_SUITES[check].every((suite) =>
      SUITES[suite].targets.every((target) =>
        suiteReceipts.some((receipt) => suiteReceiptCounts(receipt, suite, target, expect)),
      ),
    );
  const passes = (check: ValidationCheck) => packagePasses(check) && suitesPass(check);
  return {
    build,
    install: passes("install"),
    update: passes("update"),
    recovery: passes("recovery"),
  };
};

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

const toAndroidArtifact = (verified: VerifiedAndroidApk) => ({
  asset: verified.asset,
  versionCode: verified.versionCode,
  sourceVersion: verified.sourceVersion,
  sourceCommit: verified.sourceCommit,
  packageName: verified.packageName,
  signerSha256: verified.signerSha256,
  updaterProtocol: verified.updaterProtocol,
});

/** Builds fork-release.json and proves it decodes under the exact contract schema. */
export const composeManifest = (input: {
  readonly version: string;
  readonly commit: string;
  readonly channel: ForkChannel;
  readonly releasedAt: string;
  readonly assets: ReadonlyArray<CandidateAsset>;
  readonly android: { readonly normal: VerifiedAndroidApk; readonly recovery: VerifiedAndroidApk };
  readonly checks: ForkReleaseManifest["checks"];
}): ForkReleaseManifest =>
  decodeForkReleaseManifest({
    format: 1,
    repository: "unn-corp/t3code",
    version: input.version,
    commit: input.commit,
    channel: input.channel,
    releasedAt: input.releasedAt,
    assets: input.assets
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(({ name, sha256, bytes, kind, platform }) => ({ name, sha256, bytes, kind, platform })),
    android: {
      normal: toAndroidArtifact(input.android.normal),
      recovery: toAndroidArtifact(input.android.recovery),
    },
    checks: input.checks,
  });

export const allChecksPass = (checks: ForkReleaseManifest["checks"]): boolean =>
  checks.build && checks.install && checks.update && checks.recovery;

/** Confirms a directory holds exactly the files a manifest lists, byte for byte. */
export const verifyPayloadAgainstManifest = (
  dir: string,
  manifest: ForkReleaseManifest,
): string[] => {
  const problems: string[] = [];
  const expected = new Map(manifest.assets.map((asset) => [asset.name, asset]));
  const present = new Set(listFiles(dir));
  for (const required of [FORK_MANIFEST_ASSET, ...expected.keys()]) {
    if (!present.has(required)) problems.push(`${required}: missing from the release.`);
  }
  for (const file of present) {
    if (file !== FORK_MANIFEST_ASSET && !expected.has(file))
      problems.push(`${file}: not in the manifest.`);
  }
  for (const [name, asset] of expected) {
    if (!present.has(name)) continue;
    const file = NodePath.join(dir, name);
    if (NodeFS.statSync(file).size !== asset.bytes)
      problems.push(`${name}: size differs from the manifest.`);
    else if (sha256File(file) !== asset.sha256)
      problems.push(`${name}: digest differs from the manifest.`);
  }
  if (!expected.has(FORK_CHECKSUMS_ASSET))
    problems.push(`${FORK_CHECKSUMS_ASSET}: not listed in the manifest.`);
  return problems;
};

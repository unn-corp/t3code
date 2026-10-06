#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - release tooling runs host tools before any Effect runtime exists.
// Command line for the fork release workflows. Each subcommand does one verifiable step and
// fails closed: a non-zero exit means the release must not advance.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ANDROID_RECOVERY_EXTRAS_DIR,
  ANDROID_METADATA_FILE,
  ARTIFACT_DIRS,
  VALIDATION_CHECKS,
  VALIDATION_TARGETS,
  WSL_EMBEDDED_FILE,
  allChecksPass,
  candidateDigest,
  composeManifest,
  evaluateChecks,
  parseAaptBadging,
  parseAndroidBuildMetadata,
  parseApksignerCerts,
  parseCheckReceipt,
  renderChecksums,
  sha256File,
  verifyAndroidApk,
  verifyBuild,
  type CandidateAsset,
  type CheckReceipt,
  type VerifiedAndroidApk,
  type WslEmbeddedReceipt,
} from "./fork-release-assets.ts";
import { FORK_ANDROID_PACKAGE } from "./fork-release-contract.ts";
import { runValidation } from "./fork-release-config.ts";
import { RECOVERY_HELPER_ASSETS, buildRecoveryHelper } from "./fork-release-helper.ts";
import {
  PACKAGE_VALIDATION,
  SUITES,
  parseSuiteReceipt,
  runSuite,
  type SuiteId,
  type SuiteReceipt,
} from "./fork-release-suites.ts";
import {
  BASELINE_TAG,
  packBaseline,
  parseBaselineManifest,
  verifyBaselinePayload,
  BASELINE_MANIFEST_ASSET,
  baselineDigest,
} from "./fork-release-baseline.ts";
import { androidCodeRangeTag, androidCodeTag } from "./fork-release-policy.ts";
import {
  createDraft,
  createGitHubApi,
  fetchRelease,
  loadBaseline,
  loadReleaseRecords,
  publishDraft,
  reserveAndroidCodes,
  restoreRelease,
  withdrawRelease,
  type GitHubApi,
} from "./fork-release-github.ts";
import {
  FORK_CHECKSUMS_ASSET,
  FORK_MANIFEST_ASSET,
  buildPlan,
  type AndroidCodeAllocation,
  type ForkChannel,
  type PlannedRelease,
} from "./fork-release-policy.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

type Args = Readonly<Record<string, string | undefined>>;

interface AndroidCodeReceipt extends AndroidCodeAllocation {
  readonly plan: {
    readonly version: string;
    readonly commit: string;
    readonly channel: ForkChannel;
    readonly recoveries: ReadonlyArray<{
      readonly version: string;
      readonly commit: string;
      readonly asset: string;
      readonly tag: string;
    }>;
  };
  readonly reservation: {
    readonly rangeTag: string;
    readonly startTag: string;
  };
}

const readJson = (file: string): unknown => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Appends `key=value` lines for later workflow steps; values here never contain newlines. */
const setOutputs = (outputs: Readonly<Record<string, string | number | boolean>>) => {
  const target = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (target) NodeFS.appendFileSync(target, `${lines.join("\n")}\n`);
  for (const line of lines) console.log(line);
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
};

const githubFromEnv = (): GitHubApi =>
  createGitHubApi({
    token: requireEnv("GITHUB_TOKEN"),
    repository: requireEnv("GITHUB_REPOSITORY"),
  });

const loadPlan = (file: string): PlannedRelease => {
  const plan = readJson(file) as PlannedRelease & { skip?: boolean };
  if (plan.skip) throw new Error("This run was planned as a skip; later steps must not run.");
  return plan;
};

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------

const runPlan = async (values: Args) => {
  const channel = values.channel as ForkChannel;
  if (channel !== "stable" && channel !== "nightly")
    throw new Error("--channel must be stable or nightly.");
  const github = githubFromEnv();
  const releases = await loadReleaseRecords(github);
  const baseline = await loadBaseline(github);
  const outcome = buildPlan({
    channel,
    ...(channel === "nightly" ? { commit: values.commit ?? requireEnv("GITHUB_SHA") } : {}),
    now: new Date(),
    runNumber: Number(values["run-number"] ?? process.env.GITHUB_RUN_NUMBER ?? "0"),
    releases,
    baseline: baseline
      ? {
          tag: BASELINE_TAG,
          version: baseline.manifest.version,
          commit: baseline.manifest.commit,
        }
      : null,
  });
  const out = values.out ?? "fork-release-plan.json";
  if (outcome.kind === "skip") {
    writeJson(out, { skip: true, reason: outcome.reason });
    setOutputs({ skip: true, reason: outcome.reason });
    return;
  }
  const plan = outcome.plan;
  writeJson(out, { ...plan, skip: false, plannedAt: new Date().toISOString() });
  setOutputs({
    skip: false,
    channel: plan.channel,
    version: plan.version,
    tag: plan.tag,
    commit: plan.commit,
    prerelease: plan.channel === "nightly",
    predecessor_tag: plan.predecessor.tag,
    predecessor_version: plan.predecessor.version,
    predecessor_commit: plan.predecessor.commit,
    predecessor_baseline: plan.predecessor.baseline === true,
    recovery_sources: JSON.stringify(plan.recoverySources),
    has_additional_recoveries: plan.recoverySources.length > 1,
  });
};

// ---------------------------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------------------------

const resolveBuildTool = (name: string): string => {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error("Set ANDROID_HOME to the Android SDK.");
  const tools = NodeFS.readdirSync(NodePath.join(sdk, "build-tools")).toSorted((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  for (const version of tools.toReversed()) {
    for (const suffix of ["", ".bat"]) {
      const candidate = NodePath.join(sdk, "build-tools", version, `${name}${suffix}`);
      if (NodeFS.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Android build-tools provide no ${name}.`);
};

/** Reads package identity and the single signer from an APK with the SDK's own tools. */
const readApk = (apk: string) => ({
  facts: parseAaptBadging(
    NodeChildProcess.execFileSync(resolveBuildTool("aapt2"), ["dump", "badging", apk], {
      encoding: "utf8",
    }),
  ),
  signer: parseApksignerCerts(
    NodeChildProcess.execFileSync(resolveBuildTool("apksigner"), ["verify", "--print-certs", apk], {
      encoding: "utf8",
    }),
  ),
});

const runAndroidVerify = (values: Args) => {
  const role = values.role as "normal" | "recovery";
  if (role !== "normal" && role !== "recovery")
    throw new Error("--role must be normal or recovery.");
  const apk = NodePath.resolve(values.apk ?? "");
  const releaseVersion = values["release-version"] ?? "";
  const { facts, signer } = readApk(apk);
  const apkSha256 = sha256File(apk);
  // The build helper writes metadata.json beside every release APK, recovery builds included.
  const metadata = parseAndroidBuildMetadata(readJson(NodePath.resolve(values.metadata ?? "")));
  const assetName =
    values["asset-name"] ??
    (role === "normal"
      ? `t3-code-android-${releaseVersion}.apk`
      : `t3-code-android-recovery-${releaseVersion}.apk`);
  const verified = verifyAndroidApk({
    assetName,
    apkSha256,
    facts,
    signerSha256: signer,
    metadata,
    expectVersionCode: Number(values.code),
    expectVersion: values["source-version"] ?? "",
    expectCommit: values.commit ?? "",
    expectSignerSha256: values["pinned-signer"] ? values["pinned-signer"].toLowerCase() : null,
    expectKind: role,
    apkBytes: NodeFS.statSync(apk).size,
  });
  const outDir = NodePath.resolve(values.out ?? "");
  NodeFS.mkdirSync(outDir, { recursive: true });
  NodeFS.copyFileSync(apk, NodePath.join(outDir, assetName));
  writeJson(NodePath.join(outDir, ANDROID_METADATA_FILE), verified);
  setOutputs({ [`${role}_signer`]: verified.signerSha256 });
};

// ---------------------------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------------------------

export interface BaselineProof {
  readonly format: 1;
  readonly version: string;
  readonly commit: string;
  readonly digest: string;
  readonly androidVersionCode: number;
  readonly signerSha256: string;
  readonly problems: ReadonlyArray<string>;
}

/**
 * Proves a baseline directory is what its manifest says: every file's bytes, and that the APK
 * reports the recorded package, installation code, and signer. The proof is evidence for a human
 * publishing the baseline; nothing in it is self-authenticating.
 */
export const proveBaseline = (dir: string, pinnedSigner: string | null): BaselineProof => {
  const manifest = parseBaselineManifest(readJson(NodePath.join(dir, BASELINE_MANIFEST_ASSET)));
  const problems = verifyBaselinePayload(dir, manifest);
  if (problems.length === 0) {
    const { facts, signer } = readApk(NodePath.join(dir, manifest.android.asset));
    if (facts.packageName !== FORK_ANDROID_PACKAGE)
      problems.push(`The APK package is ${facts.packageName}.`);
    if (facts.debuggable) problems.push("The baseline APK is debuggable.");
    if (facts.versionCode !== manifest.android.versionCode) {
      problems.push(
        `The APK versionCode is ${facts.versionCode}, the manifest says ${manifest.android.versionCode}.`,
      );
    }
    if (signer !== manifest.android.signerSha256)
      problems.push("The APK signer differs from the manifest.");
    if (pinnedSigner && signer !== pinnedSigner.toLowerCase()) {
      problems.push("The APK is not signed with the pinned release identity.");
    }
  }
  return {
    format: 1,
    version: manifest.version,
    commit: manifest.commit,
    digest: baselineDigest(manifest),
    androidVersionCode: manifest.android.versionCode,
    signerSha256: manifest.android.signerSha256,
    problems,
  };
};

const runBaselinePack = (values: Args): number => {
  const apk = NodePath.resolve(values.apk ?? "");
  const { facts, signer } = readApk(apk);
  const out = NodePath.resolve(values.out ?? "baseline");
  packBaseline({
    outDir: out,
    version: values.version ?? "",
    commit: values.commit ?? "",
    windowsInstaller: NodePath.resolve(values["windows-installer"] ?? ""),
    linuxAppImage: NodePath.resolve(values["linux-appimage"] ?? ""),
    linuxDeb: NodePath.resolve(values["linux-deb"] ?? ""),
    linuxServer: NodePath.resolve(values["linux-server"] ?? ""),
    apk,
    androidVersionCode: facts.versionCode,
    signerSha256: signer,
    recordedAt: new Date().toISOString(),
  });
  const proof = proveBaseline(out, values["pinned-signer"] ?? null);
  writeJson(`${out}.proof.json`, proof);
  proof.problems.forEach((problem) => console.error(problem));
  console.log(
    `Baseline ${proof.version} packed in ${out}; proof ${proof.problems.length === 0 ? "clean" : "FAILED"}.`,
  );
  return proof.problems.length === 0 ? 0 : 1;
};

// ---------------------------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------------------------

export interface CandidateRecord {
  readonly format: 1;
  readonly version: string;
  readonly commit: string;
  readonly channel: ForkChannel;
  readonly candidateDigest: string;
  readonly assets: ReadonlyArray<Omit<CandidateAsset, "path">>;
  readonly android: {
    readonly normal: VerifiedAndroidApk;
    readonly recovery: VerifiedAndroidApk;
    readonly recoveries: ReadonlyArray<VerifiedAndroidApk>;
  };
}

const readVerifiedApk = (
  dir: string,
  metadataName = ANDROID_METADATA_FILE,
): VerifiedAndroidApk | null => {
  const file = NodePath.join(dir, metadataName);
  return NodeFS.existsSync(file) ? (readJson(file) as VerifiedAndroidApk) : null;
};

const readWslReceipt = (inputDir: string): WslEmbeddedReceipt | null => {
  const file = NodePath.join(inputDir, ARTIFACT_DIRS.wslEmbedded, WSL_EMBEDDED_FILE);
  return NodeFS.existsSync(file) ? (readJson(file) as WslEmbeddedReceipt) : null;
};

/**
 * Verifies a downloaded artifact tree and flattens it into the release payload plus SHA256SUMS.
 * Returns the problems found; the candidate directory is written only when there are none.
 */
export const assembleCandidate = (input: {
  readonly plan: PlannedRelease;
  readonly inputDir: string;
  readonly outDir: string;
  readonly codeAllocation?: AndroidCodeReceipt;
}): { problems: string[]; record: CandidateRecord | null } => {
  const { plan } = input;
  const normal = readVerifiedApk(NodePath.join(input.inputDir, ARTIFACT_DIRS.androidNormal));
  const recoverySources = plan.recoverySources ?? [
    {
      ...plan.predecessor,
      channel: null,
      asset: `t3-code-android-recovery-${plan.version}.apk`,
    },
  ];
  const recoveryDirectories = recoverySources.map((source, index) => ({
    directory: index === 0 ? ARTIFACT_DIRS.androidRecovery : ANDROID_RECOVERY_EXTRAS_DIR,
    asset: source.asset,
  }));
  const recoveries = recoverySources.map((source, index) =>
    readVerifiedApk(
      NodePath.join(input.inputDir, recoveryDirectories[index]!.directory),
      index === 0 ? ANDROID_METADATA_FILE : `metadata-${index}.json`,
    ),
  );
  const recovery = recoveries[0] ?? null;
  const verification = verifyBuild({
    inputDir: input.inputDir,
    version: plan.version,
    channel: plan.channel,
    helperAssets: RECOVERY_HELPER_ASSETS,
    android: {
      normal,
      recovery,
      recoveries: recoveries.filter((entry): entry is VerifiedAndroidApk => entry !== null),
    },
    androidRecoveries: recoveryDirectories,
    wslEmbedded: readWslReceipt(input.inputDir),
  });
  const problems = [...verification.problems];
  if (input.codeAllocation) {
    const allocation = input.codeAllocation;
    if (
      allocation.plan.version !== plan.version ||
      allocation.plan.commit !== plan.commit ||
      allocation.plan.channel !== plan.channel ||
      allocation.plan.recoveries.length !== recoverySources.length ||
      allocation.plan.recoveries.some(
        (source, index) =>
          source.version !== recoverySources[index]?.version ||
          source.commit !== recoverySources[index]?.commit ||
          source.asset !== recoverySources[index]?.asset ||
          source.tag !== recoverySources[index]?.tag,
      ) ||
      allocation.reservation.rangeTag !==
        androidCodeRangeTag(allocation.normal, allocation.reservedThrough) ||
      allocation.reservation.startTag !== androidCodeTag(allocation.normal) ||
      !normal ||
      normal.versionCode !== allocation.normal ||
      allocation.recoveries.length !== recoverySources.length ||
      allocation.recovery !== allocation.recoveries[0] ||
      allocation.reservedThrough !== allocation.normal + allocation.recoveries.length
    ) {
      problems.push("Android APK codes do not match the durable reserved allocation.");
    } else {
      for (const [index, verified] of recoveries.entries()) {
        if (verified && verified.versionCode !== allocation.recoveries[index]) {
          problems.push(`Recovery APK ${index} does not use its exact reserved versionCode.`);
        }
      }
    }
  }
  if (normal && normal.sourceCommit !== plan.commit) {
    problems.push(
      `The normal APK was built from ${normal.sourceCommit}, not the pinned ${plan.commit}.`,
    );
  }
  if (
    recovery &&
    (recovery.sourceCommit !== plan.predecessor.commit ||
      recovery.sourceVersion !== plan.predecessor.version)
  ) {
    problems.push(
      `The primary recovery APK reports ${recovery.sourceVersion} at ${recovery.sourceCommit}, not ${plan.predecessor.version} at ${plan.predecessor.commit}.`,
    );
  }
  for (let index = 0; index < recoverySources.length; index++) {
    const source = recoverySources[index]!;
    const verified = recoveries[index];
    if (!verified) {
      problems.push(`Recovery APK metadata is missing for ${source.version} at ${source.commit}.`);
      continue;
    }
    if (
      verified.asset !== source.asset ||
      verified.sourceVersion !== source.version ||
      verified.sourceCommit !== source.commit
    )
      problems.push(
        `Recovery APK ${source.asset} does not match its frozen source ${source.version} at ${source.commit}.`,
      );
  }
  if (problems.length > 0 || !normal || !recovery || recoveries.some((entry) => entry === null))
    return { problems, record: null };

  NodeFS.rmSync(input.outDir, { recursive: true, force: true });
  NodeFS.mkdirSync(input.outDir, { recursive: true });
  for (const asset of verification.assets) {
    NodeFS.copyFileSync(asset.path, NodePath.join(input.outDir, asset.name));
  }
  const checksums = renderChecksums(verification.assets);
  NodeFS.writeFileSync(NodePath.join(input.outDir, FORK_CHECKSUMS_ASSET), checksums);
  const checksumAsset: CandidateAsset = {
    name: FORK_CHECKSUMS_ASSET,
    path: NodePath.join(input.outDir, FORK_CHECKSUMS_ASSET),
    sha256: sha256File(NodePath.join(input.outDir, FORK_CHECKSUMS_ASSET)),
    bytes: Buffer.byteLength(checksums),
    kind: "feed",
    platform: "shared",
  };
  const assets = [...verification.assets, checksumAsset];
  const record: CandidateRecord = {
    format: 1,
    version: plan.version,
    commit: plan.commit,
    channel: plan.channel,
    candidateDigest: candidateDigest(assets),
    assets: assets.map(({ path: _path, ...rest }) => rest),
    android: {
      normal,
      recovery,
      recoveries: recoveries as VerifiedAndroidApk[],
    },
  };
  writeJson(candidateRecordPath(input.outDir), record);
  return { problems, record };
};

// ---------------------------------------------------------------------------------------------
// receipts and manifest
// ---------------------------------------------------------------------------------------------

/** The record sits beside the payload directory, so it is never uploaded as a release asset. */
const candidateRecordPath = (dir: string): string => `${NodePath.resolve(dir)}.json`;

const readCandidateRecord = (dir: string): CandidateRecord =>
  readJson(candidateRecordPath(dir)) as CandidateRecord;

const runUrl = () =>
  `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? "local"}` +
  `/actions/runs/${process.env.GITHUB_RUN_ID ?? "0"}/attempts/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;

const runReceipt = (values: Args): number => {
  const record = readCandidateRecord(values.candidate ?? "");
  const check = values.check as (typeof VALIDATION_CHECKS)[number];
  const target = values.target as (typeof VALIDATION_TARGETS)[number];
  if (!VALIDATION_CHECKS.includes(check) || !VALIDATION_TARGETS.includes(target)) {
    throw new Error("--check and --target must name a known validation.");
  }
  const receipt = runValidation(
    {
      run: PACKAGE_VALIDATION.run,
      timeoutMinutes: PACKAGE_VALIDATION.timeoutMinutes[check],
    },
    {
      check,
      target,
      version: record.version,
      commit: record.commit,
      channel: record.channel,
      candidateDir: values.candidate ?? "",
      candidateDigest: record.candidateDigest,
      // An empty value means the workflow had no predecessor to hand over.
      predecessorDir: values.predecessor || null,
      predecessorDigest: values["predecessor-digest"] || null,
      repoRoot: REPO_ROOT,
      runner: `${process.env.RUNNER_OS ?? Effect.runSync(HostProcessPlatform)}-${process.env.RUNNER_ARCH ?? Effect.runSync(HostProcessArchitecture)}`,
      runUrl: runUrl(),
      namespace: `fork-release-${process.env.GITHUB_RUN_ID ?? "local"}-${check}-${target}`,
    },
  );
  writeJson(NodePath.join(values.out ?? "receipts", `${check}-${target}.json`), receipt);
  console.log(
    `${check}/${target}: ${receipt.passed ? "passed" : "FAILED"} (exit ${receipt.exitCode})`,
  );
  return receipt.passed ? 0 : 1;
};

const runSuiteCommand = (values: Args): number => {
  const record = readCandidateRecord(values.candidate ?? "");
  const suite = values.suite as SuiteId;
  const target = values.target as (typeof VALIDATION_TARGETS)[number];
  if (!(suite in SUITES) || !SUITES[suite].targets.includes(target)) {
    throw new Error("--suite and --target must name a suite and a target it covers.");
  }
  const receipt = runSuite({
    spec: SUITES[suite],
    target,
    sourceDir: NodePath.resolve(values.source ?? ""),
    version: record.version,
    commit: record.commit,
    channel: record.channel,
    candidateDigest: record.candidateDigest,
    runner: `${process.env.RUNNER_OS ?? Effect.runSync(HostProcessPlatform)}-${process.env.RUNNER_ARCH ?? Effect.runSync(HostProcessArchitecture)}`,
    runUrl: runUrl(),
  });
  writeJson(NodePath.join(values.out ?? "receipts", `suite-${suite}-${target}.json`), receipt);
  receipt.problems.forEach((problem) => console.error(problem));
  console.log(
    `suite ${suite}/${target}: ${receipt.passed ? "passed" : "FAILED"} (${receipt.files.length} files)`,
  );
  return receipt.passed ? 0 : 1;
};

const readReceipts = (dir: string): { checks: CheckReceipt[]; suites: SuiteReceipt[] } => {
  const checks: CheckReceipt[] = [];
  const suites: SuiteReceipt[] = [];
  const walk = (current: string) => {
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      const file = NodePath.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".json")) {
        const raw = readJson(file);
        const suite = parseSuiteReceipt(raw);
        if (suite) suites.push(suite);
        else {
          const parsed = parseCheckReceipt(raw);
          if (parsed) checks.push(parsed);
        }
      }
    }
  };
  if (NodeFS.existsSync(dir)) walk(dir);
  return { checks, suites };
};

/** Reads the receipts, evaluates the checks from them, and writes fork-release.json beside the payload. */
export const composeFinalManifest = (input: {
  readonly candidateDir: string;
  readonly receiptsDir: string;
  readonly predecessorDigest: string | null;
  readonly now: Date;
}) => {
  const record = readCandidateRecord(input.candidateDir);
  const receipts = readReceipts(input.receiptsDir);
  const checks = evaluateChecks(
    receipts.checks,
    receipts.suites,
    {
      version: record.version,
      commit: record.commit,
      channel: record.channel,
      candidateDigest: record.candidateDigest,
      predecessorDigest: input.predecessorDigest,
    },
    true,
  );
  const manifest = composeManifest({
    version: record.version,
    commit: record.commit,
    channel: record.channel,
    releasedAt: input.now.toISOString(),
    assets: record.assets.map((asset) => ({
      ...asset,
      path: NodePath.join(input.candidateDir, asset.name),
    })),
    android: record.android,
    checks,
  });
  writeJson(NodePath.join(input.candidateDir, FORK_MANIFEST_ASSET), manifest);
  return { checks, manifest };
};

const runManifest = (values: Args): number => {
  const { checks } = composeFinalManifest({
    candidateDir: NodePath.resolve(values.candidate ?? ""),
    receiptsDir: values.receipts ?? "receipts",
    predecessorDigest: values["predecessor-digest"] || null,
    now: new Date(),
  });
  setOutputs({
    all_checks: allChecksPass(checks),
    check_build: checks.build,
    check_install: checks.install,
    check_update: checks.update,
    check_recovery: checks.recovery,
  });
  if (!allChecksPass(checks)) {
    console.error(`Required checks are not all true: ${JSON.stringify(checks)}`);
    return 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------------------------

const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  const [command, ...rest] = argv;
  const { values: parsed } = NodeUtil.parseArgs({
    args: [...rest],
    allowPositionals: false,
    options: {
      channel: { type: "string" },
      commit: { type: "string" },
      "run-number": { type: "string" },
      out: { type: "string" },
      plan: { type: "string" },
      role: { type: "string" },
      apk: { type: "string" },
      metadata: { type: "string" },
      "asset-name": { type: "string" },
      "release-version": { type: "string" },
      "source-version": { type: "string" },
      code: { type: "string" },
      "pinned-signer": { type: "string" },
      input: { type: "string" },
      codes: { type: "string" },
      candidate: { type: "string" },
      check: { type: "string" },
      target: { type: "string" },
      predecessor: { type: "string" },
      "predecessor-digest": { type: "string" },
      receipts: { type: "string" },
      tag: { type: "string" },
      version: { type: "string" },
      reason: { type: "string" },
      "release-id": { type: "string" },
      scratch: { type: "string" },
      platform: { type: "string" },
      workdir: { type: "string" },
      suite: { type: "string" },
      source: { type: "string" },
      summary: { type: "string" },
      "windows-installer": { type: "string" },
      "linux-appimage": { type: "string" },
      "linux-deb": { type: "string" },
      "linux-server": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const dryRun = parsed["dry-run"] === true;
  const values: Args = Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [
      key,
      typeof value === "string" ? value : undefined,
    ]),
  );

  switch (command) {
    case "plan":
      await runPlan(values);
      return 0;
    case "reserve-codes": {
      const plan = loadPlan(values.plan ?? "");
      const allocation = await reserveAndroidCodes(githubFromEnv(), plan.commit, {
        dryRun,
        recoveryCount: plan.recoverySources.length,
      });
      const recoveries = plan.recoverySources.map((source, index) => ({
        index,
        version: source.version,
        commit: source.commit,
        tag: source.tag,
        asset: source.asset,
        baseline: source.baseline === true,
        code: allocation.recoveries[index]!,
      }));
      writeJson(values.out ?? "android-codes.json", {
        normal: allocation.normal,
        recovery: allocation.recovery,
        recoveries: allocation.recoveries,
        reservedThrough: allocation.reservedThrough,
        plan: {
          version: plan.version,
          commit: plan.commit,
          channel: plan.channel,
          recoveries: plan.recoverySources.map((source) => ({
            version: source.version,
            commit: source.commit,
            asset: source.asset,
            tag: source.tag,
          })),
        },
        reservation: {
          rangeTag: androidCodeRangeTag(allocation.normal, allocation.reservedThrough),
          startTag: androidCodeTag(allocation.normal),
        },
        recoveryMatrix: recoveries.slice(1),
      });
      setOutputs({
        normal_code: allocation.normal,
        recovery_code: allocation.recovery,
        recovery_codes: JSON.stringify(allocation.recoveries),
        recovery_matrix: JSON.stringify(recoveries.slice(1)),
      });
      return 0;
    }
    case "android-verify":
      runAndroidVerify(values);
      return 0;
    case "build-helper": {
      // The helper belongs to the candidate's source, so it is built from that checkout.
      const problems = buildRecoveryHelper({
        sourceDir: NodePath.resolve(values.workdir ?? ""),
        platform: values.platform as "linux-x64" | "windows-x64",
        outDir: NodePath.resolve(values.out ?? ""),
      });
      problems.forEach((problem) => console.error(problem));
      return problems.length === 0 ? 0 : 1;
    }
    case "assemble": {
      const codeAllocation = readJson(NodePath.resolve(values.codes ?? "")) as AndroidCodeReceipt;
      const { problems } = assembleCandidate({
        plan: loadPlan(values.plan ?? ""),
        inputDir: NodePath.resolve(values.input ?? ""),
        outDir: NodePath.resolve(values.out ?? ""),
        codeAllocation,
      });
      problems.forEach((problem) => console.error(problem));
      return problems.length === 0 ? 0 : 1;
    }
    case "fetch-predecessor": {
      const fetched = await fetchRelease(
        githubFromEnv(),
        values.tag ?? "",
        values.out ?? "predecessor",
      );
      setOutputs({
        predecessor_digest: fetched.digest,
        predecessor_version: fetched.version,
      });
      return 0;
    }
    case "baseline-pack":
      return runBaselinePack(values);
    case "baseline-verify": {
      const proof = proveBaseline(
        NodePath.resolve(values.input ?? ""),
        values["pinned-signer"] ?? null,
      );
      writeJson(values.out ?? "baseline-proof.json", proof);
      proof.problems.forEach((problem) => console.error(problem));
      return proof.problems.length === 0 ? 0 : 1;
    }
    case "receipt":
      return runReceipt(values);
    case "suite":
      return runSuiteCommand(values);
    case "manifest":
      return runManifest(values);
    case "draft": {
      const plan = loadPlan(values.plan ?? "");
      const draft = await createDraft(
        githubFromEnv(),
        plan,
        NodePath.resolve(values.candidate ?? ""),
        values.summary ?? "",
      );
      setOutputs({ release_id: draft.id });
      return 0;
    }
    case "publish": {
      const plan = loadPlan(values.plan ?? "");
      const release = await publishDraft(
        githubFromEnv(),
        plan,
        Number(values["release-id"]),
        NodePath.resolve(values.scratch ?? "verify-draft"),
      );
      setOutputs({ release_id: release.id, tag: plan.tag });
      return 0;
    }
    case "withdraw": {
      const outcome = await withdrawRelease(
        githubFromEnv(),
        values.version ?? "",
        values.reason ?? "",
        new Date(),
      );
      console.log(outcome);
      return 0;
    }
    case "restore": {
      const outcome = await restoreRelease(
        githubFromEnv(),
        values.version ?? "",
        NodePath.resolve(values.scratch ?? "restore-verify"),
      );
      console.log(outcome);
      return 0;
    }
    default:
      console.error(
        "Usage: fork-release.ts <plan|reserve-codes|android-verify|build-helper|assemble|fetch-predecessor|baseline-pack|baseline-verify|receipt|suite|manifest|draft|publish|withdraw|restore> [options]",
      );
      return 2;
  }
};

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : cause);
      process.exit(1);
    },
  );
}

// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - release tooling runs test suites and reads their results synchronously.
// The safety suites every fork release must pass, defined in code on purpose. A release is
// eligible only when receipts show exactly these suites, specified exactly this way, passed against
// the candidate's own source. Nothing here can be swapped for a different command or a smaller file
// list through configuration: a receipt for a different spec simply does not count.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { redactCliSmokeOutput } from "./lib/cli-smoke-output.ts";
import type { ForkChannel } from "./fork-release-policy.ts";

export const VALIDATION_CHECKS = ["install", "update", "recovery"] as const;
export const VALIDATION_TARGETS = ["linux-x64", "windows-x64", "android"] as const;
export type ValidationCheck = (typeof VALIDATION_CHECKS)[number];
export type ValidationTarget = (typeof VALIDATION_TARGETS)[number];

/**
 * Package-level validation: the shipped bytes install, upgrade in place, and roll back on each
 * target. Receipts must record exactly this command, so a substitute cannot satisfy a check.
 */
export const PACKAGE_VALIDATION = {
  run: ["node", "scripts/fork-release-validate.ts"],
  timeoutMinutes: { install: 30, update: 45, recovery: 45 },
} as const;

export type SuiteId =
  | "coordinator"
  | "host-runtime"
  | "desktop-updater"
  | "client-updates"
  | "native-android";

export interface SuiteSpec {
  readonly id: SuiteId;
  readonly description: string;
  readonly targets: ReadonlyArray<ValidationTarget>;
  /** Directory inside the source checkout the command runs from. */
  readonly workdir: string;
  /** `<OUT>` is replaced with the result file the runner reads back. */
  readonly command: ReadonlyArray<string>;
  readonly results: "vitest" | "junit";
  /** Test files (vitest, relative to workdir) or fully qualified classes (junit) that must run and pass. */
  readonly required: ReadonlyArray<string>;
  /** Where JUnit reports land, relative to workdir. */
  readonly junitDir?: string;
  /** Work that must succeed first, such as generating the web assets Gradle's preBuild needs. */
  readonly prepare?: {
    readonly workdir: string;
    readonly run: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  };
  readonly timeoutMinutes: number;
}

const VITEST = [
  "vp",
  "test",
  "run",
  "--config",
  "../../vite.config.ts",
  "--dir",
  ".",
  "--reporter=json",
  "--outputFile=<OUT>",
];
const pwa = (name: string) => `com.devotek.t3code.pwa.${name}`;

export const SUITES: Readonly<Record<SuiteId, SuiteSpec>> = {
  coordinator: {
    id: "coordinator",
    description:
      "Device maintenance coordinator: work admission and idle windows, durable coordination store and fencing, multi-home snapshots, the update/recovery transaction and its commit boundary, the controller, and the recovery helper.",
    targets: ["linux-x64", "windows-x64"],
    workdir: "packages/shared",
    command: VITEST,
    results: "vitest",
    required: [
      "src/forkMaintenance.test.ts",
      "src/forkMaintenanceAdmission.test.ts",
      "src/forkMaintenanceStore.test.ts",
      "src/forkMaintenanceSnapshot.test.ts",
      "src/forkMaintenanceTransaction.test.ts",
      "src/forkMaintenanceController.test.ts",
      "src/forkRecoveryHelper.test.ts",
      "src/forkDesktopHandoff.test.ts",
      "src/forkRecoveryCache.test.ts",
      "src/forkMaintenanceWsl.test.ts",
      "src/forkMaintenanceHomeOperations.test.ts",
    ],
    timeoutMinutes: 30,
  },
  "host-runtime": {
    id: "host-runtime",
    description:
      "Runtime integration: registration before database opening, work and restart admission, operator authorization, launcher trial and health boundaries.",
    targets: ["linux-x64", "windows-x64"],
    workdir: "apps/server",
    command: VITEST,
    results: "vitest",
    required: [
      "src/maintenance/MaintenanceHost.test.ts",
      "src/maintenance/MaintenanceCoordinator.test.ts",
      "src/maintenance/IdleProcessRoots.test.ts",
      "src/storageCleanup.test.ts",
      "src/diagnostics/ProcessDiagnostics.test.ts",
      "src/maintenance/MaintenanceOperatorHttp.test.ts",
      "src/maintenance/WorkAdmission.test.ts",
      "src/maintenance/coordinatedRestart.test.ts",
      "src/maintenance/restartGate.test.ts",
      "src/maintenance/serviceInstaller.test.ts",
      "src/serviceLauncherMaintenance.test.ts",
      "src/auth/RpcAuthorization.test.ts",
      "src/auth/RpcAuthorization.maintenance.test.ts",
    ],
    timeoutMinutes: 30,
  },
  "desktop-updater": {
    id: "desktop-updater",
    description:
      "Desktop updater: update state machine, channel selection, remote update flow, and the Electron updater adapters.",
    targets: ["linux-x64", "windows-x64"],
    workdir: "apps/desktop",
    command: VITEST,
    results: "vitest",
    required: [
      "src/maintenance/DesktopForkMaintenance.test.ts",
      "src/maintenance/artifactCache.test.ts",
      "src/maintenance/handoff.test.ts",
      "src/maintenance/installedBuild.test.ts",
      "src/maintenance/interaction.test.ts",
      "src/maintenance/privateDirectory.test.ts",
      "src/maintenance/wslTransport.test.ts",
      "src/backend/DesktopBackendConfiguration.test.ts",
      "src/backend/DesktopBackendManager.test.ts",
      "src/updates/DesktopRemoteUpdates.test.ts",
      "src/updates/DesktopUpdates.test.ts",
      "src/updates/remoteUpdateFlow.test.ts",
      "src/updates/updateChannels.test.ts",
      "src/updates/updateMachine.test.ts",
      "src/maintenance/DesktopForkMaintenance.identity.test.ts",
    ],
    timeoutMinutes: 30,
  },
  "client-updates": {
    id: "client-updates",
    description:
      "Shared client update controls: waiting state, host capability admission, device grouping, exact recovery confirmation, restored automation review, Android bridge, and full upload admission.",
    // The same web source ships in both desktop packages and the fork APK. The native adapters
    // also run on their own target suites; this suite proves the shared controller integration.
    targets: ["linux-x64"],
    workdir: "apps/web",
    command: VITEST,
    results: "vitest",
    required: [
      "src/state/forkUpdates.test.ts",
      "src/state/hostForkUpdates.test.ts",
      "src/state/hostUpdateBatcher.test.ts",
      "src/components/settings/UpdateRecoveryDialog.test.tsx",
      "src/components/settings/UpdateSafetyReviewDialog.test.tsx",
      "src/android/updates.test.ts",
      "src/lib/attachmentUploadQueue.test.ts",
      "src/browser/browserRecordingUpload.test.ts",
    ],
    timeoutMinutes: 30,
  },
  "native-android": {
    id: "native-android",
    description:
      "Native Android updater: APK verification, install guard and transaction, release manifest and client, eligibility, reconciliation, recovery cache, and update store.",
    targets: ["android"],
    workdir: "apps/android-pwa",
    command: ["./gradlew", "--no-daemon", ":app:testReleaseUnitTest"],
    results: "junit",
    junitDir: "app/build/test-results/testReleaseUnitTest",
    required: [
      pwa("ApkVerifierTest"),
      pwa("InstallGuardTest"),
      pwa("InstallIntentsTest"),
      pwa("InstallTransactionTest"),
      pwa("RecoveryCacheTest"),
      pwa("ReleaseClientTest"),
      pwa("ReleaseManifestTest"),
      pwa("UpdateEligibilityTest"),
      pwa("UpdateCapacityTest"),
      pwa("UpdateReconcilerTest"),
      pwa("UpdateStoreTest"),
      pwa("UpdateEngineRecoveryReadinessTest"),
    ],
    prepare: {
      workdir: "apps/web",
      run: [
        "vp",
        "build",
        "--outDir",
        "../android-pwa/app/build/generated/web-assets",
        "--emptyOutDir",
      ],
      env: { VITE_ANDROID_PWA: "1", T3CODE_WEB_SOURCEMAP: "0" },
    },
    timeoutMinutes: 45,
  },
};

/**
 * Which suites each manifest check depends on. Install needs the admission and capability guards
 * that decide whether an install may start at all; update and recovery add both native updaters.
 */
export const REQUIRED_SUITES: Readonly<Record<ValidationCheck, ReadonlyArray<SuiteId>>> = {
  install: ["coordinator", "host-runtime"],
  update: ["coordinator", "host-runtime", "desktop-updater", "client-updates", "native-android"],
  recovery: ["coordinator", "host-runtime", "desktop-updater", "client-updates", "native-android"],
};

export const suiteSpecDigest = (spec: SuiteSpec): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        id: spec.id,
        workdir: spec.workdir,
        command: spec.command,
        results: spec.results,
        required: spec.required,
        junitDir: spec.junitDir ?? null,
        prepare: spec.prepare ?? null,
      }),
    )
    .digest("hex");

/** Every (suite, target) a candidate needs a passing receipt for, across all checks. */
export const requiredSuiteRuns = (): ReadonlyArray<{
  readonly suite: SuiteId;
  readonly target: ValidationTarget;
}> => {
  const needed = new Set(VALIDATION_CHECKS.flatMap((check) => REQUIRED_SUITES[check]));
  return [...needed].flatMap((suite) => SUITES[suite].targets.map((target) => ({ suite, target })));
};

// ---------------------------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------------------------

export interface SuiteReceipt {
  readonly format: 1;
  readonly suite: SuiteId;
  readonly target: ValidationTarget;
  readonly version: string;
  /** The commit the artifacts were built from. */
  readonly commit: string;
  readonly channel: ForkChannel;
  /** Digest of the whole artifact payload the run is bound to. */
  readonly candidateDigest: string;
  /** Digest of the exact suite specification that ran. */
  readonly specDigest: string;
  /** The commit actually checked out and tested; must equal `commit`. */
  readonly testedCommit: string;
  readonly command: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{ readonly name: string; readonly tests: number }>;
  readonly problems: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runner: string;
  readonly runUrl: string;
}

export const parseSuiteReceipt = (raw: unknown): SuiteReceipt | null => {
  const value = raw as Partial<SuiteReceipt> | null;
  if (
    !value ||
    value.format !== 1 ||
    !(value.suite !== undefined && value.suite in SUITES) ||
    !VALIDATION_TARGETS.includes(value.target as ValidationTarget) ||
    typeof value.version !== "string" ||
    typeof value.commit !== "string" ||
    typeof value.candidateDigest !== "string" ||
    typeof value.specDigest !== "string" ||
    typeof value.testedCommit !== "string" ||
    !Array.isArray(value.command) ||
    !Number.isInteger(value.exitCode) ||
    typeof value.passed !== "boolean"
  ) {
    return null;
  }
  return value as SuiteReceipt;
};

export interface SuiteExpectation {
  readonly version: string;
  readonly commit: string;
  readonly channel: ForkChannel;
  readonly candidateDigest: string;
}

/** True only for a clean pass of this exact suite spec, on this target, against this cohort. */
export const suiteReceiptCounts = (
  receipt: SuiteReceipt,
  suite: SuiteId,
  target: ValidationTarget,
  expect: SuiteExpectation,
): boolean =>
  receipt.suite === suite &&
  receipt.target === target &&
  receipt.version === expect.version &&
  receipt.commit === expect.commit &&
  receipt.channel === expect.channel &&
  receipt.candidateDigest === expect.candidateDigest &&
  receipt.testedCommit === expect.commit &&
  receipt.specDigest === suiteSpecDigest(SUITES[suite]) &&
  receipt.exitCode === 0 &&
  receipt.passed &&
  receipt.problems.length === 0 &&
  SUITES[suite].required.every((name) =>
    receipt.files.some((file) => file.name === name && file.tests > 0),
  );

// ---------------------------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------------------------

interface VitestReport {
  readonly testResults?: ReadonlyArray<{
    readonly name: string;
    readonly assertionResults?: ReadonlyArray<{
      readonly status: string;
      readonly fullName?: string;
      readonly failureMessages?: ReadonlyArray<string>;
    }>;
  }>;
}

/** Every required file must have run at least one test, and every test in it must have passed. */
export const parseVitestReport = (
  raw: unknown,
  required: ReadonlyArray<string>,
): { files: Array<{ name: string; tests: number }>; problems: string[] } => {
  const report = raw as VitestReport;
  const files: Array<{ name: string; tests: number }> = [];
  const problems: string[] = [];
  for (const name of required) {
    const normalized = name.replaceAll("\\", "/");
    const result = report.testResults?.find((entry) =>
      entry.name.replaceAll("\\", "/").endsWith(`/${normalized}`),
    );
    const assertions = result?.assertionResults ?? [];
    if (!result || assertions.length === 0) {
      problems.push(`${name}: no tests ran.`);
      continue;
    }
    const notPassed = assertions.filter((assertion) => assertion.status !== "passed");
    if (notPassed.length > 0) {
      problems.push(
        `${name}: ${notPassed.length} test(s) did not pass (${[...new Set(notPassed.map((a) => a.status))].join(", ")}).`,
      );
      for (const assertion of notPassed.slice(0, 10)) {
        const detail = [
          assertion.fullName ?? "unnamed test",
          ...(assertion.failureMessages ?? []),
        ].join("\n");
        problems.push(redactCliSmokeOutput(detail).slice(0, 4000));
      }
    }
    files.push({ name, tests: assertions.length });
  }
  return { files, problems };
};

const attr = (element: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1];

/** Reads one JUnit report per class; a skipped, failed, or errored test is a problem. */
export const parseJunitReports = (
  reports: ReadonlyMap<string, string>,
  required: ReadonlyArray<string>,
): { files: Array<{ name: string; tests: number }>; problems: string[] } => {
  const files: Array<{ name: string; tests: number }> = [];
  const problems: string[] = [];
  for (const name of required) {
    const xml = reports.get(name);
    const suite = xml ? /<testsuite\b[^>]*>/.exec(xml)?.[0] : undefined;
    if (!suite) {
      problems.push(`${name}: no report.`);
      continue;
    }
    const tests = Number(attr(suite, "tests") ?? 0);
    const bad = ["failures", "errors", "skipped"].map((key) => Number(attr(suite, key) ?? 0));
    if (tests === 0) problems.push(`${name}: no tests ran.`);
    if (bad.some((count) => count > 0)) {
      problems.push(`${name}: ${bad[0]} failure(s), ${bad[1]} error(s), ${bad[2]} skipped.`);
    }
    files.push({ name, tests });
  }
  return { files, problems };
};

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

const git = (dir: string, ...args: string[]): string =>
  NodeChildProcess.execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

const spawn = (
  command: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>>,
  timeoutMinutes: number,
) => {
  const [program, ...args] = command;
  return (
    NodeChildProcess.spawnSync(program!, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
      timeout: timeoutMinutes * 60_000,
      shell: false,
    }).status ?? -1
  );
};

export interface RunSuiteInput extends SuiteExpectation {
  readonly spec: SuiteSpec;
  readonly target: ValidationTarget;
  readonly sourceDir: string;
  readonly runner: string;
  readonly runUrl: string;
}

/**
 * Runs one suite inside the candidate's source checkout. The checkout must be the candidate's
 * commit and clean, every required test must run and pass, and the result is a receipt bound to
 * that commit and to the artifact cohort. Any shortfall yields a failing receipt, never a skip.
 */
export const runSuite = (input: RunSuiteInput): SuiteReceipt => {
  const { spec } = input;
  const startedAt = new Date().toISOString();
  const problems: string[] = [];
  let testedCommit = "unknown";
  let exitCode = -1;
  let files: Array<{ name: string; tests: number }> = [];
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `fork-suite-${spec.id}-`));
  try {
    testedCommit = git(input.sourceDir, "rev-parse", "HEAD");
    if (testedCommit !== input.commit)
      problems.push(`The checkout is at ${testedCommit}, not the candidate's ${input.commit}.`);
    if (git(input.sourceDir, "status", "--porcelain") !== "")
      problems.push("The checkout has uncommitted changes.");
    const workdir = NodePath.join(input.sourceDir, spec.workdir);
    if (spec.results === "vitest") {
      for (const name of spec.required) {
        if (!NodeFS.existsSync(NodePath.join(workdir, name)))
          problems.push(`${name}: required test file is missing from the source.`);
      }
    }
    if (problems.length === 0) {
      if (spec.prepare) {
        const prepared = spawn(
          spec.prepare.run,
          NodePath.join(input.sourceDir, spec.prepare.workdir),
          spec.prepare.env,
          spec.timeoutMinutes,
        );
        if (prepared !== 0) problems.push(`Preparing the suite exited ${prepared}.`);
      }
    }
    if (problems.length === 0) {
      const out = NodePath.join(scratch, "result.json");
      const command = spec.command.map((part) => part.replaceAll("<OUT>", out));
      const withFiles = spec.results === "vitest" ? [...command, ...spec.required] : command;
      exitCode = spawn(withFiles, workdir, {}, spec.timeoutMinutes);
      if (spec.results === "vitest") {
        if (!NodeFS.existsSync(out)) problems.push("The test runner wrote no result file.");
        else {
          const parsed = parseVitestReport(
            JSON.parse(NodeFS.readFileSync(out, "utf8")),
            spec.required,
          );
          files = parsed.files;
          problems.push(...parsed.problems);
        }
      } else {
        const dir = NodePath.join(workdir, spec.junitDir ?? "");
        const reports = new Map<string, string>();
        if (NodeFS.existsSync(dir)) {
          for (const entry of NodeFS.readdirSync(dir)) {
            const match = /^TEST-(.+)\.xml$/.exec(entry);
            if (match)
              reports.set(match[1]!, NodeFS.readFileSync(NodePath.join(dir, entry), "utf8"));
          }
        }
        const parsed = parseJunitReports(reports, spec.required);
        files = parsed.files;
        problems.push(...parsed.problems);
      }
      if (exitCode !== 0) problems.push(`The test command exited ${exitCode}.`);
    }
  } catch (cause) {
    problems.push(cause instanceof Error ? cause.message : String(cause));
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
  return {
    format: 1,
    suite: spec.id,
    target: input.target,
    version: input.version,
    commit: input.commit,
    channel: input.channel,
    candidateDigest: input.candidateDigest,
    specDigest: suiteSpecDigest(spec),
    testedCommit,
    command: [...spec.command],
    files,
    problems,
    exitCode,
    passed: exitCode === 0 && problems.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    runner: input.runner,
    runUrl: input.runUrl,
  };
};

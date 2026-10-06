// @effect-diagnostics nodeBuiltinImport:off globalDate:off - these tests run real commands inside real git checkouts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  REQUIRED_SUITES,
  SUITES,
  parseJunitReports,
  parseSuiteReceipt,
  parseVitestReport,
  requiredSuiteRuns,
  runSuite,
  suiteReceiptCounts,
  suiteSpecDigest,
  type SuiteSpec,
} from "./fork-release-suites.ts";
import { sha, suiteReceiptFor } from "./fork-release-fixtures.ts";

const REPO = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-suites-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("the required suites", () => {
  it("name real test files and classes", () => {
    for (const spec of Object.values(SUITES)) {
      for (const required of spec.required) {
        const file =
          spec.results === "vitest"
            ? NodePath.join(REPO, spec.workdir, required)
            : NodePath.join(
                REPO,
                spec.workdir,
                "app/src/test/java",
                `${required.replaceAll(".", "/")}.java`,
              );
        assert.isTrue(NodeFS.existsSync(file), `${spec.id}: ${required} does not exist`);
      }
    }
  });

  it("cover admission, the store, snapshots, the transaction, the controller, and both native updaters", () => {
    const coordinator = SUITES.coordinator.required.join(" ");
    for (const part of [
      "Admission",
      "Store",
      "Snapshot",
      "Transaction",
      "Controller",
      "RecoveryHelper",
    ]) {
      assert.include(coordinator, part);
    }
    assert.include(SUITES["desktop-updater"].required.join(" "), "updateMachine");
    assert.include(SUITES["native-android"].required.join(" "), "InstallTransactionTest");
    assert.include(SUITES["native-android"].required.join(" "), "UpdateReconcilerTest");
    assert.include(SUITES["client-updates"].required.join(" "), "UpdateRecoveryDialog.test.tsx");
    assert.include(SUITES["client-updates"].required.join(" "), "browserRecordingUpload.test.ts");
  });

  it("gate every check on the coordinator, and update and recovery on both updaters", () => {
    for (const check of ["install", "update", "recovery"] as const)
      assert.include(REQUIRED_SUITES[check], "coordinator");
    for (const check of ["update", "recovery"] as const) {
      assert.include(REQUIRED_SUITES[check], "desktop-updater");
      assert.include(REQUIRED_SUITES[check], "native-android");
      assert.include(REQUIRED_SUITES[check], "client-updates");
    }
    const runs = requiredSuiteRuns()
      .map((run) => `${run.suite}:${run.target}`)
      .toSorted();
    assert.deepStrictEqual(runs, [
      "client-updates:linux-x64",
      "coordinator:linux-x64",
      "coordinator:windows-x64",
      "desktop-updater:linux-x64",
      "desktop-updater:windows-x64",
      "host-runtime:linux-x64",
      "host-runtime:windows-x64",
      "native-android:android",
    ]);
  });

  it("change their specification digest whenever a required file or the command changes", () => {
    const base = SUITES.coordinator;
    assert.notEqual(
      suiteSpecDigest(base),
      suiteSpecDigest({ ...base, required: base.required.slice(1) }),
    );
    assert.notEqual(
      suiteSpecDigest(base),
      suiteSpecDigest({ ...base, command: [...base.command, "--bail"] }),
    );
    assert.equal(suiteSpecDigest(base), suiteSpecDigest({ ...base }));
  });
});

describe("result parsing", () => {
  const report = (files: Record<string, string[]>) => ({
    testResults: Object.entries(files).map(([name, statuses]) => ({
      name: `/work/${name}`,
      assertionResults: statuses.map((status) => ({ status })),
    })),
  });

  it("counts a required vitest file only when it ran tests and all of them passed", () => {
    const ok = parseVitestReport(report({ "src/a.test.ts": ["passed", "passed"] }), [
      "src/a.test.ts",
    ]);
    assert.deepStrictEqual([ok.problems, ok.files], [[], [{ name: "src/a.test.ts", tests: 2 }]]);
    assert.include(parseVitestReport(report({}), ["src/a.test.ts"]).problems[0], "no tests ran");
    assert.include(
      parseVitestReport(report({ "src/a.test.ts": [] }), ["src/a.test.ts"]).problems[0],
      "no tests ran",
    );
    assert.include(
      parseVitestReport(report({ "src/a.test.ts": ["passed", "failed"] }), ["src/a.test.ts"])
        .problems[0],
      "did not pass",
    );
    assert.include(
      parseVitestReport(report({ "src/a.test.ts": ["passed", "skipped"] }), ["src/a.test.ts"])
        .problems[0],
      "skipped",
    );
  });

  it("does not let a file with a similar name satisfy a required one", () => {
    const result = parseVitestReport(report({ "src/other/a.test.ts": ["passed"] }), [
      "src/a.test.ts",
    ]);
    assert.include(result.problems[0], "no tests ran");
  });

  const xml = (tests: number, failures = 0, errors = 0, skipped = 0) =>
    `<?xml version="1.0"?><testsuite name="x" tests="${tests}" skipped="${skipped}" failures="${failures}" errors="${errors}"></testsuite>`;

  it("counts a JUnit class only when it ran tests with no failure, error, or skip", () => {
    assert.deepStrictEqual(parseJunitReports(new Map([["A", xml(4)]]), ["A"]).problems, []);
    assert.include(parseJunitReports(new Map(), ["A"]).problems[0], "no report");
    assert.include(parseJunitReports(new Map([["A", xml(0)]]), ["A"]).problems[0], "no tests ran");
    assert.include(parseJunitReports(new Map([["A", xml(4, 1)]]), ["A"]).problems[0], "1 failure");
    assert.include(
      parseJunitReports(new Map([["A", xml(4, 0, 0, 2)]]), ["A"]).problems[0],
      "2 skipped",
    );
  });
});

describe("running a suite in a source checkout", () => {
  const git = (dir: string, ...args: string[]) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { encoding: "utf8" },
    ).trim();

  const checkout = () => {
    const dir = NodePath.join(root, "source");
    NodeFS.mkdirSync(NodePath.join(dir, "pkg/src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "pkg/src/a.test.ts"), "// test");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "source");
    return { dir, commit: git(dir, "rev-parse", "HEAD") };
  };

  // A stand-in test runner that writes a vitest-shaped report to <OUT>.
  const runner = (statuses: string[], exit = 0): SuiteSpec => ({
    ...SUITES.coordinator,
    workdir: "pkg",
    required: ["src/a.test.ts"],
    command: [
      "node",
      "-e",
      `const fs=require("fs"),out=process.argv[1];fs.writeFileSync(out,JSON.stringify({testResults:[{name:process.cwd()+"/src/a.test.ts",assertionResults:${JSON.stringify(statuses.map((status) => ({ status })))}}]}));process.exit(${exit})`,
      "<OUT>",
    ],
  });
  const input = (dir: string, commit: string, spec: SuiteSpec, expectCommit = commit) => ({
    spec,
    target: "linux-x64" as const,
    sourceDir: dir,
    version: "1.0.1",
    commit: expectCommit,
    channel: "stable" as const,
    candidateDigest: "9".repeat(64),
    runner: "Linux-X64",
    runUrl: "https://example.test/run",
  });

  it("produces a clean receipt bound to the commit, the payload, and the exact specification", () => {
    const { dir, commit } = checkout();
    const spec = runner(["passed", "passed"]);
    const receipt = runSuite(input(dir, commit, spec));
    assert.deepStrictEqual(
      [receipt.passed, receipt.problems, receipt.testedCommit, receipt.exitCode],
      [true, [], commit, 0],
    );
    assert.equal(receipt.specDigest, suiteSpecDigest(spec));
    assert.deepStrictEqual(receipt.files, [{ name: "src/a.test.ts", tests: 2 }]);
    assert.isNotNull(parseSuiteReceipt(JSON.parse(JSON.stringify(receipt))));
  });

  it("fails when the checkout is not the candidate's commit or has uncommitted changes", () => {
    const { dir, commit } = checkout();
    const wrong = runSuite(input(dir, commit, runner(["passed"]), sha("other")));
    assert.isFalse(wrong.passed);
    assert.isTrue(wrong.problems.some((p) => p.includes("not the candidate")));
    NodeFS.writeFileSync(NodePath.join(dir, "pkg/src/a.test.ts"), "// changed");
    const dirty = runSuite(input(dir, commit, runner(["passed"])));
    assert.isTrue(dirty.problems.some((p) => p.includes("uncommitted")));
    assert.isFalse(dirty.passed);
  });

  it("fails when a required test file was removed from the source", () => {
    const { dir, commit } = checkout();
    git(dir, "rm", "-q", "pkg/src/a.test.ts");
    git(dir, "commit", "-q", "-m", "drop test");
    const head = git(dir, "rev-parse", "HEAD");
    const receipt = runSuite(input(dir, head, runner(["passed"])));
    assert.isFalse(receipt.passed);
    assert.isTrue(receipt.problems.some((p) => p.includes("required test file is missing")));
    assert.notEqual(head, commit);
  });

  it("fails on a red test, a non-zero exit, or a runner that wrote no result", () => {
    const { dir, commit } = checkout();
    assert.isFalse(runSuite(input(dir, commit, runner(["passed", "failed"]))).passed);
    const exited = runSuite(input(dir, commit, runner(["passed"], 3)));
    assert.deepStrictEqual([exited.passed, exited.exitCode], [false, 3]);
    const silent: SuiteSpec = {
      ...runner(["passed"]),
      command: ["node", "-e", "process.exit(0)", "<OUT>"],
    };
    assert.isTrue(
      runSuite(input(dir, commit, silent)).problems.some((p) => p.includes("no result file")),
    );
  });

  it("reads JUnit reports for the native suite and fails on a missing class", () => {
    const { dir, commit } = checkout();
    const { prepare: _prepare, ...nativeWithoutPrepare } = SUITES["native-android"];
    const spec: SuiteSpec = {
      ...nativeWithoutPrepare,
      workdir: "pkg",
      required: ["x.AlphaTest", "x.BetaTest"],
      junitDir: "reports",
      command: [
        "node",
        "-e",
        `const fs=require("fs");fs.mkdirSync("reports",{recursive:true});fs.writeFileSync("reports/TEST-x.AlphaTest.xml",'<testsuite tests="2" skipped="0" failures="0" errors="0"/>')`,
      ],
    };
    const receipt = runSuite(input(dir, commit, spec));
    assert.isFalse(receipt.passed);
    assert.deepStrictEqual(receipt.problems, ["x.BetaTest: no report."]);
    assert.deepStrictEqual(receipt.files, [{ name: "x.AlphaTest", tests: 2 }]);
  });

  it("is counted by the evaluator only when its receipt is for exactly this cohort", () => {
    const record = {
      version: "1.0.1",
      commit: sha("c"),
      channel: "stable" as const,
      candidateDigest: "9".repeat(64),
    };
    const receipt = parseSuiteReceipt(suiteReceiptFor(record, "coordinator", "linux-x64"))!;
    assert.isTrue(suiteReceiptCounts(receipt, "coordinator", "linux-x64", record));
    assert.isFalse(suiteReceiptCounts(receipt, "coordinator", "windows-x64", record));
    assert.isFalse(suiteReceiptCounts(receipt, "desktop-updater", "linux-x64", record));
  });
});

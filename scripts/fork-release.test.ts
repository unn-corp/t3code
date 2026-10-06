// @effect-diagnostics nodeBuiltinImport:off globalDate:off - these tests run the CLI and configured commands for real.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  candidateDigest,
  sha256Bytes,
  ARTIFACT_DIRS,
  type CheckReceipt,
} from "./fork-release-assets.ts";
import { runValidation, type ValidationContext } from "./fork-release-config.ts";
import {
  PREDECESSOR_DIGEST,
  prepareCandidate,
  sha,
  writeFixtureTree,
} from "./fork-release-fixtures.ts";
import { assembleCandidate } from "./fork-release.ts";
import { androidCodeRangeTag, androidCodeTag } from "./fork-release-policy.ts";

const SCRIPT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fork-release.ts",
);

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-cli-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const node = (code: string) => ({
  run: ["node", "-e", code],
  timeoutMinutes: 1,
});

describe("assembling a candidate", () => {
  it("flattens a complete build into the exact release payload with checksums and a record", () => {
    const inputDir = NodePath.join(root, "input");
    const tree = writeFixtureTree(inputDir);
    const outDir = NodePath.join(root, "candidate");
    const { problems, record } = assembleCandidate({
      plan: tree.plan,
      inputDir,
      outDir,
    });
    assert.deepStrictEqual(problems, []);
    const v = tree.plan.version;
    assert.deepStrictEqual(
      NodeFS.readdirSync(outDir).toSorted(),
      [
        "SHA256SUMS",
        `T3-Code-${v}-x64.exe`,
        `T3-Code-${v}-x64.exe.blockmap`,
        `T3-Code-${v}-amd64.deb`,
        `T3-Code-${v}-x86_64.AppImage`,
        `T3-Code-${v}-x86_64.AppImage.blockmap`,
        "nightly-linux.yml",
        "nightly.yml",
        `t3-code-android-${v}.apk`,
        `t3-code-android-recovery-${v}.apk`,
        "t3-recovery-helper-linux-x64.mjs",
        "t3-recovery-helper-windows-x64.mjs",
        "t3-recovery-node-linux-x64",
        "t3-recovery-node-windows-x64.exe",
        `t3-${v}-linux-x64.tar.gz`,
        `t3-${v}-win32-x64.zip`,
      ].toSorted(),
    );
    assert.equal(NodeFS.existsSync(`${outDir}.json`), true);
    assert.isFalse(NodeFS.existsSync(NodePath.join(outDir, "candidate.json")));
    assert.equal(record?.candidateDigest, candidateDigest(record!.assets));
    assert.include(
      NodeFS.readFileSync(NodePath.join(outDir, "nightly.yml"), "utf8"),
      `url: T3-Code-${v}-x64.exe`,
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(outDir, "SHA256SUMS"), "utf8").trim().split("\n").length,
      2,
    );
  });

  it("rejects a build whose APKs came from the wrong source and writes no candidate", () => {
    const inputDir = NodePath.join(root, "input");
    const tree = writeFixtureTree(inputDir);
    const outDir = NodePath.join(root, "candidate");
    const wrongCommit = assembleCandidate({
      plan: { ...tree.plan, commit: sha("moved-head") },
      inputDir,
      outDir,
    });
    assert.isTrue(wrongCommit.problems.some((p) => p.includes("not the pinned")));
    const wrongPredecessor = assembleCandidate({
      plan: {
        ...tree.plan,
        predecessor: { ...tree.plan.predecessor, commit: sha("elsewhere") },
      },
      inputDir,
      outDir,
    });
    assert.isTrue(
      wrongPredecessor.problems.some((p) => p.includes("primary recovery APK reports")),
    );
    assert.isFalse(NodeFS.existsSync(outDir));
    assert.isFalse(NodeFS.existsSync(`${outDir}.json`));
  });

  it("verifies and publishes every frozen recovery source with unique higher codes", () => {
    const inputDir = NodePath.join(root, "input");
    const tree = writeFixtureTree(inputDir);
    const extraVersion = "1.0.0";
    const extraCommit = sha("retained-stable");
    const extraAsset = `t3-code-android-recovery-${tree.plan.version}-from-${extraVersion}-${extraCommit.slice(0, 12)}.apk`;
    const extraBytes = Buffer.from("extra-recovery-apk");
    const extra = {
      asset: extraAsset,
      versionCode: 29_853_681,
      sourceVersion: extraVersion,
      sourceCommit: extraCommit,
      packageName: "com.devotek.t3code.pwa" as const,
      signerSha256: "a".repeat(64),
      updaterProtocol: 1 as const,
      apkSha256: sha256Bytes(extraBytes),
    };
    const extraDir = NodePath.join(inputDir, "android-recovery-extras");
    NodeFS.mkdirSync(extraDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(extraDir, extraAsset), extraBytes);
    NodeFS.writeFileSync(NodePath.join(extraDir, "metadata-1.json"), JSON.stringify(extra));
    const plan = {
      ...tree.plan,
      recoverySources: [
        ...tree.plan.recoverySources,
        {
          tag: "fork-v1.0.0",
          version: extraVersion,
          commit: extraCommit,
          channel: "stable" as const,
          asset: extraAsset,
        },
      ],
    };
    const outDir = NodePath.join(root, "candidate-with-recoveries");
    const result = assembleCandidate({ plan, inputDir, outDir });
    assert.deepStrictEqual(result.problems, []);
    assert.isNotNull(result.record);
    assert.include(
      result.record!.assets.map((asset) => asset.name),
      extraAsset,
    );
    assert.equal(result.record!.android.recoveries.length, 2);
    assert.equal(result.record!.android.recoveries[1]?.sourceVersion, extraVersion);
  });

  it("rejects a code allocation receipt from a different pinned plan", () => {
    const inputDir = NodePath.join(root, "input");
    const tree = writeFixtureTree(inputDir);
    const source = tree.plan.recoverySources[0]!;
    const normal = 29_853_679;
    const allocation = {
      normal,
      recovery: normal + 1,
      recoveries: [normal + 1],
      reservedThrough: normal + 1,
      plan: {
        version: tree.plan.version,
        commit: sha("stale-plan"),
        channel: tree.plan.channel,
        recoveries: [
          {
            version: source.version,
            commit: source.commit,
            asset: source.asset,
            tag: source.tag,
          },
        ],
      },
      reservation: {
        rangeTag: androidCodeRangeTag(normal, normal + 1),
        startTag: androidCodeTag(normal),
      },
    };
    const result = assembleCandidate({
      plan: tree.plan,
      inputDir,
      outDir: NodePath.join(root, "stale-allocation"),
      codeAllocation: allocation,
    });
    assert.isNull(result.record);
    assert.isTrue(
      result.problems.some((problem) => problem.includes("durable reserved allocation")),
    );
  });

  it("rejects an incomplete build: missing helper, missing server archive, no WSL receipt", () => {
    const inputDir = NodePath.join(root, "input");
    const tree = writeFixtureTree(inputDir, {
      tamper: (dir) => {
        NodeFS.rmSync(NodePath.join(dir, ARTIFACT_DIRS.windowsServer), {
          recursive: true,
        });
        NodeFS.rmSync(NodePath.join(dir, ARTIFACT_DIRS.wslEmbedded), {
          recursive: true,
        });
        NodeFS.rmSync(NodePath.join(dir, "recovery-helper-windows-x64"), {
          recursive: true,
        });
      },
    });
    const { problems, record } = assembleCandidate({
      plan: tree.plan,
      inputDir,
      outDir: NodePath.join(root, "candidate"),
    });
    assert.isNull(record);
    assert.isTrue(problems.some((p) => p.includes("cli-win-x64: missing")));
    assert.isTrue(problems.some((p) => p.includes("no embedded WSL runtime receipt")));
    assert.isTrue(problems.some((p) => p.includes("recovery-helper-windows-x64")));
  });
});

describe("running a validation", () => {
  const context = (overrides: Partial<ValidationContext> = {}): ValidationContext => ({
    check: "install",
    target: "linux-x64",
    version: "1.0.1-nightly.20261006.7",
    commit: sha("source"),
    channel: "nightly",
    candidateDir: root,
    candidateDigest: "9".repeat(64),
    predecessorDir: NodePath.join(root, "predecessor"),
    predecessorDigest: PREDECESSOR_DIGEST,
    repoRoot: root,
    runner: "Linux-X64",
    runUrl: "https://example.test/run",
    namespace: "fork-release-1-install-linux-x64",
    ...overrides,
  });

  it("records a pass only when the command exits zero, and hands it the candidate and an isolated namespace", () => {
    const check = [
      "const e = process.env;",
      "const ok = e.FORK_RELEASE_VERSION === '1.0.1-nightly.20261006.7' && e.FORK_RELEASE_TARGET === 'linux-x64'",
      "&& e.FORK_RELEASE_CHECK === 'install' && e.FORK_RELEASE_CANDIDATE_DIR && e.T3CODE_MAINTENANCE_NAMESPACE === 'fork-release-1-install-linux-x64';",
      "process.exit(ok ? 0 : 7);",
    ].join(" ");
    const receipt = runValidation(node(check), context());
    assert.deepStrictEqual([receipt.exitCode, receipt.passed], [0, true]);
    assert.deepStrictEqual(receipt.command?.[0], "node");
    assert.equal(receipt.candidateDigest, "9".repeat(64));
  });

  it("records the real exit status of a failing command", () => {
    const receipt = runValidation(node("process.exit(3)"), context());
    assert.deepStrictEqual([receipt.exitCode, receipt.passed], [3, false]);
  });

  it("records a command that cannot start as a failure", () => {
    const missing = runValidation(
      { run: ["definitely-not-a-real-binary-xyz"], timeoutMinutes: 1 },
      context(),
    );
    assert.deepStrictEqual([missing.exitCode, missing.passed], [-1, false]);
  });

  it("fails closed, with a failing receipt, when there is no command", () => {
    const receipt = runValidation(null, context());
    assert.deepStrictEqual([receipt.exitCode, receipt.passed, receipt.command], [-1, false, null]);
  });

  it("fails closed for update and recovery when there is no predecessor, without running the command", () => {
    const marker = NodePath.join(root, "ran");
    const command = node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
    const receipt = runValidation(
      command,
      context({
        check: "update",
        predecessorDir: null,
        predecessorDigest: null,
      }),
    );
    assert.deepStrictEqual([receipt.exitCode, receipt.passed], [-1, false]);
    assert.isFalse(NodeFS.existsSync(marker));
    assert.equal(runValidation(command, context({ check: "update" })).passed, true);
    assert.isTrue(NodeFS.existsSync(marker));
  });
});

describe("command line", () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    NodeChildProcess.spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it("runs the real package validation and records its failure rather than a pass", () => {
    // The fixture archives are not real servers, so the shipped validation fails honestly.
    const candidate = prepareCandidate(root);
    const receipts = NodePath.join(root, "cli-receipts");
    const result = cli(
      [
        "receipt",
        "--check",
        "install",
        "--target",
        "linux-x64",
        "--candidate",
        candidate.candidateDir,
        "--out",
        receipts,
      ],
      { GITHUB_RUN_ID: "42" },
    );
    assert.equal(result.status, 1);
    const written = JSON.parse(
      NodeFS.readFileSync(NodePath.join(receipts, "install-linux-x64.json"), "utf8"),
    ) as CheckReceipt;
    assert.deepStrictEqual(written.command, ["node", "scripts/fork-release-validate.ts"]);
    assert.deepStrictEqual([written.passed, written.candidateDigest.length], [false, 64]);
    assert.notEqual(written.exitCode, 0);
  });

  it("turns receipts into manifest checks and exits non-zero when a required suite has no receipt", () => {
    const candidate = prepareCandidate(root, {
      omitSuites: ["native-android"],
    });
    const output = NodePath.join(root, "github-output");
    const result = cli(
      [
        "manifest",
        "--candidate",
        candidate.candidateDir,
        "--receipts",
        candidate.receiptsDir,
        "--predecessor-digest",
        PREDECESSOR_DIGEST,
      ],
      { GITHUB_OUTPUT: output },
    );
    assert.equal(result.status, 1);
    assert.include(result.stderr, "Required checks are not all true");
    const outputs = NodeFS.readFileSync(output, "utf8");
    assert.include(outputs, "all_checks=false");
    assert.include(outputs, "check_install=true");
    assert.include(outputs, "check_update=false");
    assert.include(outputs, "check_recovery=false");
    const written = JSON.parse(
      NodeFS.readFileSync(NodePath.join(candidate.candidateDir, "fork-release.json"), "utf8"),
    );
    assert.deepStrictEqual(written.checks, {
      build: true,
      install: true,
      update: false,
      recovery: false,
    });
  });

  it("exits with usage for an unknown subcommand", () => {
    const result = cli(["frobnicate"]);
    assert.equal(result.status, 2);
    assert.include(result.stderr, "Usage:");
  });
});

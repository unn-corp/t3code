// @effect-diagnostics nodeBuiltinImport:off - fixtures live on the real filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  ANDROID_METADATA_FILE,
  ARTIFACT_DIRS,
  candidateDigest,
  composeManifest,
  discoverCandidateAssets,
  evaluateChecks,
  parseAaptBadging,
  parseAndroidBuildMetadata,
  parseApksignerCerts,
  renderChecksums,
  sha256File,
  verifyAndroidApk,
  verifyBuild,
  type AndroidFacts,
  type CheckReceipt,
  type VerifiedAndroidApk,
} from "./fork-release-assets.ts";
import { FORK_ANDROID_PACKAGE } from "./fork-release-contract.ts";
import { SIGNER, sha, suiteReceiptFor, writeFixtureTree } from "./fork-release-fixtures.ts";
import {
  PACKAGE_VALIDATION,
  requiredSuiteRuns,
  type SuiteId,
  type SuiteReceipt,
} from "./fork-release-suites.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-assets-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const read = (dir: string, name: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(root, dir, name), "utf8"));
const verified = (tree: ReturnType<typeof writeFixtureTree>) => ({
  normal: read(ARTIFACT_DIRS.androidNormal, ANDROID_METADATA_FILE) as VerifiedAndroidApk,
  recovery: read(ARTIFACT_DIRS.androidRecovery, ANDROID_METADATA_FILE) as VerifiedAndroidApk,
  wslEmbedded: read(ARTIFACT_DIRS.wslEmbedded, "wsl-embedded.json"),
  input: {
    inputDir: tree.inputDir,
    version: tree.plan.version,
    channel: tree.plan.channel,
    helperAssets: tree.helperAssets,
  },
});
const buildOf = (tree: ReturnType<typeof writeFixtureTree>) => {
  const v = verified(tree);
  return verifyBuild({
    ...v.input,
    android: { normal: v.normal, recovery: v.recovery },
    wslEmbedded: v.wslEmbedded,
  });
};

describe("Android APK verification", () => {
  it("reads the package, codes, and debuggable flag from aapt2 badging output", () => {
    const facts = parseAaptBadging(
      [
        "package: name='com.devotek.t3code.pwa' versionCode='29853679' versionName='1.0.1' platformBuildVersionName='16' compileSdkVersion='36'",
        "sdkVersion:'24'",
        "application-label:'T3 Code'",
      ].join("\n"),
    );
    assert.deepStrictEqual(facts, {
      packageName: FORK_ANDROID_PACKAGE,
      versionCode: 29_853_679,
      versionName: "1.0.1",
      debuggable: false,
    });
    assert.equal(
      parseAaptBadging("package: name='x' versionCode='1' versionName='1'\napplication-debuggable")
        .debuggable,
      true,
    );
    assert.throws(() => parseAaptBadging("no package line"));
  });

  it("requires exactly one signing certificate", () => {
    const one = `Signer #1 certificate DN: CN=T3\nSigner #1 certificate SHA-256 digest: ${SIGNER.toUpperCase()}\n`;
    assert.equal(parseApksignerCerts(one), SIGNER);
    assert.throws(
      () => parseApksignerCerts(`${one}Signer #2 certificate SHA-256 digest: ${"b".repeat(64)}\n`),
      /exactly one/,
    );
    assert.throws(() => parseApksignerCerts(""), /exactly one/);
  });

  it("accepts SDK-ranged records for the same pinned certificate and rejects mixed certificates", () => {
    const ranged = [
      `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${SIGNER}`,
      `Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${SIGNER.toUpperCase()}`,
    ].join("\r\n");
    assert.equal(parseApksignerCerts(`${ranged}\r\n`), SIGNER);
    assert.throws(
      () => parseApksignerCerts(ranged.replace(SIGNER.toUpperCase(), "b".repeat(64))),
      /found 2/,
    );
  });

  const facts: AndroidFacts = {
    packageName: FORK_ANDROID_PACKAGE,
    versionCode: 29_853_679,
    versionName: "1.0.1",
    debuggable: false,
  };
  const apkSha = "c".repeat(64);
  const commit = sha("c");
  const metadata = parseAndroidBuildMetadata({
    format: 1,
    packageName: FORK_ANDROID_PACKAGE,
    versionName: "1.0.1",
    versionCode: 29_853_679,
    sourceCommit: commit,
    signerSha256: SIGNER,
    updaterProtocol: 1,
    apkSha256: apkSha,
  });
  const call = (overrides: Partial<Parameters<typeof verifyAndroidApk>[0]> = {}) =>
    verifyAndroidApk({
      assetName: "t3-code-android-1.0.1.apk",
      apkSha256: apkSha,
      facts,
      signerSha256: SIGNER,
      metadata,
      expectVersionCode: 29_853_679,
      expectVersion: "1.0.1",
      expectCommit: commit,
      expectSignerSha256: SIGNER,
      ...overrides,
    });

  it("accepts an APK that matches every expectation", () => {
    const result = call();
    assert.equal(result.versionCode, 29_853_679);
    assert.equal(result.packageName, FORK_ANDROID_PACKAGE);
    assert.equal(result.updaterProtocol, 1);
  });

  it("rejects each way an APK can differ from what the release promised", () => {
    assert.throws(() => call({ facts: { ...facts, packageName: "com.example.other" } }), /package/);
    assert.throws(() => call({ facts: { ...facts, debuggable: true } }), /debuggable/);
    assert.throws(() => call({ expectVersionCode: 29_853_680 }), /versionCode/);
    assert.throws(() => call({ expectVersion: "1.0.2" }), /versionName/);
    assert.throws(() => call({ expectSignerSha256: "d".repeat(64) }), /pinned release identity/);
    assert.throws(() => call({ expectCommit: sha("other") }), /built from/);
    assert.throws(() => call({ apkSha256: "e".repeat(64) }), /digest/);
    assert.throws(
      () => call({ metadata: { ...metadata, updaterProtocol: 0 } }),
      /updater protocol/,
    );
    assert.throws(
      () => call({ metadata: { ...metadata, versionCode: 1 } }),
      /metadata versionCode/,
    );
  });

  it("rejects malformed build metadata", () => {
    assert.throws(() => parseAndroidBuildMetadata({ format: 2 }));
    assert.throws(() => parseAndroidBuildMetadata({ ...metadata, signerSha256: "short" }));
    assert.throws(() => parseAndroidBuildMetadata(null));
  });
});

describe("candidate discovery", () => {
  it("finds every required asset in a complete build and ignores electron-builder's debug dump", () => {
    const tree = writeFixtureTree(root);
    const found = discoverCandidateAssets({ ...verified(tree).input });
    assert.deepStrictEqual(found.problems, []);
    const byKind = Object.groupBy(found.assets, (asset) => `${asset.kind}:${asset.platform}`);
    // Both Linux packagings ship; devices tell them apart by exact suffix.
    assert.deepStrictEqual(
      byKind["desktop:linux-x64"]?.map((asset) => asset.name.split(".").pop()).toSorted(),
      ["AppImage", "deb"],
    );
    assert.equal(byKind["desktop:windows-x64"]?.length, 1);
    assert.equal(byKind["server:linux-x64"]?.length, 1);
    assert.equal(byKind["server:windows-x64"]?.length, 1);
    assert.equal(byKind["recovery-helper:linux-x64"]?.length, 2);
    assert.equal(byKind["recovery-helper:windows-x64"]?.length, 2);
    assert.equal(byKind["android:android"]?.length, 1);
    assert.equal(byKind["android-recovery:android"]?.length, 1);
    assert.equal(
      found.assets.some((asset) => asset.name === "builder-debug.yml"),
      false,
    );
  });

  it("publishes the Windows feed under its channel name and the nightly feeds under nightly", () => {
    const tree = writeFixtureTree(root);
    const names = discoverCandidateAssets(verified(tree).input).assets.map((asset) => asset.name);
    assert.include(names, "nightly.yml");
    assert.include(names, "nightly-linux.yml");
    const stableRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-assets-stable-"));
    try {
      const stable = writeFixtureTree(stableRoot, { version: "1.0.1", channel: "stable" });
      const stableNames = discoverCandidateAssets({
        inputDir: stableRoot,
        version: "1.0.1",
        channel: "stable",
        helperAssets: stable.helperAssets,
      }).assets.map((asset) => asset.name);
      assert.include(stableNames, "latest.yml");
      assert.include(stableNames, "latest-linux.yml");
    } finally {
      NodeFS.rmSync(stableRoot, { recursive: true, force: true });
    }
  });

  it("reports missing assets", () => {
    const tree = writeFixtureTree(root, {
      tamper: (dir) => {
        NodeFS.rmSync(NodePath.join(dir, ARTIFACT_DIRS.linuxServer), { recursive: true });
        NodeFS.rmSync(NodePath.join(dir, "recovery-helper-windows-x64"), { recursive: true });
      },
    });
    const { problems } = discoverCandidateAssets(verified(tree).input);
    assert.isTrue(
      problems.some((p) =>
        p.includes("cli-linux-x64: missing t3-1.0.1-nightly.20261006.7-linux-x64.tar.gz"),
      ),
    );
    assert.isTrue(problems.some((p) => p.includes("recovery-helper-windows-x64")));
  });

  it("reports extra assets and duplicate installers", () => {
    const tree = writeFixtureTree(root, {
      tamper: (dir) => {
        NodeFS.writeFileSync(
          NodePath.join(dir, ARTIFACT_DIRS.androidNormal, "debug-symbols.zip"),
          "x",
        );
        NodeFS.writeFileSync(
          NodePath.join(dir, ARTIFACT_DIRS.windowsDesktop, "T3-Code-other-x64.exe"),
          "x",
        );
      },
    });
    const { problems } = discoverCandidateAssets(verified(tree).input);
    assert.isTrue(
      problems.some((p) => p.includes("android-normal/debug-symbols.zip: unexpected asset")),
    );
    assert.isTrue(problems.some((p) => p.includes("expected exactly one *.exe, found 2")));
  });

  it("requires exactly one recovery helper per platform", () => {
    const tree = writeFixtureTree(root);
    const input = verified(tree).input;
    const twoLinux = discoverCandidateAssets({
      ...input,
      helperAssets: [...input.helperAssets, { name: "second-linux-helper", platform: "linux-x64" }],
    });
    assert.isTrue(
      twoLinux.problems.some((p) =>
        p.includes(
          "Exactly one helper and one recovery runtime are required for linux-x64, found 3",
        ),
      ),
    );
    const noWindows = discoverCandidateAssets({
      ...input,
      helperAssets: input.helperAssets.filter((h) => h.platform === "linux-x64"),
    });
    assert.isTrue(noWindows.problems.some((p) => p.includes("windows-x64, found 0")));
  });

  it("reports an empty file and an unconfigured recovery helper", () => {
    const tree = writeFixtureTree(root, {
      tamper: (dir) =>
        NodeFS.writeFileSync(
          NodePath.join(
            dir,
            ARTIFACT_DIRS.windowsServer,
            "t3-1.0.1-nightly.20261006.7-win32-x64.zip",
          ),
          "",
        ),
    });
    const { problems } = discoverCandidateAssets({ ...verified(tree).input, helperAssets: [] });
    assert.isTrue(problems.some((p) => p.includes("file is empty")));
    assert.isTrue(problems.some((p) => p.includes("recovery helper assets are not configured")));
  });
});

describe("build verification", () => {
  it("passes a complete build whose feeds, WSL runtime, and APKs all agree", () => {
    const result = buildOf(writeFixtureTree(root));
    assert.deepStrictEqual(result.problems, []);
  });

  it("validates an AppImage's embedded block map against the feed and shipped bytes", () => {
    const tree = writeFixtureTree(root, {
      tamper: (dir) => {
        const linux = NodePath.join(dir, ARTIFACT_DIRS.linuxDesktop);
        const name = NodeFS.readdirSync(linux).find((file) => file.endsWith(".AppImage"))!;
        NodeFS.unlinkSync(NodePath.join(linux, `${name}.blockmap`));
        const map = NodeZlib.deflateRawSync(
          JSON.stringify({
            version: "2",
            files: [{ name: "file", offset: 0, checksums: ["checksum"], sizes: [2048] }],
          }),
        );
        const trailer = Buffer.alloc(4);
        trailer.writeUInt32BE(map.length);
        const bytes = Buffer.concat([Buffer.alloc(2048), map, trailer]);
        NodeFS.writeFileSync(NodePath.join(linux, name), bytes);
        const digest = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
        const feed = NodePath.join(linux, "nightly-linux.yml");
        NodeFS.writeFileSync(
          feed,
          NodeFS.readFileSync(feed, "utf8")
            .replaceAll(/sha512: .*/g, `sha512: ${digest}`)
            .replace(/    size: .*/, `    size: ${bytes.length}\n    blockMapSize: ${map.length}`),
        );
      },
    });
    assert.deepStrictEqual(buildOf(tree).problems, []);
    const feed = NodePath.join(root, ARTIFACT_DIRS.linuxDesktop, "nightly-linux.yml");
    NodeFS.writeFileSync(
      feed,
      NodeFS.readFileSync(feed, "utf8").replace(
        /blockMapSize: (\d+)/,
        (_, size) => `blockMapSize: ${Number(size) + 1}`,
      ),
    );
    assert.isTrue(buildOf(tree).problems.some((problem) => problem.includes("trailer differs")));
  });

  it("requires an AppImage block map when no embedded size is recorded", () => {
    const tree = writeFixtureTree(root, {
      tamper: (dir) => {
        const linux = NodePath.join(dir, ARTIFACT_DIRS.linuxDesktop);
        const name = NodeFS.readdirSync(linux).find((file) => file.endsWith(".AppImage.blockmap"))!;
        NodeFS.unlinkSync(NodePath.join(linux, name));
      },
    });
    assert.isTrue(
      buildOf(tree).problems.some((problem) =>
        problem.includes("neither an embedded nor an external block map"),
      ),
    );
  });

  it("rejects a feed whose digest, size, or version does not match the shipped file", () => {
    const wrongDigest = writeFixtureTree(root, {
      tamper: (dir) => {
        const feed = NodePath.join(dir, ARTIFACT_DIRS.windowsDesktop, "nightly-win-x64.yml");
        NodeFS.writeFileSync(
          feed,
          NodeFS.readFileSync(feed, "utf8").replaceAll(/sha512: .*/g, "sha512: AAAA"),
        );
      },
    });
    assert.isTrue(
      buildOf(wrongDigest).problems.some((p) => p.includes("does not match the feed's sha512")),
    );
  });

  it("rejects a feed that points at a file missing from the release or the wrong version", () => {
    const tree = writeFixtureTree(root, {
      tamper: (dir) => {
        const feed = NodePath.join(dir, ARTIFACT_DIRS.linuxDesktop, "nightly-linux.yml");
        NodeFS.writeFileSync(
          feed,
          NodeFS.readFileSync(feed, "utf8")
            .replaceAll(/url: .*/g, "url: T3-Code-vanished.AppImage")
            .replace(/version: .*/, "version: 9.9.9"),
        );
      },
    });
    const problems = buildOf(tree).problems;
    assert.isTrue(
      problems.some((p) =>
        p.includes("references T3-Code-vanished.AppImage, which is not a release asset"),
      ),
    );
    assert.isTrue(problems.some((p) => p.includes("feed version 9.9.9")));
    assert.isTrue(problems.some((p) => p.includes("does not reference installer")));
  });

  it("rejects a Windows installer whose embedded WSL runtime is not the Linux archive's exact bytes", () => {
    const tree = writeFixtureTree(root);
    const v = verified(tree);
    const result = verifyBuild({
      ...v.input,
      android: { normal: v.normal, recovery: v.recovery },
      wslEmbedded: { ...v.wslEmbedded, sha256: "f".repeat(64) },
    });
    assert.isTrue(result.problems.some((p) => p.includes("not byte-identical")));
    const missing = verifyBuild({
      ...v.input,
      android: { normal: v.normal, recovery: v.recovery },
      wslEmbedded: null,
    });
    assert.isTrue(missing.problems.some((p) => p.includes("no embedded WSL runtime receipt")));
  });

  it("rejects mismatched Android pairs: different keys, a lower recovery code, or the same source", () => {
    const tree = writeFixtureTree(root);
    const v = verified(tree);
    const base = { ...v.input, wslEmbedded: v.wslEmbedded };
    const differentKey = verifyBuild({
      ...base,
      android: { normal: v.normal, recovery: { ...v.recovery, signerSha256: "b".repeat(64) } },
    });
    assert.isTrue(differentKey.problems.some((p) => p.includes("different key")));
    const lowerCode = verifyBuild({
      ...base,
      android: { normal: v.normal, recovery: { ...v.recovery, versionCode: v.normal.versionCode } },
    });
    assert.isTrue(lowerCode.problems.some((p) => p.includes("higher installation code")));
    const sameSource = verifyBuild({
      ...base,
      android: {
        normal: v.normal,
        recovery: {
          ...v.recovery,
          sourceVersion: v.normal.sourceVersion,
          sourceCommit: v.normal.sourceCommit,
        },
      },
    });
    assert.isTrue(sameSource.problems.some((p) => p.includes("same source")));
  });

  it("rejects an APK whose bytes changed after it was verified", () => {
    const tree = writeFixtureTree(root, {
      tamper: (dir) =>
        NodeFS.appendFileSync(
          NodePath.join(
            dir,
            ARTIFACT_DIRS.androidNormal,
            "t3-code-android-1.0.1-nightly.20261006.7.apk",
          ),
          "!",
        ),
    });
    assert.isTrue(
      buildOf(tree).problems.some((p) => p.includes("differs from the bytes that were verified")),
    );
  });
});

describe("checksums and receipts", () => {
  it("lists only the server archives, sorted, in sha256sum format", () => {
    const tree = writeFixtureTree(root);
    const text = renderChecksums(buildOf(tree).assets);
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^[0-9a-f]{64} {2}t3-1\.0\.1-nightly\.20261006\.7-linux-x64\.tar\.gz$/);
    assert.match(lines[1]!, / {2}t3-1\.0\.1-nightly\.20261006\.7-win32-x64\.zip$/);
    assert.equal(
      lines[0]!.split("  ")[0],
      sha256File(
        NodePath.join(
          root,
          ARTIFACT_DIRS.linuxServer,
          "t3-1.0.1-nightly.20261006.7-linux-x64.tar.gz",
        ),
      ),
    );
  });

  it("derives one digest for the payload regardless of order and changes with any byte", () => {
    const a = [
      { name: "a", sha256: "1".repeat(64) },
      { name: "b", sha256: "2".repeat(64) },
    ];
    assert.equal(candidateDigest(a), candidateDigest(a.toReversed()));
    assert.notEqual(
      candidateDigest(a),
      candidateDigest([a[0]!, { name: "b", sha256: "3".repeat(64) }]),
    );
    assert.notEqual(
      candidateDigest(a),
      candidateDigest([a[0]!, { name: "c", sha256: "2".repeat(64) }]),
    );
  });

  const expectation = {
    version: "1.0.1-nightly.20261006.7",
    commit: sha("source"),
    channel: "nightly" as const,
    candidateDigest: "9".repeat(64),
    predecessorDigest: "8".repeat(64),
  };
  const receipt = (
    check: CheckReceipt["check"],
    target: CheckReceipt["target"],
    overrides: Partial<CheckReceipt> = {},
  ): CheckReceipt => ({
    format: 1,
    check,
    target,
    version: expectation.version,
    commit: expectation.commit,
    channel: expectation.channel,
    candidateDigest: expectation.candidateDigest,
    predecessorDigest: expectation.predecessorDigest,
    command: [...PACKAGE_VALIDATION.run],
    exitCode: 0,
    passed: true,
    startedAt: "2026-10-06T07:50:00Z",
    finishedAt: "2026-10-06T07:55:00Z",
    runner: "Linux-X64",
    runUrl: "https://example.test/run",
    ...overrides,
  });
  const all = (overrides: Partial<CheckReceipt> = {}) =>
    (["install", "update", "recovery"] as const).flatMap((check) =>
      (["linux-x64", "windows-x64", "android"] as const).map((target) =>
        receipt(check, target, overrides),
      ),
    );
  const suites = (overrides: Record<string, unknown> = {}, skip: SuiteId[] = []): SuiteReceipt[] =>
    requiredSuiteRuns()
      .filter((run) => !skip.includes(run.suite))
      .map(
        (run) =>
          ({
            ...suiteReceiptFor(expectation, run.suite, run.target),
            ...overrides,
          }) as SuiteReceipt,
      );
  const evaluate = (
    packages: CheckReceipt[],
    suiteReceipts: SuiteReceipt[],
    expect:
      | typeof expectation
      | (Omit<typeof expectation, "predecessorDigest"> & { predecessorDigest: null }) = expectation,
    build = true,
  ) => evaluateChecks(packages, suiteReceipts, expect, build);
  const ALL_TRUE = { build: true, install: true, update: true, recovery: true };

  it("marks a check true only when package and suite evidence both cover this candidate", () => {
    assert.deepStrictEqual(evaluate(all(), suites()), ALL_TRUE);
  });

  it("never reports a pass without real receipts", () => {
    assert.deepStrictEqual(evaluate([], []), {
      build: true,
      install: false,
      update: false,
      recovery: false,
    });
    assert.equal(evaluate(all(), suites(), expectation, false).build, false);
  });

  it("does not let package receipts stand in for the safety suites, or the reverse", () => {
    assert.deepStrictEqual(evaluate(all(), []), {
      build: true,
      install: false,
      update: false,
      recovery: false,
    });
    assert.deepStrictEqual(evaluate([], suites()), {
      build: true,
      install: false,
      update: false,
      recovery: false,
    });
  });

  it("rejects package receipts for other bytes, versions, commits, or a failing exit", () => {
    const missingTarget = all().filter((r) => !(r.check === "update" && r.target === "android"));
    assert.equal(evaluate(missingTarget, suites()).update, false);
    assert.equal(evaluate(all({ candidateDigest: "0".repeat(64) }), suites()).install, false);
    assert.equal(evaluate(all({ version: "1.0.1-nightly.20261006.8" }), suites()).install, false);
    assert.equal(evaluate(all({ commit: sha("other") }), suites()).install, false);
    assert.equal(evaluate(all({ exitCode: 1, passed: false }), suites()).install, false);
    assert.equal(evaluate(all({ passed: false }), suites()).install, false);
    assert.equal(evaluate(all({ command: null }), suites()).install, false);
  });

  it("ignores a receipt for any command other than the package validation defined in code", () => {
    assert.equal(
      evaluate(all({ command: ["node", "-e", "process.exit(0)"] }), suites()).install,
      false,
    );
    assert.equal(
      evaluate(all({ command: [...PACKAGE_VALIDATION.run, "--skip"] }), suites()).install,
      false,
    );
    assert.equal(evaluate(all({ command: ["true"] }), suites()).update, false);
  });

  it("requires update and recovery receipts to name the predecessor they ran against", () => {
    assert.equal(evaluate(all({ predecessorDigest: "1".repeat(64) }), suites()).update, false);
    assert.equal(evaluate(all({ predecessorDigest: "1".repeat(64) }), suites()).install, true);
    assert.deepStrictEqual(evaluate(all(), suites(), { ...expectation, predecessorDigest: null }), {
      build: true,
      install: true,
      update: false,
      recovery: false,
    });
  });

  it("makes each missing safety suite fail exactly the checks that depend on it", () => {
    // The coordinator guards every check; the native updaters guard update and recovery.
    assert.deepStrictEqual(evaluate(all(), suites({}, ["coordinator"])), {
      build: true,
      install: false,
      update: false,
      recovery: false,
    });
    assert.deepStrictEqual(evaluate(all(), suites({}, ["native-android"])), {
      build: true,
      install: true,
      update: false,
      recovery: false,
    });
    assert.deepStrictEqual(evaluate(all(), suites({}, ["desktop-updater"])), {
      build: true,
      install: true,
      update: false,
      recovery: false,
    });
  });

  it("requires a suite receipt on every target the suite covers", () => {
    const withoutWindows = suites().filter(
      (r) => !(r.suite === "coordinator" && r.target === "windows-x64"),
    );
    assert.deepStrictEqual(evaluate(all(), withoutWindows), {
      build: true,
      install: false,
      update: false,
      recovery: false,
    });
  });

  it("rejects suite receipts bound to another cohort or run from different source", () => {
    const bad = (overrides: Record<string, unknown>) => evaluate(all(), suites(overrides));
    const NONE = { build: true, install: false, update: false, recovery: false };
    assert.deepStrictEqual(bad({ candidateDigest: "0".repeat(64) }), NONE);
    assert.deepStrictEqual(bad({ commit: sha("other"), testedCommit: sha("other") }), NONE);
    // Tests that ran on a different checkout than the one the artifacts came from prove nothing.
    assert.deepStrictEqual(bad({ testedCommit: sha("moved-head") }), NONE);
    assert.deepStrictEqual(bad({ version: "1.0.1-nightly.20261006.8" }), NONE);
    assert.deepStrictEqual(bad({ channel: "stable" }), NONE);
  });

  it("rejects a suite that ran a different specification, failed, reported problems, or skipped a required file", () => {
    const NONE = { build: true, install: false, update: false, recovery: false };
    assert.deepStrictEqual(evaluate(all(), suites({ specDigest: "0".repeat(64) })), NONE);
    assert.deepStrictEqual(evaluate(all(), suites({ exitCode: 1, passed: false })), NONE);
    assert.deepStrictEqual(evaluate(all(), suites({ problems: ["flaky"] })), NONE);
    const shrunk = suites().map((receipt) =>
      receipt.suite === "coordinator" ? { ...receipt, files: receipt.files.slice(1) } : receipt,
    );
    assert.equal(evaluate(all(), shrunk).install, false);
    const empty = suites().map((receipt) =>
      receipt.suite === "coordinator"
        ? { ...receipt, files: receipt.files.map((f) => ({ ...f, tests: 0 })) }
        : receipt,
    );
    assert.equal(evaluate(all(), empty).install, false);
  });
});

describe("manifest", () => {
  const compose = (checks: {
    build: boolean;
    install: boolean;
    update: boolean;
    recovery: boolean;
  }) => {
    const tree = writeFixtureTree(root);
    const result = buildOf(tree);
    const v = verified(tree);
    return composeManifest({
      version: tree.plan.version,
      commit: tree.plan.commit,
      channel: tree.plan.channel,
      releasedAt: "2026-10-06T08:00:00.000Z",
      assets: result.assets,
      android: { normal: v.normal, recovery: v.recovery },
      checks,
    });
  };

  it("decodes under the exact contract schema and carries the real digests and sizes", () => {
    const manifest = compose({ build: true, install: true, update: true, recovery: true });
    assert.equal(manifest.repository, "unn-corp/t3code");
    assert.equal(manifest.android.normal.packageName, FORK_ANDROID_PACKAGE);
    const exe = manifest.assets.find(
      (asset) => asset.kind === "desktop" && asset.platform === "windows-x64",
    )!;
    assert.equal(
      exe.sha256,
      sha256File(NodePath.join(root, ARTIFACT_DIRS.windowsDesktop, exe.name)),
    );
    assert.equal(
      exe.bytes,
      NodeFS.statSync(NodePath.join(root, ARTIFACT_DIRS.windowsDesktop, exe.name)).size,
    );
    assert.deepStrictEqual(
      manifest.assets.map((asset) => asset.name),
      manifest.assets.map((asset) => asset.name).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("records failing checks as false rather than hardcoding a pass", () => {
    const manifest = compose({ build: true, install: true, update: false, recovery: false });
    assert.deepStrictEqual(manifest.checks, {
      build: true,
      install: true,
      update: false,
      recovery: false,
    });
  });

  it("refuses to compose a manifest the contract would not accept", () => {
    const tree = writeFixtureTree(root);
    const result = buildOf(tree);
    const v = verified(tree);
    assert.throws(() =>
      composeManifest({
        version: tree.plan.version,
        commit: "not-a-sha",
        channel: tree.plan.channel,
        releasedAt: "2026-10-06T08:00:00.000Z",
        assets: result.assets,
        android: { normal: v.normal, recovery: v.recovery },
        checks: { build: true, install: true, update: true, recovery: true },
      }),
    );
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  ANDROID_MAX_VERSION_CODE,
  MANUAL_BASELINE_GUIDANCE,
  androidBuildMetadata,
  parseBadging,
  planAndroidBuild,
  predecessorProblems,
  singleSignerDigest,
  verifyBuiltApk,
  type AndroidBuildInput,
} from "./android-pwa-config.ts";

const COMMIT = "a".repeat(40);
const SIGNER = "eb38a25cf25676b7418fee5105f66d9ff166bfd5546ba816288e5bd83b73d362";
const base: AndroidBuildInput = {
  kind: "normal",
  versionName: "1.0.1",
  versionCode: 29_853_700,
  normalVersionCode: null,
  sourceCommit: COMMIT,
  sourceDir: null,
  repoRoot: "/repo",
  nowMs: 1_790_000_000_000,
};

describe("planAndroidBuild", () => {
  it("plans a normal build from this repository and reserves the next code for recovery", () => {
    const plan = planAndroidBuild(base);
    expect(plan).toMatchObject({
      kind: "normal",
      versionCode: 29_853_700,
      sourceDir: "/repo",
      recovery: false,
      emitsReleaseMetadata: true,
    });
  });

  it("defaults the code to minutes since the epoch", () => {
    expect(planAndroidBuild({ ...base, versionCode: null }).versionCode).toBe(29_833_333);
  });

  it("refuses a normal code whose recovery code would not fit", () => {
    expect(() => planAndroidBuild({ ...base, versionCode: ANDROID_MAX_VERSION_CODE })).toThrow(
      /integer from 1/,
    );
    expect(
      planAndroidBuild({ ...base, versionCode: ANDROID_MAX_VERSION_CODE - 1 }).versionCode,
    ).toBe(ANDROID_MAX_VERSION_CODE - 1);
  });

  it("does not stamp release identity on a build of unknown source", () => {
    const plan = planAndroidBuild({ ...base, sourceCommit: null });
    expect(plan.sourceCommit).toBe("unknown");
    expect(plan.emitsReleaseMetadata).toBe(false);
    expect(() =>
      androidBuildMetadata({
        plan,
        signerSha256: SIGNER,
        apkSha256: "b".repeat(64),
        assetName: "a.apk",
        bytes: 1,
      }),
    ).toThrow(/unknown source/);
  });

  it("rejects malformed versions and commits", () => {
    expect(() => planAndroidBuild({ ...base, versionName: "../1.0" })).toThrow(/version-name/);
    expect(() => planAndroidBuild({ ...base, versionName: 'a"b' })).toThrow(/version-name/);
    expect(() => planAndroidBuild({ ...base, sourceCommit: "abc123" })).toThrow(/40-character/);
    expect(() => planAndroidBuild({ ...base, sourceCommit: "A".repeat(40) })).toThrow(
      /40-character/,
    );
  });

  it("builds recovery one code above its normal build from the predecessor checkout", () => {
    const plan = planAndroidBuild({
      ...base,
      kind: "recovery",
      versionCode: null,
      normalVersionCode: 29_853_700,
      sourceDir: "/predecessor",
      versionName: "1.0.0",
      sourceCommit: "b".repeat(40),
    });
    expect(plan).toMatchObject({
      kind: "recovery",
      versionCode: 29_853_701,
      recovery: true,
      sourceDir: "/predecessor",
      sourceCommit: "b".repeat(40),
    });
    expect(
      planAndroidBuild({
        ...base,
        kind: "recovery",
        versionCode: 29_853_705,
        normalVersionCode: 29_853_700,
        sourceDir: "/p",
      }).versionCode,
    ).toBe(29_853_705);
  });

  it("accepts a separately reserved recovery code above its paired normal code", () => {
    const plan = planAndroidBuild({
      ...base,
      kind: "recovery",
      versionCode: 29_853_711,
      normalVersionCode: 29_853_700,
      sourceDir: "/predecessor",
      sourceCommit: "b".repeat(40),
    });
    expect(plan.versionCode).toBe(29_853_711);
    expect(
      planAndroidBuild({
        ...base,
        kind: "recovery",
        versionCode: ANDROID_MAX_VERSION_CODE,
        normalVersionCode: ANDROID_MAX_VERSION_CODE - 1,
        sourceDir: "/predecessor",
        sourceCommit: "b".repeat(40),
      }).versionCode,
    ).toBe(ANDROID_MAX_VERSION_CODE);
    expect(() =>
      planAndroidBuild({
        ...base,
        kind: "recovery",
        versionCode: 29_853_700,
        normalVersionCode: 29_853_700,
        sourceDir: "/p",
      }),
    ).toThrow(/greater than its paired normal code/);
    expect(() =>
      planAndroidBuild({
        ...base,
        kind: "recovery",
        versionCode: ANDROID_MAX_VERSION_CODE + 1,
        normalVersionCode: 29_853_700,
        sourceDir: "/p",
      }),
    ).toThrow(/greater than its paired normal code/);
    expect(() =>
      planAndroidBuild({
        ...base,
        kind: "recovery",
        versionCode: ANDROID_MAX_VERSION_CODE,
        normalVersionCode: ANDROID_MAX_VERSION_CODE,
        sourceDir: "/p",
      }),
    ).toThrow(/normal-version-code/);
  });

  it("fails closed with manual baseline guidance when no predecessor exists", () => {
    expect(() =>
      planAndroidBuild({
        ...base,
        kind: "recovery",
        normalVersionCode: 29_853_700,
        sourceDir: null,
      }),
    ).toThrow(MANUAL_BASELINE_GUIDANCE);
    expect(MANUAL_BASELINE_GUIDANCE).toMatch(/manual baseline/);
    expect(MANUAL_BASELINE_GUIDANCE).toMatch(/never uninstall/);
  });

  it("will not build recovery from the current tree or an uncommitted source", () => {
    expect(() =>
      planAndroidBuild({ ...base, kind: "recovery", normalVersionCode: null, sourceDir: "/p" }),
    ).toThrow(/normal-version-code/);
    expect(() =>
      planAndroidBuild({
        ...base,
        kind: "recovery",
        versionCode: null,
        normalVersionCode: 5,
        sourceDir: "/p",
        sourceCommit: null,
      }),
    ).toThrow(/committed predecessor/);
    expect(() => planAndroidBuild({ ...base, normalVersionCode: 5 })).toThrow(/only applies/);
  });
});

describe("predecessorProblems", () => {
  const equipped = (path: string) =>
    path.endsWith("build.gradle") ? "pwaSourceCommit pwaRecovery" : "class NativeUpdateController";
  it("accepts a checkout with the updater and the build properties", () => {
    expect(predecessorProblems(equipped)).toEqual([]);
  });
  it("rejects a pre-updater predecessor, which could never update again", () => {
    expect(
      predecessorProblems((path) => (path.endsWith("build.gradle") ? "pwaVersionCode" : null)).join(
        " ",
      ),
    ).toMatch(/no native updater/);
    expect(
      predecessorProblems((path) => (path.endsWith("build.gradle") ? "pwaVersionCode" : "x")).join(
        " ",
      ),
    ).toMatch(/-PpwaSourceCommit/);
    expect(predecessorProblems(() => null)).toHaveLength(2);
  });
});

describe("release metadata", () => {
  const plan = planAndroidBuild(base);
  it("describes the APK for the release workflow's cross-check", () => {
    expect(
      androidBuildMetadata({
        plan,
        signerSha256: SIGNER,
        apkSha256: "c".repeat(64),
        assetName: "t3-code-android-1.0.1.apk",
        bytes: 1234,
      }),
    ).toEqual({
      format: 1,
      packageName: "com.devotek.t3code.pwa",
      versionName: "1.0.1",
      versionCode: 29_853_700,
      sourceCommit: COMMIT,
      signerSha256: SIGNER,
      updaterProtocol: 1,
      apkSha256: "c".repeat(64),
      kind: "normal",
      assetName: "t3-code-android-1.0.1.apk",
      bytes: 1234,
    });
  });
  it("rejects malformed digests and asset names", () => {
    expect(() =>
      androidBuildMetadata({
        plan,
        signerSha256: "EB38",
        apkSha256: "c".repeat(64),
        assetName: "a.apk",
        bytes: 1,
      }),
    ).toThrow(/SHA-256/);
    expect(() =>
      androidBuildMetadata({
        plan,
        signerSha256: SIGNER,
        apkSha256: "c".repeat(64),
        assetName: "../a.apk",
        bytes: 1,
      }),
    ).toThrow(/asset name/);
  });
});

describe("tool output", () => {
  it("accepts exactly one signer", () => {
    expect(
      singleSignerDigest(`Signer #1 certificate SHA-256 digest: ${SIGNER.toUpperCase()}\n`),
    ).toBe(SIGNER);
    expect(() => singleSignerDigest("")).toThrow(/found 0/);
    expect(() =>
      singleSignerDigest(
        `Signer #1 certificate SHA-256 digest: ${SIGNER}\nSigner #2 certificate SHA-256 digest: ${"b".repeat(64)}\n`,
      ),
    ).toThrow(/found 2/);
  });
  it("accepts repeated SDK-ranged records only when they identify the same certificate", () => {
    const ranged = [
      `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${SIGNER.toUpperCase()}`,
      `Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${SIGNER}`,
    ].join("\r\n");
    expect(singleSignerDigest(`${ranged}\r\n`)).toBe(SIGNER);
    expect(() =>
      singleSignerDigest(`${ranged.replace(SIGNER.toUpperCase(), "b".repeat(64))}\r\n`),
    ).toThrow(/found 2/);
  });
  it("accepts the SDK scheme-labelled format and requires one certificate across schemes", () => {
    const schemeRecords = [
      `V2 Signer: certificate SHA-256 digest: ${SIGNER}`,
      `V3 Signer: certificate SHA-256 digest: ${SIGNER.toUpperCase()}`,
    ].join("\r\n");
    expect(singleSignerDigest(`${schemeRecords}\r\n`)).toBe(SIGNER);
    expect(() =>
      singleSignerDigest(schemeRecords.replace(SIGNER.toUpperCase(), "b".repeat(64))),
    ).toThrow(/found 2/);
    expect(() => singleSignerDigest(`V9 Signer: certificate SHA-256 digest: ${SIGNER}`)).toThrow(
      /Unrecognized/,
    );
  });
  it("rejects malformed certificate records instead of ignoring them", () => {
    expect(() =>
      singleSignerDigest("Signer #1 certificate SHA-256 digest: not-a-certificate\r\n"),
    ).toThrow(/Unrecognized/);
  });
  const badging =
    "package: name='com.devotek.t3code.pwa' versionCode='29853700' versionName='1.0.1' platformBuildVersionName='16'\nsdkVersion:'24'\n";
  it("verifies the compiled APK against the plan", () => {
    const plan = planAndroidBuild(base);
    verifyBuiltApk(plan, parseBadging(badging));
    expect(() =>
      verifyBuiltApk(plan, parseBadging(badging.replace("29853700", "29853701"))),
    ).toThrow(/versionCode/);
    expect(() => verifyBuiltApk(plan, parseBadging(badging.replace("1.0.1", "1.0.2")))).toThrow(
      /versionName/,
    );
    expect(() => verifyBuiltApk(plan, parseBadging(`${badging}application-debuggable\n`))).toThrow(
      /debuggable/,
    );
    expect(() =>
      verifyBuiltApk(plan, parseBadging(badging.replace("com.devotek.t3code.pwa", "com.example"))),
    ).toThrow(/package/);
    expect(() => parseBadging("nothing")).toThrow(/no package name/);
  });
});

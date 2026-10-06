// @effect-diagnostics nodeBuiltinImport:off globalDate:off - baselines are real files with fixed instants.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  BASELINE_MANIFEST_ASSET,
  BASELINE_TAG,
  baselineDigest,
  packBaseline,
  parseBaselineManifest,
  verifyBaselinePayload,
} from "./fork-release-baseline.ts";
import { FakeGitHub, makeRelease, sha } from "./fork-release-fixtures.ts";
import { fetchRelease, loadBaseline } from "./fork-release-github.ts";
import { buildPlan } from "./fork-release-policy.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-baseline-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const file = (name: string, content: string) => {
  const path = NodePath.join(root, "src", name);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
  return path;
};
const pack = (outName = "baseline") =>
  packBaseline({
    outDir: NodePath.join(root, outName),
    version: "0.0.46-baseline",
    commit: sha("baseline"),
    windowsInstaller: file("setup.exe", "exe"),
    linuxAppImage: file("app.AppImage", "appimage"),
    linuxDeb: file("app.deb", "deb"),
    linuxServer: file("server.tar.gz", "server"),
    apk: file("app.apk", "apk"),
    androidVersionCode: 29_853_678,
    signerSha256: "a".repeat(64),
    recordedAt: "2026-10-05T12:00:00.000Z",
  });

describe("baseline packing", () => {
  it("copies the files under canonical names and records their real digests", () => {
    const manifest = pack();
    assert.deepStrictEqual(manifest.assets.map((asset) => asset.name).toSorted(), [
      "T3-Code-0.0.46-baseline-amd64.deb",
      "T3-Code-0.0.46-baseline-x64.exe",
      "T3-Code-0.0.46-baseline-x86_64.AppImage",
      "t3-0.0.46-baseline-linux-x64.tar.gz",
      "t3-code-android-0.0.46-baseline.apk",
    ]);
    assert.deepStrictEqual(verifyBaselinePayload(NodePath.join(root, "baseline"), manifest), []);
    assert.equal(manifest.android.versionCode, 29_853_678);
    assert.match(baselineDigest(manifest), /^[0-9a-f]{64}$/);
  });

  it("detects a missing, altered, resized, or extra file", () => {
    const manifest = pack();
    const dir = NodePath.join(root, "baseline");
    NodeFS.writeFileSync(NodePath.join(dir, "t3-code-android-0.0.46-baseline.apk"), "APK");
    NodeFS.appendFileSync(NodePath.join(dir, "T3-Code-0.0.46-baseline-x64.exe"), "!");
    NodeFS.rmSync(NodePath.join(dir, "t3-0.0.46-baseline-linux-x64.tar.gz"));
    NodeFS.writeFileSync(NodePath.join(dir, "stray.bin"), "x");
    const problems = verifyBaselinePayload(dir, manifest);
    assert.isTrue(problems.some((p) => p.includes("apk: digest differs")));
    assert.isTrue(problems.some((p) => p.includes("exe: size differs")));
    assert.isTrue(problems.some((p) => p.includes("tar.gz: missing")));
    assert.isTrue(problems.some((p) => p.includes("stray.bin: not in the baseline manifest")));
  });

  it("rejects a manifest that is malformed or lacks a required asset", () => {
    assert.throws(() => parseBaselineManifest({ format: 1 }));
    const manifest = pack();
    assert.throws(() => parseBaselineManifest({ ...manifest, commit: "short" }));
    assert.throws(() => parseBaselineManifest({ ...manifest, updaterProtocol: 0 }));
    const incomplete = parseBaselineManifest({
      ...manifest,
      assets: manifest.assets.filter((a) => a.kind !== "android"),
    });
    assert.isTrue(
      verifyBaselinePayload(NodePath.join(root, "baseline"), incomplete).some((p) =>
        p.includes("no apk"),
      ),
    );
  });
});

describe("baseline as predecessor", () => {
  const tip = sha("tip");
  const baseline = { tag: BASELINE_TAG, version: "0.0.46-baseline", commit: sha("baseline") };
  const input = {
    channel: "nightly" as const,
    commit: tip,
    now: new Date("2026-10-06T07:23:00Z"),
    runNumber: 1,
  };

  it("is used only while no pipeline release is eligible", () => {
    const first = buildPlan({ ...input, releases: [], baseline });
    assert.equal(first.kind === "release" ? first.plan.predecessor.baseline : null, true);
    const later = buildPlan({ ...input, releases: [makeRelease({ version: "1.0.0" })], baseline });
    assert.equal(later.kind === "release" ? later.plan.predecessor.baseline : "x", undefined);
  });

  it("is refused when it is the candidate's own source, which would restore nothing", () => {
    assert.throws(
      () => buildPlan({ ...input, commit: baseline.commit, releases: [], baseline }),
      /baseline/,
    );
  });
});

describe("baseline release", () => {
  const publishBaseline = (github: FakeGitHub, tamper = false) => {
    const manifest = pack();
    const dir = NodePath.join(root, "baseline");
    const created = github.createDraftRelease({
      tagName: BASELINE_TAG,
      commit: manifest.commit,
      name: "baseline",
      body: "",
      prerelease: true,
    });
    return created.then(async (draft) => {
      for (const name of NodeFS.readdirSync(dir)) {
        await github.uploadAsset(draft.id, name, NodeFS.readFileSync(NodePath.join(dir, name)));
      }
      if (tamper) github.corruptAsset(draft.id, "T3-Code-0.0.46-baseline-x64.exe");
      return { manifest, draft };
    });
  };

  it("loads the manifest and downloads a verified payload for update and recovery tests", async () => {
    const github = new FakeGitHub();
    const { manifest } = await publishBaseline(github);
    assert.equal((await loadBaseline(github))?.manifest.version, "0.0.46-baseline");
    const fetched = await fetchRelease(github, BASELINE_TAG, NodePath.join(root, "predecessor"));
    assert.deepStrictEqual(
      [fetched.baseline, fetched.version, fetched.digest],
      [true, manifest.version, baselineDigest(manifest)],
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(root, "predecessor", BASELINE_MANIFEST_ASSET)));
  });

  it("refuses a baseline whose downloaded bytes differ from its manifest", async () => {
    const github = new FakeGitHub();
    await publishBaseline(github, true);
    let failure: unknown;
    await fetchRelease(github, BASELINE_TAG, NodePath.join(root, "predecessor")).catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /does not verify/);
  });

  it("reports no baseline when none was published", async () => {
    assert.isNull(await loadBaseline(new FakeGitHub()));
  });
});

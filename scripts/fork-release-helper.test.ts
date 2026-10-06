// oxlint-disable t3code/no-global-process-runtime -- The release CLI packages and tests its own platform runtime.
// @effect-diagnostics nodeBuiltinImport:off - the helper build runs a real bundle with a real self-test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  RECOVERY_HELPER_ASSETS,
  RECOVERY_HELPER_ENTRY,
  RECOVERY_HELPER_PACKAGE,
  buildRecoveryHelper,
  helperAssetFor,
  type HelperBundler,
} from "./fork-release-helper.ts";

const hostPlatform = process.platform === "win32" ? "windows-x64" : "linux-x64";
let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-helper-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const source = (withEntry = true) => {
  const dir = NodePath.join(root, "source");
  const entry = NodePath.join(dir, RECOVERY_HELPER_PACKAGE, RECOVERY_HELPER_ENTRY);
  NodeFS.mkdirSync(NodePath.dirname(entry), { recursive: true });
  if (withEntry) NodeFS.writeFileSync(entry, "// coordinator entry");
  return dir;
};
const out = (name = "out") => NodePath.join(root, name);

/** A bundler that writes the given JavaScript as the bundle, standing in for `vp pack`. */
const bundling =
  (script: string): HelperBundler =>
  ({ outFile }) => {
    NodeFS.mkdirSync(NodePath.dirname(outFile), { recursive: true });
    NodeFS.writeFileSync(outFile, script);
  };
const selfTest = (body: string) => `if (process.argv[2] === "--self-test") { ${body} }`;

describe("recovery helper assets", () => {
  it("defines a helper and retained runtime for each platform", () => {
    assert.deepStrictEqual(
      RECOVERY_HELPER_ASSETS.map((asset) => asset.platform),
      ["linux-x64", "windows-x64", "linux-x64", "windows-x64"],
    );
    assert.equal(helperAssetFor("windows-x64").name, "t3-recovery-helper-windows-x64.mjs");
    assert.throws(() => helperAssetFor("android" as never));
  });
});

describe("building the recovery helper from the coordinator", () => {
  it("fails closed, naming the contract, when the coordinator provides no entry", () => {
    const problems = buildRecoveryHelper({
      sourceDir: source(false),
      platform: hostPlatform,
      outDir: out(),
    });
    assert.equal(problems.length, 1);
    assert.include(problems[0], "packages/shared/src/forkRecoveryHelperMain.ts");
    assert.include(problems[0], "no release can be published");
  });

  it("produces the platform's asset once the bundle's self-test reports the protocol", () => {
    const problems = buildRecoveryHelper({
      sourceDir: source(),
      platform: hostPlatform,
      outDir: out(),
      bundler: bundling(selfTest('console.log("recovery-helper-protocol=1"); process.exit(0);')),
    });
    assert.deepStrictEqual(problems, []);
    assert.isTrue(NodeFS.existsSync(NodePath.join(out(), helperAssetFor(hostPlatform).name)));
    const runtime = RECOVERY_HELPER_ASSETS.find(
      (asset) => asset.platform === hostPlatform && !asset.name.endsWith(".mjs"),
    )!;
    assert.equal(
      NodeFS.statSync(NodePath.join(out(), runtime.name)).size,
      NodeFS.statSync(process.execPath).size,
    );
  });

  it("rejects a bundle whose self-test fails, reports another protocol, or says nothing", () => {
    const build = (script: string) =>
      buildRecoveryHelper({
        sourceDir: source(),
        platform: hostPlatform,
        outDir: out(),
        bundler: bundling(script),
      });
    assert.match(
      build(selfTest('console.error("restore mismatch"); process.exit(1);'))[0]!,
      /self-test exited 1.*restore mismatch/s,
    );
    assert.match(
      build(selfTest('console.log("recovery-helper-protocol=2");'))[0]!,
      /did not report protocol 1/,
    );
    assert.match(build("// does nothing")[0]!, /did not report protocol 1/);
  });

  it("runs the self-test away from the source tree so an unbundled dependency cannot hide", () => {
    const sourceDir = source();
    const problems = buildRecoveryHelper({
      sourceDir,
      platform: hostPlatform,
      outDir: out(),
      bundler: bundling(
        selfTest(
          `require("fs").readFileSync(${JSON.stringify(NodePath.join(sourceDir, RECOVERY_HELPER_PACKAGE, RECOVERY_HELPER_ENTRY))}.replace("forkRecoveryHelper.ts","missing-sibling.ts"));`,
        ),
      ),
    });
    assert.match(problems[0]!, /self-test exited/);
  });

  it("reports a failing or empty bundler", () => {
    const failing: HelperBundler = () => {
      throw new Error("vp pack exited 1.");
    };
    assert.match(
      buildRecoveryHelper({
        sourceDir: source(),
        platform: hostPlatform,
        outDir: out(),
        bundler: failing,
      })[0]!,
      /Bundling the recovery helper failed: vp pack exited 1/,
    );
    const none: HelperBundler = () => {};
    assert.match(
      buildRecoveryHelper({
        sourceDir: source(),
        platform: hostPlatform,
        outDir: out(),
        bundler: none,
      })[0]!,
      /produced no/,
    );
    assert.match(
      buildRecoveryHelper({
        sourceDir: source(),
        platform: hostPlatform,
        outDir: out(),
        bundler: bundling(""),
      })[0]!,
      /produced no/,
    );
  });
});

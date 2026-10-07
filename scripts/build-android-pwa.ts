// @effect-diagnostics nodeBuiltinImport:off globalDate:off - APK build bootstrap invokes synchronous host tools before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { forkUpstreamIdentity } from "./lib/build-identity.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ANDROID_METADATA_FILE,
  androidBuildMetadata,
  parseBadging,
  planAndroidBuild,
  predecessorProblems,
  singleSignerDigest,
  verifyBuiltApk,
  type AndroidBuildKind,
} from "./lib/android-pwa-config.ts";

const platform = Effect.runSync(HostProcessPlatform);
if (platform === "win32") throw new Error("Build from WSL, Linux, or macOS with JDK 17.");
const { values } = NodeUtil.parseArgs({
  options: {
    keystore: { type: "string" },
    "password-file": { type: "string" },
    "key-alias": { type: "string", default: "t3-pwa" },
    "output-dir": { type: "string", default: "release/android-pwa" },
    "asset-name": { type: "string" },
    "version-name": { type: "string", default: "1.0" },
    "version-code": { type: "string" },
    kind: { type: "string", default: "normal" },
    "source-commit": { type: "string" },
    "source-dir": { type: "string" },
    "normal-version-code": { type: "string" },
    "expect-signer": { type: "string" },
    "allow-dirty": { type: "boolean", default: false },
  },
});

if (!values.keystore || !values["password-file"]) {
  throw new Error("Required: --keystore /private/signing.jks --password-file /private/password");
}
if (values.kind !== "normal" && values.kind !== "recovery")
  throw new Error("--kind must be normal or recovery.");
const kind: AndroidBuildKind = values.kind;
const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error("Set ANDROID_HOME to your Android SDK.");
const toCode = (name: string, raw: string | undefined) => {
  if (raw === undefined) return null;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer.`);
  return Number(raw);
};

const git = (dir: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// A normal build compiles this checkout; a recovery build recompiles the predecessor's checkout.
const sourceDir = values["source-dir"] ? NodePath.resolve(values["source-dir"]) : null;
const compileRoot = kind === "recovery" ? sourceDir : repo;
let sourceCommit = values["source-commit"] ?? null;
if (compileRoot !== null && NodeFS.existsSync(compileRoot)) {
  const head = git(compileRoot, "rev-parse", "HEAD");
  const dirty = git(compileRoot, "status", "--porcelain") !== "";
  if (sourceCommit !== null && sourceCommit !== head) {
    throw new Error(
      `The checkout at ${compileRoot} is at ${head}, not the requested source commit ${sourceCommit}.`,
    );
  }
  if (dirty) {
    if (!values["allow-dirty"] || kind === "recovery") {
      throw new Error(
        `${compileRoot} has uncommitted changes, so its APK would not match its commit. Commit them, or for a local build pass --allow-dirty (the APK is then stamped with an unknown source and gets no release metadata).`,
      );
    }
    sourceCommit = "unknown";
  } else sourceCommit ??= head;
} else if (kind === "recovery" && sourceDir !== null) {
  throw new Error(`--source-dir ${sourceDir} does not exist.`);
}

const plan = planAndroidBuild({
  kind,
  versionName: values["version-name"],
  versionCode: toCode("version-code", values["version-code"]),
  normalVersionCode: toCode("normal-version-code", values["normal-version-code"]),
  sourceCommit,
  sourceDir,
  repoRoot: repo,
  nowMs: Date.now(),
});
if (plan.recovery) {
  const problems = predecessorProblems((relative) => {
    const file = NodePath.join(plan.sourceDir, relative);
    return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null;
  });
  if (problems.length > 0) {
    throw new Error(
      `The predecessor cannot be a recovery build: ${problems.join("; ")}. Manual baseline guidance: install an updater-equipped normal build yourself first.`,
    );
  }
  if (!NodeFS.existsSync(NodePath.join(plan.sourceDir, "node_modules"))) {
    throw new Error(
      `Install dependencies in ${plan.sourceDir} (vp i) before building its recovery APK.`,
    );
  }
}

const android = NodePath.join(plan.sourceDir, "apps/android-pwa");
const provenance = forkUpstreamIdentity(
  NodeURL.pathToFileURL(NodePath.join(plan.sourceDir, "fork-upstream.json")),
);
// Stable recovery sources may have no recorded workflow counter. Do not label them
// with this release's counter; nightly predecessors carry theirs in their exact version.
const forkBuildNumber = Number(
  /-nightly\.\d{8}\.(\d+)$/.exec(plan.versionName)?.[1] ??
    (plan.recovery ? "0" : (process.env.ARCWRIGHT_BUILD_NUMBER ?? "0")),
);
if (!Number.isSafeInteger(forkBuildNumber) || forkBuildNumber < 0 || forkBuildNumber > 2147483647)
  throw new Error("Invalid Arcwright build number.");
const webAssets = NodePath.join(android, "app/build/generated/web-assets");
NodeChildProcess.execFileSync("vp", ["build", "--outDir", webAssets, "--emptyOutDir"], {
  cwd: NodePath.join(plan.sourceDir, "apps/web"),
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_ANDROID_PWA: "1",
    APP_VERSION: plan.versionName,
    APP_BUILD_COMMIT: plan.sourceCommit === "unknown" ? "" : plan.sourceCommit,
    ARCWRIGHT_BUILD_NUMBER: String(forkBuildNumber),
    T3CODE_WEB_SOURCEMAP: "0",
  },
});
NodeChildProcess.execFileSync(
  "./gradlew",
  [
    "--no-daemon",
    ":app:assembleRelease",
    ":app:lintRelease",
    "-PpwaPackage=com.devotek.t3code.pwa",
    `-PpwaVersionName=${plan.versionName}`,
    `-PpwaVersionCode=${plan.versionCode}`,
    `-PpwaSourceVersion=${plan.versionName}`,
    `-PpwaSourceCommit=${plan.sourceCommit}`,
    `-PpwaRecovery=${plan.recovery}`,
    `-PpwaForkBuildNumber=${forkBuildNumber}`,
  ],
  {
    cwd: android,
    stdio: "inherit",
    env: {
      ...process.env,
      T3_PWA_KEYSTORE: NodePath.resolve(values.keystore),
      T3_PWA_PASSWORD_FILE: NodePath.resolve(values["password-file"]),
      T3_PWA_KEY_ALIAS: values["key-alias"],
    },
  },
);
const apk = NodePath.join(android, "app/build/outputs/apk/release/app-release.apk");
const tools = NodeFS.readdirSync(NodePath.join(sdk, "build-tools"))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .at(-1);
if (!tools) throw new Error("Install Android SDK build-tools.");
const tool = (name: string) => NodePath.join(sdk, "build-tools", tools, name);
const signerSha256 = singleSignerDigest(
  NodeChildProcess.execFileSync(tool("apksigner"), ["verify", "--print-certs", apk], {
    encoding: "utf8",
  }),
);
if (values["expect-signer"] && values["expect-signer"].toLowerCase() !== signerSha256) {
  throw new Error("The APK is not signed with the expected release certificate.");
}
verifyBuiltApk(
  plan,
  parseBadging(
    NodeChildProcess.execFileSync(tool("aapt2"), ["dump", "badging", apk], { encoding: "utf8" }),
  ),
);

const output = NodePath.resolve(repo, values["output-dir"]);
const assetName = values["asset-name"] ?? "t3-code-pwa.apk";
NodeFS.mkdirSync(output, { recursive: true });
const bytes = NodeFS.readFileSync(apk);
NodeFS.writeFileSync(NodePath.join(output, assetName), bytes);
const log = (message: string) => Effect.runSync(Effect.log(message));
if (plan.emitsReleaseMetadata) {
  // One metadata file per output directory: the release workflow uploads each APK in its own directory.
  const metadata = androidBuildMetadata({
    plan,
    signerSha256,
    apkSha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    assetName,
    bytes: bytes.length,
  });
  NodeFS.writeFileSync(
    NodePath.join(output, ANDROID_METADATA_FILE),
    `${JSON.stringify({ ...metadata, ...provenance, ...(forkBuildNumber > 0 ? { forkBuildNumber } : {}) }, null, 2)}\n`,
  );
  log(
    `Wrote ${ANDROID_METADATA_FILE} for ${assetName} (${plan.kind}, code ${plan.versionCode}, source ${plan.sourceCommit}).`,
  );
} else {
  log("Local build of an unknown source: no release metadata was written.");
}
log(`Signed ${plan.kind} APK: ${NodePath.join(output, assetName)} (signer ${signerSha256})`);

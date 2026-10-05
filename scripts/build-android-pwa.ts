import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ANDROID_PWA_PACKAGE,
  androidAssetLinks,
  normalizePwaOrigin,
} from "./lib/android-pwa-config.ts";

const platform = Effect.runSync(HostProcessPlatform);
if (platform === "win32") throw new Error("Build from WSL, Linux, or macOS with JDK 17.");
const { values } = NodeUtil.parseArgs({
  options: {
    url: { type: "string" },
    keystore: { type: "string" },
    "password-file": { type: "string" },
    "key-alias": { type: "string", default: "t3-pwa" },
    "output-dir": { type: "string", default: "release/android-pwa" },
    "version-name": { type: "string", default: "1.0" },
    "version-code": { type: "string", default: String(Math.floor(Date.now() / 60_000)) },
  },
});

if (!values.url || !values.keystore || !values["password-file"]) {
  throw new Error(
    "Required: --url https://your-host/ --keystore /private/signing.jks --password-file /private/password",
  );
}
const origin = normalizePwaOrigin(values.url);
const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const android = NodePath.join(repo, "apps/android-pwa");
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error("Set ANDROID_HOME to your Android SDK.");
const versionCode = Number(values["version-code"]);
if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_147_483_647) {
  throw new Error("version-code must be a positive Android version code.");
}
NodeChildProcess.execFileSync(
  "./gradlew",
  [
    "--no-daemon",
    ":app:assembleRelease",
    ":app:lintRelease",
    `-PpwaUrl=${origin}`,
    `-PpwaPackage=${ANDROID_PWA_PACKAGE}`,
    `-PpwaVersionName=${values["version-name"]}`,
    `-PpwaVersionCode=${versionCode}`,
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
const cert = NodeChildProcess.execFileSync(
  NodePath.join(sdk, "build-tools", tools, "apksigner"),
  ["verify", "--print-certs", apk],
  { encoding: "utf8" },
);
const fingerprint = /certificate SHA-256 digest: ([a-fA-F0-9]+)/.exec(cert)?.[1];
if (!fingerprint) throw new Error("APK signer did not report a SHA-256 certificate.");
const output = NodePath.resolve(repo, values["output-dir"]);
NodeFS.mkdirSync(output, { recursive: true });
NodeFS.copyFileSync(apk, NodePath.join(output, "t3-code-pwa.apk"));
NodeFS.writeFileSync(
  NodePath.join(output, "assetlinks.json"),
  `${JSON.stringify(androidAssetLinks(ANDROID_PWA_PACKAGE, fingerprint), null, 2)}\n`,
);
console.log(`Signed APK: ${NodePath.join(output, "t3-code-pwa.apk")}`);
console.log(
  `Publish assetlinks.json at ${origin}.well-known/assetlinks.json to enable fullscreen verification.`,
);

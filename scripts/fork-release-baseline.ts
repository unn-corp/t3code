// @effect-diagnostics nodeBuiltinImport:off globalDate:off - baseline tooling hashes and copies real files.
// The baseline is the first updater-equipped build, installed by hand before any pipeline release
// exists. It is published under the tag `fork-baseline` (never `fork-v*`, so no device selects it)
// and gives the first release something real to update from and recover to.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { candidateDigest, sha256File } from "./fork-release-assets.ts";

export const BASELINE_TAG = "fork-baseline";
export const BASELINE_MANIFEST_ASSET = "fork-baseline.json";

export interface BaselineAsset {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: "desktop" | "server" | "android";
  readonly platform: "windows-x64" | "linux-x64" | "android";
}

export interface BaselineManifest {
  readonly format: 1;
  readonly version: string;
  /** Full commit the baseline was built from; the first release rebuilds it as its recovery APK. */
  readonly commit: string;
  readonly updaterProtocol: 1;
  readonly android: {
    readonly asset: string;
    readonly versionCode: number;
    readonly signerSha256: string;
  };
  readonly assets: ReadonlyArray<BaselineAsset>;
  readonly recordedAt: string;
}

const isHex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);

export const parseBaselineManifest = (raw: unknown): BaselineManifest => {
  const value = raw as Partial<BaselineManifest> | null;
  const assets = value?.assets;
  if (
    !value ||
    value.format !== 1 ||
    typeof value.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.version) ||
    !isHex(value.commit, 40) ||
    value.updaterProtocol !== 1 ||
    typeof value.recordedAt !== "string" ||
    !value.android ||
    typeof value.android.asset !== "string" ||
    !Number.isInteger(value.android.versionCode) ||
    !isHex(value.android.signerSha256, 64) ||
    !Array.isArray(assets) ||
    !assets.every(
      (asset) =>
        typeof asset?.name === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(asset.name) &&
        isHex(asset.sha256, 64) &&
        Number.isInteger(asset.bytes) &&
        asset.bytes > 0,
    )
  ) {
    throw new Error("fork-baseline.json does not match format 1.");
  }
  return value as BaselineManifest;
};

/** Files the update and recovery validations start from; each must be present exactly once. */
export const baselineAssetNames = (version: string) => ({
  windowsInstaller: `T3-Code-${version}-x64.exe`,
  linuxAppImage: `T3-Code-${version}-x86_64.AppImage`,
  linuxDeb: `T3-Code-${version}-amd64.deb`,
  linuxServer: `t3-${version}-linux-x64.tar.gz`,
  apk: `t3-code-android-${version}.apk`,
});

export const verifyBaselineManifest = (manifest: BaselineManifest): string[] => {
  const problems: string[] = [];
  const names = baselineAssetNames(manifest.version);
  const have = new Map(manifest.assets.map((asset) => [asset.name, asset]));
  for (const [label, name] of Object.entries(names)) {
    if (!have.has(name)) problems.push(`The baseline has no ${label} (${name}).`);
  }
  if (manifest.android.asset !== names.apk)
    problems.push("The baseline's Android asset is not the canonical APK name.");
  if (have.size !== manifest.assets.length) problems.push("The baseline lists an asset twice.");
  return problems;
};

/** Compares a directory with the manifest it carries: nothing missing, extra, resized, or altered. */
export const verifyBaselinePayload = (dir: string, manifest: BaselineManifest): string[] => {
  const problems = verifyBaselineManifest(manifest);
  const present = new Set(
    NodeFS.readdirSync(dir).filter((name) => NodeFS.statSync(NodePath.join(dir, name)).isFile()),
  );
  const listed = new Set(manifest.assets.map((asset) => asset.name));
  for (const asset of manifest.assets) {
    const file = NodePath.join(dir, asset.name);
    if (!present.has(asset.name)) {
      problems.push(`${asset.name}: missing.`);
    } else if (NodeFS.statSync(file).size !== asset.bytes) {
      problems.push(`${asset.name}: size differs from the baseline manifest.`);
    } else if (sha256File(file) !== asset.sha256) {
      problems.push(`${asset.name}: digest differs from the baseline manifest.`);
    }
  }
  for (const name of present) {
    if (name !== BASELINE_MANIFEST_ASSET && !listed.has(name))
      problems.push(`${name}: not in the baseline manifest.`);
  }
  return problems;
};

/** The digest update and recovery receipts record for the baseline they ran from. */
export const baselineDigest = (manifest: BaselineManifest): string =>
  candidateDigest(manifest.assets);

export interface BaselinePackInput {
  readonly outDir: string;
  readonly version: string;
  readonly commit: string;
  readonly windowsInstaller: string;
  readonly linuxAppImage: string;
  readonly linuxDeb: string;
  readonly linuxServer: string;
  readonly apk: string;
  readonly androidVersionCode: number;
  readonly signerSha256: string;
  readonly recordedAt: string;
}

/** Copies the baseline's files under their canonical names and writes fork-baseline.json. */
export const packBaseline = (input: BaselinePackInput): BaselineManifest => {
  const names = baselineAssetNames(input.version);
  NodeFS.mkdirSync(input.outDir, { recursive: true });
  const sources: ReadonlyArray<[string, string, BaselineAsset["kind"], BaselineAsset["platform"]]> =
    [
      [input.windowsInstaller, names.windowsInstaller, "desktop", "windows-x64"],
      [input.linuxAppImage, names.linuxAppImage, "desktop", "linux-x64"],
      [input.linuxDeb, names.linuxDeb, "desktop", "linux-x64"],
      [input.linuxServer, names.linuxServer, "server", "linux-x64"],
      [input.apk, names.apk, "android", "android"],
    ];
  const assets: BaselineAsset[] = sources.map(([source, name, kind, platform]) => {
    const target = NodePath.join(input.outDir, name);
    NodeFS.copyFileSync(source, target);
    return {
      name,
      sha256: sha256File(target),
      bytes: NodeFS.statSync(target).size,
      kind,
      platform,
    };
  });
  const manifest = parseBaselineManifest({
    format: 1,
    version: input.version,
    commit: input.commit,
    updaterProtocol: 1,
    android: {
      asset: names.apk,
      versionCode: input.androidVersionCode,
      signerSha256: input.signerSha256,
    },
    assets,
    recordedAt: input.recordedAt,
  });
  NodeFS.writeFileSync(
    NodePath.join(input.outDir, BASELINE_MANIFEST_ASSET),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
};

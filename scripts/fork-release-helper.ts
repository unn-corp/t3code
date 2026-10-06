// oxlint-disable t3code/no-global-process-runtime -- The release CLI packages and tests its own platform runtime.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - the helper build runs a bundler and the bundle's own self-test.
// Builds the recovery helper release assets from the coordinator's own implementation.
//
// The helper is the part of recovery that must survive the application directory being replaced,
// so it ships as a separate asset per platform and a device caches it outside that directory. Its
// logic is not written here: it is the coordinator's restore path in packages/shared, exposed by one
// entry module. This builder bundles that module with its dependencies inlined and refuses to
// produce an asset unless the bundle proves itself by running the coordinator's restore against
// a fixture home.
//
// Entry contract (owned by the coordinator, enforced here and in its required test file):
//   packages/shared/src/forkRecoveryHelper.ts
//   `node <bundle> --self-test`  snapshots a temporary home, changes it, restores the snapshot with
//   the coordinator's real restoreSnapshot, verifies the result, prints
//   `recovery-helper-protocol=1`, and exits 0. Any other outcome exits non-zero.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { HelperAssetSpec } from "./fork-release-assets.ts";

export const RECOVERY_HELPER_PACKAGE = "packages/shared";
export const RECOVERY_HELPER_ENTRY = "src/forkRecoveryHelper.ts";
export const RECOVERY_HELPER_PROTOCOL = 1;

/** A device caches the helper AND its verified Node runtime outside the replaced application. */
export const RECOVERY_HELPER_ASSETS: ReadonlyArray<HelperAssetSpec> = [
  { name: "t3-recovery-helper-linux-x64.mjs", platform: "linux-x64" },
  { name: "t3-recovery-helper-windows-x64.mjs", platform: "windows-x64" },
  { name: "t3-recovery-node-linux-x64", platform: "linux-x64" },
  { name: "t3-recovery-node-windows-x64.exe", platform: "windows-x64" },
];

export type HelperBundler = (input: {
  readonly packageDir: string;
  readonly entry: string;
  readonly outFile: string;
}) => void;

/** Bundles one entry with every dependency inlined, via a throwaway pack config in the package. */
export const bundleWithVitePlus: HelperBundler = ({ packageDir, entry, outFile }) => {
  const config = NodePath.join(packageDir, "vite.config.ts");
  if (NodeFS.existsSync(config))
    throw new Error(`${config} already exists; the helper build will not overwrite it.`);
  const outDir = NodePath.dirname(outFile);
  NodeFS.mkdirSync(outDir, { recursive: true });
  NodeFS.writeFileSync(
    config,
    `import { defineConfig } from "vite-plus";
export default defineConfig({
  pack: {
    entry: { helper: ${JSON.stringify(entry)} },
    format: "esm",
    platform: "node",
    outDir: ${JSON.stringify(outDir)},
    dts: false,
    clean: true,
    sourcemap: false,
    deps: { alwaysBundle: () => true, onlyBundle: false },
  },
});
`,
  );
  try {
    const result = NodeChildProcess.spawnSync("vp", ["pack"], {
      cwd: packageDir,
      stdio: "inherit",
      shell: false,
    });
    if (result.status !== 0)
      throw new Error(`vp pack exited ${result.status ?? "without a status"}.`);
  } finally {
    NodeFS.rmSync(config, { force: true });
  }
  NodeFS.renameSync(NodePath.join(outDir, "helper.mjs"), outFile);
};

export const helperAssetFor = (platform: HelperAssetSpec["platform"]): HelperAssetSpec => {
  const asset = RECOVERY_HELPER_ASSETS.find(
    (entry) => entry.platform === platform && entry.name.endsWith(".mjs"),
  );
  if (!asset) throw new Error(`No recovery helper asset is defined for ${platform}.`);
  return asset;
};

/** Returns the reasons the helper could not be produced; empty means `outDir` holds the verified asset. */
export const buildRecoveryHelper = (input: {
  readonly sourceDir: string;
  readonly platform: Exclude<HelperAssetSpec["platform"], "shared">;
  readonly outDir: string;
  readonly bundler?: HelperBundler;
}): string[] => {
  const packageDir = NodePath.join(input.sourceDir, RECOVERY_HELPER_PACKAGE);
  if (!NodeFS.existsSync(NodePath.join(packageDir, RECOVERY_HELPER_ENTRY))) {
    return [
      `The coordinator provides no recovery helper entry (${RECOVERY_HELPER_PACKAGE}/${RECOVERY_HELPER_ENTRY}), ` +
        "so no helper can be built and no release can be published.",
    ];
  }
  const asset = helperAssetFor(input.platform);
  const outFile = NodePath.join(input.outDir, asset.name);
  try {
    NodeFS.rmSync(input.outDir, { recursive: true, force: true });
    (input.bundler ?? bundleWithVitePlus)({ packageDir, entry: RECOVERY_HELPER_ENTRY, outFile });
  } catch (cause) {
    return [
      `Bundling the recovery helper failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    ];
  }
  if (!NodeFS.existsSync(outFile) || NodeFS.statSync(outFile).size === 0) {
    return [`The bundler produced no ${asset.name}.`];
  }
  const runtimeAsset = RECOVERY_HELPER_ASSETS.find(
    (entry) => entry.platform === input.platform && !entry.name.endsWith(".mjs"),
  )!;
  const runtimeFile = NodePath.join(input.outDir, runtimeAsset.name);
  const hostPlatform =
    process.platform === "win32"
      ? "windows-x64"
      : process.platform === "linux"
        ? "linux-x64"
        : null;
  if (input.platform !== hostPlatform || process.arch !== "x64")
    return ["The recovery runtime must be built on its matching x64 platform runner."];
  if (Number(process.versions.node.split(".")[0]) < 24)
    return ["The recovery runtime requires Node 24 or newer."];
  try {
    NodeFS.copyFileSync(process.execPath, runtimeFile, NodeFS.constants.COPYFILE_FICLONE);
    if (process.platform !== "win32") NodeFS.chmodSync(runtimeFile, 0o700);
  } catch (cause) {
    return [`Could not retain the recovery runtime: ${String(cause)}`];
  }
  // The self-test runs with the retained runtime, from a neutral directory, so an unbundled dependency cannot hide behind
  // the source tree's node_modules.
  const neutral = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(input.outDir), "helper-selftest-"),
  );
  try {
    const result = NodeChildProcess.spawnSync(runtimeFile, [outFile, "--self-test"], {
      cwd: neutral,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.status !== 0) {
      return [
        `The helper's self-test exited ${result.status ?? "without a status"}: ${result.stderr.slice(-1500)}`,
      ];
    }
    if (!result.stdout.includes(`recovery-helper-protocol=${RECOVERY_HELPER_PROTOCOL}`)) {
      return [`The helper's self-test did not report protocol ${RECOVERY_HELPER_PROTOCOL}.`];
    }
  } finally {
    NodeFS.rmSync(neutral, { recursive: true, force: true });
  }
  return [];
};

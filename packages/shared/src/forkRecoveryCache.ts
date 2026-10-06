/* oxlint-disable t3code/no-global-process-runtime -- node-only filesystem coordinator: the host platform is the point */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Caches the recovery helper and its own Node runtime OUTSIDE the application directory, so
 * recovery works when the app is replaced or broken and needs neither a system Node nor the
 * main Electron app. Both files are digest-checked against the release manifest, stored
 * owner-only (the runtime executable), proven by running the helper's self-test with the cached
 * runtime from a neutral directory, and only then recorded as the current recovery command.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import type { ForkReleaseManifest } from "@t3tools/contracts";
import { forkRecoveryAssetsFor, type ForkPlatformKey } from "./forkMaintenance.ts";
import { restrictWindowsAcl } from "./forkMaintenanceSnapshot.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
export const RECOVERY_HELPER_PROTOCOL_LINE = "recovery-helper-protocol=1";
const RETAINED_VERSIONS = 2;

const Command = Schema.Struct({
  protocol: Schema.Literal(1),
  version: Schema.String,
  platform: Schema.Literals(["linux-x64", "windows-x64"]),
  nodePath: Schema.String,
  helperPath: Schema.String,
  nodeSha256: Schema.String,
  helperSha256: Schema.String,
  installedAt: Schema.Number,
});
export type RecoveryCommand = typeof Command.Type;
const decodeCommand = Schema.decodeUnknownSync(Command);

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const isCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

async function privateDirectory(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await restrictWindowsAcl(directory);
  else await NodeFSP.chmod(directory, 0o700);
}
async function writeOwnerOnly(file: string, bytes: Uint8Array, executable: boolean) {
  const handle = await NodeFSP.open(file, "wx", executable ? 0o700 : 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await NodeFSP.chmod(file, executable ? 0o700 : 0o600);
}
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
}

/** Runs the cached runtime on the cached helper from a neutral directory and requires the protocol line. */
export async function selfTestRecoveryCommand(
  command: Pick<RecoveryCommand, "nodePath" | "helperPath">,
): Promise<void> {
  const neutral = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-recovery-proof-"));
  try {
    // A minimal environment: nothing from the app or a system Node may be relied on.
    const { stdout } = await run(command.nodePath, [command.helperPath, "--self-test"], {
      cwd: neutral,
      env: {
        PATH: "",
        ...(process.platform === "win32" && process.env.SystemRoot !== undefined
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
      timeout: 120_000,
      windowsHide: true,
    });
    if (!stdout.includes(RECOVERY_HELPER_PROTOCOL_LINE))
      throw new Error("The cached recovery runtime did not report the helper protocol.");
  } finally {
    await NodeFSP.rm(neutral, { recursive: true, force: true });
  }
}

/**
 * Downloads (through `fetchAsset`, which must read from the fork release origin), verifies, stores
 * and proves both recovery assets, then records them as current. Idempotent: an identical, already
 * proven version is reused. A failed proof leaves the previous recovery command untouched.
 */
export async function installRecoveryHelper(input: {
  readonly cacheDir: string;
  readonly manifest: ForkReleaseManifest;
  readonly platform: ForkPlatformKey;
  readonly fetchAsset: (assetName: string) => Promise<Uint8Array>;
}): Promise<RecoveryCommand> {
  const assets = forkRecoveryAssetsFor(input.manifest, input.platform);
  if (assets === null)
    throw new Error(
      "The release has no unambiguous recovery helper and runtime for this platform.",
    );
  await privateDirectory(input.cacheDir);
  const existing = await readRecoveryCommand(input.cacheDir).catch(() => null);
  if (
    existing !== null &&
    existing.version === input.manifest.version &&
    existing.helperSha256 === assets.helper.sha256 &&
    existing.nodeSha256 === assets.node.sha256
  )
    return existing;

  const versionDir = NodePath.join(input.cacheDir, input.manifest.version);
  const stagingDir = NodePath.join(
    input.cacheDir,
    `.staging-${NodeCrypto.randomUUID().slice(0, 8)}`,
  );
  await privateDirectory(stagingDir);
  try {
    const helperBytes = await input.fetchAsset(assets.helper.name);
    const nodeBytes = await input.fetchAsset(assets.node.name);
    // Digests detect corruption and a mismatched asset; they do not authenticate the origin.
    if (sha256(helperBytes) !== assets.helper.sha256)
      throw new Error(`${assets.helper.name} does not match the digest recorded in the release.`);
    if (sha256(nodeBytes) !== assets.node.sha256)
      throw new Error(`${assets.node.name} does not match the digest recorded in the release.`);
    await writeOwnerOnly(NodePath.join(stagingDir, assets.helper.name), helperBytes, false);
    await writeOwnerOnly(NodePath.join(stagingDir, assets.node.name), nodeBytes, true);
    await selfTestRecoveryCommand({
      nodePath: NodePath.join(stagingDir, assets.node.name),
      helperPath: NodePath.join(stagingDir, assets.helper.name),
    });
    await NodeFSP.rm(versionDir, { recursive: true, force: true });
    await NodeFSP.rename(stagingDir, versionDir);
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true });
    throw cause;
  }
  const command: RecoveryCommand = {
    protocol: 1,
    version: input.manifest.version,
    platform: input.platform,
    nodePath: NodePath.join(versionDir, assets.node.name),
    helperPath: NodePath.join(versionDir, assets.helper.name),
    nodeSha256: assets.node.sha256,
    helperSha256: assets.helper.sha256,
    installedAt: Date.now(),
  };
  // Re-prove from the final location: the rename must not have changed what runs.
  await selfTestRecoveryCommand(command);
  await NodeFSP.writeFile(NodePath.join(versionDir, "command.json"), JSON.stringify(command), {
    mode: 0o600,
  });
  await atomicJson(NodePath.join(input.cacheDir, "current.json"), command);
  await pruneRecoveryCache(input.cacheDir, command.version);
  return command;
}

/** The current recovery command, re-verified byte for byte. Throws when absent or altered: a broken helper is no helper. */
export async function readRecoveryCommand(cacheDir: string): Promise<RecoveryCommand> {
  const command = decodeCommand(
    JSON.parse(await NodeFSP.readFile(NodePath.join(cacheDir, "current.json"), "utf8")),
  );
  if (!NodePath.isAbsolute(command.nodePath) || !NodePath.isAbsolute(command.helperPath))
    throw new Error("The recovery command is not absolute.");
  const [node, helper] = await Promise.all([
    NodeFSP.readFile(command.nodePath),
    NodeFSP.readFile(command.helperPath),
  ]);
  if (sha256(node) !== command.nodeSha256 || sha256(helper) !== command.helperSha256)
    throw new Error("The cached recovery helper does not match its recorded digests.");
  if (process.platform !== "win32" && ((await NodeFSP.stat(command.nodePath)).mode & 0o111) === 0)
    throw new Error("The cached recovery runtime is not executable.");
  return command;
}

/** Whether recovery can run right now: cached, intact, and for the release this device is on. */
export async function recoveryReady(cacheDir: string): Promise<boolean> {
  try {
    await readRecoveryCommand(cacheDir);
    return true;
  } catch (cause) {
    if (isCode(cause, "ENOENT")) return false;
    return false;
  }
}

async function pruneRecoveryCache(cacheDir: string, current: string) {
  const entries = (await NodeFSP.readdir(cacheDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );
  const dated = await Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      mtime: (await NodeFSP.stat(NodePath.join(cacheDir, entry.name))).mtimeMs,
    })),
  );
  const keep = new Set([
    current,
    ...dated
      .filter((entry) => entry.name !== current)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, RETAINED_VERSIONS - 1)
      .map((entry) => entry.name),
  ]);
  for (const entry of dated)
    if (!keep.has(entry.name))
      await NodeFSP.rm(NodePath.join(cacheDir, entry.name), { recursive: true, force: true });
}

/** The argv a person (or the app's recovery entry) runs: always the cached absolute runtime. */
export const recoveryInvocation = (
  command: RecoveryCommand,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } => ({
  command: command.nodePath,
  args: [command.helperPath, ...args],
});

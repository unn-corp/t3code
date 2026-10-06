/* oxlint-disable t3code/no-global-process-runtime -- node-only filesystem coordinator: the host platform is the point */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off — restore points are copied, hashed and swapped on the real filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import { capacityShortfalls, type FilesystemCapacity } from "./forkMaintenanceAdmission.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);

/**
 * A restore point captures the whole state directory except rebuildable runtime
 * artifacts. An allowlist would silently miss new state (pairing, queues,
 * provider profiles), so exclusions are the explicit, reviewed part.
 */
export const SNAPSHOT_EXCLUDED = new Set([
  "logs",
  "server-runtime.json",
  "antigravity-tmp",
  "model-manifest.json",
]);
const isExcluded = (name: string) =>
  SNAPSHOT_EXCLUDED.has(name) || name.startsWith(".maintenance-");
const isDatabase = (name: string) => /\.(sqlite|sqlite3|db)$/.test(name);
const isDatabaseSidecar = (name: string) => /\.(sqlite|sqlite3|db)-(wal|shm|journal)$/.test(name);
export const DATABASE_FILES = ["statev2.sqlite", "state.sqlite"] as const;
export const RESTORE_POINT_DIRECTORY = "maintenance/restore-points";
const PREFIX = "tx-";

const Manifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  id: Schema.String,
  transactionId: Schema.String,
  kind: Schema.Literals(["restore-point", "rescue"]),
  createdAt: Schema.String,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, sha256: Schema.String, bytes: Schema.Number }),
  ),
});
export type SnapshotManifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownSync(Manifest);

const isCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

/** Restricts a directory to the current user. POSIX modes are set at creation; Windows needs an explicit ACL. */
export type RestrictAccess = (directory: string) => Promise<void>;
export const restrictWindowsAcl: RestrictAccess = async (directory) => {
  // Replace the DACL, including explicit grants left on an existing directory. chmod has no
  // ownership semantics on Windows, and adding a grant would leave other readers authorized.
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:T3_FORK_PRIVATE_DIRECTORY -AclObject $acl
`;
  await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, T3_FORK_PRIVATE_DIRECTORY: directory },
    },
  );
};
const restrictByPlatform: RestrictAccess = async (directory) => {
  if (process.platform === "win32") await restrictWindowsAcl(directory);
  else await NodeFSP.chmod(directory, 0o700);
};

const hashFile = async (file: string) => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** Regular files and directories only: symlinks and special files would let a restore write outside its target. */
async function filesBelow(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await NodeFSP.readdir(NodePath.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await filesBelow(root, child)));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`Restore points refuse symbolic links and special files: ${child}`);
  }
  return [...result].sort();
}
async function exists(target: string) {
  try {
    await NodeFSP.lstat(target);
    return true;
  } catch (cause) {
    if (isCode(cause, "ENOENT")) return false;
    throw cause;
  }
}
/** Copies a state tree. Databases go through SQLite's online backup so an idle live runtime is safe to copy. */
async function copyState(
  source: string,
  destination: string,
  restrict: RestrictAccess,
  top = true,
) {
  await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
  await restrict(destination);
  for (const entry of await NodeFSP.readdir(source, { withFileTypes: true })) {
    if (top && isExcluded(entry.name)) continue;
    if (isDatabaseSidecar(entry.name)) continue;
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    if (entry.isDirectory()) await copyState(from, to, restrict, false);
    else if (entry.isFile() && isDatabase(entry.name)) {
      const database = new NodeSqlite.DatabaseSync(from, { readOnly: true });
      try {
        await NodeSqlite.backup(database, to);
      } finally {
        database.close();
      }
      // The backup keeps the source's WAL mode, and merely opening such a file read-only
      // creates -shm/-wal sidecars. Rollback-journal mode keeps the copy a single file.
      const copy = new NodeSqlite.DatabaseSync(to);
      try {
        copy.exec("PRAGMA journal_mode = DELETE");
      } finally {
        copy.close();
      }
      if (process.platform !== "win32") await NodeFSP.chmod(to, 0o600);
    } else if (entry.isFile()) {
      await NodeFSP.copyFile(from, to);
      if (process.platform !== "win32") await NodeFSP.chmod(to, 0o600);
    } else if (entry.isSocket() || entry.isFIFO()) continue;
    else throw new Error(`Restore points refuse symbolic links and special files: ${entry.name}`);
  }
}
async function copyTree(source: string, destination: string, restrict: RestrictAccess) {
  const stat = await NodeFSP.lstat(source);
  if (stat.isDirectory()) {
    await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
    // A private copy that cannot be made private is not made at all.
    await restrict(destination);
    for (const name of await NodeFSP.readdir(source))
      await copyTree(NodePath.join(source, name), NodePath.join(destination, name), restrict);
  } else if (stat.isFile()) {
    await NodeFSP.copyFile(source, destination);
    if (process.platform !== "win32") await NodeFSP.chmod(destination, 0o600);
  } else throw new Error(`Restore points refuse symbolic links and special files: ${source}`);
}
async function sizeOf(target: string): Promise<number> {
  if (!(await exists(target))) return 0;
  const stat = await NodeFSP.lstat(target);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const name of await NodeFSP.readdir(target))
    total += await sizeOf(NodePath.join(target, name));
  return total;
}
function checkDatabase(file: string) {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    const rows = database.prepare("PRAGMA quick_check").all();
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok")
      throw new Error(`Database failed its integrity check: ${NodePath.basename(file)}`);
  } finally {
    database.close();
  }
}

export const stateDirectory = (home: string) => NodePath.join(home, "userdata");
export const restorePointsDirectory = (home: string) =>
  NodePath.join(home, ...RESTORE_POINT_DIRECTORY.split("/"));

/**
 * Restore swaps the literal `home/userdata` directory atomically. Following a
 * relocated symlink here would snapshot one tree, then replace the link itself
 * during restore; capacity would also be charged to the wrong filesystem.
 */
async function assertLocalStateDirectory(home: string, allowMissing = false): Promise<void> {
  const state = stateDirectory(home);
  let stat: NodeFS.Stats;
  try {
    stat = await NodeFSP.lstat(state);
  } catch (cause) {
    if (allowMissing && isCode(cause, "ENOENT")) return;
    throw cause;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("Automatic maintenance does not support relocated userdata directories.");
}

/** Bytes a restore point of this home adds, and the filesystem (by device identity) that must hold them. */
export async function snapshotRequirement(
  home: string,
): Promise<FilesystemCapacity & { readonly deviceId: string }> {
  await assertLocalStateDirectory(home);
  const state = stateDirectory(home);
  let bytes = 0;
  for (const name of await NodeFSP.readdir(state)) {
    // Database sidecars are folded into the database copy; count the WAL conservatively.
    if (!isExcluded(name)) bytes += await sizeOf(NodePath.join(state, name));
  }
  await NodeFSP.mkdir(restorePointsDirectory(home), { recursive: true, mode: 0o700 });
  const [stats, stat] = await Promise.all([
    NodeFSP.statfs(restorePointsDirectory(home)),
    NodeFSP.stat(restorePointsDirectory(home), { bigint: true }),
  ]);
  return {
    filesystem: home,
    deviceId: String(stat.dev),
    requiredAdditionalBytes: bytes,
    availableBytes: Number(stats.bavail) * Number(stats.bsize),
  };
}
export interface CapacityReserve {
  /** Recovery also writes a rescue copy of current data before restoring, doubling the peak. */
  readonly rescue?: boolean;
  /** Staged payloads and recovery assets written into each home's filesystem. */
  readonly artifactBytesByHome?: Readonly<Record<string, number>>;
}
/**
 * Capacity is aggregated per physical filesystem: two homes on one disk share one
 * pool and one safety margin, so checking each logical home alone would pass a
 * plan that cannot fit. Rechecked after quiescence because earlier checks race with writes.
 */
export async function assertCapacity(
  homes: ReadonlyArray<string>,
  reserve: CapacityReserve = {},
): Promise<void> {
  const pools = new Map<string, { names: string[]; required: number; available: number }>();
  for (const home of homes) {
    const requirement = await snapshotRequirement(home);
    const peak =
      requirement.requiredAdditionalBytes * (reserve.rescue === true ? 2 : 1) +
      (reserve.artifactBytesByHome?.[home] ?? 0);
    const pool = pools.get(requirement.deviceId) ?? {
      names: [],
      required: 0,
      available: requirement.availableBytes,
    };
    pool.names.push(home);
    pool.required += peak;
    // The same disk reports the same free space; take the smallest report to stay conservative.
    pool.available = Math.min(pool.available, requirement.availableBytes);
    pools.set(requirement.deviceId, pool);
  }
  const shortfalls = capacityShortfalls(
    [...pools.values()].map((pool) => ({
      filesystem: pool.names.join(" + "),
      requiredAdditionalBytes: pool.required,
      availableBytes: pool.available,
    })),
  );
  if (shortfalls.length > 0)
    throw new Error(`Not enough free space for restore points on: ${shortfalls.join(", ")}.`);
}

export interface SnapshotOptions {
  readonly kind?: "restore-point" | "rescue";
  readonly restrict?: RestrictAccess;
  readonly now?: () => Date;
}

/** Creates a verified, private restore point. The database uses SQLite's online backup so an idle live runtime is safe to copy. */
export async function createSnapshot(
  home: string,
  transactionId: string,
  options: SnapshotOptions = {},
): Promise<string> {
  const restrict = options.restrict ?? restrictByPlatform;
  const kind = options.kind ?? "restore-point";
  await assertLocalStateDirectory(home);
  const state = await NodeFSP.realpath(stateDirectory(home));
  const root = restorePointsDirectory(home);
  await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
  await restrict(root);
  const id = `${PREFIX}${transactionId}-${kind}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const destination = NodePath.join(root, id);
  await NodeFSP.mkdir(destination, { mode: 0o700 });
  try {
    await restrict(destination);
    const payload = NodePath.join(destination, "userdata");
    await NodeFSP.mkdir(payload, { mode: 0o700 });
    await copyState(state, payload, restrict);
    const files = [];
    for (const file of await filesBelow(payload)) {
      files.push({
        path: file,
        sha256: await hashFile(NodePath.join(payload, file)),
        bytes: (await NodeFSP.stat(NodePath.join(payload, file))).size,
      });
    }
    if (!files.some((file) => file.path === "statev2.sqlite"))
      throw new Error("The home has no database to protect.");
    const manifest: SnapshotManifest = {
      formatVersion: 1,
      id,
      transactionId,
      kind,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      files,
    };
    await NodeFSP.writeFile(
      NodePath.join(destination, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    // Verify before reporting: a restore point nobody checked is not a restore point.
    await verifySnapshot(home, id);
    return id;
  } catch (cause) {
    await NodeFSP.rm(destination, { recursive: true, force: true });
    throw cause;
  }
}

function resolvePoint(home: string, snapshotId: string) {
  if (!snapshotId.startsWith(PREFIX) || !/^[A-Za-z0-9._-]+$/.test(snapshotId))
    throw new Error("Invalid restore point identifier.");
  return NodePath.join(restorePointsDirectory(home), snapshotId);
}

/** Re-reads every byte against the manifest. Returns the verified manifest. */
export async function verifySnapshot(home: string, snapshotId: string): Promise<SnapshotManifest> {
  const directory = resolvePoint(home, snapshotId);
  const manifest = decodeManifest(
    JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "manifest.json"), "utf8")),
  );
  const payload = NodePath.join(directory, "userdata");
  const actual = await filesBelow(payload);
  const recorded = manifest.files.map((file) => file.path).sort();
  if (
    new Set(recorded).size !== recorded.length ||
    JSON.stringify(actual) !== JSON.stringify(recorded)
  )
    throw new Error("Restore point file list does not match its manifest.");
  for (const file of manifest.files) {
    if (
      file.path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
    )
      throw new Error("Unsupported restore point path.");
    const target = NodePath.join(payload, file.path);
    if (
      (await NodeFSP.stat(target)).size !== file.bytes ||
      (await hashFile(target)) !== file.sha256
    )
      throw new Error(`Restore point checksum mismatch: ${file.path}`);
  }
  for (const file of recorded)
    if (isDatabase(NodePath.basename(file))) checkDatabase(NodePath.join(payload, file));
  return manifest;
}

/**
 * Replaces the home's state with a verified restore point. The runtime must be
 * stopped. Safe to replay after a crash: the stage is rebuilt, and each rename
 * step recognises the result of the one before it.
 */
export async function restoreSnapshot(
  home: string,
  snapshotId: string,
  transactionId: string,
  restrict: RestrictAccess = restrictByPlatform,
): Promise<void> {
  // The state directory can be absent after a crash between the two swap renames.
  // In that replay case, the stage can still be atomically installed at its literal path.
  await assertLocalStateDirectory(home, true);
  const manifest = await verifySnapshot(home, snapshotId);
  const state = stateDirectory(home);
  const stage = NodePath.join(home, `.maintenance-stage-${safeSegment(transactionId)}`);
  const replaced = NodePath.join(home, `.maintenance-replaced-${safeSegment(transactionId)}`);
  await NodeFSP.rm(stage, { recursive: true, force: true });
  await copyTree(NodePath.join(resolvePoint(home, snapshotId), "userdata"), stage, restrict);
  // Rebuildable runtime artifacts (logs) survive the swap; everything else comes from the restore point.
  const staged = await filesBelow(stage);
  if (JSON.stringify(staged) !== JSON.stringify(manifest.files.map((file) => file.path).sort()))
    throw new Error("Restore stage does not match the restore point.");
  for (const file of manifest.files)
    if ((await hashFile(NodePath.join(stage, file.path))) !== file.sha256)
      throw new Error(`Restore stage checksum mismatch: ${file.path}`);
  // Keep what is being replaced until the swap completes. Logs and caches stay with the old directory.
  if (await exists(state)) {
    await NodeFSP.rm(replaced, { recursive: true, force: true });
    await NodeFSP.rename(state, replaced);
  }
  await NodeFSP.rename(stage, state);
  if (await exists(NodePath.join(replaced, "logs")))
    await NodeFSP.rename(NodePath.join(replaced, "logs"), NodePath.join(state, "logs")).catch(
      () => undefined,
    );
  await NodeFSP.rm(replaced, { recursive: true, force: true });
}
const safeSegment = (value: string) => {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("Invalid identifier.");
  return value;
};

export interface RestorePoint {
  readonly id: string;
  readonly transactionId: string;
  readonly kind: "restore-point" | "rescue";
  readonly createdAt: string;
  readonly bytes: number;
}
export async function listRestorePoints(home: string): Promise<ReadonlyArray<RestorePoint>> {
  const root = restorePointsDirectory(home);
  if (!(await exists(root))) return [];
  const points: RestorePoint[] = [];
  for (const name of await NodeFSP.readdir(root)) {
    if (!name.startsWith(PREFIX)) continue;
    try {
      const manifest = decodeManifest(
        JSON.parse(await NodeFSP.readFile(NodePath.join(root, name, "manifest.json"), "utf8")),
      );
      points.push({
        id: manifest.id,
        transactionId: manifest.transactionId,
        kind: manifest.kind,
        createdAt: manifest.createdAt,
        bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      });
    } catch {
      // An unreadable directory is not listed as usable; pruning never touches it either.
    }
  }
  return [...points].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
export async function discardSnapshot(home: string, snapshotId: string): Promise<void> {
  await NodeFSP.rm(resolvePoint(home, snapshotId), { recursive: true, force: true });
}

/**
 * Keeps the newest `keep` restore points of committed updates plus everything
 * pinned (referenced by a recovery option or an in-flight transaction).
 * Rescue copies are retained as long as the point they protect.
 */
export async function pruneRestorePoints(
  home: string,
  options: { readonly keep: number; readonly pinned: ReadonlySet<string> },
): Promise<ReadonlyArray<string>> {
  const points = (await listRestorePoints(home)).filter((point) => point.kind === "restore-point");
  const keepIds = new Set([
    ...points
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.keep)
      .map((point) => point.id),
    ...options.pinned,
  ]);
  const removed: string[] = [];
  for (const point of await listRestorePoints(home)) {
    if (keepIds.has(point.id)) continue;
    if (
      point.kind === "rescue" &&
      [...keepIds].some((id) => id.startsWith(`${PREFIX}${point.transactionId}-`))
    )
      continue;
    await discardSnapshot(home, point.id);
    removed.push(point.id);
  }
  return removed;
}

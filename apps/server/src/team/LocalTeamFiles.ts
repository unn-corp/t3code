import * as PubSub from "effect/PubSub";
import * as Deferred from "effect/Deferred";
// @effect-diagnostics nodeBuiltinImport:off - checkout installation and safe writes need native no-follow/exclusive file handles.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  TeamFileError,
  TeamFileEntry,
  TeamFileMutation,
  TEAM_TRANSFER_CHUNK,
  type LocalTeamFilesResult,
  LocalTeamFilesControl,
} from "@t3tools/contracts/teamFiles";
import type { TeamProjectConnection } from "./TeamProjectTransport.ts";
import type { LocalTeamLinkRow } from "./LocalTeamProjectStore.ts";
import {
  checkedRoot,
  checkoutBundle,
  contentHash,
  exportBundle,
  fileError,
  gitIdentity,
  hashFile,
  installCheckout,
  privatePath,
  restrictedGit,
  safeFile,
  readSafeHandle,
  sharedPath,
  withSharedParent,
  validateDestination,
} from "./TeamGit.ts";

const isTeamFileError = Schema.is(TeamFileError);
export const fileIO = <A>(work: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) => (isTeamFileError(error) ? error : fileError("unavailable")),
  });
const id = () => NodeCrypto.randomBytes(16).toString("hex");
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Schema.Array(TeamFileEntry)));
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(TeamFileEntry)));
const encodePaths = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodePaths = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeControl = Schema.encodeSync(Schema.fromJsonString(LocalTeamFilesControl));
const encodeMutation = Schema.encodeSync(Schema.fromJsonString(TeamFileMutation));
const decodeMutation = Schema.decodeUnknownSync(Schema.fromJsonString(TeamFileMutation));
const Conflict = Schema.Struct({
  local: Schema.NullOr(Schema.String),
  remote: Schema.NullOr(Schema.String),
  content: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(Schema.String),
  localExecutable: Schema.NullOr(Schema.Boolean),
  remoteExecutable: Schema.NullOr(Schema.Boolean),
  reason: Schema.optional(Schema.Literal("directory")),
});
const Conflicts = Schema.Record(Schema.String, Conflict);
const encodeConflicts = Schema.encodeSync(Schema.fromJsonString(Conflicts));
const decodeConflicts = Schema.decodeUnknownSync(Schema.fromJsonString(Conflicts));
type State = {
  link_id: string;
  branch: string;
  root_identity: string;
  status: LocalTeamFilesResult["status"];
  enabled: number;
  version: number;
  manifest_json: string;
  remote_json: string;
  included_json: string;
  pending_json: string | null;
  conflicts_json: string;
};

export const uploadRepository = Effect.fnUntraced(function* (
  connection: TeamProjectConnection,
  root: string,
  expected: string | null,
  selection?: { branch: string; commit: string | null },
) {
  const temp = yield* fileIO(() =>
    NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(root), ".t3-team-transfer-")),
  );
  return yield* Effect.acquireUseRelease(
    Effect.succeed(temp),
    (directory) =>
      Effect.gen(function* () {
        const bundle = NodePath.join(directory, "project.bundle");
        const metadata = yield* fileIO((signal) => exportBundle(root, bundle, signal));
        if (
          selection &&
          (metadata.branch !== selection.branch || metadata.commit !== selection.commit)
        )
          return yield* fileError("branch_changed");
        const existing = (yield* connection.repository({ action: "repository" })).repository;
        if (
          existing &&
          existing.commit === metadata.commit &&
          existing.branch === metadata.branch &&
          existing.hash === metadata.hash
        )
          return metadata;
        const uploadId = id();
        yield* Effect.addFinalizer(() =>
          connection
            .repository({ action: "abort", id: uploadId })
            .pipe(
              Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed({}) }),
              Effect.ignore,
            ),
        );
        yield* connection.repository({
          action: "begin",
          id: uploadId,
          branch: metadata.branch,
          commit: metadata.commit,
          expected,
          hash: metadata.hash,
          bytes: metadata.bytes,
        });
        for (let index = 0; index < Math.ceil(metadata.bytes / TEAM_TRANSFER_CHUNK); index++) {
          const data = yield* fileIO(async () => {
            const handle = await NodeFSP.open(bundle, "r");
            try {
              const bytes = Buffer.alloc(
                Math.min(TEAM_TRANSFER_CHUNK, metadata.bytes - index * TEAM_TRANSFER_CHUNK),
              );
              await handle.read(bytes, 0, bytes.length, index * TEAM_TRANSFER_CHUNK);
              return bytes.toString("base64");
            } finally {
              await handle.close();
            }
          });
          yield* connection.repository({ action: "upload", id: uploadId, index, data });
        }
        yield* connection.repository({ action: "finish", id: uploadId });
        return metadata;
      }),
    (directory) =>
      fileIO(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
  );
}, Effect.scoped);
export const downloadRepository = Effect.fnUntraced(function* (
  connection: TeamProjectConnection,
  bundle: string,
) {
  const repository = (yield* connection.repository({ action: "repository" })).repository;
  if (!repository) return yield* fileError("initializing");
  yield* fileIO(() => NodeFSP.writeFile(bundle, Buffer.alloc(0), { flag: "wx", mode: 0o600 }));
  for (let index = 0; index < Math.ceil(repository.bytes / TEAM_TRANSFER_CHUNK); index++) {
    const chunk = (yield* connection.repository({
      action: "download",
      hash: repository.hash,
      index,
    })).content;
    if (chunk === undefined) return yield* fileError("unavailable");
    yield* fileIO(() => NodeFSP.appendFile(bundle, Buffer.from(chunk, "base64")));
  }
  if ((yield* fileIO(() => hashFile(bundle))) !== repository.hash)
    return yield* fileError("invalid");
  return repository;
});
// Remove only empty directories through pinned parents, preserving any local child data.
async function removeEmptySharedDirectory(root: string, name: string, expectedIdentity?: string) {
  return withSharedParent(
    root,
    name,
    false,
    async (target) => {
      try {
        await NodeFSP.rmdir(target);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST") return false;
        if (code === "ENOENT") return true;
        throw error;
      }
    },
    expectedIdentity,
  );
}
async function pruneEmptySharedParents(root: string, name: string, expectedIdentity?: string) {
  const parts = sharedPath(name);
  for (let length = parts.length - 1; length > 0; length--)
    if (
      !(await removeEmptySharedDirectory(root, parts.slice(0, length).join("/"), expectedIdentity))
    )
      break;
}
async function sharedDirectory(root: string, name: string, expectedIdentity?: string) {
  return withSharedParent(
    root,
    name,
    false,
    async (target) => (await NodeFSP.lstat(target)).isDirectory(),
    expectedIdentity,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  });
}
async function localSharedFile(root: string, name: string, expectedIdentity?: string) {
  return safeFile(root, name, expectedIdentity).catch((error: NodeJS.ErrnoException) => {
    // A valid directory-to-file transition makes old indexed descendant paths absent.
    if (error.code === "ENOTDIR") return null;
    throw error;
  });
}

export const openCheckout = Effect.fnUntraced(function* (
  connection: TeamProjectConnection,
  destination: string,
) {
  const identity = yield* fileIO(() => validateDestination(destination));
  const directory = yield* fileIO(() =>
    NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(destination), ".t3-team-transfer-")),
  );
  return yield* Effect.acquireUseRelease(
    Effect.succeed(directory),
    (temp) =>
      Effect.gen(function* () {
        const bundle = NodePath.join(temp, "project.bundle");
        const repository = yield* downloadRepository(connection, bundle);
        const checkout = NodePath.join(temp, "checkout");
        yield* fileIO((signal) =>
          checkoutBundle(bundle, checkout, repository.branch, repository.commit, signal),
        );
        const manifest = (yield* connection.repository({ action: "manifest" })).manifest;
        if (!manifest) return yield* fileError("initializing");
        const committed = (yield* fileIO((signal) =>
          restrictedGit(checkout, ["ls-files", "-z"], signal),
        ))
          .toString()
          .split("\0")
          .filter(Boolean);
        for (const name of committed)
          if (!manifest.files.some((entry) => entry.path === name))
            yield* fileIO(async () => {
              await NodeFSP.unlink(NodePath.join(checkout, ...sharedPath(name)));
              await pruneEmptySharedParents(checkout, name);
            });
        for (const entry of manifest.files) {
          const content = (yield* connection.repository({ action: "read", hash: entry.hash }))
            .content;
          if (content === undefined || contentHash(Buffer.from(content, "base64")) !== entry.hash)
            return yield* fileError("invalid");
          yield* fileIO(async () => {
            const file = NodePath.join(checkout, ...sharedPath(entry.path));
            await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
            await NodeFSP.writeFile(file, Buffer.from(content, "base64"), {
              mode: entry.executable ? 0o755 : 0o644,
            });
            await NodeFSP.chmod(file, entry.executable ? 0o755 : 0o644);
          });
        }
        if (
          (yield* connection.repository({ action: "manifest" })).manifest?.version !==
          manifest.version
        )
          return yield* fileError("conflict");
        // A final authenticated call prevents a completed download from being installed after access changes.
        yield* connection.config;
        yield* fileIO(() => installCheckout(checkout, destination, identity));
        return repository;
      }),
    (temp) => fileIO(() => NodeFSP.rm(temp, { recursive: true, force: true })).pipe(Effect.ignore),
  );
});

/** Move the old inode aside before installing: concurrent writes stay recoverable in the retained backup. */
export async function applySharedFile(
  root: string,
  name: string,
  expected: string | null,
  content: Buffer | null,
  executable: boolean,
  expectedIdentity?: string,
  expectedExecutable?: boolean | null,
) {
  await withSharedParent(
    root,
    name,
    true,
    async (target, rootFd) => {
      const handle = await NodeFSP.open(
        target,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      let current: Awaited<ReturnType<typeof readSafeHandle>> | null = null;
      if (handle) {
        try {
          current = await readSafeHandle(handle);
        } finally {
          await handle.close();
        }
      }
      if (
        (current ? contentHash(current.bytes) : null) !== expected ||
        (expectedExecutable !== undefined && (current?.executable ?? null) !== expectedExecutable)
      )
        throw fileError("conflict");
      let retained: typeof current = null;
      if (current) {
        const backupRoot = `${rootFd}/.t3-team-sync`;
        await NodeFSP.mkdir(backupRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const backupHandle = await NodeFSP.open(
          backupRoot,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
        );
        try {
          const backupDirectory = `/proc/self/fd/${backupHandle.fd}`;
          if ((await NodeFSP.readdir(backupDirectory)).length >= 2048) throw fileError("limit");
          const backup = `${backupDirectory}/${id()}`;
          await NodeFSP.writeFile(`${backup}.path`, `${name}\n`, { flag: "wx", mode: 0o600 });
          await NodeFSP.rename(target, backup);
          const capturedHandle = await NodeFSP.open(
            backup,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
          );
          try {
            retained = await readSafeHandle(capturedHandle);
          } finally {
            await capturedHandle.close();
          }
          if (
            contentHash(retained.bytes) !== expected ||
            (expectedExecutable !== undefined && retained.executable !== expectedExecutable)
          ) {
            await NodeFSP.writeFile(target, retained.bytes, {
              flag: "wx",
              mode: retained.executable ? 0o755 : 0o644,
            }).catch(() => undefined);
            throw fileError("conflict");
          }
        } finally {
          await backupHandle.close();
        }
      }
      if (content) {
        try {
          const output = await NodeFSP.open(
            target,
            NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              NodeFS.constants.O_NOFOLLOW,
            executable ? 0o755 : 0o644,
          );
          try {
            await output.writeFile(content);
            await output.sync();
          } finally {
            await output.close();
          }
        } catch (error) {
          if (retained)
            await NodeFSP.writeFile(target, retained.bytes, {
              flag: "wx",
              mode: retained.executable ? 0o755 : 0o644,
            }).catch(() => undefined);
          throw error;
        }
      }
    },
    expectedIdentity,
  );
  if (content === null) await pruneEmptySharedParents(root, name, expectedIdentity);
}

export interface TeamFileWatcher {
  close(): void;
}
export const makeLocalTeamFiles = Effect.fnUntraced(function* (
  watcherFactory?: (root: string, changed: (filename?: string) => void) => TeamFileWatcher,
) {
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* Semaphore.make(1);
  const receipts = yield* PubSub.sliding<{
    linkId: string;
    status: LocalTeamFilesResult["status"];
  }>(64);
  const wakes = new Map<string, Queue.Queue<void>>();
  const stops = new Map<string, Deferred.Deferred<void>>();
  const row = (link: LocalTeamLinkRow) =>
    sql<State>`SELECT * FROM local_team_files WHERE link_id=${link.link_id}`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const describe = (state: State | undefined): LocalTeamFilesResult => ({
    status: state?.status ?? "disabled",
    ...(state
      ? {
          branch: state.branch,
          conflicts: Object.entries(decodeConflicts(state.conflicts_json)).map(([path, item]) => ({
            path,
            localHash: item.local,
            remoteHash: item.remote,
            localExecutable: item.localExecutable,
            remoteExecutable: item.remoteExecutable,
            ...(item.reason ? { reason: item.reason } : {}),
          })),
        }
      : {}),
    policy: "tracked-and-explicitly-included",
  });
  const state = (link: LocalTeamLinkRow) => row(link).pipe(Effect.map(describe));
  const ensure = Effect.fnUntraced(function* (link: LocalTeamLinkRow) {
    let value = yield* row(link);
    if (!value) {
      const identity = yield* fileIO((signal) => gitIdentity(link.workspace_root, signal));
      const rootIdentity = yield* fileIO(() => checkedRoot(link.workspace_root));
      yield* sql`INSERT INTO local_team_files(link_id,branch,root_identity,status) VALUES(${link.link_id},${identity.branch},${rootIdentity},'disabled')`;
      value = (yield* row(link))!;
    }
    return value;
  });
  const check = Effect.fnUntraced(function* (link: LocalTeamLinkRow, value: State) {
    if (
      yield* fileIO(() => checkedRoot(link.workspace_root)).pipe(
        Effect.map((identity) => identity !== value.root_identity),
      )
    )
      return yield* fileError("root_changed");
    const identity = yield* fileIO((signal) => gitIdentity(link.workspace_root, signal, false));
    if (identity.branch !== value.branch) return yield* fileError("branch_changed");
  });
  const flush = Effect.fnUntraced(function* (
    link: LocalTeamLinkRow,
    connection: TeamProjectConnection,
    localPaths?: ReadonlySet<string>,
  ) {
    const value = yield* row(link);
    if (!value || !value.enabled) return;
    yield* check(link, value);
    const manifest = (yield* connection.repository({ action: "manifest", since: value.version }))
      .manifest;
    if (!manifest || manifest.branch !== value.branch) return yield* fileError("branch_changed");
    // The remote request yielded; branch/root selection may have changed meanwhile.
    yield* check(link, value);
    const baseline = new Map(
      decodeManifest(value.manifest_json).map((entry) => [entry.path, entry]),
    );
    const remote = new Map(
      (manifest.reset ? [] : decodeManifest(value.remote_json)).map((entry) => [entry.path, entry]),
    );
    for (const name of manifest.removed) remote.delete(name);
    for (const entry of manifest.files) remote.set(entry.path, entry);
    const conflicts = { ...decodeConflicts(value.conflicts_json) };
    const included = new Set(decodePaths(value.included_json));
    const tracked = yield* fileIO(async (signal) =>
      (await restrictedGit(link.workspace_root, ["ls-files", "-z"], signal))
        .toString()
        .split("\0")
        .filter(Boolean),
    );
    if (tracked.length + remote.size > 20000) return yield* fileError("limit");
    const trackedNames = new Set(tracked);
    const selected = new Set([...trackedNames, ...included, ...baseline.keys(), ...remote.keys()]);
    let pending = value.pending_json ? decodeMutation(value.pending_json) : null;
    if (pending) {
      yield* check(link, value);
      const receipt = (yield* connection.repository({ action: "mutate", mutation: pending }))
        .receipt;
      if (!receipt) return yield* fileError("unavailable");
      yield* check(link, value);
      if (receipt.status === "accepted")
        for (const change of pending.changes) {
          delete conflicts[change.path];
          if (change.content === null) baseline.delete(change.path);
          else {
            const bytes = Buffer.from(change.content, "base64");
            baseline.set(change.path, {
              path: change.path,
              hash: contentHash(bytes),
              size: bytes.length,
              executable: change.executable,
            });
          }
        }
      const pendingId = pending.id;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (receipt.status === "accepted")
            yield* sql`UPDATE local_team_file_resolutions SET completed=1 WHERE id=${pendingId} AND link_id=${link.link_id}`;
          yield* sql`UPDATE local_team_files SET status='syncing',pending_json=NULL,manifest_json=${encodeManifest([...baseline.values()])},conflicts_json=${encodeConflicts(conflicts)} WHERE link_id=${link.link_id}`;
        }),
      );
      pending = null;
      // Reload after a lost ACK: this call may have advanced the remote manifest.
      return;
    }
    // Existing baseline files leave the namespace before new paths enter, for local
    // tracked transformations as well as remote atomic directory/file replacements.
    const ordered = [...selected].sort(
      (left, right) => Number(baseline.has(right)) - Number(baseline.has(left)),
    );
    const directoryConflicts = new Set(
      Object.entries(conflicts)
        .filter(([, conflict]) => conflict.reason === "directory")
        .map(([path]) => path),
    );
    for (const name of ordered) {
      if (!(yield* row(link))?.enabled) return;
      if (privatePath(name)) continue;
      if (
        localPaths &&
        !localPaths.has(name) &&
        baseline.get(name)?.hash === remote.get(name)?.hash &&
        baseline.get(name)?.executable === remote.get(name)?.executable
      )
        continue;
      let blockedAncestor = false;
      for (let slash = name.indexOf("/"); slash >= 0; slash = name.indexOf("/", slash + 1)) {
        if (directoryConflicts.has(name.slice(0, slash))) {
          blockedAncestor = true;
          break;
        }
      }
      if (blockedAncestor) continue;
      let directoryAsMissingFile = false;
      if (yield* fileIO(() => sharedDirectory(link.workspace_root, name, value.root_identity))) {
        // Stale index entries can now name valid directories rather than working files.
        if (!baseline.has(name) && !remote.has(name)) continue;
        const before = baseline.get(name);
        const theirs = remote.get(name);
        // The local old file was removed to make a directory. Publish its checked
        // deletion without deleting that directory or publishing its untracked children.
        directoryAsMissingFile =
          link.role !== "viewer" &&
          before !== undefined &&
          theirs !== undefined &&
          before.hash === theirs.hash &&
          before.executable === theirs.executable;
        if (!directoryAsMissingFile) yield* check(link, value);
        if (
          !directoryAsMissingFile &&
          !(yield* fileIO(() =>
            removeEmptySharedDirectory(link.workspace_root, name, value.root_identity),
          ))
        ) {
          const theirs = remote.get(name);
          conflicts[name] = {
            local: null,
            remote: theirs?.hash ?? null,
            localExecutable: null,
            remoteExecutable: theirs?.executable ?? null,
            content: theirs
              ? ((yield* connection.repository({ action: "read", hash: theirs.hash })).content ??
                null)
              : null,
            receipt: null,
            reason: "directory",
          };
          directoryConflicts.add(name);
          continue;
        }
      }
      if (conflicts[name]?.reason === "directory") {
        delete conflicts[name];
        directoryConflicts.delete(name);
      }
      const local = directoryAsMissingFile
        ? null
        : yield* fileIO(() => localSharedFile(link.workspace_root, name, value.root_identity));
      const bytes = local?.bytes ?? null;
      const localHash = bytes ? contentHash(bytes) : null;
      const localExecutable = local?.executable ?? null;
      const before = baseline.get(name)?.hash ?? null;
      const theirs = remote.get(name);
      const remoteHash = theirs?.hash ?? null;
      const remoteExecutable = theirs?.executable ?? null;
      const beforeExecutable = baseline.get(name)?.executable ?? null;
      if (localHash === remoteHash && localExecutable === remoteExecutable) {
        if (theirs) baseline.set(name, theirs);
        else baseline.delete(name);
        delete conflicts[name];
        continue;
      }
      if (conflicts[name]) {
        conflicts[name] = {
          ...conflicts[name],
          local: localHash,
          remote: remoteHash,
          localExecutable,
          remoteExecutable,
        };
        continue;
      }
      if (
        localHash === before &&
        localExecutable === beforeExecutable &&
        (remoteHash !== before || remoteExecutable !== beforeExecutable)
      ) {
        const content = theirs
          ? (yield* connection.repository({ action: "read", hash: theirs.hash })).content
          : null;
        if (theirs && content === undefined) return yield* fileError("unavailable");
        if (!(yield* row(link))?.enabled) return;
        yield* check(link, value);
        const applied = yield* fileIO(() =>
          applySharedFile(
            link.workspace_root,
            name,
            localHash,
            content ? Buffer.from(content, "base64") : theirs ? Buffer.alloc(0) : null,
            theirs?.executable ?? false,
            value.root_identity,
            localExecutable,
          ),
        ).pipe(Effect.result);
        if (applied._tag === "Failure")
          conflicts[name] = {
            local: localHash,
            remote: remoteHash,
            localExecutable,
            remoteExecutable,
            content: content ?? null,
            receipt: null,
          };
        else {
          if (theirs) baseline.set(name, theirs);
          else baseline.delete(name);
        }
      } else if (
        remoteHash === before &&
        remoteExecutable === beforeExecutable &&
        link.role !== "viewer" &&
        (trackedNames.has(name) || included.has(name) || baseline.has(name))
      ) {
        const ignored = yield* fileIO((signal) =>
          restrictedGit(
            link.workspace_root,
            ["check-ignore", "--no-index", "--quiet", "--", name],
            signal,
          ).then(
            () => true,
            () => false,
          ),
        );
        if (ignored && !trackedNames.has(name) && !included.has(name)) continue;
        const change = {
          path: name,
          expected: remoteHash,
          expectedExecutable: remoteExecutable,
          content: bytes?.toString("base64") ?? null,
          executable: localExecutable ?? false,
        };
        const outgoing: TeamFileMutation = { id: id(), changes: [change] };
        yield* check(link, value);
        yield* sql`UPDATE local_team_files SET pending_json=${encodeMutation(outgoing)} WHERE link_id=${link.link_id}`;
        yield* check(link, value);
        const receipt = (yield* connection.repository({ action: "mutate", mutation: outgoing }))
          .receipt;
        if (!receipt) return yield* fileError("unavailable");
        yield* check(link, value);
        if (receipt.status === "conflict")
          conflicts[name] = {
            local: localHash,
            remote: remoteHash,
            localExecutable,
            remoteExecutable,
            content: null,
            receipt: receipt.id,
          };
        else if (bytes)
          baseline.set(name, {
            path: name,
            hash: localHash!,
            size: bytes.length,
            executable: change.executable,
          });
        else baseline.delete(name);
        yield* sql`UPDATE local_team_files SET pending_json=NULL,manifest_json=${encodeManifest([...baseline.values()])},conflicts_json=${encodeConflicts(conflicts)} WHERE link_id=${link.link_id}`;
      } else {
        const content = theirs
          ? (yield* connection.repository({ action: "read", hash: theirs.hash })).content
          : null;
        conflicts[name] = {
          local: localHash,
          remote: remoteHash,
          localExecutable,
          remoteExecutable,
          content: content ?? null,
          receipt: null,
        };
      }
    }
    yield* check(link, value);
    yield* sql`UPDATE local_team_files SET status=${Object.keys(conflicts).length ? "conflict" : "synchronized"},version=${manifest.version},remote_json=${encodeManifest([...remote.values()])},manifest_json=${encodeManifest([...baseline.values()])},conflicts_json=${encodeConflicts(conflicts)} WHERE link_id=${link.link_id}`;
    yield* PubSub.publish(receipts, {
      linkId: link.link_id,
      status: Object.keys(conflicts).length ? ("conflict" as const) : ("synchronized" as const),
    });
  });
  const reconcile = (
    link: LocalTeamLinkRow,
    connection: TeamProjectConnection,
    localPaths?: ReadonlySet<string>,
  ) =>
    gate
      .withPermits(1)(flush(link, connection, localPaths))
      .pipe(
        Effect.tapError((error) =>
          sql`UPDATE local_team_files SET status=${isTeamFileError(error) ? (error.reason === "branch_changed" ? "branch-changed" : error.reason === "root_changed" ? "root-changed" : error.reason === "access" ? "access-lost" : "offline") : "offline"} WHERE link_id=${link.link_id} AND enabled=1`.pipe(
            Effect.ignore,
          ),
        ),
      );
  const disable = Effect.fnUntraced(function* (link: LocalTeamLinkRow) {
    yield* sql`UPDATE local_team_files SET enabled=0,status='disabled' WHERE link_id=${link.link_id}`;
    const stop = stops.get(link.link_id);
    if (stop) yield* Deferred.succeed(stop, undefined);
    const wake = wakes.get(link.link_id);
    if (wake) yield* Queue.offer(wake, undefined);
    return yield* state(link);
  });
  const run = Effect.fnUntraced(function* (
    link: LocalTeamLinkRow,
    connection: TeamProjectConnection,
  ) {
    const wake = yield* Queue.sliding<void>(1);
    wakes.set(link.link_id, wake);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        wakes.delete(link.link_id);
        stops.delete(link.link_id);
      }),
    );
    while (true) {
      if (!(yield* row(link))?.enabled) {
        yield* Queue.take(wake);
        continue;
      }
      const stop = yield* Deferred.make<void>();
      stops.set(link.link_id, stop);
      yield* Effect.scoped(
        Effect.gen(function* () {
          let full = true;
          const dirty = new Set<string>();
          const changed = (filename?: string) => {
            if (
              filename &&
              (filename.startsWith(".t3-team-sync/") || filename.startsWith(".git/objects/"))
            )
              return;
            if (!filename || filename.startsWith(".git/") || dirty.size >= 10000) full = true;
            else dirty.add(filename);
            Queue.offerUnsafe(wake, undefined);
          };
          const watcher = yield* fileIO(() =>
            Promise.resolve(
              watcherFactory
                ? watcherFactory(link.workspace_root, changed)
                : NodeFS.watch(link.workspace_root, { recursive: true }, (_event, filename) =>
                    changed(filename ?? undefined),
                  ).on("error", () => changed()),
            ),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()));
          yield* connection.files.pipe(
            Stream.runForEach(() => Queue.offer(wake, undefined)),
            Effect.forkScoped,
          );
          while (true) {
            const localPaths = full ? undefined : new Set(dirty);
            full = false;
            dirty.clear();
            yield* reconcile(link, connection, localPaths).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  full = true;
                  const paused =
                    isTeamFileError(error) &&
                    ["branch_changed", "root_changed", "access"].includes(error.reason);
                  if (paused)
                    yield* sql`UPDATE local_team_files SET enabled=0 WHERE link_id=${link.link_id}`;
                  const status: LocalTeamFilesResult["status"] = isTeamFileError(error)
                    ? error.reason === "branch_changed"
                      ? "branch-changed"
                      : error.reason === "root_changed"
                        ? "root-changed"
                        : error.reason === "access"
                          ? "access-lost"
                          : "offline"
                    : "offline";
                  // Notify observers before racing the stop signal cancels this scope.
                  yield* PubSub.publish(receipts, { linkId: link.link_id, status });
                  if (paused) yield* Deferred.succeed(stop, undefined);
                }),
              ),
            );
            yield* Queue.take(wake).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () =>
                  Effect.sync(() => {
                    full = true;
                  }),
              }),
            );
            yield* Effect.sleep("100 millis");
          }
        }).pipe(
          Effect.raceFirst(Deferred.await(stop)),
          Effect.catch(() =>
            Effect.gen(function* () {
              yield* sql`UPDATE local_team_files SET status='offline' WHERE link_id=${link.link_id} AND enabled=1`;
              yield* Queue.take(wake).pipe(
                Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.void }),
              );
            }),
          ),
        ),
      );
    }
  });
  const control = Effect.fnUntraced(function* (
    link: LocalTeamLinkRow,
    connection: TeamProjectConnection,
    command: Exclude<LocalTeamFilesControl, { action: "preview" | "share" | "create" | "open" }>,
  ) {
    const resolutionId =
      command.action === "resolve"
        ? contentHash(`${link.link_id}:${encodeControl(command)}`).slice(0, 32)
        : null;
    const resolution = resolutionId
      ? (yield* sql<{
          completed: number;
        }>`SELECT completed FROM local_team_file_resolutions WHERE id=${resolutionId} AND link_id=${link.link_id}`)[0]
      : undefined;
    if (resolution?.completed) return yield* state(link);
    let value = yield* ensure(link);
    if (value.pending_json) {
      yield* flush(link, connection);
      value = (yield* row(link))!;
      if (
        resolutionId &&
        (yield* sql<{
          completed: number;
        }>`SELECT completed FROM local_team_file_resolutions WHERE id=${resolutionId}`)[0]
          ?.completed
      ) {
        yield* flush(link, connection);
        return yield* state(link);
      }
    }
    if (command.action === "disable") return yield* disable(link);
    yield* check(link, value);
    if (command.action === "enable") {
      const manifest = (yield* connection.repository({ action: "manifest" })).manifest;
      if (!manifest) return yield* fileError("initializing");
      yield* check(link, value);
      // Baseline starts at the shared tree. Existing local changes require an explicit decision.
      const conflicts: Record<string, typeof Conflict.Type> = {};
      for (const entry of manifest.files) {
        const directory = yield* fileIO(() =>
          sharedDirectory(link.workspace_root, entry.path, value.root_identity),
        );
        const local = directory
          ? null
          : yield* fileIO(() =>
              localSharedFile(link.workspace_root, entry.path, value.root_identity),
            );
        const localHash = local ? contentHash(local.bytes) : null;
        const localExecutable = local?.executable ?? null;
        if (localHash !== entry.hash || localExecutable !== entry.executable)
          conflicts[entry.path] = {
            local: localHash,
            remote: entry.hash,
            localExecutable,
            remoteExecutable: entry.executable,
            content:
              (yield* connection.repository({ action: "read", hash: entry.hash })).content ?? null,
            receipt: null,
            ...(directory ? { reason: "directory" as const } : {}),
          };
      }
      yield* sql`UPDATE local_team_files SET enabled=1,status='syncing',version=${manifest.version},remote_json=${encodeManifest(manifest.files)},manifest_json=${encodeManifest(manifest.files)},conflicts_json=${encodeConflicts(conflicts)} WHERE link_id=${link.link_id}`;
    } else if (command.action === "include") {
      if (link.role === "viewer") return yield* fileError("access");
      for (const name of command.paths) if (privatePath(name)) return yield* fileError("invalid");
      yield* sql`UPDATE local_team_files SET included_json=${encodePaths([...new Set([...decodePaths(value.included_json), ...command.paths])])} WHERE link_id=${link.link_id}`;
    } else if (command.action === "resolve") {
      const conflicts = { ...decodeConflicts(value.conflicts_json) };
      if (!conflicts[command.path]) return yield* fileError("conflict");
      if (
        yield* fileIO(() => sharedDirectory(link.workspace_root, command.path, value.root_identity))
      ) {
        yield* check(link, value);
        if (
          !(yield* fileIO(() =>
            removeEmptySharedDirectory(link.workspace_root, command.path, value.root_identity),
          ))
        )
          return yield* fileError(
            "conflict",
            "A local directory still contains files at this shared path. Move those files before resolving the shared version.",
          );
      }
      const bytes =
        (yield* fileIO(() =>
          localSharedFile(link.workspace_root, command.path, value.root_identity),
        ))?.bytes ?? null;
      const localExecutable =
        (yield* fileIO(() =>
          localSharedFile(link.workspace_root, command.path, value.root_identity),
        ))?.executable ?? null;
      const alreadyApplied =
        resolution !== undefined &&
        command.choice === "remote" &&
        (bytes ? contentHash(bytes) : null) === command.expectedRemote &&
        localExecutable === command.expectedRemoteExecutable &&
        conflicts[command.path]!.local === command.expectedLocal;
      if (
        !alreadyApplied &&
        (localExecutable !== command.expectedLocalExecutable ||
          (bytes ? contentHash(bytes) : null) !== command.expectedLocal)
      )
        return yield* fileError("conflict");
      const manifest = (yield* connection.repository({ action: "manifest" })).manifest!;
      yield* check(link, value);
      const theirs = manifest.files.find((entry) => entry.path === command.path);
      if (
        (theirs?.hash ?? null) !== command.expectedRemote ||
        (theirs?.executable ?? null) !== command.expectedRemoteExecutable
      )
        return yield* fileError("conflict");
      yield* sql`INSERT OR IGNORE INTO local_team_file_resolutions(id,link_id) VALUES(${resolutionId!},${link.link_id})`;
      if (command.choice === "local") {
        if (link.role === "viewer") return yield* fileError("access");
        const outgoing: TeamFileMutation = {
          id: resolutionId!,
          changes: [
            {
              path: command.path,
              expected: command.expectedRemote,
              expectedExecutable: theirs?.executable ?? null,
              content: bytes?.toString("base64") ?? null,
              executable: localExecutable ?? false,
            },
          ],
          ...(conflicts[command.path]!.receipt
            ? { resolve: conflicts[command.path]!.receipt! }
            : {}),
        };
        yield* check(link, value);
        yield* sql`UPDATE local_team_files SET pending_json=${encodeMutation(outgoing)} WHERE link_id=${link.link_id}`;
        yield* check(link, value);
        const receipt = (yield* connection.repository({ action: "mutate", mutation: outgoing }))
          .receipt;
        if (receipt?.status !== "accepted") return yield* fileError("conflict");
      } else {
        const content = theirs
          ? (yield* connection.repository({ action: "read", hash: theirs.hash })).content
          : null;
        yield* check(link, value);
        if (!alreadyApplied)
          yield* fileIO(() =>
            applySharedFile(
              link.workspace_root,
              command.path,
              command.expectedLocal,
              content === null ? null : Buffer.from(content ?? "", "base64"),
              theirs?.executable ?? false,
              value.root_identity,
              command.expectedLocalExecutable,
            ),
          );
      }
      delete conflicts[command.path];
      const baseline = new Map(
        decodeManifest(value.manifest_json).map((entry) => [entry.path, entry]),
      );
      const after =
        command.choice === "local"
          ? bytes
          : theirs
            ? Buffer.from(
                (yield* connection.repository({ action: "read", hash: theirs.hash })).content ?? "",
                "base64",
              )
            : null;
      if (after)
        baseline.set(command.path, {
          path: command.path,
          hash: contentHash(after),
          size: after.length,
          executable:
            command.choice === "local" ? (localExecutable ?? false) : (theirs?.executable ?? false),
        });
      else baseline.delete(command.path);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE local_team_file_resolutions SET completed=1 WHERE id=${resolutionId!}`;
          yield* sql`UPDATE local_team_files SET pending_json=NULL,manifest_json=${encodeManifest([...baseline.values()])},conflicts_json=${encodeConflicts(conflicts)} WHERE link_id=${link.link_id}`;
        }),
      );
    } else if (command.action === "publish" || command.action === "initialize") {
      if (link.role === "viewer") return yield* fileError("access");
      const repository = (yield* connection.repository({ action: "repository" })).repository;
      if (!repository && command.action !== "initialize") return yield* fileError("initializing");
      yield* check(link, value);
      const identity = yield* fileIO((signal) => gitIdentity(link.workspace_root, signal, false));
      yield* Effect.scoped(
        uploadRepository(
          {
            ...connection,
            repository: (outgoing) =>
              outgoing.action === "abort"
                ? connection.repository(outgoing)
                : check(link, value).pipe(Effect.andThen(connection.repository(outgoing))),
          },
          link.workspace_root,
          repository?.commit ?? null,
          { branch: value.branch, commit: identity.commit },
        ),
      );
      if (!value.enabled)
        yield* sql`UPDATE local_team_files SET status='disabled' WHERE link_id=${link.link_id}`;
    } else if (command.action === "fetch") {
      const temp = yield* fileIO(() =>
        NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(link.workspace_root), ".t3-team-transfer-")),
      );
      yield* Effect.acquireUseRelease(
        Effect.succeed(temp),
        (directory) =>
          Effect.gen(function* () {
            const bundle = NodePath.join(directory, "project.bundle");
            const repository = yield* downloadRepository(connection, bundle);
            yield* check(link, value);
            if (repository.commit)
              yield* fileIO((signal) =>
                restrictedGit(
                  link.workspace_root,
                  [
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    bundle,
                    `refs/heads/${repository.branch}:refs/teams/${link.link_id}`,
                  ],
                  signal,
                ),
              );
          }),
        (directory) =>
          fileIO(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
      );
    }
    if (command.action !== "state") yield* flush(link, connection);
    const wake = wakes.get(link.link_id);
    if (wake) yield* Queue.offer(wake, undefined);
    return yield* state(link);
  }, gate.withPermits(1));
  const initializing = (link: LocalTeamLinkRow) =>
    ensure(link).pipe(
      Effect.andThen(
        sql`UPDATE local_team_files SET status='initializing' WHERE link_id=${link.link_id}`,
      ),
    );
  const initialized = (link: LocalTeamLinkRow) =>
    sql`UPDATE local_team_files SET status='disabled' WHERE link_id=${link.link_id} AND enabled=0`;
  return {
    state,
    control,
    run,
    reconcile,
    disable,
    initializing,
    initialized,
    receipts: Stream.fromPubSub(receipts),
  };
});

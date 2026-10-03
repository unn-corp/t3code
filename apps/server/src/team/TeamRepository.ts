import type * as Semaphore from "effect/Semaphore";
import * as Clock from "effect/Clock";
// @effect-diagnostics nodeBuiltinImport:off - immutable bundle chunks use native bounded file handles.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  TeamRepositoryCommand,
  TeamRepositoryResult,
  TeamFileError,
  TEAM_BUNDLE_BYTES,
  TEAM_FILE_BYTES,
  TEAM_TRANSFER_CHUNK,
  type TeamFileManifest,
  TeamFileMutation,
  type TeamFileReceipt,
} from "@t3tools/contracts/teamFiles";
import { TeamDenied, type TeamSpaces } from "./TeamSpaces.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  contentHash,
  fileError,
  hashFile,
  privatePath,
  restrictedGit,
  verifyBundle,
  validateSharedTree,
  TEAM_TREE_METADATA_BYTES,
} from "./TeamGit.ts";

const isTeamFileError = Schema.is(TeamFileError);

/** Retained content blobs. A mutation that adds nothing stays allowed so cleanup can shrink an over-limit repository. */
export const TEAM_BLOB_LIMIT = 50_000;

export const admitsNewBlobs = (existingCount: number, addedCount: number) =>
  addedCount === 0 || existingCount + addedCount <= TEAM_BLOB_LIMIT;
const decode = Schema.decodeUnknownEffect(TeamRepositoryCommand);
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(TeamRepositoryResult));
const io = <A>(work: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) => (isTeamFileError(error) ? error : fileError("unavailable")),
  });
const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isTeamFileError(error)
        ? error
        : error instanceof TeamDenied
          ? fileError("access")
          : fileError("unavailable"),
    ),
    Effect.withTracerEnabled(false),
  );
type Upload = { id: string; actor: string; metadata_json: string; completed: number };

type Repository = NonNullable<TeamRepositoryResult["repository"]>;
type FileRow = { path: string; hash: string; size: number; executable: number };

const encodeCommand = Schema.encodeSync(Schema.fromJsonString(TeamRepositoryCommand));
const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(TeamRepositoryCommand));
const encodeMutation = Schema.encodeSync(Schema.fromJsonString(TeamFileMutation));
const decodeMutation = Schema.decodeUnknownSync(Schema.fromJsonString(TeamFileMutation));
const encodeResult = Schema.encodeSync(Schema.fromJsonString(TeamRepositoryResult));

export const makeTeamRepository = Effect.fnUntraced(function* (input: {
  transfers: Semaphore.Semaphore;
  spaceId: string;
  stateDir: string;
  subject: string;
  check: (write?: boolean) => Effect.Effect<unknown, TeamDenied | SqlError>;
  withAuthority: TeamSpaces["Service"]["withAuthority"];
  changes: PubSub.PubSub<number>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const root = NodePath.join(input.stateDir, "team-repositories", input.spaceId);
  yield* io(() => NodeFSP.mkdir(root, { recursive: true, mode: 0o700 }));
  const current = Effect.gen(function* () {
    const row = (yield* sql<{
      version: number;
      repository_json: string | null;
    }>`SELECT * FROM team_file_state WHERE singleton=1`)[0]!;
    return {
      version: row.version,
      repository: row.repository_json ? decodeResult(row.repository_json).repository : undefined,
    };
  });
  const manifest = (since?: number) =>
    Effect.gen(function* () {
      const state = yield* current;
      let reset =
        since === undefined || since > state.version || since < Math.max(0, state.version - 1000);
      let files = reset
        ? yield* sql<FileRow>`SELECT * FROM team_files ORDER BY path`
        : yield* sql<FileRow>`SELECT * FROM team_files WHERE path IN(SELECT path FROM team_file_events WHERE version>${since!}) ORDER BY path`;
      let removed = reset
        ? []
        : (yield* sql<{
            path: string;
          }>`SELECT DISTINCT path FROM team_file_events WHERE version>${since!} AND NOT EXISTS(SELECT 1 FROM team_files WHERE team_files.path=team_file_events.path)`).map(
            (entry) => entry.path,
          );
      // A long delta can include many removed names even when the current tree is small.
      // Fall back to the already bounded full manifest rather than exceed the socket budget.
      if (
        !reset &&
        files.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.path) * 2 + 192, 0) +
          removed.reduce((bytes, path) => bytes + Buffer.byteLength(path) * 2 + 4, 0) >
          TEAM_TREE_METADATA_BYTES
      ) {
        reset = true;
        files = yield* sql<FileRow>`SELECT * FROM team_files ORDER BY path`;
        removed = [];
      }
      return {
        version: state.version,
        reset,
        removed,
        branch: state.repository?.branch ?? null,
        commit: state.repository?.commit ?? null,
        files: files.map((entry) => ({ ...entry, executable: entry.executable === 1 })),
      } satisfies TeamFileManifest;
    });
  const ownerUpload = (id: string) =>
    Effect.gen(function* () {
      const row =
        (yield* sql<Upload>`SELECT * FROM team_git_uploads WHERE id=${id} AND actor=${input.subject}`)[0];
      if (!row) return yield* fileError("access");
      const metadata = yield* Effect.sync(() => decodeCommand(row.metadata_json));
      if (metadata.action !== "begin") return yield* fileError("invalid");
      return { row, metadata, directory: NodePath.join(root, `upload-${id}`) };
    });
  const mutation = Effect.fnUntraced(
    function* (value: TeamFileMutation) {
      yield* input.check(true);
      const digest = contentHash(encodeMutation(value));
      const prior = (yield* sql<{
        digest: string;
        actor: string;
        status: "accepted" | "conflict";
        version: number;
      }>`SELECT * FROM team_file_receipts WHERE id=${value.id}`)[0];
      if (prior) {
        if (prior.digest !== digest || prior.actor !== input.subject)
          return yield* fileError("conflict");
        return {
          receipt: {
            id: value.id,
            status: prior.status,
            version: prior.version,
            actor: prior.actor,
          },
        };
      }
      if (new Set(value.changes.map((change) => change.path)).size !== value.changes.length)
        return yield* fileError("invalid");
      const before = yield* current;
      if (!before.repository) return yield* fileError("initializing");
      let conflict = false;
      const contents: Array<{ hash: string; bytes: Buffer; content: string } | null> = [];
      for (const change of value.changes) {
        yield* io(async () => {
          if (privatePath(change.path)) throw fileError("invalid");
        });
        const existing = (yield* sql<{
          hash: string;
          executable: number;
        }>`SELECT hash,executable FROM team_files WHERE path=${change.path}`)[0];
        if (
          (existing?.hash ?? null) !== change.expected ||
          (existing ? existing.executable === 1 : null) !== change.expectedExecutable
        )
          conflict = true;
        const bytes = change.content === null ? null : Buffer.from(change.content, "base64");
        if (
          bytes &&
          (bytes.length > TEAM_FILE_BYTES || bytes.toString("base64") !== change.content)
        )
          return yield* fileError("limit");
        contents.push(bytes ? { bytes, hash: contentHash(bytes), content: change.content! } : null);
      }
      if (value.resolve) {
        const outstanding = (yield* sql<{
          actor: string;
          resolved: number;
        }>`SELECT actor,resolved FROM team_file_receipts WHERE id=${value.resolve} AND status='conflict'`)[0];
        if (!outstanding || outstanding.actor !== input.subject || outstanding.resolved)
          return yield* fileError("conflict");
      }
      const prospective = new Map(
        (yield* sql<FileRow>`SELECT * FROM team_files`).map((entry) => [entry.path, entry]),
      );
      for (const [index, change] of value.changes.entries()) {
        const content = contents[index];
        if (!content) prospective.delete(change.path);
        else
          prospective.set(change.path, {
            path: change.path,
            hash: content.hash,
            size: content.bytes.length,
            executable: change.executable ? 1 : 0,
          });
      }
      yield* io(async () => validateSharedTree([...prospective.values()]));
      const pendingBytes = (yield* sql<{
        bytes: number;
      }>`SELECT COALESCE(SUM(length(mutation_json)),0) AS bytes FROM team_file_receipts WHERE status='conflict' AND resolved=0`)[0]!
        .bytes;
      if (pendingBytes + encodeMutation(value).length > 64 * 1024 * 1024)
        return yield* fileError("limit");
      const usage = (yield* sql<{
        bytes: number;
        count: number;
      }>`SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS count FROM team_file_blobs`)[0]!;
      const seenHashes = new Set<string>();
      let addedBlobs = 0;
      for (const item of contents) {
        if (!item || seenHashes.has(item.hash)) continue;
        seenHashes.add(item.hash);
        const known = (yield* sql<{
          present: number;
        }>`SELECT 1 AS present FROM team_file_blobs WHERE hash=${item.hash} LIMIT 1`)[0];
        if (!known) addedBlobs++;
      }
      if (
        usage.bytes + contents.reduce((sum, item) => sum + (item?.bytes.length ?? 0), 0) >
          128 * 1024 * 1024 ||
        !admitsNewBlobs(usage.count, addedBlobs)
      )
        return yield* fileError("limit");
      const receipt: TeamFileReceipt = {
        id: value.id,
        status: conflict ? "conflict" : "accepted",
        version: before.version + (conflict ? 0 : 1),
        actor: input.subject,
      };
      if (!conflict) {
        for (const [index, change] of value.changes.entries()) {
          yield* sql`INSERT INTO team_file_events(version,path) VALUES(${receipt.version},${change.path})`;
          const content = contents[index];
          if (!content) yield* sql`DELETE FROM team_files WHERE path=${change.path}`;
          else {
            yield* sql`INSERT OR IGNORE INTO team_file_blobs(hash,content,size) VALUES(${content.hash},${content.content},${content.bytes.length})`;
            yield* sql`INSERT OR REPLACE INTO team_files(path,hash,size,executable) VALUES(${change.path},${content.hash},${content.bytes.length},${change.executable ? 1 : 0})`;
          }
        }
        yield* sql`UPDATE team_file_state SET version=${receipt.version} WHERE singleton=1`;
        yield* sql`DELETE FROM team_file_events WHERE version<=${receipt.version - 1000}`;
        if (value.resolve)
          yield* sql`UPDATE team_file_receipts SET resolved=1,mutation_json='{}' WHERE id=${value.resolve}`;
      }
      yield* sql`INSERT INTO team_file_receipts(id,digest,actor,status,version,mutation_json) VALUES(${value.id},${digest},${input.subject},${receipt.status},${receipt.version},${conflict ? encodeMutation(value) : "{}"})`;
      yield* sql`DELETE FROM team_file_blobs WHERE NOT EXISTS(SELECT 1 FROM team_files WHERE team_files.hash=team_file_blobs.hash)`;
      return { receipt };
    },
    sql.withTransaction,
    input.withAuthority,
    Effect.uninterruptible,
    safe,
  );
  const finish = Effect.fnUntraced(function* (id: string) {
    yield* input.check(true);
    const upload = yield* ownerUpload(id);
    const { metadata, directory } = upload;
    if (upload.row.completed)
      return {
        repository: {
          branch: metadata.branch,
          commit: metadata.commit,
          hash: metadata.hash,
          bytes: metadata.bytes,
        },
      };
    const attempt = NodePath.join(root, `verify-${NodeCrypto.randomBytes(16).toString("hex")}`);
    const bundle = `${attempt}.bundle`;
    return yield* Effect.acquireUseRelease(
      Effect.succeed(undefined),
      () =>
        Effect.gen(function* () {
          yield* io(async (signal) => {
            const output = await NodeFSP.open(bundle, "wx", 0o600);
            try {
              for (
                let index = 0;
                index < Math.ceil(metadata.bytes / TEAM_TRANSFER_CHUNK);
                index++
              ) {
                if (signal.aborted) throw fileError("unavailable");
                const chunk = await NodeFSP.readFile(NodePath.join(directory, String(index)));
                const expected = Math.min(
                  TEAM_TRANSFER_CHUNK,
                  metadata.bytes - index * TEAM_TRANSFER_CHUNK,
                );
                if (chunk.length !== expected) throw fileError("invalid");
                await output.write(chunk);
              }
              await output.sync();
            } finally {
              await output.close();
            }
            if ((await hashFile(bundle)) !== metadata.hash) throw fileError("invalid");
          });
          const files = yield* io((signal) =>
            verifyBundle(attempt, bundle, metadata.branch, metadata.commit, signal),
          );
          if (metadata.expected && metadata.commit)
            yield* io((signal) =>
              restrictedGit(
                attempt,
                ["merge-base", "--is-ancestor", metadata.expected!, metadata.commit!],
                signal,
              ),
            );
          // Expensive verification never holds the membership gate. Only durable publication does.
          return yield* Effect.gen(function* () {
            yield* input.check(true);
            const currentUpload = yield* ownerUpload(id);
            if (currentUpload.row.completed)
              return {
                repository: {
                  branch: metadata.branch,
                  commit: metadata.commit,
                  hash: metadata.hash,
                  bytes: metadata.bytes,
                },
              };
            const before = yield* current;
            if ((before.repository?.commit ?? null) !== metadata.expected)
              return yield* fileError("conflict");
            if (before.repository && before.repository.branch !== metadata.branch)
              return yield* fileError("branch_changed");
            const repository: Repository = {
              branch: metadata.branch,
              commit: metadata.commit,
              hash: metadata.hash,
              bytes: metadata.bytes,
            };
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const oldTree = new Map(
                  (yield* sql<FileRow>`SELECT * FROM team_git_files`).map((entry) => [
                    entry.path,
                    entry,
                  ]),
                );
                const working = new Map(
                  (yield* sql<FileRow>`SELECT * FROM team_files`).map((entry) => [
                    entry.path,
                    entry,
                  ]),
                );
                const incoming = new Map(files.map((entry) => [entry.path, entry]));
                const combined = new Map(working);
                const changed = new Set([...oldTree.keys(), ...incoming.keys()]);
                for (const name of changed) {
                  const old = oldTree.get(name);
                  const currentFile = working.get(name);
                  if (
                    (old?.hash ?? null) !== (currentFile?.hash ?? null) ||
                    old?.executable !== currentFile?.executable
                  )
                    continue;
                  const next = incoming.get(name);
                  if (next) combined.set(name, { ...next, executable: next.executable ? 1 : 0 });
                  else combined.delete(name);
                }
                // This must pass before either the Git pointer or live namespace is changed.
                yield* io(async () => validateSharedTree([...combined.values()]));
                // Validate first so a rejected overlay cannot accumulate retained bundles.
                // Installation still precedes the SQL pointer; a crash can leave an orphan,
                // never a pointer to a missing bundle.
                yield* io(async () => {
                  await NodeFSP.rename(bundle, NodePath.join(root, `${metadata.hash}.bundle`));
                });
                for (const name of changed) {
                  const old = oldTree.get(name);
                  const currentFile = working.get(name);
                  const next = incoming.get(name);
                  if (
                    (old?.hash ?? null) !== (currentFile?.hash ?? null) ||
                    old?.executable !== currentFile?.executable
                  )
                    continue;
                  yield* sql`INSERT INTO team_file_events(version,path) VALUES(${before.version + 1},${name})`;
                  if (!next) yield* sql`DELETE FROM team_files WHERE path=${name}`;
                  else {
                    yield* sql`INSERT OR IGNORE INTO team_file_blobs(hash,content,size) VALUES(${next.hash},${next.content},${next.size})`;
                    yield* sql`INSERT OR REPLACE INTO team_files(path,hash,size,executable) VALUES(${next.path},${next.hash},${next.size},${next.executable ? 1 : 0})`;
                  }
                }
                yield* sql`DELETE FROM team_git_files`;
                for (const entry of files)
                  yield* sql`INSERT INTO team_git_files(path,hash,size,executable) VALUES(${entry.path},${entry.hash},${entry.size},${entry.executable ? 1 : 0})`;
                yield* sql`DELETE FROM team_file_blobs WHERE NOT EXISTS(SELECT 1 FROM team_files WHERE team_files.hash=team_file_blobs.hash)`;
                yield* sql`UPDATE team_file_state SET repository_json=${encodeResult({ repository })},version=version+1 WHERE singleton=1`;
                yield* sql`UPDATE team_git_uploads SET completed=1 WHERE id=${id}`;
              }),
            );
            yield* io(async () => {
              await NodeFSP.rm(directory, { recursive: true, force: true });
              if (before.repository && before.repository.hash !== metadata.hash)
                await NodeFSP.rm(NodePath.join(root, `${before.repository.hash}.bundle`), {
                  force: true,
                });
            });
            yield* PubSub.publish(input.changes, before.version + 1);
            return { repository };
          }).pipe(input.withAuthority, Effect.uninterruptible);
        }),
      () =>
        io(async () => {
          await NodeFSP.rm(attempt, { recursive: true, force: true });
          await NodeFSP.rm(bundle, { force: true });
        }).pipe(Effect.ignore),
    );
  }, safe);
  const command = Effect.fnUntraced(function* (
    raw: TeamRepositoryCommand,
  ): Effect.fn.Return<TeamRepositoryResult, TeamFileError> {
    const value = yield* decode(raw).pipe(Effect.mapError(() => fileError("invalid")));
    yield* input
      .check(!["manifest", "read", "repository", "download", "conflicts"].includes(value.action))
      .pipe(safe);
    if (value.action === "finish") return yield* input.transfers.withPermits(1)(finish(value.id));
    if (value.action === "mutate") {
      const result = yield* mutation(value.mutation);
      if (result.receipt.status === "accepted")
        yield* PubSub.publish(input.changes, result.receipt.version);
      return result;
    }
    return yield* Effect.gen(function* () {
      yield* input.check(
        !["manifest", "read", "repository", "download", "conflicts"].includes(value.action),
      );
      switch (value.action) {
        case "manifest":
          return { manifest: yield* manifest(value.since) };
        case "repository":
          return { repository: (yield* current).repository };
        case "read": {
          const blob = (yield* sql<{
            content: string;
          }>`SELECT content FROM team_file_blobs WHERE hash=${value.hash} AND EXISTS(SELECT 1 FROM team_files WHERE hash=${value.hash})`)[0];
          if (!blob) return yield* fileError("invalid");
          return { content: blob.content };
        }
        case "conflicts": {
          const rows = yield* sql<{
            id: string;
            actor: string;
            version: number;
            mutation_json: string;
          }>`SELECT * FROM team_file_receipts WHERE status='conflict' AND resolved=0 AND actor=${input.subject} AND id>${value.after ?? ""} ORDER BY id LIMIT 2`;
          return {
            ...(rows.length > 1 ? { nextConflict: rows[0]!.id } : {}),
            conflicts: rows.slice(0, 1).map((row) => ({
              receipt: {
                id: row.id,
                actor: row.actor,
                status: "conflict" as const,
                version: row.version,
              },
              mutation: decodeMutation(row.mutation_json),
            })),
          };
        }
        case "abort": {
          const upload = yield* ownerUpload(value.id);
          if (!upload.row.completed) {
            yield* io(() => NodeFSP.rm(upload.directory, { recursive: true, force: true }));
            yield* sql`DELETE FROM team_git_uploads WHERE id=${value.id}`;
          }
          return {};
        }
        case "begin": {
          if (
            value.bytes > TEAM_BUNDLE_BYTES ||
            value.branch.startsWith("-") ||
            value.branch === "HEAD"
          )
            return yield* fileError("limit");
          const existing =
            (yield* sql<Upload>`SELECT * FROM team_git_uploads WHERE id=${value.id}`)[0];
          if (existing) {
            if (existing.actor !== input.subject || existing.metadata_json !== encodeCommand(value))
              return yield* fileError("conflict");
            return {};
          }
          const expiredBefore = (yield* Clock.currentTimeMillis) - 10 * 60 * 1000;
          const expired = yield* sql<{
            id: string;
          }>`SELECT id FROM team_git_uploads WHERE completed=0 AND created_at<${expiredBefore}`;
          for (const old of expired) {
            yield* io(() =>
              NodeFSP.rm(NodePath.join(root, `upload-${old.id}`), { recursive: true, force: true }),
            );
            yield* sql`DELETE FROM team_git_uploads WHERE id=${old.id}`;
          }
          const count = (yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM team_git_uploads WHERE completed=0`)[0]!.count;
          if (count >= 2) return yield* fileError("limit");
          yield* io(() =>
            NodeFSP.mkdir(NodePath.join(root, `upload-${value.id}`), {
              recursive: true,
              mode: 0o700,
            }),
          );
          yield* sql`INSERT INTO team_git_uploads(id,actor,metadata_json,created_at) VALUES(${value.id},${input.subject},${encodeCommand(value)},${yield* Clock.currentTimeMillis})`;
          return {};
        }
        case "upload": {
          const { metadata, directory, row } = yield* ownerUpload(value.id);
          if (row.completed) return {};
          const bytes = Buffer.from(value.data, "base64");
          if (
            bytes.toString("base64") !== value.data ||
            bytes.length !==
              Math.min(TEAM_TRANSFER_CHUNK, metadata.bytes - value.index * TEAM_TRANSFER_CHUNK) ||
            value.index >= Math.ceil(metadata.bytes / TEAM_TRANSFER_CHUNK)
          )
            return yield* fileError("limit");
          yield* io(async () => {
            const file = NodePath.join(directory, String(value.index));
            const old = await NodeFSP.readFile(file).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (old) {
              if (!old.equals(bytes)) throw fileError("conflict");
              return;
            }
            await NodeFSP.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
          });
          return {};
        }
        case "download": {
          const repository = (yield* current).repository;
          if (
            !repository ||
            repository.hash !== value.hash ||
            value.index * TEAM_TRANSFER_CHUNK >= repository.bytes
          )
            return yield* fileError("invalid");
          const content = yield* io(async () => {
            const handle = await NodeFSP.open(
              NodePath.join(root, `${repository.hash}.bundle`),
              "r",
            );
            try {
              const bytes = Buffer.alloc(
                Math.min(TEAM_TRANSFER_CHUNK, repository.bytes - value.index * TEAM_TRANSFER_CHUNK),
              );
              const read = await handle.read(
                bytes,
                0,
                bytes.length,
                value.index * TEAM_TRANSFER_CHUNK,
              );
              if (read.bytesRead !== bytes.length) throw fileError("unavailable");
              return bytes.toString("base64");
            } finally {
              await handle.close();
            }
          });
          return { content };
        }
      }
    }).pipe(input.withAuthority, safe);
  }, safe);
  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      yield* input.check();
      const queue = yield* PubSub.subscribe(input.changes);
      return Stream.concat(
        Stream.succeed((yield* current).version),
        Stream.fromSubscription(queue),
      ).pipe(Stream.mapEffect((version) => input.check().pipe(Effect.as(version), safe)));
    }).pipe(safe),
  );
  return { command, subscribe };
});

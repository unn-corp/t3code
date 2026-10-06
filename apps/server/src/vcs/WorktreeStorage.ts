// @effect-diagnostics nodeBuiltinImport:off - Node exposes mandatory reflinks; Effect's copy API permits ordinary copies.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { WorktreeStorageSupport } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";

export class WorktreeStorageError extends Schema.TaggedError<WorktreeStorageError>()(
  "WorktreeStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Worktree storage ${this.operation} failed.`;
  }
}

type Snapshot = { directory: string; tree: string; signature: string };
// A cache generation is immutable. Serialize restore/replace across driver instances,
// including the instances used by MCP and background tasks.
const cacheLocks = new Map<string, Semaphore.Semaphore>();

class WorktreeStorage extends Context.Service<
  WorktreeStorage,
  {
    readonly support: (destination?: string) => Effect.Effect<WorktreeStorageSupport>;
    readonly read: (
      repository: string,
      signature: string,
    ) => Effect.Effect<Snapshot | null, WorktreeStorageError>;
    readonly restore: (
      snapshot: Snapshot,
      destination: string,
    ) => Effect.Effect<void, WorktreeStorageError>;
    readonly capture: (
      repository: string,
      signature: string,
      tree: string,
      source: string,
      trackedPaths: readonly string[],
    ) => Effect.Effect<void, WorktreeStorageError>;
    readonly withLock: <A, E, R>(
      repository: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/vcs/WorktreeStorage") {}

export const make = Effect.gen(function* () {
  const { worktreesDir } = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcessPlatform;
  const cacheRoot = NodePath.join(worktreesDir, ".checkout-cache");
  const repositoryDirectory = (repository: string) =>
    NodePath.join(cacheRoot, NodeCrypto.createHash("sha256").update(repository).digest("hex"));
  const io = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new WorktreeStorageError({ operation, cause }),
    }).pipe(Effect.uninterruptible);
  const copy = (source: string, destination: string, trackedPaths?: readonly string[]) => {
    const entries = new Set(trackedPaths);
    const directories = new Set<string>();
    for (const entry of trackedPaths ?? []) {
      let parent = NodePath.dirname(entry);
      while (parent !== ".") {
        directories.add(parent);
        parent = NodePath.dirname(parent);
      }
    }
    return NodeFSP.cp(source, destination, {
      recursive: true,
      mode: NodeFS.constants.COPYFILE_FICLONE_FORCE,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (entry) => {
        const relative = NodePath.relative(source, entry);
        return (
          relative !== ".git" &&
          (trackedPaths === undefined ||
            relative === "" ||
            entries.has(relative) ||
            directories.has(relative))
        );
      },
    });
  };
  const support = (destination = worktreesDir) =>
    Effect.tryPromise({
      try: async (): Promise<WorktreeStorageSupport> => {
        if (platform !== "linux" && platform !== "darwin") {
          return {
            supported: false,
            reason:
              "Copy-on-write worktrees currently require Linux or macOS with a compatible filesystem.",
          };
        }
        await NodeFSP.mkdir(destination, { recursive: true });
        const probe = await NodeFSP.mkdtemp(NodePath.join(destination, ".reflink-probe-"));
        try {
          const source = NodePath.join(probe, "source");
          await NodeFSP.writeFile(source, Buffer.alloc(4096, 0x54));
          await NodeFSP.copyFile(
            source,
            NodePath.join(probe, "copy"),
            NodeFS.constants.COPYFILE_FICLONE_FORCE,
          );
          return { supported: true, reason: null };
        } finally {
          await NodeFSP.rm(probe, { recursive: true, force: true });
        }
      },
      catch: (cause) => new WorktreeStorageError({ operation: "probe", cause }),
    }).pipe(
      Effect.catch((error) => {
        const cause = error.cause;
        const code =
          typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
        return Effect.succeed<WorktreeStorageSupport>({
          supported: false,
          reason:
            code === "EACCES" || code === "EPERM"
              ? "T3 cannot write to the worktree folder to check copy-on-write support. Check its permissions."
              : code === "ENOSPC"
                ? "There is not enough free space to check copy-on-write support."
                : "The filesystem containing T3's worktree folder does not support copy-on-write file copies. Use a compatible filesystem such as Btrfs, reflink-enabled XFS, or APFS.",
        });
      }),
    );
  const read = (repository: string, signature: string) =>
    io("read", async () => {
      const root = repositoryDirectory(repository);
      let value: unknown;
      try {
        value = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "current.json"), "utf8"));
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return null;
        throw cause;
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("generation" in value) ||
        !("tree" in value) ||
        !("signature" in value) ||
        typeof value.generation !== "string" ||
        !/^[a-f0-9-]+$/.test(value.generation) ||
        typeof value.tree !== "string" ||
        !/^[a-f0-9]{40,64}$/.test(value.tree) ||
        value.signature !== signature
      )
        return null;
      return {
        directory: NodePath.join(root, value.generation, "files"),
        tree: value.tree,
        signature,
      };
    });
  const restore = (snapshot: Snapshot, destination: string) =>
    io("restore", () => copy(snapshot.directory, destination));
  const capture = (
    repository: string,
    signature: string,
    tree: string,
    source: string,
    trackedPaths: readonly string[],
  ) =>
    io("capture", async () => {
      const root = repositoryDirectory(repository);
      const generation = NodeCrypto.randomUUID();
      await NodeFSP.mkdir(root, { recursive: true });
      const staging = NodePath.join(root, generation);
      try {
        await copy(source, NodePath.join(staging, "files"), trackedPaths);
        const manifest = NodePath.join(root, `${generation}.json`);
        await NodeFSP.writeFile(manifest, JSON.stringify({ generation, tree, signature }));
        await NodeFSP.rename(manifest, NodePath.join(root, "current.json"));
      } catch (cause) {
        await NodeFSP.rm(staging, { recursive: true, force: true });
        throw cause;
      }
      // Retain one clean base per repository. Reflinks in live worktrees remain
      // valid when old cache generations are removed.
      for (const entry of await NodeFSP.readdir(root)) {
        if (entry !== generation && entry !== "current.json") {
          await NodeFSP.rm(NodePath.join(root, entry), { recursive: true, force: true });
        }
      }
    });
  return WorktreeStorage.of({
    support,
    read,
    restore,
    capture,
    withLock: (repository, effect) => {
      const key = repositoryDirectory(repository);
      let lock = cacheLocks.get(key);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        cacheLocks.set(key, lock);
      }
      return lock.withPermits(1)(effect);
    },
  });
});

import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeStorage from "./WorktreeStorage.ts";

const decodeManifest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      generation: Schema.String,
      tree: Schema.String,
      signature: Schema.String,
    }),
  ),
);

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-storage-test-" });
const testLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerSettings.layerTest({ spaceEfficientWorktrees: true })),
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);

describe("copy-on-write worktree storage", () => {
  it.effect(
    "measures ignored build output without following links or counting hardlinks twice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          const storage = yield* WorktreeStorage.make;
          const root = path.join(config.worktreesDir, "usage");
          yield* fs.makeDirectory(path.join(root, "build"), { recursive: true });
          yield* fs.writeFileString(path.join(root, "build", "output"), "A".repeat(65536));
          yield* fs.makeDirectory(path.join(root, ".git", "objects"), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, ".git", "objects", "shared"),
            "B".repeat(1048576),
          );
          yield* fs.writeFileString(path.join(config.worktreesDir, "outside"), "B".repeat(1048576));
          yield* Effect.promise(() =>
            NodeFSP.link(path.join(root, "build", "output"), path.join(root, "duplicate")),
          );
          yield* Effect.promise(() =>
            NodeFSP.symlink(path.join(config.worktreesDir, "outside"), path.join(root, "external")),
          );
          const usage = yield* storage
            .usage(root)
            .pipe(Effect.provideService(HostProcessPlatform, "darwin"));
          expect(usage).not.toBeNull();
          expect(usage?.measurement).toBe("allocated");
          expect(usage?.bytes).toBe(65536);
          expect(usage?.sharedBytes).toBeNull();
          // A second read is served from the cache, even if files change meanwhile.
          yield* fs.writeFileString(path.join(root, "new"), "new");
          expect(yield* storage.usage(root)).toEqual(usage);
          expect(yield* storage.usage(path.join(root, "missing"))).toBeNull();
        }).pipe(
          Effect.provide(configLayer),
          Effect.provide(NodeServices.layer),
          Effect.provideService(HostProcessPlatform, "darwin"),
        ),
      ),
  );

  it.effect("reports logical file size when allocation accounting is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const storage = yield* WorktreeStorage.make;
        const root = path.join(config.worktreesDir, "usage");
        yield* fs.makeDirectory(root, { recursive: true });
        yield* fs.writeFileString(path.join(root, "asset"), "12345");
        expect(yield* storage.usage(root)).toMatchObject({
          bytes: 5,
          measurement: "logical",
          sharedBytes: null,
        });
        expect(yield* storage.usage(path.join(root, "asset"))).toBeNull();
      }).pipe(
        Effect.provide(configLayer),
        Effect.provide(NodeServices.layer),
        Effect.provideService(HostProcessPlatform, "win32"),
      ),
    ),
  );

  it.effect("separates shared reflink data from exclusive worktree data on Btrfs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const storage = yield* WorktreeStorage.make;
        const root = path.join(config.worktreesDir, "usage");
        yield* fs.makeDirectory(root, { recursive: true });
        if (!(yield* storage.support()).supported) return;
        const source = path.join(config.worktreesDir, "asset");
        yield* fs.writeFileString(source, "A".repeat(65536));
        yield* Effect.promise(() =>
          NodeFSP.copyFile(
            source,
            path.join(root, "asset"),
            NodeFS.constants.COPYFILE_FICLONE_FORCE,
          ),
        );
        const usage = yield* storage.usage(root);
        // Platforms without btrfs-progs keep the explicitly labeled estimate.
        const filesystem = yield* Effect.promise(() => NodeFSP.statfs(root));
        if (
          (yield* HostProcessPlatform) === "linux" &&
          filesystem.type === 0x9123683e &&
          (yield* fs.exists("/usr/bin/btrfs"))
        ) {
          expect(usage?.measurement).toBe("exclusive");
        }
        if (usage?.measurement !== "exclusive") return;
        expect(usage.bytes).toBe(0);
        expect(usage.sharedBytes).toBeGreaterThanOrEqual(65536);
      }).pipe(Effect.provide(configLayer), Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("detects an incompatible filesystem even on Linux", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if ((yield* HostProcessPlatform) !== "linux" || !(yield* fs.exists("/dev/shm"))) return;
        const storage = yield* WorktreeStorage.make;
        const support = yield* storage.support("/dev/shm");
        expect(support.supported).toBe(false);
        expect(support.reason).toContain("filesystem");
      }).pipe(Effect.provide(configLayer), Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("reports an explanatory disabled state on unsupported platforms", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* WorktreeStorage.make;
        const support = yield* storage.support();
        expect(support.supported).toBe(false);
        expect(support.reason).toContain("Linux or macOS");
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provide(configLayer),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("caches only tracked files and keeps edits independent when replacing a base", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const storage = yield* WorktreeStorage.make;
        const support = yield* storage.support();
        if (!support.supported) return;
        const source = path.join(config.worktreesDir, "source");
        const destination = path.join(config.worktreesDir, "destination");
        yield* fs.makeDirectory(path.join(source, "assets"), { recursive: true });
        yield* fs.writeFileString(path.join(source, "assets", "model.bin"), "A".repeat(65536));
        yield* fs.writeFileString(path.join(source, ".env"), "private");
        yield* fs.writeFileString(path.join(source, ".git"), "private metadata");
        yield* storage.capture("repo", "signature", "a".repeat(40), source, ["assets/model.bin"]);
        const snapshot = yield* storage.read("repo", "signature");
        expect(snapshot).not.toBeNull();
        expect(yield* storage.read("repo", "other-signature")).toBeNull();
        if (snapshot === null) return;
        yield* storage.restore(snapshot, destination);
        expect(yield* fs.exists(path.join(destination, ".env"))).toBe(false);
        expect(yield* fs.exists(path.join(destination, ".git"))).toBe(false);
        yield* fs.writeFileString(path.join(destination, "assets", "model.bin"), "edited");
        expect(yield* fs.readFileString(path.join(source, "assets", "model.bin"))).toBe(
          "A".repeat(65536),
        );
        yield* storage.capture("repo", "signature", "b".repeat(40), source, ["assets/model.bin"]);
        expect(yield* fs.exists(snapshot.directory)).toBe(false);
        expect(yield* fs.readFileString(path.join(destination, "assets", "model.bin"))).toBe(
          "edited",
        );
      }).pipe(Effect.provide(configLayer), Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect(
    "creates clean worktrees across commits without copying dirty edits or deleted files",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          const storage = yield* WorktreeStorage.make;
          const supported = (yield* storage.support()).supported;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const warnings: string[] = [];
          const logger = Logger.make<unknown, void>(({ message }) =>
            warnings.push(String(message)),
          );
          const createWorktree = (...args: Parameters<typeof driver.createWorktree>) =>
            driver
              .createWorktree(...args)
              .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
          const repo = path.join(config.worktreesDir, "repository");
          yield* fs.makeDirectory(repo, { recursive: true });
          const git = (cwd: string, args: readonly string[]) =>
            driver.execute({ operation: "test.worktreeStorage", cwd, args });
          yield* git(repo, ["init"]);
          yield* git(repo, ["config", "user.name", "Test"]);
          yield* git(repo, ["config", "user.email", "test@example.com"]);
          yield* fs.writeFileString(path.join(repo, "asset.bin"), "A".repeat(65536));
          yield* fs.writeFileString(path.join(repo, "deleted.txt"), "remove me");
          yield* fs.writeFileString(path.join(repo, "changed.txt"), "old");
          yield* fs.writeFileString(path.join(repo, "run.sh"), "#!/bin/sh\necho okay\n");
          yield* fs.chmod(path.join(repo, "run.sh"), 0o755);
          yield* fs.symlink("changed.txt", path.join(repo, "link.txt"));
          yield* git(repo, ["add", "."]);
          yield* git(repo, ["commit", "-m", "base"]);
          const first = path.join(config.worktreesDir, "first");
          yield* createWorktree({
            cwd: repo,
            refName: "HEAD",
            newRefName: "first",
            path: first,
          });
          if (supported)
            expect(yield* fs.exists(path.join(config.worktreesDir, ".checkout-cache"))).toBe(true);
          yield* fs.remove(path.join(repo, "deleted.txt"));
          yield* fs.writeFileString(path.join(repo, "changed.txt"), "new");
          yield* fs.writeFileString(path.join(repo, "new\nfile.txt"), "newline path");
          yield* git(repo, ["add", "."]);
          yield* git(repo, ["commit", "-m", "next"]);
          yield* fs.writeFileString(path.join(repo, "asset.bin"), "dirty main");
          yield* fs.writeFileString(path.join(first, "asset.bin"), "dirty worktree");
          const second = path.join(config.worktreesDir, "second");
          yield* createWorktree({
            cwd: repo,
            refName: "HEAD",
            newRefName: "second",
            path: second,
          });
          expect(yield* fs.readFileString(path.join(second, "asset.bin"))).toBe("A".repeat(65536));
          expect(yield* fs.readFileString(path.join(second, "changed.txt"))).toBe("new");
          expect(yield* fs.readFileString(path.join(second, "new\nfile.txt"))).toBe("newline path");
          expect(yield* fs.exists(path.join(second, "deleted.txt"))).toBe(false);
          expect(yield* fs.readLink(path.join(second, "link.txt"))).toBe("changed.txt");
          expect((yield* fs.stat(path.join(second, "run.sh"))).mode & 0o111).toBe(0o111);
          expect((yield* git(second, ["status", "--porcelain"])).stdout).toBe("");
          expect(yield* fs.readFileString(path.join(first, "asset.bin"))).toBe("dirty worktree");
          expect(yield* fs.readFileString(path.join(repo, "asset.bin"))).toBe("dirty main");
          const third = path.join(config.worktreesDir, "third");
          yield* createWorktree({
            cwd: repo,
            refName: "HEAD",
            newRefName: "third",
            path: third,
          });
          expect((yield* git(third, ["status", "--porcelain"])).stdout).toBe("");
          if (supported) {
            expect(warnings).toEqual([]);
            const cacheRoot = path.join(config.worktreesDir, ".checkout-cache");
            const repositories = yield* fs.readDirectory(cacheRoot);
            const repositoryCache = path.join(cacheRoot, repositories[0]!);
            const manifest = decodeManifest(
              yield* fs.readFileString(path.join(repositoryCache, "current.json")),
            );
            yield* fs.writeFileString(
              path.join(repositoryCache, manifest.generation, "files", "asset.bin"),
              "corrupted cache",
            );
            const fourth = path.join(config.worktreesDir, "fourth");
            yield* createWorktree({
              cwd: repo,
              refName: "HEAD",
              newRefName: "fourth",
              path: fourth,
            });
            expect(yield* fs.readFileString(path.join(fourth, "asset.bin"))).toBe(
              "A".repeat(65536),
            );
            expect((yield* git(fourth, ["status", "--porcelain"])).stdout).toBe("");
            expect(
              warnings.some((warning) => warning.includes("Copy-on-write restore failed")),
            ).toBe(true);
          }
        }).pipe(Effect.provide(testLayer)),
      ),
  );
});

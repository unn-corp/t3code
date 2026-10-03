import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type { LocalTeamLinkRow } from "./LocalTeamProjectStore.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - synthetic Git/filesystem integration fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as EffectCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as EffectPath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { TeamSpaces } from "./TeamSpaces.ts";
import { TeamNativeProjects } from "./TeamNativeProjects.ts";
import {
  contentHash,
  fileError,
  restrictedGit,
  safeRead,
  sharedPath,
  withSharedParent,
  exportBundle,
  verifyBundle,
  preflightRepository,
  gitIdentity,
} from "./TeamGit.ts";
import {
  makeLocalTeamFiles,
  fileIO,
  uploadRepository,
  openCheckout,
  applySharedFile,
} from "./LocalTeamFiles.ts";
import { localTeamError, type TeamProjectConnection } from "./TeamProjectTransport.ts";

const basic = Layer.mergeAll(EffectCrypto.layer, NodeFileSystem.layer, EffectPath.layer);
const layers = TeamNativeProjects.layer.pipe(
  Layer.provideMerge(TeamSpaces.layer),
  Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        return makeSqlitePersistenceLive((yield* ServerConfig).dbPath);
      }),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest("/untrusted", { prefix: "t3-team-files-test-" })),
  Layer.provideMerge(basic),
);
const principal = {
  userId: "owner",
  displayName: "Owner",
  verifiedEmails: ["owner@example.test"],
  expiresAt: 1e12,
};
const setup = Effect.gen(function* () {
  const spaces = yield* TeamSpaces;
  const projects = yield* TeamNativeProjects;
  const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  const created = yield* spaces.execute(principal, { action: "create", name: "Test" }, true);
  const remote = yield* projects.connect(principal, created.spaceId, (subject) =>
    Effect.succeed({ subject, displayName: subject }),
  );
  const connection: TeamProjectConnection = {
    directory: remote.directory.pipe(Effect.mapError(() => localTeamError("access"))),
    presence: remote.presence,
    heartbeat: (focus) =>
      remote.heartbeat(focus).pipe(Effect.mapError(() => localTeamError("access"))),
    config: remote.wireConfig.pipe(Effect.mapError(() => localTeamError("access"))),
    repository: remote.repository.command,
    files: remote.repository.subscribe.pipe(Stream.scoped),
    register: remote.publications.register,
    publish: remote.publications.publish,
    discussion: () => Effect.die("unused"),
    shell: () => Stream.never,
    thread: () => Stream.never,
    snapshot: () => Effect.die("unused"),
  };
  const source = NodePath.join(root, "source");
  yield* fileIO(async (signal) => {
    await NodeFSP.mkdir(source);
    await restrictedGit(source, ["init", "--template=", "--initial-branch", "main"], signal);
    await NodeFSP.writeFile(NodePath.join(source, "README.md"), "base\n");
    await NodeFSP.writeFile(NodePath.join(source, ".gitignore"), ".env\nlocal-only.txt\n");
    await restrictedGit(source, ["add", "."], signal);
    await restrictedGit(
      source,
      [
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.test",
        "commit",
        "-m",
        "initial",
      ],
      signal,
    );
    await restrictedGit(
      source,
      ["remote", "add", "origin", "https://example.invalid/preserved.git"],
      signal,
    );
    await NodeFSP.writeFile(NodePath.join(source, ".env"), "SYNTHETIC_PRIVATE=not-real\n");
    await NodeFSP.writeFile(NodePath.join(source, "untracked.txt"), "private local file\n");
  });
  return { spaces, projects, root, source, remote, connection, spaceId: created.spaceId };
});
const randomId = () => NodeCrypto.randomBytes(16).toString("hex");
it.effect(
  "transfers only committed selected history, opens a real checkout and preserves source state",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const unrelated = yield* fileIO(async (signal) => {
        await restrictedGit(f.source, ["switch", "--orphan", "private-history"], signal);
        await NodeFSP.writeFile(NodePath.join(f.source, "private.txt"), "unrelated history");
        await restrictedGit(f.source, ["add", "private.txt"], signal);
        await restrictedGit(
          f.source,
          [
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.test",
            "commit",
            "-m",
            "unrelated",
          ],
          signal,
        );
        const commit = (await restrictedGit(f.source, ["rev-parse", "HEAD"], signal))
          .toString()
          .trim();
        await restrictedGit(f.source, ["switch", "main"], signal);
        return commit;
      });
      const indexBefore = yield* fileIO(() =>
        NodeFSP.readFile(NodePath.join(f.source, ".git/index")),
      );
      yield* fileIO(() => NodeFSP.writeFile(NodePath.join(f.source, "README.md"), "uncommitted\n"));
      const before = yield* fileIO(() =>
        restrictedGit(f.source, ["status", "--porcelain=v1", "-z"]),
      );
      const exported = yield* uploadRepository(f.connection, f.source, null);
      const destination = NodePath.join(f.root, "member");
      yield* openCheckout(f.connection, destination);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(destination, "README.md"), "utf8")),
      ).toBe("base\n");
      expect(
        yield* fileIO(() =>
          NodeFSP.stat(NodePath.join(destination, ".env")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
      expect(
        yield* fileIO(() =>
          NodeFSP.stat(NodePath.join(destination, "untracked.txt")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
      expect(
        (yield* fileIO(() => restrictedGit(destination, ["rev-parse", "HEAD"]))).toString().trim(),
      ).toBe(exported.commit);
      expect(
        (yield* fileIO(() => restrictedGit(destination, ["cat-file", "-e", unrelated])).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* fileIO(() => NodeFSP.readFile(NodePath.join(f.source, ".git/index")))).equals(
          indexBefore,
        ),
      ).toBe(true);
      expect(
        (yield* fileIO(() => restrictedGit(f.source, ["status", "--porcelain=v1", "-z"]))).equals(
          before,
        ),
      ).toBe(true);
      expect(
        (yield* fileIO(() => restrictedGit(f.source, ["remote", "get-url", "origin"])))
          .toString()
          .trim(),
      ).toBe("https://example.invalid/preserved.git");
      expect((yield* openCheckout(f.connection, destination).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "persists idempotent CAS receipts, conflicts, checked resolution and cross-project isolation",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* uploadRepository(f.connection, f.source, null);
      const first = {
        id: randomId(),
        changes: [
          {
            path: "README.md",
            expected: contentHash("base\n"),
            expectedExecutable: false,
            content: Buffer.from("first\n").toString("base64"),
            executable: false,
          },
        ],
      };
      const receipt = yield* f.remote.repository.command({ action: "mutate", mutation: first });
      expect(receipt.receipt?.status).toBe("accepted");
      const delta = (yield* f.connection.repository({ action: "manifest", since: 1 })).manifest!;
      expect(delta.reset).toBe(false);
      expect(delta.files.map((entry) => entry.path)).toEqual(["README.md"]);
      const restarted = yield* f.projects.connect(principal, f.spaceId, (subject) =>
        Effect.succeed({ subject, displayName: subject }),
      );
      expect(yield* restarted.repository.command({ action: "mutate", mutation: first })).toEqual(
        receipt,
      );
      const second = {
        ...first,
        id: randomId(),
        changes: [{ ...first.changes[0]!, content: Buffer.from("second\n").toString("base64") }],
      };
      expect(
        (yield* f.remote.repository.command({ action: "mutate", mutation: second })).receipt
          ?.status,
      ).toBe("conflict");
      const conflicts = (yield* f.remote.repository.command({ action: "conflicts" })).conflicts!;
      expect(conflicts[0]?.mutation.changes[0]?.content).toBe(second.changes[0]?.content);
      const resolved = {
        ...second,
        id: randomId(),
        resolve: second.id,
        changes: [{ ...second.changes[0]!, expected: contentHash("first\n") }],
      };
      expect(
        (yield* f.remote.repository.command({ action: "mutate", mutation: resolved })).receipt
          ?.status,
      ).toBe("accepted");
      expect((yield* f.remote.repository.command({ action: "conflicts" })).conflicts).toEqual([]);
      expect(
        (yield* f.remote.sql<{
          mutation_json: string;
          resolved: number;
        }>`SELECT mutation_json,resolved FROM team_file_receipts WHERE id=${second.id}`)[0],
      ).toEqual({ mutation_json: "{}", resolved: 1 });
      expect(
        (yield* f.remote.repository.command({ action: "mutate", mutation: second })).receipt
          ?.status,
      ).toBe("conflict");
      expect(
        (yield* f.remote.repository.command({ action: "mutate", mutation: resolved })).receipt
          ?.status,
      ).toBe("accepted");
      const other = yield* f.spaces.execute(principal, { action: "create", name: "Other" }, true);
      const isolated = yield* f.projects.connect(principal, other.spaceId, (subject) =>
        Effect.succeed({ subject, displayName: subject }),
      );
      expect(
        (yield* isolated.repository
          .command({ action: "read", hash: contentHash("second\n") })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect("rejects traversal, symlinks, hard links and dirty incoming file replacement", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    for (const name of ["../outside", "/outside", "a/.git/config", "a\\b", "C:secret", "a/../b"])
      expect(() => sharedPath(name)).toThrow();
    yield* fileIO(() =>
      NodeFSP.symlink(NodePath.join(f.source, "README.md"), NodePath.join(f.source, "link")),
    );
    expect((yield* fileIO(() => safeRead(f.source, "link")).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    yield* fileIO(() =>
      NodeFSP.link(NodePath.join(f.source, "README.md"), NodePath.join(f.source, "hard")),
    );
    expect((yield* fileIO(() => safeRead(f.source, "hard")).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    yield* fileIO(() => NodeFSP.unlink(NodePath.join(f.source, "hard")));
    expect(
      (yield* fileIO(() =>
        applySharedFile(
          f.source,
          "README.md",
          contentHash("stale"),
          Buffer.from("incoming"),
          false,
        ),
      ).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      yield* fileIO(() => NodeFSP.readFile(NodePath.join(f.source, "README.md"), "utf8")),
    ).toBe("base\n");
  }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "synchronizes two real checkouts, preserves concurrent versions and recovers a durable lost ACK",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* uploadRepository(f.connection, f.source, null);
      const firstRoot = NodePath.join(f.root, "first");
      const secondRoot = NodePath.join(f.root, "second");
      yield* openCheckout(f.connection, firstRoot);
      yield* openCheckout(f.connection, secondRoot);
      const link = (root: string): LocalTeamLinkRow => ({
        link_id: randomId(),
        project_id: randomId(),
        space_id: f.spaceId,
        service_url: "https://example.test",
        issuer: "https://issuer.test",
        client_id: "test",
        subject: "owner",
        generation: "one",
        installation_id: randomId(),
        workspace_root: root,
        canonical_root: root,
        role: "owner",
        status: "synced",
      });
      const first = link(firstRoot);
      const second = link(secondRoot);
      for (const row of [first, second])
        yield* f.remote
          .sql`INSERT INTO local_team_project_links(link_id,project_id,space_id,service_url,issuer,client_id,subject,generation,installation_id,workspace_root,canonical_root,role,status) VALUES(${row.link_id},${row.project_id},${row.space_id},${row.service_url},${row.issuer},${row.client_id},${row.subject},${row.generation},${row.installation_id},${row.workspace_root},${row.canonical_root},${row.role},${row.status})`;
      let service = yield* makeLocalTeamFiles().pipe(
        Effect.provideService(SqlClient.SqlClient, f.remote.sql),
      );
      for (const row of [first, second])
        yield* service.control(row, f.connection, {
          action: "enable",
          projectId: ProjectId.make(row.project_id),
        });
      yield* fileIO(async (signal) => {
        await NodeFSP.writeFile(NodePath.join(firstRoot, "new-tracked.txt"), "new tracked content");
        await NodeFSP.writeFile(
          NodePath.join(firstRoot, "untracked-local.txt"),
          "private untracked content",
        );
        await NodeFSP.writeFile(
          NodePath.join(firstRoot, "local-only.txt"),
          "private ignored content",
        );
        await NodeFSP.writeFile(NodePath.join(firstRoot, ".env"), "SYNTHETIC_PRIVATE=not-real");
        await restrictedGit(firstRoot, ["add", "new-tracked.txt"], signal);
        await restrictedGit(firstRoot, ["add", "--force", ".env"], signal);
      });
      yield* service.reconcile(first, f.connection);
      yield* service.reconcile(second, f.connection);
      const trackedManifest = (yield* f.connection.repository({ action: "manifest" })).manifest!;
      expect(trackedManifest.files.some((file) => file.path === "new-tracked.txt")).toBe(true);
      expect(
        trackedManifest.files.some((file) =>
          ["untracked-local.txt", "local-only.txt", ".env"].includes(file.path),
        ),
      ).toBe(false);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(secondRoot, "new-tracked.txt"), "utf8")),
      ).toBe("new tracked content");
      yield* service.control(first, f.connection, {
        action: "include",
        projectId: ProjectId.make(first.project_id),
        paths: ["local-only.txt"],
      });
      yield* service.reconcile(second, f.connection);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(secondRoot, "local-only.txt"), "utf8")),
      ).toBe("private ignored content");
      yield* fileIO(() => NodeFSP.writeFile(NodePath.join(firstRoot, "README.md"), "first edit\n"));
      yield* service.reconcile(first, f.connection);
      yield* service.reconcile(second, f.connection);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(secondRoot, "README.md"), "utf8")),
      ).toBe("first edit\n");
      yield* fileIO(() =>
        NodeFSP.writeFile(NodePath.join(firstRoot, "README.md"), "concurrent A\n"),
      );
      yield* fileIO(() =>
        NodeFSP.writeFile(NodePath.join(secondRoot, "README.md"), "concurrent B\n"),
      );
      yield* service.reconcile(first, f.connection);
      yield* service.reconcile(second, f.connection);
      expect((yield* service.state(second)).status).toBe("conflict");
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(secondRoot, "README.md"), "utf8")),
      ).toBe("concurrent B\n");
      const resolution = {
        action: "resolve",
        projectId: ProjectId.make(second.project_id),
        path: "README.md",
        expectedLocal: contentHash("concurrent B\n"),
        expectedRemote: contentHash("concurrent A\n"),
        expectedLocalExecutable: false,
        expectedRemoteExecutable: false,
        choice: "local",
      } as const;
      let loseResolution = true;
      const lostResolution: TeamProjectConnection = {
        ...f.connection,
        repository: (command) =>
          f.connection.repository(command).pipe(
            Effect.flatMap((result) => {
              if (command.action === "mutate" && loseResolution) {
                loseResolution = false;
                return Effect.fail(fileError("unavailable"));
              }
              return Effect.succeed(result);
            }),
          ),
      };
      expect(
        (yield* service.control(second, lostResolution, resolution).pipe(Effect.result))._tag,
      ).toBe("Failure");
      service = yield* makeLocalTeamFiles().pipe(
        Effect.provideService(SqlClient.SqlClient, f.remote.sql),
      );
      yield* service.control(second, f.connection, resolution);
      expect((yield* service.state(second)).conflicts).toEqual([]);
      yield* service.control(second, f.connection, resolution);
      yield* service.reconcile(first, f.connection);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(firstRoot, "README.md"), "utf8")),
      ).toBe("concurrent B\n");
      yield* fileIO(() => NodeFSP.writeFile(NodePath.join(firstRoot, "README.md"), "lost ACK\n"));
      let lose = true;
      const flaky: TeamProjectConnection = {
        ...f.connection,
        repository: (command) =>
          f.connection.repository(command).pipe(
            Effect.flatMap((result) => {
              if (command.action === "mutate" && lose) {
                lose = false;
                return Effect.fail(fileError("unavailable"));
              }
              return Effect.succeed(result);
            }),
          ),
      };
      expect((yield* service.reconcile(first, flaky).pipe(Effect.result))._tag).toBe("Failure");
      service = yield* makeLocalTeamFiles().pipe(
        Effect.provideService(SqlClient.SqlClient, f.remote.sql),
      );
      yield* service.reconcile(first, f.connection);
      yield* service.reconcile(second, f.connection);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(secondRoot, "README.md"), "utf8")),
      ).toBe("lost ACK\n");
      yield* service.control(first, f.connection, {
        action: "disable",
        projectId: ProjectId.make(first.project_id),
      });
      yield* fileIO(() => NodeFSP.writeFile(NodePath.join(firstRoot, "README.md"), "disabled\n"));
      yield* service.reconcile(first, f.connection);
      expect(
        (yield* f.connection.repository({ action: "manifest" })).manifest?.files.find(
          (entry) => entry.path === "README.md",
        )?.hash,
      ).toBe(contentHash("lost ACK\n"));
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "denies queued reads after removal, viewers cannot write, and rename validates both paths",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* uploadRepository(f.connection, f.source, null);
      const invite = yield* f.spaces.execute(principal, {
        action: "invite",
        spaceId: f.spaceId,
        email: "viewer@example.test",
        role: "viewer",
      });
      const viewer = { ...principal, userId: "viewer", verifiedEmails: ["viewer@example.test"] };
      yield* f.spaces.execute(viewer, { action: "accept", token: invite.token! });
      const restricted = yield* f.projects.connect(viewer, f.spaceId, (subject) =>
        Effect.succeed({ subject, displayName: subject }),
      );
      expect(
        (yield* restricted.repository.command({ action: "manifest" })).manifest?.files.length,
      ).toBe(2);
      expect(
        (yield* restricted.repository
          .command({
            action: "mutate",
            mutation: {
              id: randomId(),
              changes: [
                {
                  path: "README.md",
                  expected: contentHash("base\n"),
                  expectedExecutable: false,
                  content: null,
                  executable: false,
                },
              ],
            },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = yield* f.spaces
        .withAuthority(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const removal = yield* f.spaces
        .execute(principal, { action: "removeMember", spaceId: f.spaceId, userId: "viewer" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const queued = yield* restricted.repository
        .command({ action: "manifest" })
        .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      yield* Fiber.join(removal);
      expect((yield* Fiber.join(queued))._tag).toBe("Failure");
      const rename = {
        id: randomId(),
        changes: [
          {
            path: "README.md",
            expected: contentHash("base\n"),
            expectedExecutable: false,
            content: null,
            executable: false,
          },
          {
            path: "renamed.md",
            expected: null,
            expectedExecutable: null,
            content: Buffer.from("base\n").toString("base64"),
            executable: true,
          },
        ],
      };
      expect(
        (yield* f.connection.repository({ action: "mutate", mutation: rename })).receipt?.status,
      ).toBe("accepted");
      const modeStale = {
        id: randomId(),
        changes: [
          {
            path: "renamed.md",
            expected: contentHash("base\n"),
            expectedExecutable: false,
            content: Buffer.from("other").toString("base64"),
            executable: false,
          },
        ],
      };
      expect(
        (yield* f.connection.repository({ action: "mutate", mutation: modeStale })).receipt?.status,
      ).toBe("conflict");
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "anchors intermediate directories and excludes inherited secrets and Git hooks/filters",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* Effect.promise(async (signal) => {
        const inside = NodePath.join(f.source, "nested");
        const outside = NodePath.join(f.root, "outside");
        await NodeFSP.mkdir(inside);
        await NodeFSP.mkdir(outside);
        await NodeFSP.writeFile(NodePath.join(inside, "file"), "inside");
        await NodeFSP.writeFile(NodePath.join(outside, "file"), "outside");
        await withSharedParent(f.source, "nested/file", false, async (anchored) => {
          await NodeFSP.rename(inside, `${inside}-retained`);
          await NodeFSP.symlink(outside, inside);
          expect(await NodeFSP.readFile(anchored, "utf8")).toBe("inside");
          await NodeFSP.writeFile(anchored, "safe update");
        });
        expect(await NodeFSP.readFile(NodePath.join(outside, "file"), "utf8")).toBe("outside");
        const marker = NodePath.join(f.root, "hook-ran");
        await NodeFSP.mkdir(NodePath.join(f.source, ".git/hooks"));
        await NodeFSP.writeFile(
          NodePath.join(f.source, ".git/hooks/pre-commit"),
          `#!/bin/sh\ntouch '${marker}'\n`,
          { mode: 0o700 },
        );
        await restrictedGit(
          f.source,
          ["config", "filter.host.smudge", `touch '${marker}'`],
          signal,
        );
        await restrictedGit(f.source, ["config", "core.fsmonitor", `touch '${marker}'`], signal);
        await NodeFSP.writeFile(
          NodePath.join(f.source, ".gitattributes"),
          "README.md filter=probe\n",
        );
        await NodeFSP.writeFile(NodePath.join(f.source, "README.md"), "edit\n");
        const index = await NodeFSP.readFile(NodePath.join(f.source, ".git/index"));
        for (const driver of ["clean", "process"]) {
          await restrictedGit(
            f.source,
            ["config", `filter.probe.${driver}`, `touch '${marker}'; cat`],
            signal,
          );
          const config = await NodeFSP.readFile(NodePath.join(f.source, ".git/config"));
          expect((await gitIdentity(f.source, signal)).excludedChanges).toBeGreaterThan(0);
          expect(await NodeFSP.readFile(NodePath.join(f.source, ".git/config"))).toEqual(config);
          expect(await NodeFSP.readFile(NodePath.join(f.source, ".git/index"))).toEqual(index);
          expect(
            await NodeFSP.stat(marker).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        }
        expect(await NodeFSP.readFile(NodePath.join(f.source, "README.md"), "utf8")).toBe("edit\n");
        process.env.T3_TEAM_TEST_PRIVATE_SENTINEL = "DO-NOT-INHERIT";
        try {
          const environment = await restrictedGit(
            f.source,
            ["-c", "alias.probe=!env", "probe"],
            signal,
          );
          expect(environment.toString()).not.toContain("DO-NOT-INHERIT");
        } finally {
          delete process.env.T3_TEAM_TEST_PRIVATE_SENTINEL;
        }
        await restrictedGit(f.source, ["config", "--remove-section", "filter.probe"], signal);
        await restrictedGit(
          f.source,
          [
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.test",
            "commit",
            "--allow-empty",
            "-m",
            "safe hooks",
          ],
          signal,
        );
        expect(
          await NodeFSP.stat(marker).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      });
      yield* uploadRepository(f.connection, f.source, null);
      const opened = NodePath.join(f.root, "opened");
      yield* openCheckout(f.connection, opened);
      expect(
        yield* fileIO(() =>
          NodeFSP.stat(NodePath.join(f.root, "hook-ran")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "cleans cancelled transfers, rejects switched selections and opens an empty repository",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const entered = yield* Deferred.make<void>();
      const stalled: TeamProjectConnection = {
        ...f.connection,
        repository: (command) =>
          f.connection
            .repository(command)
            .pipe(
              Effect.flatMap((result) =>
                command.action === "begin"
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.succeed(result),
              ),
            ),
      };
      const upload = yield* uploadRepository(stalled, f.source, null).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(upload);
      expect(
        (yield* f.remote.sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM team_git_uploads WHERE completed=0`)[0]?.count,
      ).toBe(0);
      expect(
        (yield* fileIO(() => NodeFSP.readdir(f.root))).filter((name) =>
          name.startsWith(".t3-team-transfer-"),
        ),
      ).toEqual([]);
      expect(
        (yield* uploadRepository(f.connection, f.source, null, {
          branch: "different",
          commit: null,
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const empty = NodePath.join(f.root, "empty");
      yield* fileIO(async (signal) => {
        await NodeFSP.mkdir(empty);
        await restrictedGit(empty, ["init", "--template=", "--initial-branch", "main"], signal);
      });
      yield* uploadRepository(f.connection, empty, null);
      const opened = NodePath.join(f.root, "empty-member");
      yield* openCheckout(f.connection, opened);
      expect(yield* fileIO(() => NodeFSP.readdir(opened))).toEqual([".git"]);
      expect((yield* f.connection.repository({ action: "manifest" })).manifest?.commit).toBe(null);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "runs the bounded watcher, pauses on branch changes and closes it when synchronization is disabled",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* uploadRepository(f.connection, f.source, null);
      const root = NodePath.join(f.root, "watched");
      yield* openCheckout(f.connection, root);
      const row: LocalTeamLinkRow = {
        link_id: randomId(),
        project_id: randomId(),
        space_id: f.spaceId,
        service_url: "https://example.test",
        issuer: "https://issuer.test",
        client_id: "test",
        subject: "owner",
        generation: "one",
        installation_id: randomId(),
        workspace_root: root,
        canonical_root: root,
        role: "owner",
        status: "synced",
      };
      yield* f.remote
        .sql`INSERT INTO local_team_project_links(link_id,project_id,space_id,service_url,issuer,client_id,subject,generation,installation_id,workspace_root,canonical_root,role,status) VALUES(${row.link_id},${row.project_id},${row.space_id},${row.service_url},${row.issuer},${row.client_id},${row.subject},${row.generation},${row.installation_id},${row.workspace_root},${row.canonical_root},${row.role},${row.status})`;
      const closed = yield* Queue.unbounded<void>();
      const watching = yield* Queue.unbounded<void>();
      let notify: (path?: string) => void = () => {
        throw new Error("watcher not started");
      };
      const service = yield* makeLocalTeamFiles((_root, changed) => {
        notify = changed;
        Queue.offerUnsafe(watching, undefined);
        return {
          close: () => {
            Queue.offerUnsafe(closed, undefined);
          },
        };
      }).pipe(Effect.provideService(SqlClient.SqlClient, f.remote.sql));
      yield* service.control(row, f.connection, {
        action: "enable",
        projectId: ProjectId.make(row.project_id),
      });
      const results = yield* Queue.unbounded<string>();
      let failFileRequest = false;
      const connection: TeamProjectConnection = {
        ...f.connection,
        repository: (command) => {
          if (command.action === "manifest" && failFileRequest) {
            failFileRequest = false;
            return Effect.fail(fileError("unavailable"));
          }
          return f.connection.repository(command);
        },
      };
      yield* service.receipts.pipe(
        Stream.runForEach((receipt) => Queue.offer(results, receipt.status)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* service.run(row, connection).pipe(Effect.forkScoped);
      yield* Queue.take(watching);
      expect(yield* Queue.take(results)).toBe("synchronized");
      failFileRequest = true;
      yield* fileIO(() => NodeFSP.writeFile(NodePath.join(root, "README.md"), "failed edit\n"));
      notify("README.md");
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(results)).toBe("offline");
      expect((yield* service.state(row)).status).toBe("offline");
      // A later edit recovers the existing worker; the account/config connection stays healthy.
      yield* fileIO(() => NodeFSP.writeFile(NodePath.join(root, "README.md"), "watcher change\n"));
      notify("README.md");
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(results)).toBe("synchronized");
      expect(
        (yield* f.connection.repository({ action: "manifest" })).manifest?.files.find(
          (file) => file.path === "README.md",
        )?.hash,
      ).toBe(contentHash("watcher change\n"));
      yield* service.disable(row);
      yield* Queue.take(closed);
      expect((yield* service.state(row)).status).toBe("disabled");
      yield* fileIO((signal) => restrictedGit(root, ["switch", "-c", "different"], signal));
      expect(
        (yield* service
          .control(row, f.connection, {
            action: "enable",
            projectId: ProjectId.make(row.project_id),
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* fileIO((signal) => restrictedGit(root, ["switch", "main"], signal));
      yield* service.control(row, f.connection, {
        action: "enable",
        projectId: ProjectId.make(row.project_id),
      });
      yield* Queue.take(watching);
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(results)).toBe("synchronized");
      yield* fileIO((signal) => restrictedGit(root, ["switch", "different"], signal));
      notify(".git/HEAD");
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(results)).toBe("branch-changed");
      yield* Queue.take(closed);
      expect((yield* service.state(row)).status).toBe("branch-changed");
      yield* fileIO((signal) => restrictedGit(root, ["switch", "main"], signal));
      yield* service.control(row, f.connection, {
        action: "enable",
        projectId: ProjectId.make(row.project_id),
      });
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(results)).toBe("synchronized");
      yield* service.disable(row);
      yield* Queue.take(closed);
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "publishes fast-forward commits without resetting live edits and opens the current working tree",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const first = yield* uploadRepository(f.connection, f.source, null);
      yield* f.connection.repository({
        action: "mutate",
        mutation: {
          id: randomId(),
          changes: [
            {
              path: "README.md",
              expected: contentHash("base\n"),
              expectedExecutable: false,
              content: Buffer.from("live change\n").toString("base64"),
              executable: false,
            },
          ],
        },
      });
      yield* fileIO(async (signal) => {
        await NodeFSP.writeFile(NodePath.join(f.source, "new.txt"), "committed addition\n");
        await restrictedGit(f.source, ["add", "new.txt"], signal);
        await restrictedGit(
          f.source,
          [
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.test",
            "commit",
            "-m",
            "next",
          ],
          signal,
        );
      });
      const second = yield* uploadRepository(f.connection, f.source, first.commit);
      expect(second.commit).not.toBe(first.commit);
      const opened = NodePath.join(f.root, "latest");
      yield* openCheckout(f.connection, opened);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(opened, "README.md"), "utf8")),
      ).toBe("live change\n");
      expect(yield* fileIO(() => NodeFSP.readFile(NodePath.join(opened, "new.txt"), "utf8"))).toBe(
        "committed addition\n",
      );
      yield* fileIO((signal) =>
        restrictedGit(f.source, ["reset", "--soft", first.commit!], signal),
      );
      expect(
        (yield* uploadRepository(f.connection, f.source, second.commit).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* f.connection.repository({ action: "repository" })).repository?.commit).toBe(
        second.commit,
      );
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "rejects colliding Git overlays and nonadjacent or normalized live ancestors without changing either version",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const first = yield* uploadRepository(f.connection, f.source, null);
      yield* f.connection.repository({
        action: "mutate",
        mutation: {
          id: randomId(),
          changes: [
            {
              path: "README.md",
              expected: contentHash("base\n"),
              expectedExecutable: false,
              content: Buffer.from("live dirty\n").toString("base64"),
              executable: false,
            },
          ],
        },
      });
      yield* fileIO(async (signal) => {
        await NodeFSP.unlink(NodePath.join(f.source, "README.md"));
        await NodeFSP.mkdir(NodePath.join(f.source, "README.md"));
        await NodeFSP.writeFile(
          NodePath.join(f.source, "README.md/nested.txt"),
          "new committed file\n",
        );
        await restrictedGit(f.source, ["add", "README.md"], signal);
        await restrictedGit(
          f.source,
          [
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.test",
            "commit",
            "-m",
            "file to directory",
          ],
          signal,
        );
      });
      const failure = yield* uploadRepository(f.connection, f.source, first.commit).pipe(
        Effect.result,
      );
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") expect(failure.failure.reason).toBe("conflict");
      const manifest = (yield* f.connection.repository({ action: "manifest" })).manifest!;
      expect(manifest.commit).toBe(first.commit);
      expect(manifest.files.find((file) => file.path === "README.md")?.hash).toBe(
        contentHash("live dirty\n"),
      );
      expect(manifest.files.some((file) => file.path === "README.md/nested.txt")).toBe(false);
      expect(
        yield* fileIO(() =>
          NodeFSP.readFile(NodePath.join(f.source, "README.md/nested.txt"), "utf8"),
        ),
      ).toBe("new committed file\n");
      for (const path of ["a", "a-b"])
        yield* f.connection.repository({
          action: "mutate",
          mutation: {
            id: randomId(),
            changes: [
              { path, expected: null, expectedExecutable: null, content: "", executable: false },
            ],
          },
        });
      for (const path of ["a/b", "A", "A/b"])
        expect(
          (yield* f.connection
            .repository({
              action: "mutate",
              mutation: {
                id: randomId(),
                changes: [
                  {
                    path,
                    expected: null,
                    expectedExecutable: null,
                    content: "",
                    executable: false,
                  },
                ],
              },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "preflights protected history and bounds every imported object, including unreachable objects",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* Effect.promise(async (signal) => {
        const bundle = NodePath.join(f.root, "safe.bundle");
        const exported = await exportBundle(f.source, bundle, signal);
        await expect(
          verifyBundle(
            NodePath.join(f.root, "too-expanded"),
            bundle,
            exported.branch,
            exported.commit,
            signal,
            1,
          ),
        ).rejects.toMatchObject({ reason: "limit" });
        await restrictedGit(f.source, ["switch", "--orphan", "extra"], signal);
        await NodeFSP.writeFile(NodePath.join(f.source, "extra.txt"), "unreachable extra");
        await restrictedGit(f.source, ["add", "extra.txt"], signal);
        await restrictedGit(
          f.source,
          [
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.test",
            "commit",
            "-m",
            "extra",
          ],
          signal,
        );
        const pack = await restrictedGit(
          f.source,
          ["pack-objects", "--revs", "--all", "--stdout"],
          signal,
        );
        const extraBundle = NodePath.join(f.root, "extra.bundle");
        await NodeFSP.writeFile(
          extraBundle,
          Buffer.concat([
            Buffer.from(`# v2 git bundle\n${exported.commit} refs/heads/main\n\n`),
            pack,
          ]),
        );
        await expect(
          verifyBundle(
            NodePath.join(f.root, "extra-import"),
            extraBundle,
            exported.branch,
            exported.commit,
            signal,
          ),
        ).rejects.toMatchObject({
          reason: "invalid",
          message: expect.stringContaining("outside the selected branch"),
        });
        await restrictedGit(f.source, ["switch", "main"], signal);
        await NodeFSP.writeFile(
          NodePath.join(f.source, ".env.example"),
          "SYNTHETIC_TEMPLATE=not-real",
        );
        await restrictedGit(f.source, ["add", ".env.example"], signal);
        await restrictedGit(
          f.source,
          [
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.test",
            "commit",
            "-m",
            "protected",
          ],
          signal,
        );
        await expect(preflightRepository(f.source, signal)).rejects.toMatchObject({
          reason: "invalid",
          message: expect.stringContaining("retrying unchanged history will not help"),
        });
        expect(
          (await NodeFSP.readdir(f.root)).some((name) => name.startsWith(".t3-team-preflight-")),
        ).toBe(false);
      });
      expect((yield* f.connection.repository({ action: "repository" })).repository).toBeUndefined();
    }).pipe(Effect.provide(layers), Effect.scoped),
);

it.effect(
  "opens and synchronizes both namespace transitions while preserving unrelated local children",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const child = "directory/deep/child.txt";
      yield* fileIO(async (signal) => {
        await NodeFSP.mkdir(NodePath.join(f.source, "directory/deep"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(f.source, child), "old child");
        await restrictedGit(f.source, ["add", "directory"], signal);
        await restrictedGit(
          f.source,
          [
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.test",
            "commit",
            "-m",
            "nested source",
          ],
          signal,
        );
      });
      yield* uploadRepository(f.connection, f.source, null);
      const roots = [
        NodePath.join(f.root, "clean-member"),
        NodePath.join(f.root, "retained-member"),
      ];
      const rows: LocalTeamLinkRow[] = [];
      const service = yield* makeLocalTeamFiles().pipe(
        Effect.provideService(SqlClient.SqlClient, f.remote.sql),
      );
      for (const root of roots) {
        yield* openCheckout(f.connection, root);
        const row: LocalTeamLinkRow = {
          link_id: randomId(),
          project_id: randomId(),
          space_id: f.spaceId,
          service_url: "https://example.test",
          issuer: "https://issuer.test",
          client_id: "test",
          subject: "owner",
          generation: "one",
          installation_id: randomId(),
          workspace_root: root,
          canonical_root: root,
          role: "owner",
          status: "synced",
        };
        rows.push(row);
        yield* f.remote
          .sql`INSERT INTO local_team_project_links ${f.remote.sql.insert({ ...row })}`;
        yield* service.control(row, f.connection, {
          action: "enable",
          projectId: ProjectId.make(row.project_id),
        });
      }
      const localChild = NodePath.join(roots[1]!, "directory/untracked-local.txt");
      yield* fileIO(() => NodeFSP.writeFile(localChild, "retained local child"));
      const replacement = "new directory replacement";
      expect(
        (yield* f.connection.repository({
          action: "mutate",
          mutation: {
            id: randomId(),
            changes: [
              {
                path: "directory",
                expected: null,
                expectedExecutable: null,
                content: Buffer.from(replacement).toString("base64"),
                executable: false,
              },
              {
                path: child,
                expected: contentHash("old child"),
                expectedExecutable: false,
                content: null,
                executable: false,
              },
            ],
          },
        })).receipt?.status,
      ).toBe("accepted");
      const openedFile = NodePath.join(f.root, "opened-file");
      yield* openCheckout(f.connection, openedFile);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(openedFile, "directory"), "utf8")),
      ).toBe(replacement);
      yield* service.reconcile(rows[0]!, f.connection);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(roots[0]!, "directory"), "utf8")),
      ).toBe(replacement);
      yield* service.reconcile(rows[1]!, f.connection);
      expect(yield* service.state(rows[1]!)).toMatchObject({
        status: "conflict",
        conflicts: [{ path: "directory", reason: "directory" }],
      });
      expect(yield* fileIO(() => NodeFSP.readFile(localChild, "utf8"))).toBe(
        "retained local child",
      );
      const resolution = {
        action: "resolve" as const,
        projectId: ProjectId.make(rows[1]!.project_id),
        path: "directory",
        expectedLocal: null,
        expectedRemote: contentHash(replacement),
        expectedLocalExecutable: null,
        expectedRemoteExecutable: false,
        choice: "remote" as const,
      };
      const blocked = yield* service
        .control(rows[1]!, f.connection, resolution)
        .pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");
      if (blocked._tag === "Failure")
        expect(blocked.failure).toMatchObject({
          reason: "conflict",
          message: expect.stringContaining("Move those files"),
        });
      expect(yield* fileIO(() => NodeFSP.readFile(localChild, "utf8"))).toBe(
        "retained local child",
      );
      const retained = NodePath.join(roots[1]!, "retained-untracked.txt");
      yield* fileIO(() => NodeFSP.rename(localChild, retained));
      yield* service.control(rows[1]!, f.connection, resolution);
      expect((yield* service.state(rows[1]!)).conflicts).toEqual([]);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(roots[1]!, "directory"), "utf8")),
      ).toBe(replacement);
      expect(
        (yield* f.connection.repository({
          action: "mutate",
          mutation: {
            id: randomId(),
            changes: [
              {
                path: child,
                expected: null,
                expectedExecutable: null,
                content: Buffer.from("new live child").toString("base64"),
                executable: false,
              },
              {
                path: "directory",
                expected: contentHash(replacement),
                expectedExecutable: false,
                content: null,
                executable: false,
              },
            ],
          },
        })).receipt?.status,
      ).toBe("accepted");
      const openedDirectory = NodePath.join(f.root, "opened-directory");
      yield* openCheckout(f.connection, openedDirectory);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(openedDirectory, child), "utf8")),
      ).toBe("new live child");
      for (const row of rows) {
        yield* service.reconcile(row, f.connection);
        yield* service.reconcile(row, f.connection);
        expect((yield* service.state(row)).status).toBe("synchronized");
        expect(
          yield* fileIO(() => NodeFSP.readFile(NodePath.join(row.workspace_root, child), "utf8")),
        ).toBe("new live child");
      }
      expect(yield* fileIO(() => NodeFSP.readFile(retained, "utf8"))).toBe("retained local child");
      // Local tracked namespace changes must publish deletion before creating the replacement.
      yield* fileIO(async (signal) => {
        await NodeFSP.unlink(NodePath.join(roots[0]!, child));
        await NodeFSP.rmdir(NodePath.join(roots[0]!, "directory/deep"));
        await NodeFSP.rmdir(NodePath.join(roots[0]!, "directory"));
        await NodeFSP.writeFile(NodePath.join(roots[0]!, "directory"), "local replacement");
        await restrictedGit(roots[0]!, ["add", "--all", "directory"], signal);
      });
      yield* service.reconcile(rows[0]!, f.connection);
      yield* service.reconcile(rows[1]!, f.connection);
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(roots[1]!, "directory"), "utf8")),
      ).toBe("local replacement");
      yield* fileIO(async (signal) => {
        await NodeFSP.unlink(NodePath.join(roots[0]!, "directory"));
        await NodeFSP.mkdir(NodePath.join(roots[0]!, "directory/deep"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(roots[0]!, child), "local new child");
        await NodeFSP.writeFile(
          NodePath.join(roots[0]!, "directory/untracked-local.txt"),
          "local child stays local",
        );
        await restrictedGit(roots[0]!, ["add", child], signal);
      });
      yield* service.reconcile(rows[0]!, f.connection);
      yield* service.reconcile(rows[1]!, f.connection);
      expect((yield* service.state(rows[0]!)).status).toBe("synchronized");
      expect(yield* fileIO(() => NodeFSP.readFile(NodePath.join(roots[1]!, child), "utf8"))).toBe(
        "local new child",
      );
      expect(
        yield* fileIO(() =>
          NodeFSP.readFile(NodePath.join(roots[0]!, "directory/untracked-local.txt"), "utf8"),
        ),
      ).toBe("local child stays local");
      expect(
        (yield* f.connection.repository({ action: "manifest" })).manifest!.files.some(
          (file) => file.path === "directory/untracked-local.txt",
        ),
      ).toBe(false);
      expect(yield* fileIO(() => NodeFSP.readFile(NodePath.join(f.source, child), "utf8"))).toBe(
        "old child",
      );
      expect(
        yield* fileIO(() => NodeFSP.readFile(NodePath.join(openedDirectory, "README.md"), "utf8")),
      ).toBe("base\n");
    }).pipe(Effect.provide(layers), Effect.scoped),
);

for (const delayed of ["manifest", "read"] as const) {
  it.effect(`pauses an in-flight worker on a branch switch during remote ${delayed}`, () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* uploadRepository(f.connection, f.source, null);
      const root = NodePath.join(f.root, "in-flight-branch");
      yield* openCheckout(f.connection, root);
      const row: LocalTeamLinkRow = {
        link_id: randomId(),
        project_id: randomId(),
        space_id: f.spaceId,
        service_url: "https://example.test",
        issuer: "https://issuer.test",
        client_id: "test",
        subject: "owner",
        generation: "one",
        installation_id: randomId(),
        workspace_root: root,
        canonical_root: root,
        role: "owner",
        status: "synced",
      };
      yield* f.remote.sql`INSERT INTO local_team_project_links ${f.remote.sql.insert({ ...row })}`;
      const watching = yield* Queue.unbounded<void>();
      const closed = yield* Queue.unbounded<void>();
      const receipts = yield* Queue.unbounded<string>();
      let notify: (path?: string) => void = () => {
        throw new Error("watcher missing");
      };
      const service = yield* makeLocalTeamFiles((_root, changed) => {
        notify = changed;
        Queue.offerUnsafe(watching, undefined);
        return {
          close: () => {
            Queue.offerUnsafe(closed, undefined);
          },
        };
      }).pipe(Effect.provideService(SqlClient.SqlClient, f.remote.sql));
      yield* service.control(row, f.connection, {
        action: "enable",
        projectId: ProjectId.make(row.project_id),
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      let block = false;
      const resumedText = "resumed shared edit\n";
      const connection: TeamProjectConnection = {
        ...f.connection,
        repository: (command) =>
          Effect.gen(function* () {
            if (command.action === delayed && block) {
              block = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            const result = yield* f.connection.repository(command);
            if (
              command.action === "mutate" &&
              command.mutation.changes.some(
                (change) => change.content === Buffer.from(resumedText).toString("base64"),
              )
            )
              yield* Deferred.succeed(resumed, undefined);
            return result;
          }),
      };
      yield* service.receipts.pipe(
        Stream.runForEach((receipt) => Queue.offer(receipts, receipt.status)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* service.run(row, connection).pipe(Effect.forkScoped);
      yield* Queue.take(watching);
      expect(yield* Queue.take(receipts)).toBe("synchronized");
      let expectedShared = "base\n";
      if (delayed === "read") {
        expectedShared = "incoming shared version\n";
        yield* f.connection.repository({
          action: "mutate",
          mutation: {
            id: randomId(),
            changes: [
              {
                path: "README.md",
                expected: contentHash("base\n"),
                expectedExecutable: false,
                content: Buffer.from(expectedShared).toString("base64"),
                executable: false,
              },
            ],
          },
        });
      }
      block = true;
      notify("README.md");
      yield* TestClock.adjust("100 millis");
      yield* Deferred.await(entered);
      const privateText = "PRIVATE BRANCH MUST STAY LOCAL\n";
      yield* fileIO(async (signal) => {
        await restrictedGit(root, ["switch", "-c", "private-branch"], signal);
        await NodeFSP.writeFile(NodePath.join(root, "README.md"), privateText);
      });
      yield* Deferred.succeed(release, undefined);
      expect(yield* Queue.take(receipts)).toBe("branch-changed");
      yield* Queue.take(closed);
      expect((yield* service.state(row)).status).toBe("branch-changed");
      expect(
        (yield* f.connection.repository({ action: "manifest" })).manifest!.files.find(
          (file) => file.path === "README.md",
        )?.hash,
      ).toBe(contentHash(expectedShared));
      expect(yield* fileIO(() => NodeFSP.readFile(NodePath.join(root, "README.md"), "utf8"))).toBe(
        privateText,
      );
      yield* fileIO(async (signal) => {
        await restrictedGit(root, ["switch", "main"], signal);
        await NodeFSP.writeFile(NodePath.join(root, "README.md"), expectedShared);
      });
      yield* service.control(row, f.connection, {
        action: "enable",
        projectId: ProjectId.make(row.project_id),
      });
      yield* Queue.take(watching);
      yield* fileIO(() => NodeFSP.writeFile(NodePath.join(root, "README.md"), resumedText));
      notify("README.md");
      yield* TestClock.adjust("100 millis");
      yield* Deferred.await(resumed);
      expect(
        (yield* f.connection.repository({ action: "manifest" })).manifest!.files.find(
          (file) => file.path === "README.md",
        )?.hash,
      ).toBe(contentHash(resumedText));
      yield* service.disable(row);
      yield* Queue.take(closed);
    }).pipe(Effect.provide(layers), Effect.scoped),
  );
}

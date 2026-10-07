import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off — tests use isolated directories and SQLite fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import { afterEach, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Backup from "./BackupService.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-backup-test-"));
  roots.push(root);
  const home = NodePath.join(root, "source");
  const userdata = NodePath.join(home, "userdata");
  await NodeFSP.mkdir(NodePath.join(userdata, "attachments"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
  database.exec(
    "CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('retained history');",
  );
  database.close();
  await NodeFSP.writeFile(
    NodePath.join(userdata, "settings.json"),
    '{"runLimits":{"maxDurationMinutes":10,"maxOutputTokens":null}}',
  );
  await NodeFSP.writeFile(
    NodePath.join(userdata, "attachments", "picture.txt"),
    "attachment content",
  );
  await NodeFSP.mkdir(NodePath.join(userdata, "secrets"));
  await NodeFSP.writeFile(NodePath.join(userdata, "secrets", "credential"), "local credential");
  await NodeFSP.mkdir(NodePath.join(userdata, "logs"));
  await NodeFSP.writeFile(NodePath.join(userdata, "logs", "runtime.log"), "excluded log");
  return {
    root,
    home,
    userdata,
    outputDir: NodePath.join(root, "backup"),
    restored: NodePath.join(root, "restored"),
  };
}
const run = <A>(
  use: (service: Backup.BackupService["Service"]) => Effect.Effect<A, Backup.BackupError>,
) => Effect.flatMap(Backup.BackupService, use).pipe(Effect.provide(Backup.layer));
const io = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) =>
      new Backup.BackupError({ operation: "fixture", message: String(cause), cause }),
  });

it.effect(
  "round trips conversation, settings, attachments and credentials without touching the source",
  () =>
    Effect.gen(function* () {
      const data = yield* io(fixture);
      const before = yield* io(() =>
        NodeFSP.readFile(NodePath.join(data.userdata, "statev2.sqlite")),
      );
      expect(
        yield* run((service) => service.create({ homeDir: data.home, outputDir: data.outputDir })),
      ).toMatchObject({ fileCount: 4 });
      expect(
        yield* io(() => NodeFSP.readFile(NodePath.join(data.userdata, "statev2.sqlite"))),
      ).toEqual(before);
      expect(
        yield* run((service) =>
          service.restore({ inputDir: data.outputDir, homeDir: data.restored }),
        ),
      ).toMatchObject({ fileCount: 4 });
      const db = new NodeSqlite.DatabaseSync(
        NodePath.join(data.restored, "userdata", "statev2.sqlite"),
        { readOnly: true },
      );
      try {
        expect(db.prepare("SELECT text FROM messages").get()?.text).toBe("retained history");
      } finally {
        db.close();
      }
      expect(
        yield* io(() =>
          NodeFSP.readFile(
            NodePath.join(data.restored, "userdata", "attachments", "picture.txt"),
            "utf8",
          ),
        ),
      ).toBe("attachment content");
      expect(
        yield* io(() =>
          NodeFSP.readFile(
            NodePath.join(data.restored, "userdata", "secrets", "credential"),
            "utf8",
          ),
        ),
      ).toBe("local credential");
      expect(
        yield* io(() => NodeFSP.readdir(NodePath.join(data.restored, "userdata"))),
      ).not.toContain("logs");
      if ((yield* HostProcessPlatform) !== "win32") {
        expect((yield* io(() => NodeFSP.stat(data.outputDir))).mode & 0o777).toBe(0o700);
        expect(
          (yield* io(() =>
            NodeFSP.stat(NodePath.join(data.restored, "userdata", "secrets", "credential")),
          )).mode & 0o777,
        ).toBe(0o600);
      }
    }),
);
it.effect("refuses backup while the recorded server process is alive", () =>
  Effect.gen(function* () {
    const data = yield* io(fixture);
    yield* io(() =>
      NodeFSP.writeFile(
        NodePath.join(data.userdata, "server-runtime.json"),
        JSON.stringify({ pid: process.pid }),
      ),
    );
    expect(
      (yield* run((service) =>
        service.create({ homeDir: data.home, outputDir: data.outputDir }),
      ).pipe(Effect.flip)).message,
    ).toContain("Stop the Arcwright Code server");
    expect((yield* io(() => NodeFSP.stat(data.outputDir)).pipe(Effect.exit))._tag).toBe("Failure");
  }),
);
it.effect("never overwrites an existing backup or home", () =>
  Effect.gen(function* () {
    const data = yield* io(fixture);
    yield* run((service) => service.create({ homeDir: data.home, outputDir: data.outputDir }));
    expect(
      (yield* run((service) =>
        service.create({ homeDir: data.home, outputDir: data.outputDir }),
      ).pipe(Effect.flip)).message,
    ).toContain("EEXIST");
    expect(
      (yield* run((service) =>
        service.restore({ inputDir: data.outputDir, homeDir: data.home }),
      ).pipe(Effect.flip)).message,
    ).toContain("EEXIST");
    expect(
      yield* io(() => NodeFSP.readFile(NodePath.join(data.userdata, "settings.json"), "utf8")),
    ).toContain("maxDurationMinutes");
  }),
);
it.effect("rejects corrupted files before creating the destination", () =>
  Effect.gen(function* () {
    const data = yield* io(fixture);
    yield* run((service) => service.create({ homeDir: data.home, outputDir: data.outputDir }));
    yield* io(() =>
      NodeFSP.writeFile(
        NodePath.join(data.outputDir, "userdata", "attachments", "picture.txt"),
        "tampered",
      ),
    );
    expect(
      (yield* run((service) =>
        service.restore({ inputDir: data.outputDir, homeDir: data.restored }),
      ).pipe(Effect.flip)).message,
    ).toContain("checksum mismatch");
    expect((yield* io(() => NodeFSP.stat(data.restored)).pipe(Effect.exit))._tag).toBe("Failure");
  }),
);
it.effect("rejects traversal entries and symbolic links", () =>
  Effect.gen(function* () {
    const data = yield* io(fixture);
    yield* run((service) => service.create({ homeDir: data.home, outputDir: data.outputDir }));
    const manifestPath = NodePath.join(data.outputDir, "manifest.json");
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Backup.BackupManifest),
    )(yield* io(() => NodeFSP.readFile(manifestPath, "utf8")));
    const tampered = {
      ...manifest,
      files: manifest.files.map((file, index) =>
        index === 0 ? { ...file, path: "../../outside" } : file,
      ),
    };
    yield* io(() =>
      NodeFSP.writeFile(
        manifestPath,
        Schema.encodeSync(Schema.fromJsonString(Backup.BackupManifest))(tampered),
      ),
    );
    expect(
      (yield* run((service) =>
        service.restore({ inputDir: data.outputDir, homeDir: data.restored }),
      ).pipe(Effect.flip)).message,
    ).toContain("file list");
    yield* io(() =>
      NodeFSP.symlink(
        NodePath.join(data.userdata, "settings.json"),
        NodePath.join(data.userdata, "attachments", "link"),
      ),
    );
    expect(
      (yield* run((service) =>
        service.create({ homeDir: data.home, outputDir: NodePath.join(data.root, "bad-backup") }),
      ).pipe(Effect.flip)).message,
    ).toContain("symbolic links");
    expect(
      (yield* io(() => NodeFSP.stat(NodePath.join(data.root, "bad-backup"))).pipe(Effect.exit))
        ._tag,
    ).toBe("Failure");
  }),
);

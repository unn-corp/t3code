// @effect-diagnostics nodeBuiltinImport:off globalDate:off — SQLite's online backup API and atomic directory reservation require Node.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { BUILD_IDENTITY } from "../appVersion.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";

const entries = [
  "settings.json",
  "keybindings.json",
  "environment-id",
  "anonymous-id",
  "secrets",
  "themes",
  "attachments",
  "browser-artifacts",
];
export const BackupManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  createdAt: Schema.String,
  build: Schema.Unknown,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, sha256: Schema.String, bytes: Schema.Number }),
  ),
});
export class BackupError extends Schema.TaggedError<BackupError>()("BackupError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

async function hashFile(path: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function filesBelow(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await NodeFSP.readdir(NodePath.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await filesBelow(root, child)));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`Backup refuses symbolic links and special files: ${child}`);
  }
  return result.sort();
}
async function copyPrivate(source: string, destination: string) {
  const stat = await NodeFSP.lstat(source);
  if (stat.isDirectory()) {
    await NodeFSP.mkdir(destination, { mode: 0o700, recursive: true });
    await NodeFSP.chmod(destination, 0o700);
    for (const name of await NodeFSP.readdir(source))
      await copyPrivate(NodePath.join(source, name), NodePath.join(destination, name));
  } else if (stat.isFile()) {
    await NodeFSP.copyFile(source, destination);
    await NodeFSP.chmod(destination, 0o600);
  } else throw new Error(`Backup refuses symbolic links and special files: ${source}`);
}
async function exists(path: string) {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}
async function assertStopped(stateDir: string) {
  const runtimePath = NodePath.join(stateDir, "server-runtime.json");
  if (!(await exists(runtimePath))) return;
  const runtime: unknown = JSON.parse(await NodeFSP.readFile(runtimePath, "utf8"));
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    !("pid" in runtime) ||
    typeof runtime.pid !== "number" ||
    !Number.isSafeInteger(runtime.pid) ||
    runtime.pid < 1
  )
    throw new Error("Cannot verify server state. Stop the server and check server-runtime.json.");
  if (isProcessAlive(runtime.pid))
    throw new Error(
      "Stop the Arcwright Code server before creating a backup so settings and attachments match its database.",
    );
}
async function checkDatabase(path: string) {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("PRAGMA quick_check").all();
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok")
      throw new Error("Backup database failed its integrity check.");
  } finally {
    database.close();
  }
}
const operation = <A>(name: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new BackupError({
        operation: name,
        message: cause instanceof Error ? cause.message : `Could not ${name} backup.`,
        cause,
      }),
  });

export class BackupService extends Context.Service<
  BackupService,
  {
    readonly create: (input: {
      homeDir: string;
      outputDir: string;
    }) => Effect.Effect<{ path: string; fileCount: number }, BackupError>;
    readonly restore: (input: {
      inputDir: string;
      homeDir: string;
    }) => Effect.Effect<{ path: string; fileCount: number }, BackupError>;
  }
>()("t3/backup/BackupService") {}
const make = Effect.succeed(
  BackupService.of({
    create: ({ homeDir, outputDir }) =>
      operation("create", async () => {
        const source = await NodeFSP.realpath(NodePath.join(NodePath.resolve(homeDir), "userdata"));
        const destination = NodePath.resolve(outputDir);
        const parent = await NodeFSP.realpath(NodePath.dirname(destination));
        const canonicalDestination = NodePath.join(parent, NodePath.basename(destination));
        if (
          canonicalDestination === source ||
          canonicalDestination.startsWith(`${source}${NodePath.sep}`)
        )
          throw new Error("Choose a backup directory outside userdata.");
        await assertStopped(source);
        // Reserve a fresh directory. Never overwrite an existing backup or T3 home.
        await NodeFSP.mkdir(destination, { mode: 0o700 });
        try {
          const payload = NodePath.join(destination, "userdata");
          await NodeFSP.mkdir(payload, { mode: 0o700 });
          const database = new NodeSqlite.DatabaseSync(NodePath.join(source, "statev2.sqlite"), {
            readOnly: true,
          });
          try {
            await NodeSqlite.backup(database, NodePath.join(payload, "statev2.sqlite"));
          } finally {
            database.close();
          }
          await NodeFSP.chmod(NodePath.join(payload, "statev2.sqlite"), 0o600);
          for (const entry of entries)
            if (await exists(NodePath.join(source, entry)))
              await copyPrivate(NodePath.join(source, entry), NodePath.join(payload, entry));
          await assertStopped(source);
          await checkDatabase(NodePath.join(payload, "statev2.sqlite"));
          const files = [];
          for (const path of await filesBelow(payload))
            files.push({
              path,
              sha256: await hashFile(NodePath.join(payload, path)),
              bytes: (await NodeFSP.stat(NodePath.join(payload, path))).size,
            });
          const manifest = {
            formatVersion: 1,
            createdAt: new Date().toISOString(),
            build: BUILD_IDENTITY,
            files,
          };
          await NodeFSP.writeFile(
            NodePath.join(destination, "manifest.json"),
            JSON.stringify(manifest, null, 2) + "\n",
            { mode: 0o600, flag: "wx" },
          );
          return { path: destination, fileCount: files.length };
        } catch (cause) {
          await NodeFSP.rm(destination, { recursive: true, force: true });
          throw cause;
        }
      }),
    restore: ({ inputDir, homeDir }) =>
      operation("restore", async () => {
        const source = await NodeFSP.realpath(NodePath.resolve(inputDir));
        const payload = NodePath.join(source, "userdata");
        if (
          !(await NodeFSP.lstat(payload)).isDirectory() ||
          (await NodeFSP.lstat(payload)).isSymbolicLink()
        )
          throw new Error("Invalid backup data directory.");
        const manifest = Schema.decodeUnknownSync(BackupManifest)(
          JSON.parse(await NodeFSP.readFile(NodePath.join(source, "manifest.json"), "utf8")),
        );
        const actual = await filesBelow(payload);
        const recorded = manifest.files.map((file) => file.path).sort();
        if (
          new Set(recorded).size !== recorded.length ||
          !recorded.includes("statev2.sqlite") ||
          JSON.stringify(actual) !== JSON.stringify(recorded)
        )
          throw new Error("Backup file list does not match its manifest.");
        for (const file of manifest.files) {
          // Compare against enumerated paths before joining: no traversal or arbitrary destinations.
          if (
            !actual.includes(file.path) ||
            (file.path !== "statev2.sqlite" && !entries.includes(file.path.split("/")[0]!))
          )
            throw new Error("Unsupported backup path.");
          if (
            (await NodeFSP.stat(NodePath.join(payload, file.path))).size !== file.bytes ||
            (await hashFile(NodePath.join(payload, file.path))) !== file.sha256
          )
            throw new Error(`Backup checksum mismatch: ${file.path}`);
        }
        await checkDatabase(NodePath.join(payload, "statev2.sqlite"));
        const destination = NodePath.resolve(homeDir);
        await NodeFSP.mkdir(destination, { mode: 0o700 });
        try {
          const staged = NodePath.join(destination, ".restore-userdata");
          await copyPrivate(payload, staged);
          if (JSON.stringify(await filesBelow(staged)) !== JSON.stringify(recorded))
            throw new Error("Backup file list changed while restoring.");
          // Recheck the staged copy too; concurrent edits to the backup cannot slip through.
          for (const file of manifest.files)
            if ((await hashFile(NodePath.join(staged, file.path))) !== file.sha256)
              throw new Error(`Backup changed while restoring: ${file.path}`);
          await NodeFSP.rename(staged, NodePath.join(destination, "userdata"));
          return { path: destination, fileCount: manifest.files.length };
        } catch (cause) {
          await NodeFSP.rm(destination, { recursive: true, force: true });
          throw cause;
        }
      }),
  }),
);
export const layer = Layer.effect(BackupService, make);

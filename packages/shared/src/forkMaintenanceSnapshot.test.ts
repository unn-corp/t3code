/* oxlint-disable t3code/no-global-process-runtime -- node-only filesystem coordinator: the host platform is the point */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off — fixtures exercise real directories and SQLite files.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import {
  assertCapacity,
  createSnapshot,
  discardSnapshot,
  listRestorePoints,
  pruneRestorePoints,
  restoreSnapshot,
  snapshotRequirement,
  verifySnapshot,
} from "./forkMaintenanceSnapshot.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const noAcl = async () => undefined;

async function home(rows = ["history"]) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-test-"));
  roots.push(root);
  const state = NodePath.join(root, "userdata");
  await NodeFSP.mkdir(NodePath.join(state, "attachments"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(state, "secrets"));
  await NodeFSP.mkdir(NodePath.join(state, "logs"));
  const database = new NodeSqlite.DatabaseSync(NodePath.join(state, "statev2.sqlite"));
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE messages (text TEXT)");
  for (const row of rows) database.prepare("INSERT INTO messages VALUES (?)").run(row);
  // Left open with a live WAL, as an idle running server would.
  await NodeFSP.writeFile(NodePath.join(state, "settings.json"), '{"theme":"dark"}');
  await NodeFSP.writeFile(NodePath.join(state, "secrets", "pairing"), "device-credential");
  await NodeFSP.writeFile(NodePath.join(state, "attachments", "a.txt"), "attachment");
  await NodeFSP.writeFile(NodePath.join(state, "logs", "runtime.log"), "rebuildable");
  await NodeFSP.writeFile(NodePath.join(state, "server-runtime.json"), '{"pid":1}');
  // Unlisted state must be preserved too: an allowlist would lose it.
  await NodeFSP.mkdir(NodePath.join(state, "providers", "antigravity"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(state, "providers", "antigravity", "profile.json"),
    "profile",
  );
  const sibling = new NodeSqlite.DatabaseSync(NodePath.join(state, "dashboard.sqlite"));
  sibling.exec("CREATE TABLE queue (job TEXT); INSERT INTO queue VALUES ('held')");
  sibling.close();
  return { root, state, database, close: () => database.close() };
}
const messages = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare("SELECT text FROM messages ORDER BY rowid")
      .all()
      .map((row) => row.text);
  } finally {
    database.close();
  }
};

describe("restore points", () => {
  it("captures a live idle runtime's database and all unlisted state while excluding rebuildable artifacts", async () => {
    const h = await home();
    const id = await createSnapshot(h.root, "tx1", { restrict: noAcl });
    h.close();
    const manifest = await verifySnapshot(h.root, id);
    const files = manifest.files.map((file) => file.path);
    expect(files).toEqual(
      expect.arrayContaining([
        "statev2.sqlite",
        "dashboard.sqlite",
        "settings.json",
        "secrets/pairing",
        "attachments/a.txt",
        "providers/antigravity/profile.json",
      ]),
    );
    expect(files).not.toContain("logs/runtime.log");
    expect(files).not.toContain("server-runtime.json");
    expect(files.some((file) => file.endsWith("-wal") || file.endsWith("-shm"))).toBe(false);
    if (process.platform !== "win32") {
      expect(
        (await NodeFSP.stat(NodePath.join(h.root, "maintenance", "restore-points", id))).mode &
          0o077,
      ).toBe(0);
      expect(
        (
          await NodeFSP.stat(
            NodePath.join(
              h.root,
              "maintenance",
              "restore-points",
              id,
              "userdata",
              "secrets",
              "pairing",
            ),
          )
        ).mode & 0o077,
      ).toBe(0);
    }
  });

  it("counts, snapshots, rescues and restores conversation evidence in userdata", async () => {
    const h = await home();
    const evidence = NodePath.join(
      h.state,
      "conversation-evidence",
      "thread-hash",
      "browser-screenshot-example-test.png",
    );
    await NodeFSP.mkdir(NodePath.dirname(evidence), { recursive: true });
    const original = Buffer.alloc(64 * 1024, 0x31);
    await NodeFSP.writeFile(evidence, original);
    const requirement = await snapshotRequirement(h.root);
    expect(requirement.requiredAdditionalBytes).toBeGreaterThanOrEqual(original.byteLength);

    const snapshotId = await createSnapshot(h.root, "tx-evidence", { restrict: noAcl });
    const snapshot = await verifySnapshot(h.root, snapshotId);
    expect(snapshot.files).toContainEqual(
      expect.objectContaining({
        path: "conversation-evidence/thread-hash/browser-screenshot-example-test.png",
        bytes: original.byteLength,
      }),
    );

    await NodeFSP.writeFile(evidence, "newer bytes");
    const rescueId = await createSnapshot(h.root, "tx-evidence", {
      kind: "rescue",
      restrict: noAcl,
    });
    const rescue = await verifySnapshot(h.root, rescueId);
    expect(rescue.kind).toBe("rescue");
    expect(rescue.files.map((file) => file.path)).toContain(
      "conversation-evidence/thread-hash/browser-screenshot-example-test.png",
    );

    await restoreSnapshot(h.root, snapshotId, "tx-evidence", noAcl);
    expect(await NodeFSP.readFile(evidence)).toEqual(original);
    h.close();
  });

  it("detects a tampered byte, a missing file and an extra file", async () => {
    const h = await home();
    const id = await createSnapshot(h.root, "tx1", { restrict: noAcl });
    h.close();
    const payload = NodePath.join(h.root, "maintenance", "restore-points", id, "userdata");
    await NodeFSP.appendFile(NodePath.join(payload, "settings.json"), "x");
    await expect(verifySnapshot(h.root, id)).rejects.toThrow("checksum mismatch");
    await NodeFSP.writeFile(NodePath.join(payload, "settings.json"), '{"theme":"dark"}');
    await verifySnapshot(h.root, id);
    await NodeFSP.writeFile(NodePath.join(payload, "extra"), "x");
    await expect(verifySnapshot(h.root, id)).rejects.toThrow("does not match its manifest");
  });

  it("refuses a symbolic link in the state directory instead of following it", async () => {
    const h = await home();
    await NodeFSP.symlink(
      h.root,
      NodePath.join(h.state, "attachments", "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(createSnapshot(h.root, "tx1", { restrict: noAcl })).rejects.toThrow(
      "symbolic links",
    );
    h.close();
    expect(await listRestorePoints(h.root)).toEqual([]);
  });

  it("refuses relocated userdata before capacity, snapshot, rescue or restore can alter it", async () => {
    const h = await home();
    h.close();
    const id = await createSnapshot(h.root, "tx-relocated", { restrict: noAcl });
    const moved = NodePath.join(h.root, "relocated-userdata");
    await NodeFSP.rename(h.state, moved);
    await NodeFSP.symlink(moved, h.state, process.platform === "win32" ? "junction" : "dir");
    const originalSettings = await NodeFSP.readFile(NodePath.join(moved, "settings.json"));

    await expect(snapshotRequirement(h.root)).rejects.toThrow("relocated userdata");
    await expect(createSnapshot(h.root, "tx-relocated", { restrict: noAcl })).rejects.toThrow(
      "relocated userdata",
    );
    await expect(
      createSnapshot(h.root, "tx-relocated", { kind: "rescue", restrict: noAcl }),
    ).rejects.toThrow("relocated userdata");
    await expect(restoreSnapshot(h.root, id, "tx-relocated", noAcl)).rejects.toThrow(
      "relocated userdata",
    );

    expect((await NodeFSP.lstat(h.state)).isSymbolicLink()).toBe(true);
    expect(await NodeFSP.readFile(NodePath.join(moved, "settings.json"))).toEqual(originalSettings);
    expect(await NodeFSP.stat(NodePath.join(moved, "statev2.sqlite"))).toBeDefined();
  });

  it("restores older data over newer data, keeping logs, and replays safely after a crash mid-swap", async () => {
    const h = await home(["before"]);
    const id = await createSnapshot(h.root, "tx1", { restrict: noAcl });
    h.database.prepare("INSERT INTO messages VALUES ('after the update')").run();
    h.close();
    await NodeFSP.writeFile(NodePath.join(h.state, "settings.json"), '{"theme":"light"}');
    // Simulate a crash after the old directory moved aside but before the stage landed.
    await NodeFSP.rename(h.state, NodePath.join(h.root, ".maintenance-replaced-tx1"));
    await restoreSnapshot(h.root, id, "tx1", noAcl);
    expect(messages(NodePath.join(h.state, "statev2.sqlite"))).toEqual(["before"]);
    expect(await NodeFSP.readFile(NodePath.join(h.state, "settings.json"), "utf8")).toBe(
      '{"theme":"dark"}',
    );
    // A second full replay (the journal restarts the whole set) is idempotent.
    await restoreSnapshot(h.root, id, "tx1", noAcl);
    expect(messages(NodePath.join(h.state, "statev2.sqlite"))).toEqual(["before"]);
    expect(
      (await NodeFSP.readdir(h.root)).filter((name) => name.startsWith(".maintenance-")),
    ).toEqual([]);
  });

  it("never swaps in a restore point that fails verification", async () => {
    const h = await home();
    const id = await createSnapshot(h.root, "tx1", { restrict: noAcl });
    h.close();
    await NodeFSP.appendFile(
      NodePath.join(h.root, "maintenance", "restore-points", id, "userdata", "settings.json"),
      "corrupt",
    );
    await expect(restoreSnapshot(h.root, id, "tx1", noAcl)).rejects.toThrow("checksum mismatch");
    expect(await NodeFSP.readFile(NodePath.join(h.state, "settings.json"), "utf8")).toBe(
      '{"theme":"dark"}',
    );
  });

  it("rejects identifiers that could escape the restore point directory", async () => {
    const h = await home();
    h.close();
    await expect(verifySnapshot(h.root, "../../userdata")).rejects.toThrow(
      "Invalid restore point identifier",
    );
  });

  it("reports additional bytes needed for the filesystem that holds the restore point", async () => {
    const h = await home();
    h.close();
    const requirement = await snapshotRequirement(h.root);
    expect(requirement.requiredAdditionalBytes).toBeGreaterThan("device-credential".length);
    expect(requirement.availableBytes).toBeGreaterThan(0);
  });

  it("fails closed when a private copy cannot be restricted instead of swallowing the error", async () => {
    const h = await home();
    h.close();
    const failing = async (directory: string) => {
      if (directory.endsWith("secrets")) throw new Error("ACL denied");
    };
    await expect(createSnapshot(h.root, "tx1", { restrict: failing })).rejects.toThrow(
      "ACL denied",
    );
    expect(await listRestorePoints(h.root)).toEqual([]);
  });

  it("pools capacity per physical filesystem and counts rescue copies and staged artifacts", async () => {
    const a = await home();
    const b = await home();
    a.close();
    b.close();
    const { availableBytes } = await snapshotRequirement(a.root);
    // Two homes on this one disk draw on a single pool, with one margin.
    await assertCapacity([a.root, b.root]);
    await expect(
      assertCapacity([a.root], { artifactBytesByHome: { [a.root]: availableBytes } }),
    ).rejects.toThrow("Not enough free space");
    await expect(
      assertCapacity([a.root, b.root], {
        rescue: true,
        artifactBytesByHome: { [b.root]: availableBytes },
      }),
    ).rejects.toThrow("a");
  });

  it("keeps the newest two restore points and everything pinned, and cleans up discarded ones", async () => {
    const h = await home();
    h.close();
    const ids: string[] = [];
    for (const [index, transaction] of ["a", "b", "c", "d"].entries()) {
      ids.push(
        await createSnapshot(h.root, transaction, {
          restrict: noAcl,
          now: () => new Date(2026, 0, index + 1),
        }),
      );
    }
    const removed = await pruneRestorePoints(h.root, { keep: 2, pinned: new Set([ids[0]!]) });
    expect(removed).toEqual([ids[1]]);
    expect((await listRestorePoints(h.root)).map((point) => point.id)).toEqual([
      ids[0],
      ids[2],
      ids[3],
    ]);
    await discardSnapshot(h.root, ids[0]!);
    expect((await listRestorePoints(h.root)).map((point) => point.id)).toEqual([ids[2], ids[3]]);
  });
});

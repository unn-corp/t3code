// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { parseHomeOperation, runHomeOperation } from "./forkMaintenanceHomeOperations.ts";
import { CoordinatorStore } from "./forkMaintenanceStore.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function home() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-home-ops-"));
  roots.push(root);
  await NodeFSP.mkdir(NodePath.join(root, "userdata"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(root, "userdata", "statev2.sqlite"));
  database.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one')");
  database.close();
  await NodeFSP.writeFile(NodePath.join(root, "userdata", "settings.json"), "{}");
  return root;
}

describe("home operations (the WSL control channel's verbs)", () => {
  it("snapshots, lists, verifies, restores and discards a home through the same JSON verbs a distribution would run", async () => {
    const root = await home();
    const snapshot = await runHomeOperation(root, { op: "snapshot", transactionId: "tx1" });
    expect(snapshot.ok).toBe(true);
    const id = (snapshot as { value: string }).value;
    expect(await runHomeOperation(root, { op: "list" })).toMatchObject({
      ok: true,
      value: [{ id, kind: "restore-point" }],
    });
    expect(await runHomeOperation(root, { op: "verify", snapshotId: id })).toMatchObject({
      ok: true,
      value: { id },
    });
    await NodeFSP.writeFile(NodePath.join(root, "userdata", "settings.json"), '{"changed":true}');
    expect(
      await runHomeOperation(root, { op: "restore", snapshotId: id, transactionId: "tx1" }),
    ).toEqual({ ok: true, value: true });
    expect(await NodeFSP.readFile(NodePath.join(root, "userdata", "settings.json"), "utf8")).toBe(
      "{}",
    );
    expect(await runHomeOperation(root, { op: "discard", snapshotId: id })).toEqual({
      ok: true,
      value: true,
    });
    expect(await runHomeOperation(root, { op: "list" })).toEqual({ ok: true, value: [] });
  });

  it("reports failures as data instead of throwing, so the Windows side can abort the whole cohort", async () => {
    const root = await home();
    expect(
      await runHomeOperation(root, { op: "verify", snapshotId: "tx-nope-restore-point-00000000" }),
    ).toMatchObject({ ok: false });
    expect(
      await runHomeOperation(root, { op: "restore", snapshotId: "../x", transactionId: "tx" }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Invalid restore point identifier"),
    });
    expect(
      await runHomeOperation(root, { op: "capacity", artifactBytes: Number.MAX_SAFE_INTEGER }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("Not enough free space") });
  });

  it("refuses to restore while a live runtime still owns the home", async () => {
    const root = await home();
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-home-ops-coordinator-"),
    );
    roots.push(directory);
    const store = await CoordinatorStore.open(NodePath.join(directory, "c"));
    await store.register(
      { id: "runtime", label: "Runtime", kind: "service", homes: [root], updateTarget: true },
      Date.now(),
    );
    const canonical = await NodeFSP.realpath(root);
    const snapshot = await runHomeOperation(canonical, { op: "snapshot", transactionId: "tx1" });
    const id = (snapshot as { value: string }).value;
    expect(
      await runHomeOperation(
        canonical,
        { op: "restore", snapshotId: id, transactionId: "tx1" },
        { store },
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("still owns this data home") });
    await store.unregister("runtime");
    expect(
      await runHomeOperation(
        canonical,
        { op: "restore", snapshotId: id, transactionId: "tx1" },
        { store },
      ),
    ).toEqual({ ok: true, value: true });
  });

  it("parses the argument vector the desktop sends and rejects malformed ones", () => {
    expect(parseHomeOperation(["snapshot", "--home", "/h", "--transaction", "t"])).toEqual({
      home: "/h",
      operation: { op: "snapshot", transactionId: "t" },
    });
    expect(
      parseHomeOperation(["prune", "--home", "/h", "--keep", "2", "--pin", "a", "--pin", "b"]),
    ).toEqual({ home: "/h", operation: { op: "prune", keep: 2, pinned: ["a", "b"] } });
    expect(
      parseHomeOperation([
        "capacity",
        "--home",
        "/h",
        "--rescue",
        "true",
        "--artifact-bytes",
        "10",
      ]),
    ).toEqual({ home: "/h", operation: { op: "capacity", rescue: true, artifactBytes: 10 } });
    expect(parseHomeOperation(["snapshot", "--home", "/h"])).toEqual({
      error: "--transaction is required.",
    });
    expect(parseHomeOperation(["bogus", "--home", "/h"])).toEqual({
      error: "Unknown home operation bogus.",
    });
    expect(parseHomeOperation(["list"])).toEqual({ error: "--home is required." });
    expect(parseHomeOperation(["list", "--home"])).toEqual({
      error: "Malformed arguments near --home.",
    });
  });
});

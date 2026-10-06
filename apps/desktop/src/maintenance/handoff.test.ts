// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { decodeHandoffPlan } from "@t3tools/shared/forkDesktopHandoff";
import type { RecoveryCommand } from "@t3tools/shared/forkRecoveryCache";

import {
  helperEnvironment,
  launchHandoff,
  listHandoffPlans,
  pruneHandoffPlans,
  retainedInstallPlan,
  writeHandoffPlan,
  type HandoffPlan,
} from "./handoff.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

const plan: HandoffPlan = {
  protocol: 1,
  mode: "install",
  transactionId: "u1-abc",
  coordinatorDirectory: "/state/t3-fork-maintenance",
  owner: { pid: 4242, started: "boot:1" },
  packaging: "appimage",
  installer: { path: "/cache/new.AppImage", sha256: "a".repeat(64) },
  previousInstaller: { path: "/cache/old.AppImage", sha256: "b".repeat(64) },
  installTarget: "/Apps/T3-Code.AppImage",
  relaunch: { command: "/Apps/T3-Code.AppImage", args: [] },
  waitForExitMs: 60_000,
};
const command: RecoveryCommand = {
  protocol: 1,
  version: "1.1.0",
  platform: "linux-x64",
  nodePath: "/cache/node",
  helperPath: "/cache/helper.mjs",
  nodeSha256: "c".repeat(64),
  helperSha256: "d".repeat(64),
  installedAt: 1,
};

describe("launchHandoff", () => {
  it("writes an owner-only plan the helper can decode and starts the cached runtime on the cached helper", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-plan-"));
    directories.push(directory);
    const started: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    await launchHandoff({
      directory,
      plan,
      command,
      spawn: async (spawned, args) => void started.push({ command: spawned, args }),
    });
    expect(started).toHaveLength(1);
    // Never Electron and never a system Node: the absolute cached runtime, the cached helper, one verb.
    expect(started[0]!.command).toBe("/cache/node");
    expect(started[0]!.args.slice(0, 3)).toEqual(["/cache/helper.mjs", "handoff", "--plan"]);
    const file = started[0]!.args[3]!;
    expect(decodeHandoffPlan(await NodeFSP.readFile(file, "utf8"))).toEqual(plan);
    // oxlint-disable-next-line t3code/no-global-process-runtime -- These tests assert POSIX file modes, which Windows does not report.
    if (process.platform !== "win32") expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("does not start anything when the plan cannot be written", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-plan-"));
    directories.push(directory);
    // The plan directory's parent is a file, so it cannot be created.
    await NodeFSP.writeFile(NodePath.join(directory, "blocker"), "x");
    const started: string[] = [];
    await expect(
      launchHandoff({
        directory: NodePath.join(directory, "blocker", "plans"),
        plan,
        command,
        spawn: async (spawned) => void started.push(spawned),
      }),
    ).rejects.toThrow();
    expect(started).toEqual([]);
  });
});

describe("helperEnvironment", () => {
  it("keeps the person's session so the authorization prompt and the relaunched window can appear", () => {
    const env = helperEnvironment(
      {
        DISPLAY: ":1",
        WAYLAND_DISPLAY: "wayland-0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        XDG_RUNTIME_DIR: "/run/user/1000",
        HOME: "/home/person",
        LANG: "en_US.UTF-8",
      },
      ":",
    );
    expect(env).toEqual({
      DISPLAY: ":1",
      WAYLAND_DISPLAY: "wayland-0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HOME: "/home/person",
      LANG: "en_US.UTF-8",
    });
  });

  it("drops what belongs to the process being replaced and the mount that goes away with it", () => {
    const env = helperEnvironment(
      {
        DISPLAY: ":1",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--inspect",
        T3CODE_MAINTENANCE_TRIAL: "{}",
        APPIMAGE: "/Apps/T3-Code.AppImage",
        APPDIR: "/tmp/.mount_T3-Cod",
        PATH: "/tmp/.mount_T3-Cod/usr/bin:/usr/bin:/bin",
        LD_LIBRARY_PATH: "/tmp/.mount_T3-Cod/usr/lib",
        XDG_DATA_DIRS: "/tmp/.mount_T3-Cod/usr/share:/usr/share",
      },
      ":",
    );
    expect(env).toEqual({
      DISPLAY: ":1",
      PATH: "/usr/bin:/bin",
      XDG_DATA_DIRS: "/usr/share",
    });
  });
});

describe("retained handoff plans", () => {
  const withPlan = (transactionId: string, mode: HandoffPlan["mode"]): HandoffPlan => ({
    ...plan,
    transactionId,
    mode,
    installer: { path: `/cache/${transactionId}.AppImage`, sha256: transactionId.padEnd(64, "a") },
    previousInstaller: { path: "/cache/prev.AppImage", sha256: "p".repeat(1).padEnd(64, "b") },
  });

  it("keeps the plans of recoverable transactions, claimed or not, and reports the payloads they name", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-plan-"));
    directories.push(directory);
    const kept = withPlan("u2-kept", "install");
    const claimed = await writeHandoffPlan(directory, kept);
    await NodeFSP.rename(claimed, `${claimed}.consumed`);
    await writeHandoffPlan(directory, withPlan("u2-kept", "revert"));
    await writeHandoffPlan(directory, withPlan("u1-old", "install"));
    // Not a plan: left exactly as found.
    await NodeFSP.writeFile(NodePath.join(directory, "notes.txt"), "keep");

    const digests = await pruneHandoffPlans(directory, new Set(["u2-kept"]));

    expect(digests).toEqual(new Set([kept.installer.sha256, kept.previousInstaller!.sha256]));
    expect((await NodeFSP.readdir(directory)).toSorted()).toEqual([
      "notes.txt",
      "u2-kept-install.json.consumed",
      "u2-kept-revert.json",
    ]);
    expect((await listHandoffPlans(directory)).map((entry) => entry.plan.transactionId)).toEqual([
      "u2-kept",
      "u2-kept",
    ]);
    // The plan a recovery reverses is the install plan, found even after the helper claimed it.
    expect((await retainedInstallPlan(directory, "u2-kept"))?.path).toBe(
      NodePath.join(directory, "u2-kept-install.json.consumed"),
    );
    expect(await retainedInstallPlan(directory, "u1-old")).toBeNull();
  });
});

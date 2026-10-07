// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CoordinatorStore } from "./forkMaintenanceStore.ts";
import { newJournal } from "./forkMaintenanceJournal.ts";
import {
  applicationRelaunchEnvironment,
  captureRelaunchEnvironment,
  encodeHandoffPlan,
  HANDOFF_EXIT,
  runDesktopHandoff,
  type HandoffIo,
  type HandoffPlan,
} from "./forkDesktopHandoff.ts";
import { restrictWindowsAcl } from "./forkMaintenanceSnapshot.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
const sha = (bytes: string) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

async function expectPrivateWindowsDirectory(directory: string) {
  const encodedPath = Buffer.from(directory, "utf16le").toString("base64");
  const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $entries=@((Get-Acl -LiteralPath $target).Access | ForEach-Object { [PSCustomObject]@{ sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString(); inherited=$_.IsInherited } }); [PSCustomObject]@{ userSid=$user; entries=$entries } | ConvertTo-Json -Compress -Depth 3`;
  const output = NodeChildProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  const acl = JSON.parse(output) as {
    userSid: string;
    entries: Array<{ sid: string; type: string; rights: string; inherited: boolean }>;
  };
  expect(
    acl.entries.some(
      (entry) =>
        entry.sid === acl.userSid &&
        entry.type === "Allow" &&
        entry.rights.includes("FullControl") &&
        !entry.inherited,
    ),
  ).toBe(true);
  const broadPrincipals = new Set(["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]);
  expect(
    acl.entries.filter((entry) => entry.type === "Allow" && broadPrincipals.has(entry.sid)),
  ).toEqual([]);
}

async function setup(overrides: Partial<HandoffPlan> = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-"));
  directories.push(root);
  // Match the private parent directory production uses before writing its handoff plan.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The fixture must exercise the real Windows ACL path on Windows CI.
  if (process.platform === "win32") await restrictWindowsAcl(root);
  const installer = NodePath.join(root, "target.AppImage");
  const previous = NodePath.join(root, "previous.AppImage");
  const target = NodePath.join(root, "T3-Code.AppImage");
  await NodeFSP.writeFile(installer, "target build");
  await NodeFSP.writeFile(previous, "previous build");
  await NodeFSP.writeFile(target, "running build");
  const plan: HandoffPlan = {
    protocol: 1,
    mode: "install",
    transactionId: "u1",
    coordinatorDirectory: NodePath.join(root, "coordinator"),
    owner: { pid: 100, started: "boot:100" },
    packaging: "appimage",
    installer: { path: installer, sha256: sha("target build") },
    previousInstaller: { path: previous, sha256: sha("previous build") },
    installTarget: target,
    relaunch: { command: target, args: ["--relaunched"] },
    waitForExitMs: 1000,
    ...overrides,
  };
  const file = NodePath.join(root, "plan.json");
  await NodeFSP.writeFile(file, encodeHandoffPlan(plan), { mode: 0o600 });
  const calls: Array<{ kind: "run" | "start"; command: string; args: ReadonlyArray<string> }> = [];
  const owner = { alive: true };
  const identity = async (pid: number) =>
    pid === 100 && owner.alive ? "boot:100" : pid === 800 ? "boot:helper" : null;
  const originalStore = await CoordinatorStore.open(plan.coordinatorDirectory, identity, 100);
  await originalStore.register(
    { id: "desktop", label: "Fixture desktop", kind: "desktop", homes: [root], updateTarget: true },
    0,
  );
  await originalStore.confirmBootstrap();
  await originalStore.observe("desktop", [], 0);
  await originalStore.observe("desktop", [], 600_000);
  await originalStore.freeze(plan.transactionId, 600_000, {
    intent: newJournal({
      id: plan.transactionId,
      kind: "update",
      homes: [root],
      previous: { version: "1.0.0", artifactSha256: sha("previous build") },
      target: { version: "1.0.1", artifactSha256: sha("target build") },
      now: 600_000,
    }),
  });
  const journal = {
    ...newJournal({
      id: plan.transactionId,
      kind: "update",
      homes: [root],
      previous: { version: "1.0.0", artifactSha256: sha("previous build") },
      target: { version: "1.0.1", artifactSha256: sha("target build") },
      now: 600_000,
    }),
    phase: plan.mode === "install" ? ("trial" as const) : ("restored" as const),
  };
  await originalStore.writeJournal(journal);
  await originalStore.recordDesktopHandoffAuthorization(plan.transactionId, {
    mode: plan.mode,
    buildArtifactSha256:
      plan.mode === "install" ? journal.target!.artifactSha256 : journal.previous.artifactSha256,
    artifactSha256: plan.mode === "install" ? sha("target build") : sha("previous build"),
    counterpartSha256: plan.mode === "install" ? sha("previous build") : sha("target build"),
  });
  owner.alive = false;
  const coordinator = await CoordinatorStore.open(plan.coordinatorDirectory, identity, 800);
  const clock = { value: 0 };
  const logs: string[] = [];
  const io: HandoffIo = {
    identity,
    openCoordinator: async () => coordinator,
    now: () => clock.value,
    sleep: async (ms) => {
      clock.value += ms;
    },
    run: async (command, args) => {
      calls.push({ kind: "run", command, args });
      return runResult.code;
    },
    startDetached: async (command, args) => {
      calls.push({ kind: "start", command, args });
    },
    log: (line) => logs.push(line),
    // oxlint-disable-next-line t3code/no-global-process-runtime -- These tests assert POSIX file modes and ownership, which Windows does not report.
    platform: process.platform,
    uid: process.getuid?.() ?? null,
  };
  const runResult = { code: 0 };
  return { root, file, plan, io, calls, owner, logs, runResult, target, coordinator, journal };
}

describe("runDesktopHandoff", () => {
  it("retains the app's custom homes and profile overrides without recording secrets or inheriting terminal overrides", async () => {
    const recorded = captureRelaunchEnvironment(
      {
        HOME: "/app-user",
        XDG_CONFIG_HOME: "/app-profile",
        CODEX_HOME: "/app-provider",
        T3CODE_PORT: "13883",
        GITHUB_TOKEN: "secret",
        NODE_OPTIONS: "--require old-mount.cjs",
        APPDIR: "/old-mount",
      },
      "/custom-t3-home",
      "/custom-coordinator",
    );
    const env = applicationRelaunchEnvironment(
      {
        HOME: "/recovery-terminal-user",
        XDG_CONFIG_HOME: "/terminal-profile",
        XDG_DATA_HOME: "/terminal-data",
        T3CODE_HOME: "/wrong-home",
        T3CODE_MAINTENANCE_NAMESPACE: "/wrong-coordinator",
        ELECTRON_RUN_AS_NODE: "1",
        DISPLAY: ":0",
      },
      recorded,
    );
    expect(recorded).toEqual({
      HOME: "/app-user",
      XDG_CONFIG_HOME: "/app-profile",
      CODEX_HOME: "/app-provider",
      T3CODE_PORT: "13883",
      T3CODE_HOME: "/custom-t3-home",
      T3CODE_MAINTENANCE_NAMESPACE: "/custom-coordinator",
    });
    expect(env).toEqual({ ...recorded, DISPLAY: ":0" });

    const fixture = await setup();
    const bound = {
      ...recorded,
      T3CODE_HOME: fixture.root,
      T3CODE_MAINTENANCE_NAMESPACE: fixture.plan.coordinatorDirectory,
    };
    await NodeFSP.writeFile(
      fixture.file,
      encodeHandoffPlan({
        ...fixture.plan,
        relaunch: { ...fixture.plan.relaunch, environment: bound },
      }),
    );
    let launched: unknown;
    const io: HandoffIo = {
      ...fixture.io,
      startDetached: async (_command, _args, environment) => {
        launched = environment;
      },
    };
    expect(await runDesktopHandoff(fixture.file, io)).toBe(HANDOFF_EXIT.ok);
    expect(launched).toEqual(bound);
  });
  it("refuses foreign relaunch locations before consuming a plan or replacing the binary", async () => {
    for (const wrong of ["T3CODE_HOME", "T3CODE_MAINTENANCE_NAMESPACE"] as const) {
      const fixture = await setup();
      const environment = {
        T3CODE_HOME: fixture.root,
        T3CODE_MAINTENANCE_NAMESPACE: fixture.plan.coordinatorDirectory,
        [wrong]: fixture.plan.installer.path,
      };
      await NodeFSP.writeFile(
        fixture.file,
        encodeHandoffPlan({ ...fixture.plan, relaunch: { ...fixture.plan.relaunch, environment } }),
      );
      expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.admissionRefused);
      expect(await NodeFSP.readFile(fixture.target, "utf8")).toBe("running build");
      expect((await fixture.coordinator.fenceSnapshot())?.consumedHandoffs ?? []).toEqual([]);
      expect(fixture.calls).toEqual([]);
    }
  });
  it("blocks on the actual AppImage filesystem before consuming a plan or changing its prior binary", async () => {
    const fixture = await setup();
    expect(
      await runDesktopHandoff(fixture.file, { ...fixture.io, availableBytes: async () => 0 }),
    ).toBe(HANDOFF_EXIT.admissionRefused);
    expect(await NodeFSP.readFile(fixture.target, "utf8")).toBe("running build");
    expect(await NodeFSP.readFile(fixture.file, "utf8")).toContain('"transactionId":"u1"');
    expect(fixture.calls).toEqual([]);
    expect((await fixture.coordinator.fenceSnapshot())?.consumedHandoffs ?? []).toEqual([]);
  });
  it("refuses a self-hashed revert payload that differs from its recorded authorization", async () => {
    const fixture = await setup({ mode: "revert" });
    await NodeFSP.writeFile(
      fixture.file,
      encodeHandoffPlan({
        ...fixture.plan,
        installer: { path: fixture.plan.installer.path, sha256: sha("target build") },
      }),
      { mode: 0o600 },
    );
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.admissionRefused);
    expect(fixture.calls).toEqual([]);
  });

  it("refuses a plan naming a different exited owner", async () => {
    const fixture = await setup();
    await NodeFSP.writeFile(
      fixture.file,
      encodeHandoffPlan({ ...fixture.plan, owner: { pid: 101, started: "another-owner" } }),
      { mode: 0o600 },
    );
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.admissionRefused);
    expect(fixture.calls).toEqual([]);
  });
  it("refuses a retained plan after commit and release even when its payload still verifies", async () => {
    const fixture = await setup();
    await fixture.coordinator.writeJournal({ ...fixture.journal, phase: "committed" });
    await fixture.coordinator.releaseFence(fixture.plan.transactionId);
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.admissionRefused);
    expect(fixture.calls).toEqual([]);
    expect(await NodeFSP.readFile(fixture.target, "utf8")).toBe("running build");
  });

  it("consumes a plan once and refuses a recreated copy while the transaction is still in trial", async () => {
    const fixture = await setup();
    const retained = await NodeFSP.readFile(fixture.file, "utf8");
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.ok);
    await NodeFSP.writeFile(fixture.file, retained, { mode: 0o600 });
    fixture.calls.length = 0;
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.admissionRefused);
    expect(fixture.calls).toEqual([]);
  });

  it("keeps other startup and restoration blocked until the external installer completes", async () => {
    const fixture = await setup({ packaging: "deb" });
    let checked = false;
    const io = {
      ...fixture.io,
      run: async () => {
        expect((await fixture.coordinator.status(600_000)).fence?.holderAlive).toBe(true);
        await expect(
          fixture.coordinator.takeOverAbandonedFence(fixture.plan.transactionId),
        ).rejects.toThrow("external installer");
        checked = true;
        return 0;
      },
    };
    expect(await runDesktopHandoff(fixture.file, io)).toBe(HANDOFF_EXIT.ok);
    expect(checked).toBe(true);
    expect((await fixture.coordinator.status(600_000)).fence?.holderAlive).toBe(false);
  });

  it("refuses a handoff that no longer matches the journal phase", async () => {
    const fixture = await setup();
    await fixture.coordinator.writeJournal({ ...fixture.journal, phase: "restoring" });
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.admissionRefused);
    expect(fixture.calls).toEqual([]);
  });
  it("replaces an AppImage after the owner exits, keeps the previous file, and starts the new build", async () => {
    const fixture = await setup();
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.ok);
    expect(await NodeFSP.readFile(fixture.target, "utf8")).toBe("target build");
    expect(await NodeFSP.readFile(`${fixture.target}.previous`, "utf8")).toBe("running build");
    // oxlint-disable-next-line t3code/no-global-process-runtime -- These tests assert POSIX file modes and ownership, which Windows does not report.
    if (process.platform !== "win32")
      expect((await NodeFSP.stat(fixture.target)).mode & 0o111).not.toBe(0);
    expect(fixture.calls).toEqual([
      { kind: "start", command: fixture.target, args: ["--relaunched"] },
    ]);
  });

  it("changes nothing when the owner never exits", async () => {
    const fixture = await setup();
    fixture.owner.alive = true;
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.ownerStillRunning);
    expect(await NodeFSP.readFile(fixture.target, "utf8")).toBe("running build");
    expect(fixture.calls).toEqual([]);
  });

  it("changes nothing when a payload does not match its recorded digest", async () => {
    const fixture = await setup();
    await NodeFSP.writeFile(fixture.plan.installer.path, "tampered");
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.payloadMismatch);
    expect(await NodeFSP.readFile(fixture.target, "utf8")).toBe("running build");
    expect(fixture.calls).toEqual([]);
  });

  it("refuses to trust the previous build's payload being swapped either", async () => {
    const fixture = await setup();
    await NodeFSP.writeFile(fixture.plan.previousInstaller!.path, "tampered");
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.payloadMismatch);
    expect(await NodeFSP.readFile(fixture.target, "utf8")).toBe("running build");
  });

  // The production writer stores the plan in this exact kind of private directory. POSIX
  // protects the plan mode; Windows protects its parent with an explicit current-user ACL.
  it("enforces plan privacy using the host platform's file protection", async () => {
    const fixture = await setup();
    // oxlint-disable-next-line t3code/no-global-process-runtime -- This test intentionally selects the real host's file protection mechanism.
    if (process.platform === "win32") {
      await expectPrivateWindowsDirectory(fixture.root);
      expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.ok);
      expect(fixture.calls.map(({ kind }) => kind)).toEqual(["start"]);
      expect((await NodeFSP.stat(`${fixture.file}.consumed`)).isFile()).toBe(true);
    } else {
      await NodeFSP.chmod(fixture.file, 0o644);
      expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.badPlan);
      expect(fixture.calls).toEqual([]);
    }
  });

  it("refuses a malformed plan", async () => {
    const fixture = await setup();
    await NodeFSP.writeFile(fixture.file, '{"protocol":2}', { mode: 0o600 });
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.badPlan);
  });

  it("runs the NSIS installer silently, flagged as an update, and starts the application after binary replacement", async () => {
    const fixture = await setup({ packaging: "nsis" });
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.ok);
    expect(fixture.calls).toEqual([
      {
        kind: "run",
        command: fixture.plan.installer.path,
        args: ["/S", "--updated"],
      },
      { kind: "start", command: fixture.target, args: ["--relaunched"] },
    ]);
  });

  it("asks the system to authorize a Debian package install, visibly, through pkexec", async () => {
    const fixture = await setup({ packaging: "deb" });
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.ok);
    expect(fixture.calls[0]).toEqual({
      kind: "run",
      command: "pkexec",
      args: ["dpkg", "-i", fixture.plan.installer.path],
    });
    expect(fixture.calls[1]?.kind).toBe("start");
  });

  it("starts the application that was there when the installer fails, so its journal decides", async () => {
    const fixture = await setup({ packaging: "nsis" });
    fixture.runResult.code = 1;
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.installFailed);
    expect(fixture.calls.at(-1)).toEqual({
      kind: "start",
      command: fixture.target,
      args: ["--relaunched"],
    });
  });

  it("puts the previous build back in revert mode", async () => {
    const fixture = await setup({ mode: "revert", installer: { path: "", sha256: "" } });
    // Revert plans name the previous build as the installer to put in place.
    const previous = fixture.plan.previousInstaller!;
    await NodeFSP.writeFile(
      fixture.file,
      encodeHandoffPlan({
        ...fixture.plan,
        mode: "revert",
        installer: previous,
        previousInstaller: {
          path: NodePath.join(fixture.root, "target.AppImage"),
          sha256: sha("target build"),
        },
      }),
      { mode: 0o600 },
    );
    expect(await runDesktopHandoff(fixture.file, fixture.io)).toBe(HANDOFF_EXIT.ok);
    expect(await NodeFSP.readFile(fixture.target, "utf8")).toBe("previous build");
  });
});

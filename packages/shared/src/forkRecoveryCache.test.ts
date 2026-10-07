/* oxlint-disable t3code/no-global-process-runtime -- node-only filesystem coordinator: the host platform is the point */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
// oxlint-disable-next-line t3code/namespace-node-imports -- fault injection needs the mutable builtin default, not its immutable ESM namespace
import MutableFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import type { ForkReleaseManifest } from "@t3tools/contracts";
import type { ForkPlatformKey } from "./forkMaintenance.ts";
import {
  installRecoveryHelper,
  promoteRecoveryDirectory,
  readRecoveryCommand,
  recoveryInvocation,
  recoveryReady,
} from "./forkRecoveryCache.ts";
import { recoveryProofEnvironment } from "./forkRecoveryProofEnvironment.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  NodeModule.syncBuiltinESMExports();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const HOST_PLATFORM: ForkPlatformKey = process.platform === "win32" ? "windows-x64" : "linux-x64";

/** A real Node runtime (this one) stands in for the runner-copied binary, so the self-test truly runs. */
let nodeBytes: Uint8Array | undefined;
const realNode = async () => (nodeBytes ??= await NodeFSP.readFile(process.execPath));
const helperScript = (line = "recovery-helper-protocol=1") =>
  new TextEncoder().encode(`
    import * as fs from "node:fs";
    import * as os from "node:os";
    import * as path from "node:path";
    const env = process.env;
    const expectedPath = process.platform === "win32"
      ? [path.win32.join(env.SystemRoot, "System32"), path.win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";")
      : "";
    const forbidden = ["NODE_OPTIONS", "PSModulePath", "T3CODE_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID"];
    if (env.PATH !== expectedPath || !env.HOME || !env.T3CODE_MAINTENANCE_NAMESPACE ||
        env.T3CODE_MAINTENANCE_NAMESPACE === env.T3CODE_HOME ||
        forbidden.some((key) => env[key] !== undefined) ||
        !fs.statSync(env.HOME).isDirectory() || !fs.statSync(os.tmpdir()).isDirectory() ||
        !fs.statSync(env.T3CODE_MAINTENANCE_NAMESPACE).isDirectory() ||
        (process.platform === "win32" && (!fs.statSync(env.APPDATA).isDirectory() || !fs.statSync(env.LOCALAPPDATA).isDirectory()))) process.exit(31);
    console.log(${JSON.stringify(line)});
  `);

function manifest(version: string, helper: Uint8Array, node: Uint8Array): ForkReleaseManifest {
  const base = {
    format: 1 as const,
    repository: "unn-corp/t3code" as const,
    version,
    commit: "a".repeat(40),
    channel: "stable" as const,
    releasedAt: "2026-10-05T00:00:00Z",
    android: { normal: null as never, recovery: null as never },
    checks: { build: true, install: true, update: true, recovery: true },
  };
  return {
    ...base,
    assets: [
      {
        name:
          HOST_PLATFORM === "windows-x64"
            ? "t3-recovery-helper-windows-x64.mjs"
            : "t3-recovery-helper-linux-x64.mjs",
        sha256: digest(helper),
        bytes: helper.length,
        kind: "recovery-helper",
        platform: HOST_PLATFORM,
      },
      {
        name:
          HOST_PLATFORM === "windows-x64"
            ? "t3-recovery-node-windows-x64.exe"
            : "t3-recovery-node-linux-x64",
        sha256: digest(node),
        bytes: node.length,
        kind: "recovery-helper",
        platform: HOST_PLATFORM,
      },
    ],
  } as unknown as ForkReleaseManifest;
}
const proofPaths = {
  root: "C:\\isolated",
  cwd: "C:\\isolated\\work",
  home: "C:\\isolated\\home",
  temp: "C:\\isolated\\temp",
  appData: "C:\\isolated\\appdata",
  localAppData: "C:\\isolated\\local-appdata",
  coordinator: "C:\\isolated\\coordinator",
};
const cacheDir = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-recovery-cache-"));
  roots.push(root);
  return NodePath.join(root, "recovery");
};
const serve = (helper: Uint8Array, node: Uint8Array) => async (name: string) =>
  name.endsWith(".mjs") ? helper : node;

describe("recovery helper cache", () => {
  it("promotes proven staging after transient runtime sharing locks", async () => {
    const dir = await cacheDir();
    const staging = NodePath.join(dir, ".staging-test");
    const target = NodePath.join(dir, "1.0.2");
    await NodeFSP.mkdir(staging, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(staging, "runtime"), "verified bytes");
    const rename = NodeFSP.rename;
    let attempts = 0;
    vi.spyOn(MutableFSP, "rename").mockImplementation(async (from, to) => {
      if (from === staging && ++attempts < 3)
        throw Object.assign(new Error("Runtime is briefly locked"), { code: "EPERM" });
      return rename(from, to);
    });
    NodeModule.syncBuiltinESMExports();
    await promoteRecoveryDirectory(staging, target);
    expect(attempts).toBe(3);
    expect(await NodeFSP.readFile(NodePath.join(target, "runtime"), "utf8")).toBe("verified bytes");
    await expect(NodeFSP.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks persistent promotion locks and preserves the existing recovery pointer", async () => {
    const dir = await cacheDir();
    const staging = NodePath.join(dir, ".staging-test");
    const target = NodePath.join(dir, "1.0.2");
    await NodeFSP.mkdir(staging, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, "current.json"), "previous recovery");
    const locked = Object.assign(new Error("Runtime remains locked"), { code: "EPERM" });
    const rename = vi.spyOn(MutableFSP, "rename").mockRejectedValue(locked);
    NodeModule.syncBuiltinESMExports();
    await expect(promoteRecoveryDirectory(staging, target)).rejects.toBe(locked);
    expect(rename).toHaveBeenCalledTimes(5);
    expect(await NodeFSP.readFile(NodePath.join(dir, "current.json"), "utf8")).toBe(
      "previous recovery",
    );
    expect((await NodeFSP.stat(staging)).isDirectory()).toBe(true);
    await expect(NodeFSP.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not retry unrelated promotion failures", async () => {
    const unavailable = Object.assign(new Error("Different filesystem"), { code: "EXDEV" });
    const rename = vi.spyOn(MutableFSP, "rename").mockRejectedValue(unavailable);
    NodeModule.syncBuiltinESMExports();
    await expect(promoteRecoveryDirectory("staging", "destination")).rejects.toBe(unavailable);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("retries a briefly locked replacement directory and still proves the installed runtime", async () => {
    const dir = await cacheDir();
    const node = await realNode();
    const helper = helperScript();
    const remove = NodeFSP.rm;
    let locks = 2;
    vi.spyOn(MutableFSP, "rm").mockImplementation(async (path, options) => {
      if (path === NodePath.join(dir, "1.0.1") && locks-- > 0)
        throw Object.assign(new Error("Executable is briefly locked"), { code: "EBUSY" });
      return remove(path, options);
    });
    NodeModule.syncBuiltinESMExports();
    await installRecoveryHelper({
      cacheDir: dir,
      manifest: manifest("1.0.1", helper, node),
      platform: HOST_PLATFORM,
      fetchAsset: serve(helper, node),
    });
    expect(locks).toBe(-1);
    expect(await recoveryReady(dir)).toBe(true);
  });

  it("keeps the original proof failure when staging cleanup stays locked, without admitting the build", async () => {
    const dir = await cacheDir();
    const node = await realNode();
    const helper = helperScript("wrong-protocol");
    const remove = NodeFSP.rm;
    const cleanupError = Object.assign(new Error("Staging executable stays locked"), {
      code: "EPERM",
    });
    let cleanupAttempts = 0;
    vi.spyOn(MutableFSP, "rm").mockImplementation(async (path, options) => {
      if (String(path).startsWith(NodePath.join(dir, ".staging-"))) {
        cleanupAttempts++;
        throw cleanupError;
      }
      return remove(path, options);
    });
    NodeModule.syncBuiltinESMExports();
    const result = await installRecoveryHelper({
      cacheDir: dir,
      manifest: manifest("1.0.1", helper, node),
      platform: HOST_PLATFORM,
      fetchAsset: serve(helper, node),
    }).catch((cause: unknown) => cause);
    expect(result).toBeInstanceOf(AggregateError);
    const failure = result as AggregateError;
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as Error).message).toContain("did not report the helper protocol");
    expect(failure.errors).toEqual([failure.cause, cleanupError]);
    expect(cleanupAttempts).toBe(5);
    expect(await recoveryReady(dir)).toBe(false);
  });

  it("builds a Windows proof environment with ACL prerequisites and no inherited developer or secret paths", () => {
    const env = recoveryProofEnvironment({
      platform: "windows-x64",
      paths: proofPaths,
      inherited: {
        SystemRoot: "C:\\Windows",
        SystemDrive: "C:",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        USERNAME: "runner",
        USERDOMAIN: "BUILD",
        PATH: "C:\\dev\\node;C:\\Windows\\System32",
        PSModulePath: "C:\\dev\\powershell-modules",
        NODE_OPTIONS: "--require C:\\dev\\hook.js",
        T3CODE_HOME: "C:\\real\\t3",
        OPENAI_API_KEY: "test-secret",
        AWS_ACCESS_KEY_ID: "test-secret",
      },
    });
    expect(env).toMatchObject({
      SystemRoot: "C:\\Windows",
      SystemDrive: "C:",
      OS: "Windows_NT",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      USERNAME: "runner",
      USERDOMAIN: "BUILD",
      PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      HOME: proofPaths.home,
      USERPROFILE: proofPaths.home,
      TEMP: proofPaths.temp,
      TMP: proofPaths.temp,
      APPDATA: proofPaths.appData,
      LOCALAPPDATA: proofPaths.localAppData,
      T3CODE_MAINTENANCE_NAMESPACE: proofPaths.coordinator,
    });
    for (const key of [
      "PSModulePath",
      "NODE_OPTIONS",
      "T3CODE_HOME",
      "OPENAI_API_KEY",
      "AWS_ACCESS_KEY_ID",
    ])
      expect(env[key]).toBeUndefined();
    expect(env.PATH).not.toContain("C:\\dev");
  });

  it("requires Windows ACL prerequisites instead of silently proving without ACL support", () => {
    expect(() =>
      recoveryProofEnvironment({
        platform: "windows-x64",
        paths: proofPaths,
        inherited: { SystemRoot: "C:\\Windows", USERDOMAIN: "BUILD" },
      }),
    ).toThrow("SystemRoot and USERNAME");
  });

  it("keeps Linux proofs on empty PATH with isolated homes and coordinator", () => {
    const env = recoveryProofEnvironment({
      platform: "linux-x64",
      paths: {
        root: "/proof",
        cwd: "/proof/work",
        home: "/proof/home",
        temp: "/proof/temp",
        appData: "/proof/appdata",
        localAppData: "/proof/local-appdata",
        coordinator: "/proof/coordinator",
      },
      inherited: {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/home/developer",
        NODE_OPTIONS: "--require /tmp/hook.js",
        T3CODE_HOME: "/home/developer/.t3",
        ANTHROPIC_API_KEY: "test-secret",
      },
    });
    expect(env).toEqual({
      PATH: "",
      HOME: "/proof/home",
      TMPDIR: "/proof/temp",
      T3CODE_MAINTENANCE_NAMESPACE: "/proof/coordinator",
    });
  });

  it("stores the verified helper and its own Node runtime owner-only, outside the app, and proves them with an empty PATH", async () => {
    const dir = await cacheDir();
    const node = await realNode();
    const helper = helperScript();
    const command = await installRecoveryHelper({
      cacheDir: dir,
      manifest: manifest("1.0.1", helper, node),
      platform: HOST_PLATFORM,
      fetchAsset: serve(helper, node),
    });
    expect(NodePath.isAbsolute(command.nodePath) && NodePath.isAbsolute(command.helperPath)).toBe(
      true,
    );
    if (process.platform !== "win32") {
      expect((await NodeFSP.stat(command.nodePath)).mode & 0o777).toBe(0o700);
      expect((await NodeFSP.stat(command.helperPath)).mode & 0o777).toBe(0o600);
      expect((await NodeFSP.stat(dir)).mode & 0o077).toBe(0);
    }
    expect(await recoveryReady(dir)).toBe(true);
    expect(recoveryInvocation(command, ["recover", "--home", "/h"])).toEqual({
      command: command.nodePath,
      args: [command.helperPath, "recover", "--home", "/h"],
    });
  });

  it("refuses an asset whose digest differs from the release record and keeps the previous recovery command", async () => {
    const dir = await cacheDir();
    const node = await realNode();
    const good = await installRecoveryHelper({
      cacheDir: dir,
      manifest: manifest("1.0.1", helperScript(), node),
      platform: HOST_PLATFORM,
      fetchAsset: serve(helperScript(), node),
    });
    const tampered = new TextEncoder().encode("console.log('evil')");
    await expect(
      installRecoveryHelper({
        cacheDir: dir,
        manifest: manifest("1.0.2", helperScript(), node),
        platform: HOST_PLATFORM,
        fetchAsset: serve(tampered, node),
      }),
    ).rejects.toThrow("does not match the digest");
    expect((await readRecoveryCommand(dir)).version).toBe(good.version);
    expect((await NodeFSP.readdir(dir)).filter((name) => name.startsWith(".staging"))).toEqual([]);
  });

  it("refuses a helper whose self-test does not report the protocol, so a wrong runtime or helper never becomes current", async () => {
    const dir = await cacheDir();
    const node = await realNode();
    const wrong = helperScript("recovery-helper-protocol=2");
    await expect(
      installRecoveryHelper({
        cacheDir: dir,
        manifest: manifest("1.0.1", wrong, node),
        platform: HOST_PLATFORM,
        fetchAsset: serve(wrong, node),
      }),
    ).rejects.toThrow("did not report the helper protocol");
    expect(await recoveryReady(dir)).toBe(false);
  });

  it("detects a tampered cached file and a lost executable bit", async () => {
    const dir = await cacheDir();
    const node = await realNode();
    const helper = helperScript();
    const command = await installRecoveryHelper({
      cacheDir: dir,
      manifest: manifest("1.0.1", helper, node),
      platform: HOST_PLATFORM,
      fetchAsset: serve(helper, node),
    });
    if (process.platform !== "win32") {
      await NodeFSP.chmod(command.nodePath, 0o600);
      await expect(readRecoveryCommand(dir)).rejects.toThrow("not executable");
      await NodeFSP.chmod(command.nodePath, 0o700);
    }
    await NodeFSP.appendFile(command.helperPath, "\n// changed");
    await expect(readRecoveryCommand(dir)).rejects.toThrow("recorded digests");
    expect(await recoveryReady(dir)).toBe(false);
  });

  it("is idempotent for an identical release and retains two versions", async () => {
    const dir = await cacheDir();
    const node = await realNode();
    let downloads = 0;
    const counting = (helper: Uint8Array) => async (name: string) => {
      downloads += 1;
      return name.endsWith(".mjs") ? helper : node;
    };
    const a = helperScript();
    await installRecoveryHelper({
      cacheDir: dir,
      manifest: manifest("1.0.1", a, node),
      platform: HOST_PLATFORM,
      fetchAsset: counting(a),
    });
    const first = downloads;
    await installRecoveryHelper({
      cacheDir: dir,
      manifest: manifest("1.0.1", a, node),
      platform: HOST_PLATFORM,
      fetchAsset: counting(a),
    });
    expect(downloads).toBe(first);
    for (const version of ["1.0.2", "1.0.3"]) {
      const helper = new TextEncoder().encode(
        `console.log("recovery-helper-protocol=1"); // ${version}\n`,
      );
      await installRecoveryHelper({
        cacheDir: dir,
        manifest: manifest(version, helper, node),
        platform: HOST_PLATFORM,
        fetchAsset: counting(helper),
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect((await NodeFSP.readdir(dir)).filter((name) => !name.endsWith(".json")).sort()).toEqual([
      "1.0.2",
      "1.0.3",
    ]);
  });

  it("will not install from a release with a missing or duplicated recovery asset", async () => {
    const dir = await cacheDir();
    const node = await realNode();
    const helper = helperScript();
    const incomplete = manifest("1.0.1", helper, node);
    (incomplete as { assets: unknown }).assets = incomplete.assets.filter(
      (asset) => !asset.name.includes("node"),
    );
    await expect(
      installRecoveryHelper({
        cacheDir: dir,
        manifest: incomplete,
        platform: HOST_PLATFORM,
        fetchAsset: serve(helper, node),
      }),
    ).rejects.toThrow("no unambiguous recovery helper");
  });
});

#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalFetch:off globalTimers:off - release validation drives real installers, servers, and adb.
// Package-level install, update, and recovery validation of a fork release candidate. It is the
// command `.github/scripts/fork-release-config.json` runs for every check and target, so each
// receipt records the exit of real work: extracting and starting the exact server archive, running
// the native installers, and installing the exact APKs on an emulator.
//
// Scope, stated plainly: this proves the shipped bytes install, start, upgrade in place over
// preserved data, and roll back. It does not drive the in-product maintenance coordinator; that is
// covered by mandatory coordinator and native updater suites. This command is fixed in code;
// extend its checks and the required suites together when adding release guarantees.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Asar from "@electron/asar";
import type { CandidateRecord } from "./fork-release.ts";
import { FORK_ANDROID_PACKAGE } from "./fork-release-contract.ts";
import { parseBaselineManifest, verifyBaselinePayload } from "./fork-release-baseline.ts";
import { cliSmokeEnvironment } from "./lib/cli-smoke-environment.ts";
import { appendCliSmokeOutput, redactCliSmokeOutput } from "./lib/cli-smoke-output.ts";

// ---------------------------------------------------------------------------------------------
// Asset lookup
// ---------------------------------------------------------------------------------------------

export interface PayloadAssets {
  readonly windowsInstaller: string | null;
  readonly appImage: string | null;
  readonly deb: string | null;
  readonly linuxServer: string | null;
  readonly windowsServer: string | null;
  readonly apk: string | null;
  readonly recoveryApk: string | null;
}

/** Finds the files of a release payload or baseline by their canonical names. */
export const locatePayloadAssets = (
  dir: string,
  android?: Pick<CandidateRecord["android"], "normal" | "recovery">,
): PayloadAssets => {
  const files = NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : [];
  const find = (pattern: RegExp): string | null => {
    const match = files.find((name) => pattern.test(name));
    // Validators change the child cwd to private extraction/runtime directories.
    return match ? NodePath.resolve(dir, match) : null;
  };
  return {
    windowsInstaller: find(/^T3-Code-.*-x64\.exe$/),
    appImage: find(/^T3-Code-.*\.AppImage$/),
    deb: find(/^T3-Code-.*\.deb$/),
    linuxServer: find(/^t3-.*-linux-x64\.tar\.gz$/),
    windowsServer: find(/^t3-.*-win32-x64\.zip$/),
    apk: android
      ? declaredApk(dir, android.normal.asset)
      : find(/^t3-code-android-(?!recovery-).*\.apk$/),
    recoveryApk: android
      ? declaredApk(dir, android.recovery.asset)
      : find(/^t3-code-android-recovery-.*\.apk$/),
  };
};

const declaredApk = (dir: string, name: string): string => {
  if (NodePath.basename(name) !== name || !name.endsWith(".apk"))
    throw new Error("Invalid declared APK name.");
  const file = NodePath.resolve(dir, name);
  if (!NodeFS.existsSync(file) || !NodeFS.statSync(file).isFile())
    throw new Error(`The candidate has no declared APK ${name}.`);
  return file;
};

/** Directory order cannot bind a retained source's APK to another source's installation code. */
export const androidRecoveryTargets = (dir: string, android: CandidateRecord["android"]) => {
  if (!android.recoveries.some((recovery) => recovery.asset === android.recovery.asset))
    throw new Error("Recovery validation needs the declared primary recovery APK.");
  return android.recoveries.map((recovery) => ({
    apk: declaredApk(dir, recovery.asset),
    versionCode: recovery.versionCode,
    sourceVersion: recovery.sourceVersion,
  }));
};

const need = (value: string | null, label: string, where: string): string => {
  if (value === null) throw new Error(`${where} has no ${label}.`);
  return value;
};

// ---------------------------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------------------------

const HOST_PLATFORM = Effect.runSync(HostProcessPlatform);

const run = (program: string, args: string[], options: NodeChildProcess.SpawnSyncOptions = {}) =>
  NodeChildProcess.spawnSync(program, args, { ...options, encoding: "utf8" });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const windowsTar = (): string =>
  `${process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows"}\\System32\\tar.exe`;

/** Extracts a server archive and returns the directory that holds the executable. */
export const extractServerArchive = (archive: string, destination: string): string => {
  NodeFS.rmSync(destination, { recursive: true, force: true });
  NodeFS.mkdirSync(destination, { recursive: true });
  const result = run(HOST_PLATFORM === "win32" ? windowsTar() : "tar", [
    "-xf",
    archive,
    "-C",
    destination,
  ]);
  if (result.status !== 0)
    throw new Error(`Could not extract ${NodePath.basename(archive)}: ${result.stderr}`);
  const [root] = NodeFS.readdirSync(destination);
  if (!root) throw new Error(`${NodePath.basename(archive)} is empty.`);
  const contentDir = NodePath.join(destination, root);
  const executable = NodePath.join(contentDir, HOST_PLATFORM === "win32" ? "t3.exe" : "t3");
  for (const required of [executable, NodePath.join(contentDir, "client/index.html")]) {
    if (!NodeFS.existsSync(required))
      throw new Error(
        `${NodePath.basename(archive)} is missing ${NodePath.relative(contentDir, required)}.`,
      );
  }
  return contentDir;
};

const executableIn = (contentDir: string) =>
  NodePath.join(contentDir, HOST_PLATFORM === "win32" ? "t3.exe" : "t3");

const serverEnv = (home: string): NodeJS.ProcessEnv => {
  // Package probes terminate disposable processes; Windows termination can leave a held lock.
  // Preserve the data home, but give each probe its own coordinator. The required safety suites
  // separately exercise shared-registry restart/recovery, including abandoned-lock refusal.
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodePath.dirname(home), "runtime-scratch-"));
  return cliSmokeEnvironment({
    platform: HOST_PLATFORM,
    home,
    scratch,
    inherited: process.env,
    join: NodePath.join,
  });
};

const serverInvocation = (contentDir: string, home: string) => {
  const serverArchive = NodePath.join(contentDir, "resources/server.asar");
  const entry = NodePath.join(serverArchive, "apps/server/dist/bin.mjs");
  if (NodeFS.existsSync(serverArchive)) {
    Asar.uncache(serverArchive);
    Asar.statFile(serverArchive, NodePath.join("apps", "server", "dist", "bin.mjs"));
    return {
      executable: windowsDesktopExecutable(contentDir),
      prefix: [entry],
      env: { ...serverEnv(home), ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return { executable: executableIn(contentDir), prefix: [], env: serverEnv(home) };
};

export const reportedVersion = (contentDir: string, home: string): string => {
  const invocation = serverInvocation(contentDir, home);
  const result = run(invocation.executable, [...invocation.prefix, "--version"], {
    cwd: contentDir,
    env: invocation.env,
  });
  if (result.status !== 0) throw new Error(`--version exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
};

/** Starts `serve` against a home directory, waits for a 200, then stops it. Returns the log. */
export const serveOnce = async (contentDir: string, home: string): Promise<string> => {
  NodeFS.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const invocation = serverInvocation(contentDir, home);
  const child = NodeChildProcess.spawn(
    invocation.executable,
    [...invocation.prefix, "serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
    { cwd: contentDir, env: invocation.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (chunk: Buffer) => (log = appendCliSmokeOutput(log, chunk.toString())));
  child.stderr.on("data", (chunk: Buffer) => (log = appendCliSmokeOutput(log, chunk.toString())));
  let launchError: Error | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)).once("error", () => resolve(null)),
  );
  let ready = false;
  const timeoutMs = HOST_PLATFORM === "win32" ? 90_000 : 30_000;
  const deadline = Date.now() + timeoutMs;
  while (!ready && Date.now() < deadline) {
    const early = await Promise.race([exited, sleep(250).then(() => "waiting" as const)]);
    if (early !== "waiting") break;
    ready = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.status === 200)
      .catch(() => false);
  }
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  if (launchError) throw new Error(`serve could not launch: ${launchError.message}`);
  if (!ready)
    throw new Error(
      `serve did not answer 200 within ${timeoutMs / 1000}s.\n${redactCliSmokeOutput(log)}`,
    );
  return redactCliSmokeOutput(log);
};

const MARKER = "fork-release-marker.txt";

export interface ServerArchives {
  readonly previous: string | { readonly windowsInstaller: string };
  readonly next: string;
  readonly previousVersion: string;
  readonly nextVersion: string;
}

const installServerPredecessor = (payload: ServerArchives["previous"], destination: string) =>
  typeof payload === "string"
    ? extractServerArchive(payload, destination)
    : installWindowsPayload(payload.windowsInstaller, destination).directory;

/** A fresh install of one archive: the binary reports its version and serves from a clean home. */
export const serverInstall = async (
  archive: string,
  version: string,
  scratch: string,
): Promise<void> => {
  const contentDir = extractServerArchive(archive, NodePath.join(scratch, "install"));
  const home = NodePath.join(scratch, "home");
  const reported = reportedVersion(contentDir, home);
  if (!reported.includes(version))
    throw new Error(`The archive reports ${JSON.stringify(reported)}, expected ${version}.`);
  await serveOnce(contentDir, home);
};

/** Replaces the installed server in place while its data home stays: the data must survive and the new build must serve. */
export const serverUpdate = async (archives: ServerArchives, scratch: string): Promise<void> => {
  const installRoot = NodePath.join(scratch, "install");
  const home = NodePath.join(scratch, "home");
  const old = installServerPredecessor(archives.previous, installRoot);
  if (!reportedVersion(old, home).includes(archives.previousVersion))
    throw new Error("The predecessor reports the wrong version.");
  await serveOnce(old, home);
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, "userdata", MARKER), "kept across the update\n");
  const before = NodeFS.readdirSync(home, { recursive: true }).length;

  const next = extractServerArchive(archives.next, installRoot);
  if (!reportedVersion(next, home).includes(archives.nextVersion))
    throw new Error("The update did not change the reported version.");
  await serveOnce(next, home);
  const marker = NodePath.join(home, "userdata", MARKER);
  if (
    !NodeFS.existsSync(marker) ||
    NodeFS.readFileSync(marker, "utf8") !== "kept across the update\n"
  ) {
    throw new Error("The data home lost its marker across the update.");
  }
  if (NodeFS.readdirSync(home, { recursive: true }).length < before)
    throw new Error("The update removed data from the home.");
};

/**
 * Rolls back: the predecessor's binary and the home as it was before the update return, and the
 * predecessor serves from them. Whether the old binary also accepts the updated home is reported
 * but not required, because the coordinator restores a snapshot when it does not.
 */
export const serverRecovery = async (
  archives: ServerArchives,
  scratch: string,
): Promise<string> => {
  const installRoot = NodePath.join(scratch, "install");
  const home = NodePath.join(scratch, "home");
  const snapshot = NodePath.join(scratch, "home-snapshot");
  const old = installServerPredecessor(archives.previous, installRoot);
  await serveOnce(old, home);
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, "userdata", MARKER), "before update\n");
  NodeFS.cpSync(home, snapshot, { recursive: true });

  const next = extractServerArchive(archives.next, installRoot);
  await serveOnce(next, home);
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata", "written-after-update.txt"),
    "must not survive recovery\n",
  );

  const rolledBack = installServerPredecessor(archives.previous, installRoot);
  let acceptsUpdatedHome = true;
  try {
    await serveOnce(rolledBack, home);
  } catch {
    acceptsUpdatedHome = false;
  }
  NodeFS.rmSync(home, { recursive: true, force: true });
  NodeFS.cpSync(snapshot, home, { recursive: true });
  if (!reportedVersion(rolledBack, home).includes(archives.previousVersion))
    throw new Error("Recovery did not restore the predecessor's version.");
  await serveOnce(rolledBack, home);
  const restored = NodePath.join(home, "userdata", MARKER);
  if (!NodeFS.existsSync(restored) || NodeFS.readFileSync(restored, "utf8") !== "before update\n") {
    throw new Error("The restored home does not hold the pre-update data.");
  }
  if (NodeFS.existsSync(NodePath.join(home, "userdata", "written-after-update.txt"))) {
    throw new Error("Data written after the update survived the restore.");
  }
  return `old binary ${acceptsUpdatedHome ? "also accepts" : "rejects"} the updated home (a snapshot restore ${acceptsUpdatedHome ? "is not needed" : "is required"})`;
};

// ---------------------------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------------------------

const coreOf = (version: string) => version.replace(/-.*/, "");

/** The AppImage unpacks and carries its updater config. The .deb is checked by the dpkg flows below. */
export const checkLinuxPackages = (assets: PayloadAssets, scratch: string): void => {
  const appImage = need(assets.appImage, "AppImage", "the candidate");
  NodeFS.chmodSync(appImage, 0o755);
  const extractDir = NodePath.join(scratch, "appimage");
  NodeFS.mkdirSync(extractDir, { recursive: true });
  // AppImage prints every extracted file; a valid payload can exceed spawnSync's stdout limit.
  const extract = run(appImage, ["--appimage-extract"], {
    cwd: extractDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (extract.status !== 0)
    throw new Error(`The AppImage did not unpack: ${extract.error?.message ?? extract.stderr}`);
  const updateConfig = NodePath.join(extractDir, "squashfs-root/resources/app-update.yml");
  if (!NodeFS.existsSync(updateConfig)) throw new Error("The AppImage carries no app-update.yml.");
  // AppRun adds GUI sandbox flags when user namespaces are unavailable. The Node runtime probe
  // must call the bundled executable directly, because Node rejects those Chromium-only flags.
  const launcher = NodePath.join(extractDir, "squashfs-root/t3code");
  // Exercise the bundled Electron Node runtime without requiring a display or starting a GUI.
  const smoke = run(launcher, ["--version"], {
    cwd: extractDir,
    env: { ...process.env, APPIMAGE: "", APPDIR: "", ELECTRON_RUN_AS_NODE: "1" },
    timeout: 30_000,
  });
  if (smoke.status !== 0 || !/^v\d+\.\d+\.\d+/m.test(smoke.stdout))
    throw new Error(`The extracted AppImage runtime cannot start: ${smoke.stderr}`);
};

// ---------------------------------------------------------------------------------------------
// Debian package
// ---------------------------------------------------------------------------------------------

export interface DebTool {
  /** Package name and version from the .deb's control file. */
  readonly info: (deb: string) => { readonly name: string; readonly version: string };
  /** Installs the package, upgrading or downgrading in place. Throws on failure. */
  readonly install: (deb: string) => void;
  /** The installed version, or null when the package is not installed. */
  readonly installedVersion: (name: string) => string | null;
  /** Paths the installed package owns. */
  readonly files: (name: string) => ReadonlyArray<string>;
  readonly read: (file: string) => string;
}

const sudoRun = (program: string, args: string[]) => {
  const direct = run(program, args);
  if (direct.status === 0) return direct;
  return run("sudo", ["-n", program, ...args]);
};

export const realDebTool: DebTool = {
  info: (deb) => {
    const result = run("dpkg-deb", ["-f", deb, "Package", "Version"]);
    if (result.status !== 0)
      throw new Error(`dpkg-deb could not read ${NodePath.basename(deb)}: ${result.stderr}`);
    const name = /^Package: (.+)$/m.exec(result.stdout)?.[1]?.trim();
    const version = /^Version: (.+)$/m.exec(result.stdout)?.[1]?.trim();
    if (!name || !version)
      throw new Error(`${NodePath.basename(deb)} has no package name and version.`);
    return { name, version };
  },
  install: (deb) => {
    const result = sudoRun("dpkg", ["-i", deb]);
    if (result.status !== 0)
      throw new Error(
        `dpkg -i ${NodePath.basename(deb)} exited ${result.status}: ${result.stderr}`,
      );
  },
  installedVersion: (name) => {
    const result = run("dpkg-query", ["-W", "-f=${Version}", name]);
    return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
  },
  files: (name) => {
    const result = run("dpkg", ["-L", name]);
    return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : [];
  },
  read: (file) => NodeFS.readFileSync(file, "utf8"),
};

/** The Debian version of a release version: dpkg orders `~` before the release, so `-` becomes `~`. */
const debVersionMatches = (debVersion: string, version: string) =>
  debVersion === version ||
  debVersion === version.replaceAll("-", "~") ||
  debVersion.startsWith(coreOf(version));

const installDeb = (tool: DebTool, deb: string, expectVersion: string): string => {
  const info = tool.info(deb);
  if (!debVersionMatches(info.version, expectVersion)) {
    throw new Error(
      `${NodePath.basename(deb)} is version ${info.version}, expected ${expectVersion}.`,
    );
  }
  tool.install(deb);
  const installed = tool.installedVersion(info.name);
  if (installed !== info.version)
    throw new Error(
      `After installing, dpkg reports ${installed ?? "nothing"}, expected ${info.version}.`,
    );
  return info.name;
};

/**
 * A Debian install carries what the in-product updater needs to recognize it: the updater config
 * and the package-type marker that routes updates to the .deb rather than an AppImage.
 */
export const checkDebInstalled = (tool: DebTool, name: string): void => {
  const files = tool.files(name);
  if (!files.some((file) => file.endsWith("/resources/app-update.yml")))
    throw new Error("The installed package has no app-update.yml.");
  const marker = files.find((file) => file.endsWith("/resources/package-type"));
  if (!marker)
    throw new Error(
      "The installed package has no package-type marker, so it cannot be told from an AppImage.",
    );
  if (tool.read(marker).trim() !== "deb")
    throw new Error(
      `The package-type marker says ${JSON.stringify(tool.read(marker).trim())}, not deb.`,
    );
};

export const debInstall = (
  assets: PayloadAssets,
  version: string,
  tool: DebTool = realDebTool,
): void => {
  const name = installDeb(tool, need(assets.deb, ".deb", "the candidate"), version);
  checkDebInstalled(tool, name);
};

export const debUpdate = (
  candidate: PayloadAssets,
  predecessor: PayloadAssets,
  versions: { readonly next: string; readonly previous: string },
  tool: DebTool = realDebTool,
): void => {
  const name = installDeb(
    tool,
    need(predecessor.deb, ".deb", "the predecessor"),
    versions.previous,
  );
  const before = tool.installedVersion(name);
  const nextName = installDeb(tool, need(candidate.deb, ".deb", "the candidate"), versions.next);
  if (nextName !== name)
    throw new Error(`The update changed the package name from ${name} to ${nextName}.`);
  if (tool.installedVersion(name) === before)
    throw new Error("The update did not change the installed version.");
  checkDebInstalled(tool, name);
};

/** Recovery re-installs the predecessor's package over the candidate; dpkg downgrades in place. */
export const debRecovery = (
  candidate: PayloadAssets,
  predecessor: PayloadAssets,
  versions: { readonly next: string; readonly previous: string },
  tool: DebTool = realDebTool,
): void => {
  const name = installDeb(tool, need(candidate.deb, ".deb", "the candidate"), versions.next);
  const newer = tool.installedVersion(name);
  const rolledBack = installDeb(
    tool,
    need(predecessor.deb, ".deb", "the predecessor"),
    versions.previous,
  );
  if (rolledBack !== name) throw new Error("Recovery changed the package name.");
  if (tool.installedVersion(name) === newer)
    throw new Error("Recovery did not restore the predecessor's version.");
  checkDebInstalled(tool, name);
};

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

const windowsDesktopExecutable = (directory: string): string => {
  const matches = NodeFS.readdirSync(directory).filter(
    (name) => /^T3.*\.exe$/i.test(name) && !/uninstall/i.test(name),
  );
  if (matches.length !== 1)
    throw new Error("The isolated Windows installation has no unique T3 executable.");
  return NodePath.join(directory, matches[0]!);
};

/** Install only into this check's private directory; never discover another installation by name. */
const installWindowsPayload = (installer: string, directory: string) => {
  NodeFS.mkdirSync(directory, { recursive: true });
  const install = run(installer, ["/S", `/D=${directory}`], { timeout: 120_000 });
  if (install.status !== 0)
    throw new Error(`${NodePath.basename(installer)} exited ${install.status}: ${install.stderr}`);
  windowsDesktopExecutable(directory);
  const resources = NodePath.join(directory, "resources");
  for (const required of ["app-update.yml", "server.asar", "app.asar"])
    if (!NodeFS.existsSync(NodePath.join(resources, required)))
      throw new Error(`The installed desktop is missing ${required}.`);
  // The check replaces this path repeatedly. @electron/asar caches headers by pathname, so an
  // old header would read the new archive at stale offsets after update or recovery.
  const appArchive = NodePath.join(resources, "app.asar");
  Asar.uncache(appArchive);
  const metadata = JSON.parse(Asar.extractFile(appArchive, "package.json").toString()) as {
    version?: string;
  };
  if (!metadata.version) throw new Error("The installed desktop has no package version.");
  return { directory, version: metadata.version };
};

/** Silently installs an NSIS installer and returns its exact packaged source version. */
export const installWindowsInstaller = (installer: string, directory: string): string =>
  installWindowsPayload(installer, directory).version;

// ---------------------------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------------------------

export interface InstalledPackage {
  readonly versionCode: number;
  readonly versionName: string;
  readonly firstInstallTime: string;
  readonly lastUpdateTime: string;
}

/** Reads `adb shell dumpsys package <name>`. */
export const parseDumpsysPackage = (output: string): InstalledPackage => {
  const field = (key: string) => new RegExp(`^\\s*${key}=(.+)$`, "m").exec(output)?.[1]?.trim();
  const versionCode = Number(/versionCode=(\d+)/.exec(output)?.[1]);
  const versionName = field("versionName");
  const firstInstallTime = field("firstInstallTime");
  const lastUpdateTime = field("lastUpdateTime");
  if (!Number.isInteger(versionCode) || !versionName || !firstInstallTime || !lastUpdateTime) {
    throw new Error("dumpsys output has no installed package record.");
  }
  return { versionCode, versionName, firstInstallTime, lastUpdateTime };
};

const adb = (args: string[]) => {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const program = sdk ? NodePath.join(sdk, "platform-tools", "adb") : "adb";
  const serial = process.env.FORK_VALIDATION_ANDROID_SERIAL;
  if (!serial || !/^emulator-\d+$/.test(serial))
    throw new Error(
      "Android release validation requires an explicitly selected isolated emulator.",
    );
  // A disconnected emulator can leave an install waiting indefinitely in ADB. Fail the gate
  // instead of retaining a command until the enclosing CI job times out.
  return run(program, ["-s", serial, ...args], { timeout: 180_000 });
};

const installedPackage = (): InstalledPackage => {
  const result = adb(["shell", "dumpsys", "package", FORK_ANDROID_PACKAGE]);
  if (result.status !== 0) throw new Error(`adb dumpsys failed: ${result.stderr}`);
  return parseDumpsysPackage(result.stdout);
};

const adbInstall = (apk: string) => adb(["install", "-r", apk]);

export const requireAndroidDowngradeRejection = (result: {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): void => {
  if (
    result.status === null ||
    result.status === 0 ||
    !/INSTALL_FAILED_VERSION_DOWNGRADE/.test(`${result.stdout}${result.stderr}`)
  )
    throw new Error(
      "Android did not explicitly reject the lower installation code as a downgrade.",
    );
};

/** Starts the app and confirms its process stays alive, so a crash on launch fails the check. */
export const launchAndConfirm = async (
  ports: {
    readonly runAdb?: typeof adb;
    readonly wait?: (milliseconds: number) => Promise<unknown>;
  } = {},
): Promise<void> => {
  const runAdb = ports.runAdb ?? adb;
  const start = runAdb([
    "shell",
    "am",
    "start",
    "-S",
    "-W",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
    "-n",
    `${FORK_ANDROID_PACKAGE}/.MainActivity`,
  ]);
  // Replacements can leave a warm task from the old APK. This disposable, stopped-work fixture
  // needs a fresh process loading the installed bytes, followed by the full survival check.
  // Do not use randomized Monkey input, which can navigate away immediately after launch.
  if (start.status !== 0 || !/^Status: ok\s*$/m.test(start.stdout))
    throw new Error(
      `The app did not launch: ${redactCliSmokeOutput(`${start.stdout}${start.stderr}`)}`,
    );
  await (ports.wait ?? sleep)(8_000);
  const pid = runAdb(["shell", "pidof", FORK_ANDROID_PACKAGE]);
  if (pid.status !== 0 || pid.stdout.trim() === "") {
    // The selected device is always a throwaway emulator. Retain the crash before the runner
    // tears it down, without exposing credentials that an exception message might contain.
    const crash = runAdb(["logcat", "-d", "-b", "crash", "-t", "80"]);
    const lifecycle = runAdb([
      "logcat",
      "-d",
      "-b",
      "system",
      "-t",
      "500",
      "ActivityManager:I",
      "ActivityTaskManager:I",
      "*:S",
    ]);
    const exitInfo = runAdb(["shell", "dumpsys", "activity", "exit-info", FORK_ANDROID_PACKAGE]);
    const activity = runAdb(["shell", "dumpsys", "activity", "activities", FORK_ANDROID_PACKAGE]);
    throw new Error(
      `The app process was not running after launch.\nLauncher:\n${redactCliSmokeOutput(`${start.stdout}${start.stderr}`).slice(-4_000)}\nProcess probe (exit ${pid.status}):\n${redactCliSmokeOutput(`${pid.stdout}${pid.stderr}`).slice(-2_000)}\nAndroid crash log:\n${redactCliSmokeOutput(`${crash.stdout}${crash.stderr}`).slice(-8_000)}\nAndroid lifecycle log:\n${redactCliSmokeOutput(`${lifecycle.stdout}${lifecycle.stderr}`).slice(-16_000)}\nAndroid process exits:\n${redactCliSmokeOutput(`${exitInfo.stdout}${exitInfo.stderr}`).slice(-12_000)}\nAndroid activity state:\n${redactCliSmokeOutput(`${activity.stdout}${activity.stderr}`).slice(-8_000)}`,
    );
  }
};

const mustInstall = (apk: string) => {
  const result = adbInstall(apk);
  if (result.status !== 0 || !/Success/.test(result.stdout)) {
    throw new Error(
      `adb install ${NodePath.basename(apk)} failed: ${result.stdout}${result.stderr}`,
    );
  }
};

export interface AndroidPlan {
  readonly normalCode: number;
  readonly recoveryCode: number;
  readonly version: string;
  readonly predecessorVersion: string;
  readonly instrumentationApk?: string;
}

export const androidInstall = async (assets: PayloadAssets, plan: AndroidPlan): Promise<void> => {
  mustInstall(need(assets.apk, "normal APK", "the candidate"));
  const installed = installedPackage();
  if (installed.versionCode !== plan.normalCode || installed.versionName !== plan.version) {
    throw new Error(
      `Installed ${installed.versionName} (${installed.versionCode}), expected ${plan.version} (${plan.normalCode}).`,
    );
  }
  if (plan.instrumentationApk) {
    mustInstall(plan.instrumentationApk);
    const result = adb([
      "shell",
      "am",
      "instrument",
      "-w",
      `${FORK_ANDROID_PACKAGE}.test/com.devotek.t3code.pwa.UpdaterSmokeInstrumentation`,
    ]);
    if (result.status !== 0)
      throw new Error(`Android updater instrumentation could not run: ${result.stderr}`);
    requireAndroidInstrumentationReceipt(result.stdout);
  }
  await launchAndConfirm();
};

export function requireAndroidInstrumentationReceipt(output: string): void {
  const checks = Number(/^INSTRUMENTATION_RESULT: checks=(\d+)$/m.exec(output)?.[1]);
  const result = /^INSTRUMENTATION_RESULT: result=(.+)$/m.exec(output)?.[1] ?? "";
  const required = [
    "fresh-shell-health",
    "manual-wait",
    "upload-hold",
    "stale-build-rejection",
    "cancel",
    "pin-resume",
    "recovery-before-WebView",
    "local-state-preserved",
    "Android-settings-hold-and-return",
    "native-navigation-hold",
    "blocked-update-channel",
  ];
  if (
    !/^INSTRUMENTATION_CODE: -1$/m.test(output) ||
    checks !== required.length ||
    required.some(
      (check) =>
        !result
          .split(";")
          .map((part) => part.trim())
          .includes(check),
    )
  )
    throw new Error(`Android updater interaction checks failed: ${output}`);
}

/** Only the explicitly selected throwaway emulator is reset; installation checks never touch paired devices. */
function resetAndroidValidationFixture(): void {
  for (const name of [FORK_ANDROID_PACKAGE, `${FORK_ANDROID_PACKAGE}.test`]) {
    const present = adb(["shell", "pm", "path", name]);
    if (present.stdout.trim()) {
      const removed = adb(["uninstall", name]);
      if (removed.status !== 0 || !/Success/.test(removed.stdout))
        throw new Error(
          `Cannot reset the isolated Android fixture: ${removed.stdout}${removed.stderr}`,
        );
    }
  }
}

export const androidUpdate = async (
  candidate: PayloadAssets,
  predecessor: PayloadAssets,
  plan: AndroidPlan,
): Promise<void> => {
  mustInstall(need(predecessor.apk, "normal APK", "the predecessor"));
  await launchAndConfirm();
  const before = installedPackage();
  mustInstall(need(candidate.apk, "normal APK", "the candidate"));
  const after = installedPackage();
  if (after.versionCode !== plan.normalCode)
    throw new Error(`The update left versionCode ${after.versionCode}.`);
  if (after.firstInstallTime !== before.firstInstallTime)
    throw new Error("The update was not in place: the first install time changed.");
  if (after.lastUpdateTime === before.lastUpdateTime)
    throw new Error("The package update time did not move.");
  await launchAndConfirm();
};

/**
 * Android refuses a lower code, which is exactly why every release ships a recovery APK with a
 * higher one. Recovery must replace the candidate in place, report the predecessor's source version,
 * and still launch; the plain predecessor APK must be refused.
 */
export const androidRecovery = async (
  candidate: PayloadAssets,
  predecessor: PayloadAssets,
  plan: AndroidPlan,
): Promise<void> => {
  mustInstall(need(candidate.apk, "normal APK", "the candidate"));
  await launchAndConfirm();
  const before = installedPackage();
  const downgrade = adbInstall(need(predecessor.apk, "normal APK", "the predecessor"));
  requireAndroidDowngradeRejection(downgrade);
  mustInstall(need(candidate.recoveryApk, "recovery APK", "the candidate"));
  const after = installedPackage();
  if (after.versionCode !== plan.recoveryCode)
    throw new Error(
      `Recovery left versionCode ${after.versionCode}, expected ${plan.recoveryCode}.`,
    );
  if (after.versionName !== plan.predecessorVersion)
    throw new Error(`Recovery left ${after.versionName}, expected ${plan.predecessorVersion}.`);
  if (after.firstInstallTime !== before.firstInstallTime)
    throw new Error("Recovery was not in place: the first install time changed.");
  await launchAndConfirm();
};

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
};

const readRecord = (candidateDir: string): CandidateRecord =>
  JSON.parse(
    NodeFS.readFileSync(`${NodePath.resolve(candidateDir)}.json`, "utf8"),
  ) as CandidateRecord;

const versionOfPredecessor = (dir: string): string => {
  const names = NodeFS.readdirSync(dir);
  if (names.includes("fork-baseline.json")) {
    const baseline = parseBaselineManifest(
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "fork-baseline.json"), "utf8")),
    );
    const problems = verifyBaselinePayload(dir, baseline);
    if (problems.length) throw new Error(`Invalid baseline predecessor: ${problems.join(" ")}`);
    return baseline.version;
  }
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(dir, "fork-release.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
};

export const validate = async (env: NodeJS.ProcessEnv): Promise<string> => {
  const check = requireEnv("FORK_RELEASE_CHECK");
  const target = requireEnv("FORK_RELEASE_TARGET");
  const candidateDir = requireEnv("FORK_RELEASE_CANDIDATE_DIR");
  const predecessorDir = env.FORK_RELEASE_PREDECESSOR_DIR || null;
  const record = readRecord(candidateDir);
  const candidate = locatePayloadAssets(candidateDir, record.android);
  const predecessor = predecessorDir ? locatePayloadAssets(predecessorDir) : null;
  if (check !== "install" && (!predecessorDir || !predecessor))
    throw new Error(`${check} needs a predecessor directory.`);
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `fork-validate-${check}-`));
  const previousVersion = predecessorDir ? versionOfPredecessor(predecessorDir) : "";
  const archiveOf = (assets: PayloadAssets) =>
    need(
      target === "windows-x64" ? assets.windowsServer : assets.linuxServer,
      "server archive",
      "the payload",
    );

  try {
    if (target === "linux-x64" || target === "windows-x64") {
      if (check === "install") {
        await serverInstall(archiveOf(candidate), record.version, scratch);
        if (target === "linux-x64") {
          checkLinuxPackages(candidate, scratch);
          debInstall(candidate, record.version);
        } else {
          const installed = installWindowsInstaller(
            need(candidate.windowsInstaller, "installer", "the candidate"),
            NodePath.join(scratch, "desktop"),
          );
          if (installed !== record.version)
            throw new Error(`The installer installed ${installed}, expected ${record.version}.`);
        }
        return `${target} install passed`;
      }
      const archives: ServerArchives = {
        // The immutable updater baseline predates Windows SEA packaging. Exercise its real
        // installed Electron/server.asar pair instead; ordinary releases still require an archive.
        previous:
          target === "windows-x64" &&
          predecessor!.windowsServer === null &&
          predecessorDir &&
          NodeFS.existsSync(NodePath.join(predecessorDir, "fork-baseline.json"))
            ? {
                windowsInstaller: need(
                  predecessor!.windowsInstaller,
                  "baseline installer",
                  "the predecessor",
                ),
              }
            : archiveOf(predecessor!),
        next: archiveOf(candidate),
        previousVersion,
        nextVersion: record.version,
      };
      if (target === "windows-x64") {
        const first =
          check === "update" ? predecessor!.windowsInstaller : candidate.windowsInstaller;
        const second =
          check === "update" ? candidate.windowsInstaller : predecessor!.windowsInstaller;
        const expected = check === "update" ? record.version : previousVersion;
        const directory = NodePath.join(scratch, "desktop");
        installWindowsInstaller(need(first, "installer", "the first build"), directory);
        const installed = installWindowsInstaller(
          need(second, "installer", "the second build"),
          directory,
        );
        if (installed !== expected)
          throw new Error(
            `After ${check} the installer reports ${installed}, expected ${expected}.`,
          );
      }
      const debVersions = { next: record.version, previous: previousVersion };
      if (target === "linux-x64") {
        if (check === "update") debUpdate(candidate, predecessor!, debVersions);
        else debRecovery(candidate, predecessor!, debVersions);
      }
      if (check === "update") {
        await serverUpdate(archives, scratch);
        return `${target} update passed`;
      }
      return `${target} recovery passed: ${await serverRecovery(archives, scratch)}`;
    }

    resetAndroidValidationFixture();
    const instrumentationApk =
      check === "install" ? requireEnv("FORK_VALIDATION_ANDROID_TEST_APK") : undefined;
    if (instrumentationApk && !NodeFS.existsSync(instrumentationApk))
      throw new Error("Updater instrumentation APK is missing.");
    const plan: AndroidPlan = {
      normalCode: record.android.normal.versionCode,
      recoveryCode: record.android.recovery.versionCode,
      version: record.version,
      predecessorVersion: previousVersion,
      ...(instrumentationApk ? { instrumentationApk } : {}),
    };
    if (check === "install") await androidInstall(candidate, plan);
    else if (check === "update") await androidUpdate(candidate, predecessor!, plan);
    else {
      // Every retained source must boot after recovery. Each uses a new throwaway fixture:
      // installing the next normal APK over a higher recovery code would itself be a downgrade.
      for (const recovery of androidRecoveryTargets(candidateDir, record.android)) {
        resetAndroidValidationFixture();
        await androidRecovery({ ...candidate, recoveryApk: recovery.apk }, predecessor!, {
          ...plan,
          recoveryCode: recovery.versionCode,
          predecessorVersion: recovery.sourceVersion,
        });
      }
    }
    return `android ${check} passed`;
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
};

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  validate(process.env).then(
    (message) => {
      console.log(message);
      process.exit(0);
    },
    (cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : cause);
      process.exit(1);
    },
  );
}

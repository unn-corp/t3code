// @effect-diagnostics nodeBuiltinImport:off globalDate:off - these tests run real archives, servers, and package tools.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  androidRecoveryTargets,
  requireAndroidDowngradeRejection,
  requireAndroidInstrumentationReceipt,
  launchAndConfirm,
  checkDebInstalled,
  checkLinuxPackages,
  debInstall,
  debRecovery,
  debUpdate,
  type DebTool,
  type PayloadAssets,
  locatePayloadAssets,
  parseDumpsysPackage,
  serverInstall,
  serverRecovery,
  serverUpdate,
  windowsDesktopExecutable,
} from "./fork-release-validate.ts";
import { makeManifest } from "./fork-release-fixtures.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-validate-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

type Behavior = "healthy" | "wipes-home" | "migrates-home" | "leaves-coordinator-lock";

/**
 * A tiny stand-in for the single-executable server archive: same layout, `--version`, and a
 * `serve` that opens an HTTP port and keeps state under T3CODE_HOME, so the lifecycle code runs
 * against real processes and a real tarball.
 */
const makeServerArchive = (version: string, behavior: Behavior = "healthy"): string => {
  const stem = `t3-${version}-linux-x64`;
  const dir = NodePath.join(root, "build", stem);
  NodeFS.mkdirSync(NodePath.join(dir, "client"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "client/index.html"), "<html></html>");
  const script = `#!${process.execPath}
const fs = require("fs"), path = require("path"), http = require("http");
const [command, ...args] = process.argv.slice(2);
if (command === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
const home = process.env.T3CODE_HOME;
if (!process.env.T3CODE_MAINTENANCE_NAMESPACE?.startsWith(path.dirname(home) + path.sep)) {
  console.error("validation must isolate its coordinator"); process.exit(2);
}
if (${JSON.stringify(behavior)} === "leaves-coordinator-lock") {
  const coordinator = process.env.T3CODE_MAINTENANCE_NAMESPACE;
  const lock = path.join(coordinator, "registry.lock");
  if (fs.existsSync(lock)) { console.error("Unrepaired coordinator lock"); process.exit(3); }
  fs.mkdirSync(coordinator, { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: "fixture" }));
}
const data = path.join(home, "userdata");
if (${JSON.stringify(behavior)} === "wipes-home") fs.rmSync(data, { recursive: true, force: true });
if (fs.existsSync(path.join(data, "migrated-by-newer"))) { console.error("database is newer than this build"); process.exit(1); }
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, "state.sqlite"), "db");
if (${JSON.stringify(behavior)} === "migrates-home") fs.writeFileSync(path.join(data, "migrated-by-newer"), "1");
const port = Number(args[args.indexOf("--port") + 1]);
const server = http.createServer((req, res) => res.end("ok")).listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
  NodeFS.writeFileSync(NodePath.join(dir, "t3"), script, { mode: 0o755 });
  const archive = NodePath.join(root, `${stem}.tar.gz`);
  const tar = NodeChildProcess.spawnSync("tar", [
    "-czf",
    archive,
    "-C",
    NodePath.join(root, "build"),
    stem,
  ]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return archive;
};

const scratch = (name: string) => NodePath.join(root, name);

describe("isolated Windows executable discovery", () => {
  it.each([
    "T3 Code.exe",
    "T3 Code (Nightly).exe",
    "Arcwright Code (Alpha).exe",
    "Arcwright Code (Nightly).exe",
  ])("finds the application %s while excluding its uninstaller", (name) => {
    NodeFS.writeFileSync(NodePath.join(root, name), "fixture");
    NodeFS.writeFileSync(NodePath.join(root, `Uninstall ${name}`), "fixture");
    assert.equal(windowsDesktopExecutable(root), NodePath.join(root, name));
  });

  it("refuses ambiguous or missing applications instead of choosing another executable", () => {
    NodeFS.writeFileSync(NodePath.join(root, "unrelated.exe"), "fixture");
    assert.throws(() => windowsDesktopExecutable(root), /no unique/);
    NodeFS.writeFileSync(NodePath.join(root, "T3 Code.exe"), "fixture");
    NodeFS.writeFileSync(NodePath.join(root, "Arcwright Code (Nightly).exe"), "fixture");
    assert.throws(() => windowsDesktopExecutable(root), /no unique/);
  });
});
const fail = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (cause) {
    return String(cause);
  }
  return "";
};

describe("asset lookup", () => {
  it("finds canonical files, keeping the recovery APK apart from the normal one", () => {
    for (const name of [
      "T3-Code-1.0.1-x64.exe",
      "T3-Code-1.0.1-x86_64.AppImage",
      "T3-Code-1.0.1-amd64.deb",
      "t3-1.0.1-linux-x64.tar.gz",
      "t3-1.0.1-win32-x64.zip",
      "t3-code-android-1.0.1.apk",
      "t3-code-android-recovery-1.0.1.apk",
    ]) {
      NodeFS.writeFileSync(NodePath.join(root, name), "x");
    }
    const found = locatePayloadAssets(root);
    assert.equal(NodePath.basename(found.apk!), "t3-code-android-1.0.1.apk");
    assert.equal(NodePath.basename(found.recoveryApk!), "t3-code-android-recovery-1.0.1.apk");
    assert.isTrue(Object.values(found).every((value) => value !== null));
    assert.equal(locatePayloadAssets(NodePath.join(root, "nowhere")).apk, null);
  });

  it("binds every retained recovery APK to its declared source and code", () => {
    const manifest = makeManifest({ version: "1.0.1-nightly.20261006.28", normalCode: 51 });
    const primary = { ...manifest.android.recovery, apkSha256: "a".repeat(64) };
    const normal = { ...manifest.android.normal, apkSha256: "b".repeat(64) };
    const baseline = {
      ...primary,
      asset: "t3-code-android-recovery-1.0.1-nightly.20261006.28-from-1.0.0-03e91091e405.apk",
      versionCode: 53,
      sourceVersion: "1.0.0",
    };
    for (const entry of [baseline, normal, primary])
      NodeFS.writeFileSync(NodePath.join(root, entry.asset), "apk");
    const android = { normal, recovery: primary, recoveries: [primary, baseline] };
    // The extra baseline sorts before the primary in readdir, which caused the real CI failure.
    assert.equal(NodePath.basename(locatePayloadAssets(root).recoveryApk!), baseline.asset);
    assert.equal(NodePath.basename(locatePayloadAssets(root, android).recoveryApk!), primary.asset);
    assert.deepEqual(androidRecoveryTargets(root, android), [
      {
        apk: NodePath.join(root, primary.asset),
        versionCode: 52,
        sourceVersion: primary.sourceVersion,
      },
      { apk: NodePath.join(root, baseline.asset), versionCode: 53, sourceVersion: "1.0.0" },
    ]);
    assert.throws(
      () => androidRecoveryTargets(root, { ...android, recoveries: [] }),
      "needs the declared primary",
    );
    NodeFS.unlinkSync(NodePath.join(root, baseline.asset));
    assert.throws(() => androidRecoveryTargets(root, android), "no declared APK");
  });
});

describe("dumpsys parsing", () => {
  it("requires Android's explicit downgrade rejection rather than an unrelated install failure", () => {
    requireAndroidDowngradeRejection({
      status: 1,
      stdout: "",
      stderr: "Failure [INSTALL_FAILED_VERSION_DOWNGRADE: lower version code]",
    });
    for (const result of [
      { status: 0, stdout: "Success", stderr: "" },
      { status: 1, stdout: "", stderr: "device offline" },
      { status: 1, stdout: "", stderr: "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]" },
      { status: null, stdout: "", stderr: "INSTALL_FAILED_VERSION_DOWNGRADE" },
    ])
      assert.throws(() => requireAndroidDowngradeRejection(result), "did not explicitly reject");
  });
  it("reads the installed version and the install times", () => {
    const output = [
      "Packages:",
      "  Package [com.devotek.t3code.pwa] (abc):",
      "    versionCode=29853680 minSdk=24 targetSdk=36",
      "    versionName=1.0.1",
      "    firstInstallTime=2026-10-06 08:00:01",
      "    lastUpdateTime=2026-10-06 08:05:09",
    ].join("\n");
    assert.deepStrictEqual(parseDumpsysPackage(output), {
      versionCode: 29_853_680,
      versionName: "1.0.1",
      firstInstallTime: "2026-10-06 08:00:01",
      lastUpdateTime: "2026-10-06 08:05:09",
    });
    assert.throws(() => parseDumpsysPackage("Unable to find package"), /no installed package/);
  });
});

describe("server archive install", () => {
  it("extracts, reports the version, and serves from a clean home", async () => {
    await serverInstall(makeServerArchive("1.0.1"), "1.0.1", scratch("a"));
  });

  it("fails when the archive reports a different version", async () => {
    assert.match(
      await fail(serverInstall(makeServerArchive("1.0.0"), "1.0.1", scratch("b"))),
      /reports/,
    );
  });

  it("fails when the archive lacks its client", async () => {
    const archive = makeServerArchive("1.0.2");
    NodeFS.rmSync(NodePath.join(root, "build/t3-1.0.2-linux-x64/client"), { recursive: true });
    NodeChildProcess.spawnSync("tar", [
      "-czf",
      archive,
      "-C",
      NodePath.join(root, "build"),
      "t3-1.0.2-linux-x64",
    ]);
    assert.match(
      await fail(serverInstall(archive, "1.0.2", scratch("c"))),
      /missing client\/index\.html/,
    );
  });
});

describe("server archive update", () => {
  const archives = (next: Behavior = "healthy") => ({
    previous: makeServerArchive("1.0.0"),
    next: makeServerArchive("1.0.1", next),
    previousVersion: "1.0.0",
    nextVersion: "1.0.1",
  });

  it("replaces the binary in place and keeps the data home", async () => {
    await serverUpdate(archives(), scratch("update"));
  });

  it("keeps abandoned smoke locks separate while preserving the same home across replacement", async () => {
    const directory = scratch("abandoned-locks");
    await serverUpdate(
      {
        previous: makeServerArchive("1.0.0", "leaves-coordinator-lock"),
        next: makeServerArchive("1.0.1", "leaves-coordinator-lock"),
        previousVersion: "1.0.0",
        nextVersion: "1.0.1",
      },
      directory,
    );
    const locks = NodeFS.readdirSync(directory)
      .filter((name) => name.startsWith("runtime-scratch-"))
      .map((name) => NodePath.join(directory, name, "coordinator/registry.lock"))
      .filter((file) => NodeFS.existsSync(file));
    assert.lengthOf(locks, 2);
    for (const file of locks)
      assert.equal(JSON.parse(NodeFS.readFileSync(file, "utf8")).started, "fixture");
    assert.equal(
      NodeFS.readFileSync(
        NodePath.join(directory, "home/userdata/fork-release-marker.txt"),
        "utf8",
      ),
      "kept across the update\n",
    );
  });

  it("fails when the new build destroys the data home", async () => {
    assert.match(
      await fail(serverUpdate(archives("wipes-home"), scratch("wipe"))),
      /lost its marker/,
    );
  });
});

describe("server archive recovery", () => {
  it("restores the predecessor's binary and the pre-update home, dropping later writes", async () => {
    const note = await serverRecovery(
      {
        previous: makeServerArchive("1.0.0"),
        next: makeServerArchive("1.0.1"),
        previousVersion: "1.0.0",
        nextVersion: "1.0.1",
      },
      scratch("recover"),
    );
    assert.include(note, "also accepts");
  });

  it("reports when the old build cannot read data the new build migrated, which is why a snapshot is restored", async () => {
    const note = await serverRecovery(
      {
        previous: makeServerArchive("1.0.0"),
        next: makeServerArchive("1.0.1", "migrates-home"),
        previousVersion: "1.0.0",
        nextVersion: "1.0.1",
      },
      scratch("recover-migrated"),
    );
    assert.include(note, "rejects");
    assert.include(note, "snapshot restore is required");
  });
});

const appImage = (dir: string, withUpdateConfig: boolean, verbose = false) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, "T3-Code-1.0.1-x86_64.AppImage");
  NodeFS.writeFileSync(
    file,
    `#!/bin/sh\nmkdir -p squashfs-root/resources\ncat > squashfs-root/t3code <<'SH'\n#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] && [ "$1" = --version ] && [ "$#" = 1 ] || exit 2\necho v39.0.0\nSH\nchmod +x squashfs-root/t3code\nprintf '#!/bin/sh\\nexit 2\\n' > squashfs-root/AppRun\nchmod +x squashfs-root/AppRun\n${withUpdateConfig ? "echo provider: github > squashfs-root/resources/app-update.yml\n" : ""}${verbose ? "printf '%2097152s' ''\n" : ""}`,
    { mode: 0o755 },
  );
  return file;
};

describe("Linux AppImage", () => {
  it("extracts payloads supplied through a relative candidate directory", () => {
    appImage(root, true);
    const payload = locatePayloadAssets(NodePath.relative(process.cwd(), root));
    checkLinuxPackages(payload, scratch("relative-extraction"));
  });
  it("accepts a successful extraction whose file listing exceeds the child output buffer", () => {
    checkLinuxPackages(
      {
        ...locatePayloadAssets(root),
        appImage: appImage(NodePath.join(root, "verbose"), true, true),
      },
      scratch("verbose-check"),
    );
  });
  it("accepts an image that unpacks with its updater config and rejects one without", () => {
    const good = {
      ...locatePayloadAssets(root),
      appImage: appImage(NodePath.join(root, "good"), true),
    };
    checkLinuxPackages(good, NodePath.join(root, "extract"));
    const bad = {
      ...locatePayloadAssets(root),
      appImage: appImage(NodePath.join(root, "bad"), false),
    };
    assert.throws(
      () => checkLinuxPackages(bad, NodePath.join(root, "extract-2")),
      /app-update\.yml/,
    );
  });

  it("requires the AppImage to exist", () => {
    assert.throws(
      () => checkLinuxPackages(locatePayloadAssets(root), NodePath.join(root, "e")),
      /no AppImage/,
    );
  });
});

/**
 * A stand-in for dpkg with the behaviors the flows depend on: the installed version follows the
 * last package installed (dpkg upgrades and downgrades in place), and an installed package owns
 * its files, including the package-type marker electron-builder writes only into the .deb.
 */
class FakeDpkg implements DebTool {
  installed = new Map<string, string>();
  installs: string[] = [];
  packageType = "deb";
  withUpdateConfig = true;
  readonly debs: Record<string, { name: string; version: string }>;
  constructor(debs: Record<string, { name: string; version: string }>) {
    this.debs = debs;
  }
  info = (deb: string) => {
    const entry = this.debs[NodePath.basename(deb)];
    if (!entry) throw new Error(`unknown deb ${deb}`);
    return entry;
  };
  install = (deb: string) => {
    const { name, version } = this.info(deb);
    this.installed.set(name, version);
    this.installs.push(version);
  };
  installedVersion = (name: string) => this.installed.get(name) ?? null;
  files = (name: string) =>
    this.installed.has(name)
      ? [
          `/opt/Arcwright Code/resources/package-type`,
          ...(this.withUpdateConfig ? [`/opt/Arcwright Code/resources/app-update.yml`] : []),
        ]
      : [];
  read = () => this.packageType;
}

describe("Debian package", () => {
  const assets = (name: string): PayloadAssets => ({
    ...locatePayloadAssets(root),
    deb: `/payload/${name}`,
  });
  const next = assets("T3-Code-1.0.1-amd64.deb");
  const previous = assets("T3-Code-1.0.0-amd64.deb");
  const debs = {
    "T3-Code-1.0.1-amd64.deb": { name: "t3-code", version: "1.0.1" },
    "T3-Code-1.0.0-amd64.deb": { name: "t3-code", version: "1.0.0" },
  };
  const versions = { next: "1.0.1", previous: "1.0.0" };

  it("installs the candidate and finds the updater config and the deb package-type marker", () => {
    const tool = new FakeDpkg(debs);
    debInstall(next, "1.0.1", tool);
    assert.equal(tool.installed.get("t3-code"), "1.0.1");
  });

  it("accepts dpkg's tilde spelling of a prerelease version", () => {
    const tool = new FakeDpkg({
      "T3-Code-1.0.1-amd64.deb": { name: "t3-code", version: "1.0.1~nightly.20261006.7" },
    });
    debInstall(next, "1.0.1-nightly.20261006.7", tool);
  });

  it("rejects a package of the wrong version, without updater config, or marked as another packaging", () => {
    assert.throws(() => debInstall(next, "2.0.0", new FakeDpkg(debs)), /expected 2\.0\.0/);
    const noConfig = new FakeDpkg(debs);
    noConfig.withUpdateConfig = false;
    assert.throws(() => debInstall(next, "1.0.1", noConfig), /no app-update\.yml/);
    const wrongType = new FakeDpkg(debs);
    wrongType.packageType = "AppImage";
    assert.throws(() => debInstall(next, "1.0.1", wrongType), /not deb/);
    assert.throws(() => checkDebInstalled(new FakeDpkg(debs), "t3-code"), /no app-update\.yml/);
  });

  it("updates in place from the predecessor to the candidate", () => {
    const tool = new FakeDpkg(debs);
    debUpdate(next, previous, versions, tool);
    assert.deepStrictEqual(tool.installs, ["1.0.0", "1.0.1"]);
    assert.equal(tool.installed.get("t3-code"), "1.0.1");
  });

  it("recovers by installing the predecessor over the candidate", () => {
    const tool = new FakeDpkg(debs);
    debRecovery(next, previous, versions, tool);
    assert.deepStrictEqual(tool.installs, ["1.0.1", "1.0.0"]);
    assert.equal(tool.installed.get("t3-code"), "1.0.0");
  });

  it("fails when an update or recovery leaves the version unchanged or renames the package", () => {
    const sameVersion = new FakeDpkg({
      ...debs,
      "T3-Code-1.0.0-amd64.deb": { name: "t3-code", version: "1.0.1" },
    });
    assert.throws(
      () => debUpdate(next, previous, { next: "1.0.1", previous: "1.0.1" }, sameVersion),
      /did not change/,
    );
    const renamed = new FakeDpkg({
      ...debs,
      "T3-Code-1.0.0-amd64.deb": { name: "other", version: "1.0.0" },
    });
    assert.throws(() => debUpdate(next, previous, versions, renamed), /changed the package name/);
    assert.throws(
      () =>
        debRecovery(
          next,
          previous,
          { next: "1.0.1", previous: "1.0.1" },
          new FakeDpkg({
            ...debs,
            "T3-Code-1.0.0-amd64.deb": { name: "t3-code", version: "1.0.1" },
          }),
        ),
      /did not restore/,
    );
  });

  it("requires both packages to be present", () => {
    assert.throws(
      () => debInstall(locatePayloadAssets(root), "1.0.1", new FakeDpkg(debs)),
      /no \.deb/,
    );
  });
});

describe("native Android interaction receipt", () => {
  it("fails a missing app process and retains redacted Android crash diagnostics", async () => {
    const commands: string[][] = [];
    let survivalWindow = 0;
    const message = await fail(
      launchAndConfirm({
        wait: async (milliseconds) => {
          survivalWindow = milliseconds;
        },
        runAdb: (args) => {
          commands.push([...args]);
          const stdout =
            args[0] === "logcat"
              ? "FATAL EXCEPTION: main\nInvalid recovery state\nAuthorization: Bearer private-fixture-token\n"
              : args[1] === "am"
                ? "Status: ok\n"
                : "";
          return {
            stdout,
            stderr: "",
            status: args[1] === "pidof" ? 1 : 0,
            signal: null,
            pid: 1,
            output: ["", stdout, ""],
          };
        },
      }),
    );
    assert.include(message, "app process was not running");
    assert.include(message, "Invalid recovery state");
    assert.notInclude(message, "private-fixture-token");
    assert.equal(survivalWindow, 8_000);
    assert.deepEqual(commands[0], [
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
      "com.devotek.t3code.pwa/.MainActivity",
    ]);
    assert.include(message, "Android process exits:");
    assert.deepEqual(commands.at(-2), [
      "shell",
      "dumpsys",
      "activity",
      "exit-info",
      "com.devotek.t3code.pwa",
    ]);
    assert.deepEqual(commands.at(-1), [
      "shell",
      "dumpsys",
      "activity",
      "activities",
      "com.devotek.t3code.pwa",
    ]);
  });

  it("rejects an unsuccessful Activity Manager result before accepting a surviving process", async () => {
    let calls = 0;
    const message = await fail(
      launchAndConfirm({
        wait: async () => {},
        runAdb: () => {
          calls++;
          return {
            stdout: "Error: Activity class does not exist\n",
            stderr: "",
            status: 0,
            signal: null,
            pid: 1,
            output: ["", "", ""],
          };
        },
      }),
    );
    assert.include(message, "did not launch");
    assert.equal(calls, 1);
  });

  it("requires every observable updater scenario and a successful instrumentation result", () => {
    const result =
      "INSTRUMENTATION_RESULT: checks=11\nINSTRUMENTATION_RESULT: result=fresh-shell-health; manual-wait; upload-hold; stale-build-rejection; cancel; pin-resume; recovery-before-WebView; local-state-preserved; Android-settings-hold-and-return; native-navigation-hold; blocked-update-channel\nINSTRUMENTATION_CODE: -1\n";
    assert.doesNotThrow(() => requireAndroidInstrumentationReceipt(result));
    assert.throws(
      () =>
        requireAndroidInstrumentationReceipt(
          result.replace("INSTRUMENTATION_CODE: -1", "INSTRUMENTATION_CODE: 0"),
        ),
      /interaction checks failed/,
    );
    assert.throws(
      () =>
        requireAndroidInstrumentationReceipt(
          result.replace("Android-settings-hold-and-return", "skipped"),
        ),
      /interaction checks failed/,
    );
    assert.throws(
      () => requireAndroidInstrumentationReceipt("INSTRUMENTATION_CODE: -1"),
      /interaction checks failed/,
    );
  });
});

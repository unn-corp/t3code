// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - This OS boundary verifies systemd cgroups and bwrap's process identity.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  OrganizationSandboxUnavailable,
  isOrganizationSandboxAvailable,
  readSandboxInfo,
  verifyNamespaceExit,
  type OrganizationSandboxInput,
  type OrganizationSandboxResult,
  type SandboxInfo,
} from "./OrganizationSandboxHost.ts";
import type { OrganizationWorkScopeIdentity } from "./OrganizationWorkScopeStore.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/usr/bin/systemctl";
const BWRAP = "/usr/bin/bwrap";
const MEMORY_BYTES = 256 * 1024 * 1024;
const TASKS_MAX = 32;
const CPU_PERCENT = 50;
const DEFAULT_WORKSPACE_BYTES = 32 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_RUNTIME_MS = 30_000;
const START_BUDGET_MS = 3_000;
const VERIFY_MS = 3_000;
const RESERVED_UNIT = /^t3-org-sandbox-[a-f0-9]{32}\.scope$/;

/** Allocate before the durable preparation marker, then pass the same name to prepare. */
export const allocateOrganizationScopedUnitName = (): string =>
  `t3-org-sandbox-${NodeCrypto.randomUUID().replaceAll("-", "")}.scope`;

function controlFd(
  child: NodeChildProcess.ChildProcess,
  index: number,
): NodeStream.Writable | undefined {
  const candidate = (child.stdio as readonly unknown[])[index];
  return candidate && typeof candidate === "object" && "end" in candidate
    ? (candidate as NodeStream.Writable)
    : undefined;
}

async function writeAndClose(fd: NodeStream.Writable, bytes: string | Buffer): Promise<void> {
  const complete = NodeStreamPromises.finished(fd, { readable: false });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      fd.destroy();
      reject(new OrganizationSandboxUnavailable("Scoped sandbox gate write timed out"));
    }, 3_000);
  });
  try {
    fd.end(bytes);
    await Promise.race([complete, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Caller code is launched only after this fixed entrypoint reads the full start token on FD5.
 * FD5 is deliberately absent from the child stdio array. EOF or a wrong token exits 125.
 */
const ENTRYPOINT = String.raw`
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const expected = process.env.T3_START_TOKEN;
let received = Buffer.alloc(0);
try {
  const chunk = Buffer.alloc(128);
  for (;;) {
    const count = fs.readSync(5, chunk, 0, chunk.length, null);
    if (count === 0) break;
    received = Buffer.concat([received, chunk.subarray(0, count)]);
    if (received.length > 64) process.exit(125);
  }
} catch { process.exit(125); }
if (!expected || received.toString('hex') !== expected) process.exit(125);
try { fs.closeSync(5); } catch { process.exit(125); }
const argv = process.argv.slice(2);
if (argv[0] !== '--' || argv.length < 2) process.exit(125);
const child = spawn(argv[1], argv.slice(2), {
  cwd: '/workspace', env: {}, shell: false,
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.once('error', () => process.exit(126));
child.once('exit', (code, signal) => process.exit(signal ? 128 : (code ?? 126)));
`;

interface Snapshot {
  readonly argv: readonly string[];
  readonly files: readonly (readonly [string, Buffer])[];
  readonly runtimeMs: number;
  readonly maxOutputBytes: number;
  readonly workspaceBytes: number;
}

function snapshotInput(input: OrganizationSandboxInput): Snapshot {
  const argv = [...input.argv];
  const runtimeMs = input.runtimeMs ?? 10_000;
  const maxOutputBytes = input.maxOutputBytes ?? 65_536;
  const workspaceBytes = input.workspaceBytes ?? DEFAULT_WORKSPACE_BYTES;
  if (!argv.length || !/^\/(usr\/bin|bin)\/[A-Za-z0-9._+-]+$/.test(argv[0] ?? ""))
    throw new TypeError("Sandbox executable must be an absolute system binary path");
  if (
    argv.some(
      (arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 8_192,
    ) ||
    argv.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 65_536
  )
    throw new TypeError("Sandbox argv is invalid or oversized");
  if (!Number.isInteger(runtimeMs) || runtimeMs < 1 || runtimeMs > MAX_RUNTIME_MS)
    throw new TypeError("Sandbox runtime is invalid");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES)
    throw new TypeError("Sandbox output limit is invalid");
  if (
    !Number.isInteger(workspaceBytes) ||
    workspaceBytes < 1024 * 1024 ||
    workspaceBytes > MAX_WORKSPACE_BYTES
  )
    throw new TypeError("Sandbox workspace limit is invalid");
  const entries = Object.entries(input.files ?? {});
  let total = 0;
  const files = entries.map(([name, value]) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ||
      [".", "..", "tmp", "dev", "t3-start.mjs"].includes(name)
    )
      throw new TypeError("Sandbox file name must be a safe single path component");
    if (typeof value !== "string" && !(value instanceof Uint8Array))
      throw new TypeError("Sandbox input must be text or bytes");
    const bytes = Buffer.from(value);
    total += bytes.length;
    if (total > MAX_INPUT_BYTES) throw new TypeError("Sandbox input files exceed 1 MiB");
    return [name, bytes] as const;
  });
  return { argv, files, runtimeMs, maxOutputBytes, workspaceBytes };
}

function busEnv(): NodeJS.ProcessEnv {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!runtime || !bus || process.getuid?.() === undefined)
    throw new OrganizationSandboxUnavailable("A systemd user bus and host UID are required");
  return { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: bus };
}

/** Read-only preflight; prepare still verifies the actual transient scope fail closed. */
export function isOrganizationScopedSandboxAvailable(): boolean {
  try {
    if (
      !isOrganizationSandboxAvailable() ||
      !NodeFS.existsSync("/sys/fs/cgroup/cgroup.controllers")
    )
      return false;
    const env = busEnv();
    return (
      NodeChildProcess.spawnSync(SYSTEMD_RUN, ["--version"], {
        env,
        stdio: "ignore",
        timeout: 1_000,
      }).status === 0 &&
      NodeChildProcess.spawnSync(SYSTEMCTL, ["--user", "show", "--property=Version", "--value"], {
        env,
        stdio: "ignore",
        timeout: 1_000,
      }).status === 0
    );
  } catch {
    return false;
  }
}

function parseProperties(output: string): Map<string, string> {
  return new Map(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const cut = line.indexOf("=");
        return [line.slice(0, cut), line.slice(cut + 1)];
      }),
  );
}

async function showUnit(unit: string): Promise<Map<string, string>> {
  const { stdout } = await execFileAsync(
    SYSTEMCTL,
    [
      "--user",
      "show",
      unit,
      "--property=Id,InvocationID,ControlGroup,KillMode,MemoryMax,MemorySwapMax,TasksMax,CPUQuotaPerSecUSec,RuntimeMaxUSec,ActiveState,LoadState,Result",
    ],
    { env: busEnv(), timeout: 2_000, maxBuffer: 16_384 },
  );
  return parseProperties(stdout);
}

function cgroupAbsolute(controlGroup: string): string {
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !controlGroup.startsWith(`/user.slice/user-${uid}.slice/user@${uid}.service/`) ||
    !/^\/[A-Za-z0-9_./@-]+$/.test(controlGroup) ||
    controlGroup.includes("..")
  )
    throw new OrganizationSandboxUnavailable("Scope cgroup is outside the current user manager");
  return NodePath.join("/sys/fs/cgroup", controlGroup);
}

function durationMicros(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)(us|ms|s)$/.exec(value ?? "");
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  return amount * (match[2] === "s" ? 1_000_000 : match[2] === "ms" ? 1_000 : 1);
}

async function verifyScope(
  unit: string,
  invocationId: string | undefined,
  childPid: number,
  hardRuntimeMs: number,
): Promise<{ invocationId: string; controlGroup: string }> {
  const p = await showUnit(unit);
  const id = p.get("InvocationID") ?? "";
  const group = p.get("ControlGroup") ?? "";
  if (
    p.get("Id") !== unit ||
    !/^[a-f0-9]{32}$/i.test(id) ||
    (invocationId && id !== invocationId) ||
    p.get("KillMode") !== "control-group" ||
    p.get("ActiveState") !== "active" ||
    p.get("MemoryMax") !== String(MEMORY_BYTES) ||
    p.get("MemorySwapMax") !== "0" ||
    p.get("TasksMax") !== String(TASKS_MAX) ||
    p.get("CPUQuotaPerSecUSec") !== "500ms" ||
    durationMicros(p.get("RuntimeMaxUSec")) > hardRuntimeMs * 1_000 ||
    !Number.isFinite(durationMicros(p.get("RuntimeMaxUSec"))) ||
    !group.endsWith(`/${unit}`)
  )
    throw new OrganizationSandboxUnavailable(
      "Scope identity or requested limits could not be verified",
    );
  const cgroup = cgroupAbsolute(group);
  const [memory, swap, pids, cpu, membership] = await Promise.all([
    NodeFSP.readFile(NodePath.join(cgroup, "memory.max"), "utf8"),
    NodeFSP.readFile(NodePath.join(cgroup, "memory.swap.max"), "utf8"),
    NodeFSP.readFile(NodePath.join(cgroup, "pids.max"), "utf8"),
    NodeFSP.readFile(NodePath.join(cgroup, "cpu.max"), "utf8"),
    NodeFSP.readFile(`/proc/${childPid}/cgroup`, "utf8"),
  ]);
  const cpuParts = cpu.trim().split(/\s+/).map(Number);
  if (
    Number(memory.trim()) > MEMORY_BYTES ||
    swap.trim() !== "0" ||
    Number(pids.trim()) > TASKS_MAX ||
    !Number.isFinite(Number(memory.trim())) ||
    !Number.isFinite(Number(pids.trim())) ||
    cpuParts.length !== 2 ||
    !Number.isFinite(cpuParts[0]) ||
    !Number.isFinite(cpuParts[1]) ||
    (cpuParts[0] ?? Infinity) * 100 > (cpuParts[1] ?? 0) * CPU_PERCENT ||
    !membership.split("\n").includes(`0::${group}`)
  )
    throw new OrganizationSandboxUnavailable(
      "Kernel cgroup limits or sandbox membership could not be verified",
    );
  return { invocationId: id, controlGroup: group };
}

async function verifyStopped(
  unit: string,
  invocationId: string,
  controlGroup: string,
  info: Pick<SandboxInfo, "pidNamespace">,
): Promise<boolean> {
  const deadline = Date.now() + VERIFY_MS;
  for (;;) {
    const p = await showUnit(unit);
    const unloaded =
      p.get("LoadState") === "not-found" && !p.get("InvocationID") && !p.get("ControlGroup");
    const timedOutState =
      p.get("ActiveState") === "failed" &&
      p.get("Result") === "timeout" &&
      p.get("InvocationID") === invocationId;
    const stopped =
      p.get("ActiveState") === "inactive" &&
      (unloaded || (p.get("Id") === unit && p.get("InvocationID") === invocationId));
    if ((!stopped && !timedOutState) || p.get("Id") !== unit) {
      if (Date.now() >= deadline) throw new Error("Exact sandbox scope did not become inactive");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }
    try {
      const events = await NodeFSP.readFile(
        NodePath.join(cgroupAbsolute(controlGroup), "cgroup.events"),
        "utf8",
      );
      if (!/^populated 0$/m.test(events)) {
        if (Date.now() >= deadline) throw new Error("Sandbox cgroup is still populated");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // systemd removed this exact inactive cgroup; kernel removal requires emptiness.
    }
    await verifyNamespaceExit(info.pidNamespace);
    return timedOutState;
  }
}

/** Stop and verify an identity persisted before the original host disappeared.
 * A missing unit is accepted only for this known invocation and only after its
 * cgroup and PID namespace are empty. An identity-less launch has no such proof.
 */
export async function stopAndVerifyOrganizationScopedSandbox(
  identity: OrganizationWorkScopeIdentity,
): Promise<void> {
  const { unitName, invocationId, controlGroup, sandboxPid, pidNamespace } = identity;
  if (
    !RESERVED_UNIT.test(unitName) ||
    !/^[a-f0-9]{32}$/.test(invocationId) ||
    !controlGroup.endsWith(`/${unitName}`) ||
    !Number.isSafeInteger(sandboxPid) ||
    sandboxPid <= 0 ||
    !Number.isSafeInteger(pidNamespace) ||
    pidNamespace <= 0
  )
    throw new OrganizationSandboxUnavailable("Persisted scope identity is invalid");
  cgroupAbsolute(controlGroup);
  const current = await showUnit(unitName);
  if (current.get("Id") !== unitName)
    throw new OrganizationSandboxUnavailable("Persisted scope unit identity changed");
  const absent =
    current.get("LoadState") === "not-found" &&
    !current.get("InvocationID") &&
    !current.get("ControlGroup");
  if (!absent) {
    if (current.get("InvocationID") !== invocationId)
      throw new OrganizationSandboxUnavailable("Persisted scope invocation identity changed");
    const liveGroup = current.get("ControlGroup");
    if (liveGroup && liveGroup !== controlGroup)
      throw new OrganizationSandboxUnavailable("Persisted scope cgroup identity changed");
    if (current.get("ActiveState") !== "inactive") await stopExactUnit(unitName);
  }
  await verifyStopped(unitName, invocationId, controlGroup, { pidNamespace });
}

async function stopExactUnit(unit: string): Promise<void> {
  try {
    await execFileAsync(SYSTEMCTL, ["--user", "stop", unit], {
      env: busEnv(),
      timeout: 3_000,
      maxBuffer: 16_384,
    });
  } catch (error) {
    // A short-lived scope may unload between the status check and stop. The
    // caller still verifies the exact cgroup and PID namespace before success.
    const current = await showUnit(unit);
    if (
      current.get("LoadState") === "not-found" &&
      !current.get("InvocationID") &&
      !current.get("ControlGroup")
    )
      return;
    throw error;
  }
}

export interface PreparedOrganizationScopedSandbox {
  readonly unitName: string;
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly sandboxPid: number;
  readonly pidNamespace: number;
  readonly workDirectory: string;
  /** Release only after the caller durably records unitName and invocationId. */
  start(): Promise<void>;
  /** Close both start gates without a token; caller argv must never run. */
  discard(): Promise<OrganizationSandboxResult>;
  wait(): Promise<OrganizationSandboxResult>;
  stop(): Promise<OrganizationSandboxResult>;
}

/** Preparation starts only the trusted gate. The caller's argv remains blocked on FD5. */
export async function prepareOrganizationScopedSandbox(
  input: OrganizationSandboxInput & { readonly reservedUnitName?: string },
): Promise<PreparedOrganizationScopedSandbox> {
  const captured = snapshotInput(input); // All caller-owned data is copied before the first await.
  const unitName = input.reservedUnitName ?? allocateOrganizationScopedUnitName();
  if (!RESERVED_UNIT.test(unitName))
    throw new OrganizationSandboxUnavailable("Reserved scope unit name is invalid");
  const hardRuntimeMs = captured.runtimeMs + START_BUDGET_MS;
  if (
    HostProcessPlatform.defaultValue() !== "linux" ||
    NodeChildProcess.spawnSync(BWRAP, ["--version"], { stdio: "ignore", timeout: 1_000 }).status !==
      0
  )
    throw new OrganizationSandboxUnavailable("Linux bubblewrap is unavailable");
  const env = busEnv();
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const workDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-scoped-"));
  let child: NodeChildProcess.ChildProcess | undefined;
  let info: SandboxInfo | undefined;
  let identity: { invocationId: string; controlGroup: string } | undefined;
  const stagedHandles: NodeFSP.FileHandle[] = [];
  const stagedReaders: NodeFSP.FileHandle[] = [];
  try {
    const stagedInput = [["t3-start.mjs", Buffer.from(ENTRYPOINT)] as const, ...captured.files];
    for (const [name, contents] of stagedInput) {
      const path = NodePath.join(workDirectory, name);
      const handle = await NodeFSP.open(path, "wx+", 0o600);
      stagedHandles.push(handle);
      // The path is removed before any input bytes are written. A supervisor
      // crash can leave only an empty directory, never a readable staged file.
      await NodeFSP.unlink(path);
      await handle.writeFile(contents);
      // Bubblewrap's data mount reads from a separate descriptor at offset 0.
      const reader = await NodeFSP.open(`/proc/self/fd/${handle.fd}`, "r");
      stagedHandles.push(reader);
      stagedReaders.push(reader);
    }
    await NodeFSP.rm(workDirectory, { recursive: true, force: true });
    const staging = stagedInput.flatMap(([name], index) => [
      "--ro-bind-data",
      String(6 + index),
      `/workspace/${name}`,
    ]);
    child = NodeChildProcess.spawn(
      SYSTEMD_RUN,
      [
        "--user",
        "--scope",
        "--quiet",
        `--unit=${unitName}`,
        `--property=MemoryMax=${MEMORY_BYTES}`,
        "--property=MemorySwapMax=0",
        `--property=TasksMax=${TASKS_MAX}`,
        `--property=CPUQuota=${CPU_PERCENT}%`,
        `--property=RuntimeMaxSec=${hardRuntimeMs}ms`,
        "--property=KillMode=control-group",
        BWRAP,
        "--unshare-all",
        "--unshare-user",
        "--disable-userns",
        "--assert-userns-disabled",
        "--die-with-parent",
        "--as-pid-1",
        "--new-session",
        "--clearenv",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr/bin",
        "/usr/bin",
        "--ro-bind",
        "/usr/lib",
        "/usr/lib",
        "--symlink",
        "lib",
        "/usr/lib64",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dir",
        "/dev",
        "--dev-bind",
        "/dev/null",
        "/dev/null",
        "--dev-bind",
        "/dev/zero",
        "/dev/zero",
        "--dev-bind",
        "/dev/random",
        "/dev/random",
        "--dev-bind",
        "/dev/urandom",
        "/dev/urandom",
        "--symlink",
        "workspace/tmp",
        "/tmp",
        "--size",
        String(captured.workspaceBytes),
        "--tmpfs",
        "/workspace",
        "--dir",
        "/workspace/tmp",
        ...staging,
        "--info-fd",
        "3",
        "--block-fd",
        "4",
        "--chdir",
        "/workspace",
        "--setenv",
        "T3_START_TOKEN",
        token,
        "--remount-ro",
        "/",
        "--",
        "/usr/bin/node",
        "/workspace/t3-start.mjs",
        "--",
        ...captured.argv,
      ],
      {
        cwd: "/",
        env,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          "pipe",
          "pipe",
          "pipe",
          ...stagedReaders.map((h) => h.fd),
        ],
        shell: false,
      },
    );
    await Promise.all(stagedHandles.splice(0).map((handle) => handle.close()));
    if (
      !child.pid ||
      !child.stdout ||
      !child.stderr ||
      !controlFd(child, 4) ||
      !controlFd(child, 5)
    )
      throw new OrganizationSandboxUnavailable("Scoped bubblewrap pipes are unavailable");
    // Install output readers before waiting, so the child cannot block on a full pipe.
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let exceeded = false;
    let timedOut = false;
    let started = false;
    let stopRequested = false;
    let stopTask: Promise<void> | undefined;
    let runtimeTimer: NodeJS.Timeout | undefined;
    const capture = (parts: Buffer[], chunk: Buffer) => {
      const remaining = captured.maxOutputBytes - total;
      if (remaining > 0) parts.push(chunk.subarray(0, remaining));
      total += chunk.length;
      if (total > captured.maxOutputBytes && !exceeded) {
        exceeded = true;
        void stop().catch(() => {});
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const close = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child?.once("error", reject);
        child?.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      },
    );
    void close.catch(() => {});
    info = await Promise.race([
      readSandboxInfo(child),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sandbox identity timed out")), 2_000),
      ),
      close.then(() => {
        throw new Error("Scope exited before sandbox identity was available");
      }),
    ]);
    identity = await verifyScope(unitName, undefined, info.childPid, hardRuntimeMs);
    const verifiedInfo = info;
    const verifiedIdentity = identity;
    let finalizing: Promise<OrganizationSandboxResult> | undefined;
    const finalize = () =>
      (finalizing ??= (async () => {
        try {
          const ended = await close;
          if (runtimeTimer) clearTimeout(runtimeTimer);
          const p = await showUnit(unitName);
          if (p.get("ActiveState") !== "inactive" && p.get("LoadState") !== "not-found") {
            if (p.get("Id") !== unitName || p.get("InvocationID") !== verifiedIdentity.invocationId)
              throw new Error("Scope identity changed before cleanup");
            await stopExactUnit(unitName);
          }
          const hardTimedOut = await verifyStopped(
            unitName,
            verifiedIdentity.invocationId,
            verifiedIdentity.controlGroup,
            verifiedInfo,
          );
          return {
            exitCode: ended.exitCode,
            signal: ended.signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            timedOut: timedOut || hardTimedOut,
            outputLimitExceeded: exceeded,
          };
        } catch (error) {
          // A failed close/status check cannot certify cleanup. Try the exact
          // recorded unit anyway, then preserve the original failed fence.
          try {
            const p = await showUnit(unitName);
            if (
              p.get("Id") === unitName &&
              p.get("InvocationID") === verifiedIdentity.invocationId &&
              p.get("ActiveState") !== "inactive" &&
              p.get("LoadState") !== "not-found"
            )
              await stopExactUnit(unitName);
          } catch {
            /* The caller still receives the failed verification. */
          }
          throw error;
        } finally {
          if (runtimeTimer) clearTimeout(runtimeTimer);
          await verifiedInfo.namespaceHandle.close();
          await NodeFSP.rm(workDirectory, { recursive: true, force: true });
        }
      })());
    const stop = async (): Promise<OrganizationSandboxResult> => {
      stopRequested = true;
      stopTask ??= (async () => {
        if (child) {
          controlFd(child, 4)?.destroy();
          controlFd(child, 5)?.destroy();
        }
        const p = await showUnit(unitName);
        if (p.get("ActiveState") !== "inactive" && p.get("LoadState") !== "not-found") {
          if (p.get("Id") !== unitName || p.get("InvocationID") !== verifiedIdentity.invocationId)
            throw new Error("Scope identity changed before stop");
          await stopExactUnit(unitName);
        }
      })();
      try {
        await stopTask;
      } catch (error) {
        stopTask = undefined;
        throw error;
      }
      return finalize();
    };
    return {
      unitName,
      invocationId: identity.invocationId,
      controlGroup: identity.controlGroup,
      sandboxPid: info.childPid,
      pidNamespace: info.pidNamespace,
      workDirectory,
      start: async () => {
        if (started || stopRequested) throw new Error("Sandbox is already started or stopping");
        await verifyScope(
          unitName,
          verifiedIdentity.invocationId,
          verifiedInfo.childPid,
          hardRuntimeMs,
        );
        started = true;
        // FD4 is released first. If the supervisor crashes before FD5, the trusted
        // entrypoint sees EOF and exits 125 without launching caller argv. The
        // caller's durable fence awaits both writes before recording release.
        const blockFd = child && controlFd(child, 4);
        const gateFd = child && controlFd(child, 5);
        if (!blockFd || !gateFd)
          throw new OrganizationSandboxUnavailable("Scoped sandbox control pipes closed");
        await writeAndClose(blockFd, "R");
        await writeAndClose(gateFd, Buffer.from(token, "hex"));
        runtimeTimer = setTimeout(() => {
          timedOut = true;
          void stop().catch(() => {});
        }, captured.runtimeMs);
      },
      discard: async () => {
        if (started || stopRequested) throw new Error("Sandbox is already started or stopping");
        stopRequested = true;
        // Closing FD4 releases bwrap on this host. The FD5 EOF must make the
        // trusted entrypoint exit 125 without spawning the caller's argv.
        if (child) {
          controlFd(child, 5)?.end();
          controlFd(child, 4)?.end();
        }
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            close,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Discarded sandbox did not exit")), 2_000);
            }),
          ]);
        } catch (error) {
          await stopExactUnit(unitName);
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
        return finalize();
      },
      wait: () =>
        started || stopRequested
          ? finalize()
          : Promise.reject(new Error("Sandbox has not started")),
      stop,
    };
  } catch (error) {
    await Promise.allSettled(stagedHandles.splice(0).map((handle) => handle.close()));
    if (child) {
      controlFd(child, 4)?.destroy();
      controlFd(child, 5)?.destroy();
    }
    if (child && identity) {
      try {
        const current = await showUnit(unitName);
        if (
          current.get("Id") === unitName &&
          current.get("InvocationID") === identity.invocationId &&
          current.get("ActiveState") !== "inactive" &&
          current.get("LoadState") !== "not-found"
        )
          await stopExactUnit(unitName);
      } catch {
        /* Unverified cleanup remains fail-closed to the caller and permit. */
      }
    }
    if (info) await info.namespaceHandle.close();
    await NodeFSP.rm(workDirectory, { recursive: true, force: true });
    throw error;
  }
}

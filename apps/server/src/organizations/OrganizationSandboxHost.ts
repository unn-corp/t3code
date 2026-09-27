// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - This boundary needs captured OS PIDs, /proc, and hard stop timers; bwrap owns the JSON info protocol.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BWRAP = "/usr/bin/bwrap";
const MAX_RUNTIME_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_INPUT_BYTES = 1_048_576;
const DEFAULT_WORKSPACE_BYTES = 32 * 1_048_576;
const MAX_WORKSPACE_BYTES = 64 * 1_048_576;
const STOP_GRACE_MS = 500;
const STOP_VERIFY_MS = 3_000;
const DEVICE_NAMES = ["null", "zero", "random", "urandom"] as const;

export interface OrganizationSandboxInput {
  readonly argv: readonly [string, ...string[]];
  /** Only regular files with single-component names can be staged. No host path is mounted. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly runtimeMs?: number;
  readonly maxOutputBytes?: number;
  /** Writable tmpfs budget; input files are separate read-only mounts. */
  readonly workspaceBytes?: number;
}

export interface OrganizationSandboxResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
}

export interface OrganizationSandboxHandle {
  readonly id: string;
  /** Captured bwrap host PID, also the spawned process group ID. */
  readonly pid: number;
  readonly processGroupId: number;
  /** Host staging directory for read-only inputs; removed when the sandbox exits. */
  readonly workDirectory: string;
  wait(): Promise<OrganizationSandboxResult>;
  /** Resolves when the exact marker arrives on stdout, or rejects if the sandbox exits first. */
  waitForOutput(marker: string): Promise<void>;
  /** Resolves only after the process and inherited output pipes close. */
  stop(): Promise<OrganizationSandboxResult>;
}

export class OrganizationSandboxUnavailable extends Error {
  override readonly name = "OrganizationSandboxUnavailable";
}

/** Keep production dispatch disconnected until aggregate limits are enforced. */
export const OrganizationSandboxProductionStatus = {
  ready: false,
  missing: ["aggregate process, memory, and CPU limits"],
} as const;

const BASE_ARGS = [
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
  "--symlink",
  "workspace/tmp",
  "/tmp",
] as const;

/** A real namespace probe; a present binary alone does not imply user namespaces work. */
export function isOrganizationSandboxAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const probe = spawnSync(
    BWRAP,
    [
      ...BASE_ARGS,
      "--size",
      String(DEFAULT_WORKSPACE_BYTES),
      "--tmpfs",
      "/workspace",
      "--dir",
      "/workspace/tmp",
      "--remount-ro",
      "/",
      "--",
      "/usr/bin/true",
    ],
    {
      env: {},
      stdio: "ignore",
      timeout: 2_000,
    },
  );
  return probe.status === 0;
}

function assertInput(input: {
  readonly argv: readonly [string, ...string[]];
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  readonly runtimeMs: number | undefined;
  readonly maxOutputBytes: number | undefined;
  readonly workspaceBytes: number | undefined;
}): void {
  const { argv } = input;
  if (argv.length === 0 || !/^\/(usr\/bin|bin)\/[A-Za-z0-9._+-]+$/.test(argv[0])) {
    throw new TypeError("Sandbox executable must be an absolute system binary path");
  }
  if (argv.some((arg) => arg.includes("\0") || Buffer.byteLength(arg) > 8_192)) {
    throw new TypeError("Sandbox argv contains an invalid or oversized argument");
  }
  if (argv.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 65_536) {
    throw new TypeError("Sandbox argv is too large");
  }
  if (
    input.runtimeMs !== undefined &&
    (!Number.isInteger(input.runtimeMs) || input.runtimeMs < 1 || input.runtimeMs > MAX_RUNTIME_MS)
  ) {
    throw new TypeError("Sandbox runtime must be between 1 and 30000 ms");
  }
  if (
    input.maxOutputBytes !== undefined &&
    (!Number.isInteger(input.maxOutputBytes) ||
      input.maxOutputBytes < 1 ||
      input.maxOutputBytes > MAX_OUTPUT_BYTES)
  ) {
    throw new TypeError("Sandbox output limit must be between 1 and 1048576 bytes");
  }
  if (
    input.workspaceBytes !== undefined &&
    (!Number.isInteger(input.workspaceBytes) ||
      input.workspaceBytes < 1_048_576 ||
      input.workspaceBytes > MAX_WORKSPACE_BYTES)
  ) {
    throw new TypeError("Sandbox workspace limit must be between 1 and 64 MiB");
  }
  let fileBytes = 0;
  for (const [name, contents] of Object.entries(input.files ?? {})) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ||
      name === "." ||
      name === ".." ||
      name === "tmp" ||
      name === "dev"
    ) {
      throw new TypeError("Sandbox file name must be a safe single path component");
    }
    fileBytes += Buffer.byteLength(contents);
    if (fileBytes > MAX_INPUT_BYTES) throw new TypeError("Sandbox input files exceed 1 MiB");
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  // The bwrap parent can exit while a descendant still owns an inherited pipe.
  // Signal the captured group until close, even after Node records its exit code.
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export interface SandboxInfo {
  readonly childPid: number;
  readonly pidNamespace: number;
  readonly namespaceHandle: FileHandle;
}

export function readSandboxInfo(child: ChildProcess): Promise<SandboxInfo> {
  const stream = child.stdio[3];
  if (!stream) return Promise.reject(new Error("bubblewrap did not expose sandbox info"));
  return new Promise((resolve, reject) => {
    let text = "";
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 4_096) reject(new Error("bubblewrap sandbox info is oversized"));
    });
    stream.once("error", reject);
    stream.once("end", () => {
      void (async () => {
        try {
          const value: unknown = JSON.parse(text);
          if (typeof value !== "object" || value === null) throw new Error("Invalid sandbox info");
          const childPid = Reflect.get(value, "child-pid");
          const pidNamespace = Reflect.get(value, "pid-namespace");
          if (
            typeof childPid !== "number" ||
            !Number.isSafeInteger(childPid) ||
            childPid <= 0 ||
            typeof pidNamespace !== "number" ||
            !Number.isSafeInteger(pidNamespace) ||
            pidNamespace <= 0
          ) {
            throw new Error("bubblewrap omitted sandbox PID namespace identity");
          }
          const namespaceHandle = await open(`/proc/${childPid}/ns/pid`, "r");
          try {
            const heldNamespace = await readlink(`/proc/self/fd/${namespaceHandle.fd}`);
            const status = await readFile(`/proc/${childPid}/status`, "utf8");
            const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
            const nsPids = /^NSpid:\s+([\d\s]+)/m.exec(status)?.[1]?.trim().split(/\s+/);
            if (
              heldNamespace !== `pid:[${pidNamespace}]` ||
              Number(uid) !== process.getuid?.() ||
              nsPids?.at(-1) !== "1"
            ) {
              throw new Error("bubblewrap sandbox PID, UID, or namespace identity changed");
            }
          } catch (error) {
            await namespaceHandle.close();
            throw error;
          }
          resolve({ childPid, pidNamespace, namespaceHandle });
        } catch (error) {
          reject(error);
        }
      })();
    });
  });
}

async function namespaceHasLiveProcesses(pidNamespace: number): Promise<boolean> {
  const hostUid = process.getuid?.();
  if (hostUid === undefined)
    throw new Error("Host UID is unavailable for PID namespace verification");
  const namespaceLink = `pid:[${pidNamespace}]`;
  const pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  let next = 0;
  let live = false;
  await Promise.all(
    Array.from({ length: Math.min(32, pids.length) }, async () => {
      while (next < pids.length && !live) {
        const pid = pids[next++];
        if (pid === undefined) break;
        try {
          const status = await readFile(`/proc/${pid}/status`, "utf8");
          // --unshare-user maps this sandbox to the launching host UID only.
          const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
          if (uid === undefined) throw new Error(`Cannot verify UID for process ${pid}`);
          if (Number(uid) !== hostUid) continue;
          const nsPids = /^NSpid:\s+([\d\s]+)/m.exec(status)?.[1]?.trim().split(/\s+/);
          if (!nsPids) throw new Error(`Cannot verify PID namespace for process ${pid}`);
          if (nsPids.length === 1) continue;
          if ((await readlink(`/proc/${pid}/ns/pid`)) !== namespaceLink) continue;
          const state = /^State:\s+([A-Z])/m.exec(status)?.[1];
          if (state !== "Z" && state !== "X") live = true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ESRCH") throw error;
        }
      }
    }),
  );
  return live;
}

export async function verifyNamespaceExit(pidNamespace: number): Promise<void> {
  const deadline = Date.now() + STOP_VERIFY_MS;
  while (Date.now() < deadline) {
    if (!(await namespaceHasLiveProcesses(pidNamespace))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Sandbox stop could not verify PID namespace exit");
}

/** Isolated host primitive only. It deliberately does not grant Organization work authority. */
export async function launchOrganizationSandbox(
  input: OrganizationSandboxInput,
): Promise<OrganizationSandboxHandle> {
  // Snapshot every caller-owned value before the first await. In particular,
  // staged names must be the same names that passed path validation.
  const argv = [...input.argv] as [string, ...string[]];
  const runtimeMs = input.runtimeMs;
  const maxOutputBytes = input.maxOutputBytes;
  const workspaceBytes = input.workspaceBytes;
  const sourceFiles = Object.entries(input.files ?? {});
  assertInput({
    argv,
    files: Object.fromEntries(sourceFiles),
    runtimeMs,
    maxOutputBytes,
    workspaceBytes,
  });
  const stagedInput = sourceFiles.map(([name, contents]) => [name, Buffer.from(contents)] as const);
  if (!isOrganizationSandboxAvailable()) {
    throw new OrganizationSandboxUnavailable(
      "Linux bubblewrap user/PID/network namespaces are unavailable",
    );
  }

  const workDirectory = await mkdtemp(join(tmpdir(), "t3-org-sandbox-"));
  try {
    const deviceDirectory = join(workDirectory, "dev");
    await mkdir(deviceDirectory, { mode: 0o700 });
    for (const name of DEVICE_NAMES) {
      await writeFile(join(deviceDirectory, name), "", { flag: "wx", mode: 0o600 });
    }
    await symlink("/proc/self/fd", join(deviceDirectory, "fd"));
    await symlink("/proc/self/fd/0", join(deviceDirectory, "stdin"));
    await symlink("/proc/self/fd/1", join(deviceDirectory, "stdout"));
    await symlink("/proc/self/fd/2", join(deviceDirectory, "stderr"));
    for (const [name, contents] of stagedInput) {
      await writeFile(join(workDirectory, name), contents, { flag: "wx", mode: 0o600 });
    }
    const deviceMounts = DEVICE_NAMES.flatMap((name) => [
      "--dev-bind",
      `/dev/${name}`,
      `/dev/${name}`,
    ]);
    const stagedFiles = stagedInput.flatMap(([name]) => [
      "--ro-bind",
      join(workDirectory, name),
      `/workspace/${name}`,
    ]);
    const child = spawn(
      BWRAP,
      [
        ...BASE_ARGS,
        "--ro-bind",
        deviceDirectory,
        "/dev",
        ...deviceMounts,
        "--size",
        String(workspaceBytes ?? DEFAULT_WORKSPACE_BYTES),
        "--tmpfs",
        "/workspace",
        "--dir",
        "/workspace/tmp",
        ...stagedFiles,
        "--info-fd",
        "3",
        "--chdir",
        "/workspace",
        "--remount-ro",
        "/",
        "--",
        ...argv,
      ],
      {
        cwd: "/",
        env: {},
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        detached: true,
        shell: false,
      },
    );
    if (child.pid === undefined)
      throw new OrganizationSandboxUnavailable("bubblewrap did not start");
    if (!child.stdout || !child.stderr)
      throw new OrganizationSandboxUnavailable("bubblewrap output pipes are unavailable");
    const infoPromise = readSandboxInfo(child);
    // The close handler consumes this, including when bwrap fails during startup.
    void infoPromise.catch(() => {});

    const limit = maxOutputBytes ?? 65_536;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let stopping = false;
    let stopTimer: NodeJS.Timeout | undefined;
    let verifyTimer: NodeJS.Timeout | undefined;
    let runtimeTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let closed = false;
    let stdoutText = "";
    const outputWaiters = new Set<{
      marker: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }>();
    let resolveResult!: (result: OrganizationSandboxResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<OrganizationSandboxResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const clearTimers = () => {
      if (runtimeTimer) clearTimeout(runtimeTimer);
      if (stopTimer) clearTimeout(stopTimer);
      if (verifyTimer) clearTimeout(verifyTimer);
    };
    const rejectOutputWaiters = () => {
      for (const waiter of outputWaiters)
        waiter.reject(new Error(`Sandbox exited before output marker: ${waiter.marker}`));
      outputWaiters.clear();
    };
    const stop = (): Promise<OrganizationSandboxResult> => {
      if (!stopping && !settled && !closed) {
        stopping = true;
        signalGroup(child, "SIGTERM");
        stopTimer = setTimeout(() => signalGroup(child, "SIGKILL"), STOP_GRACE_MS);
        verifyTimer = setTimeout(() => {
          if (!settled) {
            signalGroup(child, "SIGKILL");
            settled = true;
            clearTimers();
            rejectOutputWaiters();
            rejectResult(new Error("Sandbox stop could not verify descendant exit"));
          }
        }, STOP_VERIFY_MS);
      }
      return result;
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = limit - bytes;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > limit) {
        outputLimitExceeded = true;
        void stop().catch(() => {});
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdout, chunk);
      stdoutText += chunk.toString("utf8");
      if (stdoutText.length > limit) stdoutText = stdoutText.slice(-limit);
      for (const waiter of outputWaiters) {
        if (stdoutText.includes(waiter.marker)) {
          outputWaiters.delete(waiter);
          waiter.resolve();
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectOutputWaiters();
      void rm(workDirectory, { recursive: true, force: true }).finally(() => rejectResult(error));
    });
    child.once("close", (exitCode, signal) => {
      closed = true;
      if (runtimeTimer) clearTimeout(runtimeTimer);
      if (stopTimer) clearTimeout(stopTimer);
      rejectOutputWaiters();
      if (settled) {
        void rm(workDirectory, { recursive: true, force: true });
        return;
      }
      void (async () => {
        try {
          const info = await infoPromise;
          try {
            await verifyNamespaceExit(info.pidNamespace);
          } finally {
            await info.namespaceHandle.close();
          }
          if (settled) return;
          settled = true;
          clearTimers();
          await rm(workDirectory, { recursive: true, force: true });
          resolveResult({
            exitCode,
            signal,
            timedOut,
            outputLimitExceeded,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        } catch (error) {
          if (settled) return;
          settled = true;
          clearTimers();
          await rm(workDirectory, { recursive: true, force: true });
          rejectResult(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    runtimeTimer = setTimeout(() => {
      timedOut = true;
      void stop().catch(() => {});
    }, runtimeMs ?? 10_000);

    return {
      id: randomUUID(),
      pid: child.pid,
      processGroupId: child.pid,
      workDirectory,
      wait: () => result,
      waitForOutput: (marker) => {
        if (!marker || marker.length > 256)
          return Promise.reject(new TypeError("Output marker must contain 1-256 characters"));
        if (stdoutText.includes(marker)) return Promise.resolve();
        if (settled)
          return Promise.reject(new Error(`Sandbox exited before output marker: ${marker}`));
        return new Promise<void>((resolve, reject) =>
          outputWaiters.add({ marker, resolve, reject }),
        );
      },
      stop,
    };
  } catch (error) {
    await rm(workDirectory, { recursive: true, force: true });
    throw error;
  }
}

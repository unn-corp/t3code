// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - These fixtures check real systemd cgroup and namespace boundaries.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import {
  allocateOrganizationScopedUnitName,
  isOrganizationScopedSandboxAvailable,
  prepareOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";

const available = isOrganizationScopedSandboxAvailable();
const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

it("rejects malformed reserved unit names before a host launch", async () => {
  await NodeAssert.strict.rejects(
    prepareOrganizationScopedSandbox({
      argv: ["/usr/bin/true"],
      reservedUnitName: "../../user.service",
    }),
    /Reserved scope unit name is invalid/,
  );
});

it.skipIf(!available)("uses an exact preallocated systemd unit name", async () => {
  const reservedUnitName = allocateOrganizationScopedUnitName();
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/true"],
    reservedUnitName,
  });
  NodeAssert.strict.equal(handle.unitName, reservedUnitName);
  await handle.discard();
});

it.skipIf(!available)("prepares a verified scoped sandbox before caller code starts", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/node", "-e", "process.stdout.write('SCOPED_EXECUTED\\n')"],
    runtimeMs: 3_000,
  });
  NodeAssert.strict.match(handle.unitName, /^t3-org-sandbox-[a-f0-9]{32}\.scope$/);
  NodeAssert.strict.match(handle.invocationId, /^[a-f0-9]{32}$/);
  NodeAssert.strict.ok(handle.controlGroup.endsWith(`/${handle.unitName}`));
  NodeAssert.strict.equal(
    (await NodeFSP.readFile(`/sys/fs/cgroup${handle.controlGroup}/memory.swap.max`, "utf8")).trim(),
    "0",
  );
  await NodeAssert.strict.rejects(handle.wait(), /has not started/);
  await handle.start();
  const result = await handle.wait();
  NodeAssert.strict.equal(result.exitCode, 0);
  NodeAssert.strict.match(result.stdout, /SCOPED_EXECUTED/);
  await NodeAssert.strict.rejects(NodeFSP.stat(handle.workDirectory), { code: "ENOENT" });
});

it.skipIf(!available)("forwards unlinked FD6+ input as read-only staged data", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: [
      "/usr/bin/node",
      "-e",
      "const f=require('node:fs');process.stdout.write('STAGED='+f.readFileSync('/workspace/data.txt','utf8')+'\\n');try{f.writeFileSync('/workspace/data.txt','tampered');process.stdout.write('WRITABLE\\n')}catch(e){process.stdout.write('WRITE_DENIED='+e.code+'\\n')}",
    ],
    files: { "data.txt": "synthetic-stage-proof" },
  });
  await NodeAssert.strict.rejects(NodeFSP.stat(handle.workDirectory), { code: "ENOENT" });
  await handle.start();
  const result = await handle.wait();
  NodeAssert.strict.equal(result.exitCode, 0);
  NodeAssert.strict.match(result.stdout, /STAGED=synthetic-stage-proof/);
  NodeAssert.strict.match(result.stdout, /WRITE_DENIED=(EROFS|EBUSY)/);
  NodeAssert.strict.doesNotMatch(result.stdout, /WRITABLE/);
  await NodeAssert.strict.rejects(NodeFSP.stat(handle.workDirectory), { code: "ENOENT" });
});

it.skipIf(!available)("supervisor SIGKILL leaves no staged host input", async () => {
  const moduleUrl = new URL("./OrganizationScopedSandboxHost.ts", import.meta.url).href;
  const script = `
    import { prepareOrganizationScopedSandbox } from ${JSON.stringify(moduleUrl)};
    const handle = await prepareOrganizationScopedSandbox({
      argv: ['/usr/bin/node', '-e', 'setInterval(() => {}, 1000)'],
      files: { 'synthetic.txt': 'synthetic-stage-proof' },
      runtimeMs: 1_000,
    });
    process.stdout.write(JSON.stringify({unitName: handle.unitName, controlGroup: handle.controlGroup, workDirectory: handle.workDirectory}) + '\\n');
    await handle.start();
    process.stdout.write('STARTED\\n');
    setInterval(() => {}, 1000);
  `;
  const supervisor = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  let text = "";
  let unitName = "";
  let controlGroup = "";
  let workDirectory = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Crash probe did not start: ${text}`)),
        3_000,
      );
      supervisor.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const line = text.split("\n")[0];
        if (line && !unitName) {
          try {
            const value = JSON.parse(line) as {
              unitName: string;
              controlGroup: string;
              workDirectory: string;
            };
            unitName = value.unitName;
            controlGroup = value.controlGroup;
            workDirectory = value.workDirectory;
          } catch {
            /* wait for complete JSON line */
          }
        }
        if (text.includes("STARTED\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
      supervisor.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      supervisor.once("close", (code) => {
        if (!text.includes("STARTED\n")) {
          clearTimeout(timer);
          reject(new Error(`Crash probe exited ${code}: ${text}`));
        }
      });
    });
    NodeAssert.strict.match(unitName, /^t3-org-sandbox-[a-f0-9]{32}\.scope$/);
    await NodeAssert.strict.rejects(NodeFSP.stat(workDirectory), { code: "ENOENT" });
    if (!supervisor.pid) throw new Error("Supervisor PID was unavailable");
    process.kill(supervisor.pid, "SIGKILL");
    await new Promise<void>((resolve) => supervisor.once("close", () => resolve()));
    await NodeAssert.strict.rejects(NodeFSP.stat(workDirectory), { code: "ENOENT" });
    // The scope's hard deadline includes a three-second preparation allowance.
    const deadline = Date.now() + 6_000;
    for (;;) {
      const { stdout } = await execFileAsync(
        "/usr/bin/systemctl",
        ["--user", "show", unitName, "--property=ActiveState"],
        { timeout: 1_000 },
      );
      if (stdout.includes("ActiveState=inactive")) break;
      if (Date.now() >= deadline) throw new Error("Supervisor crash left scope active");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    try {
      const events = await NodeFSP.readFile(`/sys/fs/cgroup${controlGroup}/cgroup.events`, "utf8");
      NodeAssert.strict.match(events, /^populated 0$/m);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    if (supervisor.pid && supervisor.exitCode === null) {
      try {
        process.kill(supervisor.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
    if (unitName) {
      try {
        await execFileAsync("/usr/bin/systemctl", ["--user", "stop", unitName], { timeout: 3_000 });
      } catch {
        /* exact unit may already be gone */
      }
    }
  }
});

it.skipIf(!available)("stops a scoped sandbox with a detached child", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: [
      "/usr/bin/node",
      "-e",
      "const {spawn}=require('node:child_process');const c=spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});c.unref();process.stdout.write('READY\\n');setInterval(()=>{},1000)",
    ],
    runtimeMs: 3_000,
  });
  await handle.start();
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const poll = async () => {
      try {
        const cgroup = `/sys/fs/cgroup${handle.controlGroup}/cgroup.procs`;
        const pids = (await NodeFSP.readFile(cgroup, "utf8")).trim().split(/\s+/);
        // bwrap, PID 1 gate, caller Node, and its detached child are distinct.
        if (pids.length >= 4) return resolve();
        if (Date.now() >= deadline) return reject(new Error("Detached child did not start"));
        setTimeout(() => {
          void poll();
        }, 10);
      } catch (error) {
        reject(error);
      }
    };
    void poll();
  });
  const result = await handle.stop();
  NodeAssert.strict.equal(result.timedOut, false);
  NodeAssert.strict.equal(await handle.stop(), result);
});

it.skipIf(!available)("FD4 EOF cannot run caller code without the exact FD5 token", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/node", "-e", "process.stdout.write('UNAUTHORIZED_EXECUTION\\n')"],
  });
  const result = await handle.discard();
  NodeAssert.strict.equal(result.exitCode, 125);
  NodeAssert.strict.doesNotMatch(result.stdout, /UNAUTHORIZED_EXECUTION/);
});

it.skipIf(!available)("does not pass FD5 into caller code", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: [
      "/usr/bin/node",
      "-e",
      "try { process.stdout.write('FD5='+require('node:fs').readlinkSync('/proc/self/fd/5')+'\\n') } catch { process.stdout.write('FD5_CLOSED\\n') }",
    ],
  });
  const gatePipe = await NodeFSP.readlink(`/proc/${handle.sandboxPid}/fd/5`);
  await handle.start();
  const result = await handle.wait();
  NodeAssert.strict.equal(result.exitCode, 0);
  NodeAssert.strict.match(gatePipe, /^(pipe|socket):/);
  NodeAssert.strict.equal(result.stdout.includes(`FD5=${gatePipe}`), false);
});

it.skipIf(!available)("normal completion verifies scope cleanup", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: [
      "/usr/bin/node",
      "-e",
      "const {spawn}=require('node:child_process');const c=spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});c.unref();process.stdout.write('PARENT_DONE\\n')",
    ],
  });
  await handle.start();
  const result = await handle.wait();
  NodeAssert.strict.match(result.stdout, /PARENT_DONE/);
  await NodeAssert.strict.rejects(NodeFSP.stat(handle.workDirectory), { code: "ENOENT" });
});

it.skipIf(!available)("rejects a raised memory limit before releasing caller code", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/node", "-e", "process.stdout.write('UNVERIFIED_EXECUTION\\n')"],
  });
  try {
    await execFileAsync(
      "/usr/bin/systemctl",
      ["--user", "set-property", "--runtime", handle.unitName, "MemoryMax=536870912"],
      { timeout: 2_000 },
    );
    await NodeAssert.strict.rejects(handle.start(), /limits could not be verified/);
  } finally {
    const result = await handle.stop();
    NodeAssert.strict.doesNotMatch(result.stdout, /UNVERIFIED_EXECUTION/);
  }
});

it.skipIf(!available)(
  "systemd enforces a wall-clock ceiling while supervisor timers are stalled",
  async () => {
    const handle = await prepareOrganizationScopedSandbox({
      argv: ["/usr/bin/node", "-e", "setInterval(() => {}, 1000)"],
      runtimeMs: 100,
    });
    await handle.start();
    // Keep this event loop blocked past the 100ms soft timer and the independent
    // 3.1s scope deadline. Inspect systemd synchronously before timers can run.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_600);
    const status = NodeChildProcess.execFileSync(
      "/usr/bin/systemctl",
      [
        "--user",
        "show",
        handle.unitName,
        "--property=ActiveState,Result,InvocationID,RuntimeMaxUSec",
      ],
      { encoding: "utf8", timeout: 1_000 },
    );
    NodeAssert.strict.match(status, /ActiveState=failed/);
    NodeAssert.strict.match(status, /Result=timeout/);
    NodeAssert.strict.ok(status.includes(`InvocationID=${handle.invocationId}`));
    NodeAssert.strict.match(status, /RuntimeMaxUSec=3\.1(?:0*)s/);
    const result = await handle.wait();
    NodeAssert.strict.equal(result.timedOut, true);
  },
  10_000,
);

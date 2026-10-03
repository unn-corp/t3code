// @effect-diagnostics nodeBuiltinImport:off - The isolation fixture verifies real host filesystem and /proc behavior.
import { it } from "@effect/vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isOrganizationSandboxAvailable,
  launchOrganizationSandbox,
} from "./OrganizationSandboxHost.ts";

const available = isOrganizationSandboxAvailable();

async function descendantsOf(pid: number): Promise<number[]> {
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  const nested = await Promise.all(children.map(descendantsOf));
  return [...children, ...nested.flat()];
}

async function assertPidExited(pid: number): Promise<void> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const state = status.split("\n").find((line) => line.startsWith("State:"));
    // Reparented zombies can remain visible until the host init process reaps them.
    // They have exited and cannot execute, even though /proc still has a row.
    assert.match(
      state ?? "",
      /^State:\s+[ZX]/,
      `sandbox descendant ${pid} is still live: ${state ?? "unknown state"}`,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
  }
}

it.skipIf(!available)(
  "hides host data, denies writes outside workspace, and stops a forked child",
  async () => {
    const hostDirectory = await mkdtemp(join(tmpdir(), "t3-org-host-secret-"));
    const secretPath = join(hostDirectory, "secret.txt");
    const outsidePath = join(hostDirectory, "outside.txt");
    await writeFile(secretPath, "synthetic-host-secret");
    try {
      const fixture = `
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      import os from "node:os";
      const [secretPath, outsidePath] = process.argv.slice(2);
      try { fs.readFileSync(secretPath, "utf8"); process.stdout.write("SECRET_LEAK\\n"); }
      catch { process.stdout.write("SECRET_DENIED\\n"); }
      try { fs.writeFileSync(outsidePath, "escaped"); process.stdout.write("WRITE_ESCAPED\\n"); }
      catch { process.stdout.write("WRITE_DENIED\\n"); }
      process.stdout.write("HOME=" + String(process.env.HOME) + "\\n");
      process.stdout.write("NETWORK=" + Object.keys(os.networkInterfaces()).join(",") + "\\n");
      const child = spawn("/usr/bin/node", ["-e", "process.stdout.write('CHILD_READY\\\\n'); setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "inherit", "inherit"], env: {},
      });
      child.on("error", (error) => { process.stderr.write(String(error)); process.exitCode = 1; });
      setInterval(() => {}, 1000);
    `;
      const handle = await launchOrganizationSandbox({
        argv: ["/usr/bin/node", "/workspace/fixture.mjs", secretPath, outsidePath],
        files: { "fixture.mjs": fixture },
        runtimeMs: 5_000,
      });
      await handle.waitForOutput("CHILD_READY");
      const descendants = await descendantsOf(handle.pid);
      assert.ok(descendants.length >= 2, "the adversarial fixture started a descendant process");
      const result = await handle.stop();
      assert.equal(handle.processGroupId, handle.pid);
      assert.match(result.stdout, /SECRET_DENIED/);
      assert.match(result.stdout, /WRITE_DENIED/);
      assert.match(result.stdout, /HOME=undefined/);
      assert.match(result.stdout, /NETWORK=lo\n/);
      assert.doesNotMatch(result.stdout, /SECRET_LEAK|WRITE_ESCAPED/);
      assert.equal(result.timedOut, false);
      assert.equal(await readFile(secretPath, "utf8"), "synthetic-host-secret");
      await assert.rejects(stat(outsidePath), { code: "ENOENT" });
      await assert.rejects(stat(handle.workDirectory), { code: "ENOENT" });
      for (const pid of descendants) await assertPidExited(pid);
      assert.deepEqual(await handle.wait(), result);
    } finally {
      await rm(hostDirectory, { recursive: true, force: true });
    }
  },
);

it.skipIf(!available)("enforces runtime and output bounds", async () => {
  const timed = await launchOrganizationSandbox({
    argv: ["/usr/bin/node", "-e", "setInterval(() => {}, 1000)"],
    runtimeMs: 100,
  });
  const timedResult = await timed.wait();
  assert.equal(timedResult.timedOut, true);
  await assert.rejects(stat(timed.workDirectory), { code: "ENOENT" });

  const noisy = await launchOrganizationSandbox({
    argv: [
      "/usr/bin/node",
      "-e",
      "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)",
    ],
    maxOutputBytes: 128,
  });
  const noisyResult = await noisy.wait();
  assert.equal(noisyResult.outputLimitExceeded, true);
  assert.equal(Buffer.byteLength(noisyResult.stdout) + Buffer.byteLength(noisyResult.stderr), 128);
});

it.skipIf(!available)(
  "caps writable tmpfs while keeping staged input readable and immutable",
  async () => {
    const fixture = `
    import fs from "node:fs";
    const capacity = fs.statfsSync("/workspace");
    process.stdout.write("CAPACITY=" + capacity.blocks * capacity.bsize + "\\n");
    process.stdout.write("STAGED=" + fs.readFileSync("/workspace/quota.mjs", "utf8").includes("CAPACITY=") + "\\n");
    process.stdout.write("DEV_SHM=" + fs.existsSync("/dev/shm") + "\\n");
    try { fs.writeFileSync("/dev/escape", "x"); process.stdout.write("DEV_WRITABLE\\n"); }
    catch (error) { process.stdout.write("DEV_DENIED=" + error.code + "\\n"); }
    try { fs.writeFileSync("/escape", "x"); process.stdout.write("ROOT_WRITABLE\\n"); }
    catch (error) { process.stdout.write("ROOT_DENIED=" + error.code + "\\n"); }
    try { fs.writeFileSync("/workspace/quota.mjs", "tampered"); process.stdout.write("STAGE_WRITABLE\\n"); }
    catch (error) { process.stdout.write("STAGE_DENIED=" + error.code + "\\n"); }
    try { fs.writeFileSync("/workspace/fill", Buffer.alloc(2 * 1024 * 1024)); process.stdout.write("UNBOUNDED\\n"); }
    catch (error) { process.stdout.write("QUOTA=" + error.code + "\\n"); }
    try { fs.writeFileSync("/tmp/escape", Buffer.alloc(2 * 1024 * 1024)); process.stdout.write("TMP_UNBOUNDED\\n"); }
    catch (error) { process.stdout.write("TMP_QUOTA=" + error.code + "\\n"); }
  `;
    const handle = await launchOrganizationSandbox({
      argv: ["/usr/bin/node", "/workspace/quota.mjs"],
      files: { "quota.mjs": fixture },
      workspaceBytes: 1_048_576,
      runtimeMs: 5_000,
    });
    const result = await handle.wait();
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /CAPACITY=1048576\n/);
    assert.match(result.stdout, /STAGED=true\n/);
    assert.match(result.stdout, /DEV_SHM=false\n/);
    assert.match(result.stdout, /DEV_DENIED=EROFS\n/);
    assert.match(result.stdout, /ROOT_DENIED=(EACCES|EROFS)\n/);
    assert.match(result.stdout, /STAGE_DENIED=(EROFS|EBUSY)\n/);
    assert.match(result.stdout, /QUOTA=ENOSPC\n/);
    assert.match(result.stdout, /TMP_QUOTA=ENOSPC\n/);
    assert.doesNotMatch(result.stdout, /UNBOUNDED|STAGE_WRITABLE|DEV_WRITABLE|ROOT_WRITABLE/);
    await assert.rejects(stat(handle.workDirectory), { code: "ENOENT" });
  },
);

it.skipIf(!available)("tears down a detached descendant that closed all output pipes", async () => {
  const fixture = `
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    const child = spawn("/usr/bin/node", ["-e", "require('node:fs').writeFileSync('/workspace/detached-ready', 'yes'); setInterval(() => {}, 1000)"], {
      detached: true, stdio: "ignore", env: {},
    });
    child.unref();
    const timer = setInterval(() => {
      if (fs.existsSync("/workspace/detached-ready")) {
        clearInterval(timer);
        process.stdout.write("DETACHED_READY\\n");
      }
    }, 5);
    setInterval(() => {}, 1000);
  `;
  const handle = await launchOrganizationSandbox({
    argv: ["/usr/bin/node", "/workspace/detached.mjs"],
    files: { "detached.mjs": fixture },
    runtimeMs: 5_000,
  });
  await handle.waitForOutput("DETACHED_READY");
  const descendants = await descendantsOf(handle.pid);
  assert.ok(descendants.length >= 2, "detached child exists before stop");
  const result = await handle.stop();
  assert.equal(result.timedOut, false);
  for (const pid of descendants) await assertPidExited(pid);
});

it("rejects escape paths and non-system executable paths before launch", async () => {
  await assert.rejects(
    launchOrganizationSandbox({
      argv: ["/usr/bin/node", "/workspace/fixture.mjs"],
      files: { "../host.txt": "no" },
    }),
    TypeError,
  );
  await assert.rejects(
    launchOrganizationSandbox({ argv: ["/tmp/attacker"], files: {} }),
    TypeError,
  );
  await assert.rejects(
    launchOrganizationSandbox({ argv: ["/usr/bin/true"], workspaceBytes: 65 * 1_048_576 }),
    TypeError,
  );
});

it.skipIf(!available)(
  "snapshots staged names, bytes, argv, and limits before asynchronous setup",
  async () => {
    const markerName = `t3-org-sandbox-escape-${randomUUID()}.txt`;
    const outsidePath = join(tmpdir(), markerName);
    const script = Buffer.from(
      'import f from "node:fs"; const s=f.statfsSync("/workspace"); process.stdout.write("SNAPSHOT_OK\\nCAPACITY="+(s.blocks*s.bsize)+"\\n")',
    );
    const files: Record<string, string | Uint8Array> = { "fixture.mjs": script };
    const argv: [string, ...string[]] = ["/usr/bin/node", "/workspace/fixture.mjs"];
    const input = {
      argv,
      files,
      workspaceBytes: 1_048_576,
      runtimeMs: 1_000,
      maxOutputBytes: 1_024,
    };
    try {
      const launching = launchOrganizationSandbox(input);
      files[`../${markerName}`] = "escaped";
      script.fill(0);
      argv[1] = "/workspace/not-the-fixture.mjs";
      input.workspaceBytes = 64 * 1_048_576;
      input.runtimeMs = 1;
      input.maxOutputBytes = 1;
      const handle = await launching;
      const result = await handle.wait();
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /SNAPSHOT_OK\n/);
      assert.match(result.stdout, /CAPACITY=1048576\n/);
      await assert.rejects(stat(outsidePath), { code: "ENOENT" });
    } finally {
      await rm(outsidePath, { force: true });
    }
  },
);

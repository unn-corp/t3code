// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Local IPC fixtures use an isolated runtime directory.
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  serveOrganizationScopeLaunchBroker,
  organizationScopeLaunchBrokerClient,
} from "./OrganizationScopeLaunchBroker.ts";
import {
  organizationLaunchSuspendMarkerPath,
  quiesceOrganizationLaunchBroker,
  requestOrganizationLaunchBroker,
} from "./OrganizationScopeLaunchBrokerProtocol.ts";
import {
  allocateOrganizationScopedUnitName,
  isOrganizationScopedSandboxAvailable,
} from "./OrganizationScopedSandboxHost.ts";

it.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
  "serves the hidden CLI broker from an isolated T3 home",
  async () => {
    const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-broker-cli-"));
    const entry = NodePath.resolve(import.meta.dirname, "../bin.ts");
    const child = NodeChildProcess.spawn(
      process.execPath,
      [entry, "__organization-launch-broker", "--base-dir", baseDir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        let error = "";
        const timer = setTimeout(() => reject(new Error(`Broker CLI timed out: ${error}`)), 10_000);
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("READY\n")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          error += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Broker CLI exited: ${error}`)));
      });
      NodeAssert.equal(await requestOrganizationLaunchBroker(baseDir, { action: "health" }), true);
    } finally {
      child.kill("SIGKILL");
      if (child.exitCode === null)
        await new Promise<void>((resolve) => child.once("exit", resolve));
      await NodeFSP.rm(baseDir, { recursive: true, force: true });
    }
  },
);

it("keeps one broker owner and fences launches across a trial marker", async () => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-broker-test-"));
  const broker = await serveOrganizationScopeLaunchBroker(baseDir);
  try {
    NodeAssert.equal(
      await requestOrganizationLaunchBroker(baseDir, { action: "authorization-version" }),
      2,
    );
    const client = organizationScopeLaunchBrokerClient(baseDir);
    await NodeAssert.rejects(client.checkOwner(), /owner epoch is stale or absent/);
    const epoch = await client.activate();
    NodeAssert.equal(await client.checkOwner(), true);
    NodeAssert.equal(await organizationScopeLaunchBrokerClient(baseDir).activate(), epoch);
    await NodeAssert.rejects(
      requestOrganizationLaunchBroker(baseDir, { action: "activate", ownerPid: process.pid }),
      /Another live server owns/,
    );
    for (const action of ["wait", "stop", "discard"] as const) {
      await NodeAssert.rejects(
        requestOrganizationLaunchBroker(baseDir, { action, operationId: "attempt-live" }),
        /owner epoch is stale or absent/,
      );
      await NodeAssert.rejects(
        requestOrganizationLaunchBroker(baseDir, {
          action,
          operationId: "attempt-live",
          epoch: "0".repeat(64),
        }),
        /owner epoch is stale or absent/,
      );
    }
    await NodeAssert.rejects(
      requestOrganizationLaunchBroker(baseDir, {
        action: "stop-and-verify-operation",
        operationId: "attempt-live",
      }),
      /owner epoch is stale or absent/,
    );
    await NodeAssert.rejects(
      organizationScopeLaunchBrokerClient(baseDir, "0".repeat(64)).checkOwner(),
      /owner epoch is stale or absent/,
    );
    await NodeAssert.rejects(
      requestOrganizationLaunchBroker(baseDir, {
        action: "reserve",
        operationId: "stale-owner",
        unitName: allocateOrganizationScopedUnitName(),
        epoch: "0".repeat(64),
      }),
      /owner epoch is stale or absent/,
    );
    const competitor = NodeChildProcess.spawn("/usr/bin/sleep", ["10"], { stdio: "ignore" });
    try {
      if (!competitor.pid) throw new Error("Competitor PID unavailable");
      await NodeAssert.rejects(
        requestOrganizationLaunchBroker(baseDir, { action: "activate", ownerPid: competitor.pid }),
        /does not match socket peer/,
      );
      NodeAssert.match(epoch, /^[a-f0-9]{64}$/);
    } finally {
      competitor.kill("SIGTERM");
    }
    const before = allocateOrganizationScopedUnitName();
    await client.reserve("attempt-before-trial", before);
    await NodeAssert.rejects(serveOrganizationScopeLaunchBroker(baseDir), { code: "EADDRINUSE" });
    NodeAssert.equal(
      (await client.status()).find((entry) => entry.operationId === "attempt-before-trial")?.phase,
      "reserved",
    );
    const marker = organizationLaunchSuspendMarkerPath(baseDir);
    await NodeFSP.writeFile(marker, '{"version":1,"updateId":"trial-a"}\n', { mode: 0o600 });
    await NodeAssert.rejects(client.checkOwner(), /suspended for an update trial/);
    await quiesceOrganizationLaunchBroker(baseDir);
    NodeAssert.equal(
      (await client.status()).find((entry) => entry.operationId === "attempt-before-trial")?.phase,
      "never-dispatched",
    );
    await NodeAssert.rejects(
      client.reserve("attempt-during-trial", allocateOrganizationScopedUnitName()),
      /suspended for an update trial/,
    );
    await NodeFSP.rm(marker);
    NodeAssert.equal(await client.checkOwner(), true);
    await client.reserve("attempt-after-trial", allocateOrganizationScopedUnitName());
  } finally {
    await broker.close();
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
});

it("revokes the read-only owner probe when the claimed process exits", async () => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-broker-owner-"));
  const broker = await serveOrganizationScopeLaunchBroker(baseDir);
  const moduleUrl = new URL("./OrganizationScopeLaunchBroker.ts", import.meta.url).href;
  const script = `
    import { organizationScopeLaunchBrokerClient } from ${JSON.stringify(moduleUrl)};
    const epoch = await organizationScopeLaunchBrokerClient(${JSON.stringify(baseDir)}).activate();
    process.stdout.write(epoch + '\\n');
    setInterval(() => {}, 1000);
  `;
  const owner = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const epoch = await new Promise<string>((resolve, reject) => {
      let output = "";
      let errors = "";
      owner.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const line = output.split("\n")[0];
        if (line && /^[a-f0-9]{64}$/.test(line)) resolve(line);
      });
      owner.stderr?.on("data", (chunk: Buffer) => {
        errors += chunk.toString("utf8");
      });
      owner.once("error", reject);
      owner.once("exit", () => reject(new Error(`Owner exited before activation: ${errors}`)));
    });
    if (!owner.pid) throw new Error("Owner PID unavailable");
    const client = organizationScopeLaunchBrokerClient(baseDir, epoch);
    NodeAssert.equal(await client.checkOwner(), true);
    await NodeAssert.rejects(
      requestOrganizationLaunchBroker(baseDir, { action: "activate", ownerPid: owner.pid }),
      /does not match socket peer/,
    );
    owner.kill("SIGTERM");
    await new Promise<void>((resolve) => owner.once("exit", () => resolve()));
    await NodeAssert.rejects(client.checkOwner(), /owner process identity is unavailable/);
  } finally {
    if (owner.exitCode === null) owner.kill("SIGKILL");
    await broker.close();
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
});

it.skipIf(!isOrganizationScopedSandboxAvailable())(
  "quiesce stops a live scope while a wait request is pending",
  async () => {
    const baseDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-org-broker-live-test-"),
    );
    const broker = await serveOrganizationScopeLaunchBroker(baseDir);
    try {
      const client = organizationScopeLaunchBrokerClient(baseDir);
      await client.activate();
      const unit = allocateOrganizationScopedUnitName();
      await client.reserve("attempt-live", unit);
      const handle = await client.prepare("attempt-live", {
        reservedUnitName: unit,
        argv: ["/usr/bin/node", "-e", "setInterval(() => {}, 1000)"],
        runtimeMs: 10_000,
      });
      await handle.start();
      const waiting = handle.wait();
      await NodeFSP.writeFile(
        organizationLaunchSuspendMarkerPath(baseDir),
        '{"version":1,"updateId":"trial-live"}\n',
      );
      await quiesceOrganizationLaunchBroker(baseDir);
      await waiting;
      NodeAssert.equal(
        (await client.status()).find((entry) => entry.operationId === "attempt-live")?.phase,
        "stopped",
      );
    } finally {
      await broker.close();
      await NodeFSP.rm(baseDir, { recursive: true, force: true });
    }
  },
);

it.skipIf(!isOrganizationScopedSandboxAvailable())(
  "concurrent wait and exact stop finish with one durable stopped operation",
  async () => {
    const baseDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-org-broker-stop-race-"),
    );
    const broker = await serveOrganizationScopeLaunchBroker(baseDir);
    try {
      const client = organizationScopeLaunchBrokerClient(baseDir);
      await client.activate();
      const operationId = "attempt-stop-race";
      const unit = allocateOrganizationScopedUnitName();
      await client.reserve(operationId, unit);
      const handle = await client.prepare(operationId, {
        reservedUnitName: unit,
        argv: ["/usr/bin/node", "-e", "setInterval(() => {}, 1000)"],
        runtimeMs: 10_000,
      });
      await handle.start();
      const waiting = handle.wait();
      // Give the wait request a broker round trip before the stop request.
      NodeAssert.equal((await client.get(operationId))?.phase, "started");
      const stopped = await client.stopAndVerifyOperation(operationId);
      NodeAssert.equal(stopped.disposition, "stopped");
      NodeAssert.equal(stopped.identity?.unitName, unit);
      await waiting;
      NodeAssert.equal((await client.get(operationId))?.phase, "stopped");
      NodeAssert.deepEqual(await client.stopAndVerifyOperation(operationId), stopped);
    } finally {
      await broker.close();
    }
    const restarted = await serveOrganizationScopeLaunchBroker(baseDir);
    try {
      const client = organizationScopeLaunchBrokerClient(baseDir);
      await client.activate();
      NodeAssert.equal((await client.get("attempt-stop-race"))?.phase, "stopped");
      NodeAssert.equal(
        (await client.stopAndVerifyOperation("attempt-stop-race")).disposition,
        "stopped",
      );
    } finally {
      await restarted.close();
      await NodeFSP.rm(baseDir, { recursive: true, force: true });
    }
  },
);

it.skipIf(!isOrganizationScopedSandboxAvailable())(
  "replays and stops a scoped launch after broker SIGKILL",
  async () => {
    const baseDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-org-broker-crash-test-"),
    );
    const moduleUrl = new URL("./OrganizationScopeLaunchBroker.ts", import.meta.url).href;
    const unit = allocateOrganizationScopedUnitName();
    const script = `
      import { serveOrganizationScopeLaunchBroker, organizationScopeLaunchBrokerClient } from ${JSON.stringify(moduleUrl)};
      const baseDir = ${JSON.stringify(baseDir)};
      await serveOrganizationScopeLaunchBroker(baseDir);
      const client = organizationScopeLaunchBrokerClient(baseDir);
      await client.activate();
      await client.reserve('attempt-crashed', ${JSON.stringify(unit)});
      const handle = await client.prepare('attempt-crashed', {
        reservedUnitName: ${JSON.stringify(unit)},
        argv: ['/usr/bin/node', '-e', 'setInterval(() => {}, 1000)'],
        runtimeMs: 10000,
      });
      await handle.start();
      process.stdout.write('STARTED\\n');
      setInterval(() => {}, 1000);
    `;
    const child = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("STARTED\n")) resolve();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.toString("utf8");
        });
        child.once("close", (code) => reject(new Error(`Broker exited ${code}: ${errors}`)));
      });
      if (!child.pid) throw new Error("Broker PID unavailable");
      process.kill(child.pid, "SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      const restarted = await serveOrganizationScopeLaunchBroker(baseDir);
      try {
        const client = organizationScopeLaunchBrokerClient(baseDir);
        await client.activate();
        const status = await client.status();
        NodeAssert.equal(
          status.find((entry) => entry.operationId === "attempt-crashed")?.phase,
          "stopped",
        );
        const identity = status.find((entry) => entry.operationId === "attempt-crashed")?.identity;
        NodeAssert.deepEqual(await client.stopAndVerifyOperation("attempt-crashed"), {
          operationId: "attempt-crashed",
          disposition: "stopped",
          identity,
        });
      } finally {
        await restarted.close();
      }
    } finally {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* Captured child already exited. */
        }
      }
      await NodeFSP.rm(baseDir, { recursive: true, force: true });
    }
  },
);

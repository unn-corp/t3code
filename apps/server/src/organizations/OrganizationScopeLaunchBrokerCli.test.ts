// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native CLI fixtures use an isolated runtime directory.
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  organizationLaunchSuspendMarkerPath,
  createOrganizationLaunchBrokerToken,
  quiesceOrganizationLaunchBroker,
  requestOrganizationLaunchBroker,
} from "./OrganizationScopeLaunchBrokerProtocol.ts";

it("registers native broker commands and enforces the host platform", async () => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-broker-cli-"));
  if (HostProcessPlatform.defaultValue() !== "linux") {
    try {
      // Registration must survive CLI refactoring even on platforms that cannot run the Linux broker.
      const entry = NodePath.resolve(import.meta.dirname, "../bin.ts");
      const help = NodeChildProcess.spawnSync(
        process.execPath,
        [entry, "__organization-launch-broker", "--help"],
        { encoding: "utf8", timeout: 10_000 },
      );
      NodeAssert.equal(help.status, 0, help.stderr);
      NodeAssert.match(help.stdout, /__organization-launch-broker/);
      NodeAssert.match(help.stdout, /--base-dir/);
      const unsupported = NodeChildProcess.spawnSync(
        process.execPath,
        [entry, "maintenance", "scope-broker", "--base-dir", baseDir],
        { encoding: "utf8", timeout: 10_000 },
      );
      // Effect CLI renders structured failures through its console; the diagnostic may use either stream.
      const unsupportedOutput = `${unsupported.stdout}\n${unsupported.stderr}`;
      NodeAssert.equal(unsupported.status, 1, unsupportedOutput);
      NodeAssert.match(unsupportedOutput, /Organization launch broker requires Linux/);
      NodeAssert.deepEqual(await NodeFSP.readdir(baseDir), []);
    } finally {
      await NodeFSP.rm(baseDir, { recursive: true, force: true });
    }
    return;
  }
  // Existing releases may retain a safe token after the detached broker exited.
  // The native command must reuse it and restore the authenticated socket.
  await createOrganizationLaunchBrokerToken(baseDir);
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
    await NodeFSP.writeFile(organizationLaunchSuspendMarkerPath(baseDir), "{}\n", {
      mode: 0o600,
    });
    await quiesceOrganizationLaunchBroker(baseDir);
    NodeAssert.deepEqual(await requestOrganizationLaunchBroker(baseDir, { action: "status" }), []);
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", resolve));
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
});

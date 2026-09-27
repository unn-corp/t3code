// @effect-diagnostics nodeBuiltinImport:off - Disposable launch journal and OS fixtures.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  isOrganizationScopedSandboxAvailable,
  allocateOrganizationScopedUnitName,
} from "./OrganizationScopedSandboxHost.ts";
import {
  OrganizationScopeLaunchJournal,
  organizationScopeLaunchJournalPath,
} from "./OrganizationScopeLaunchJournal.ts";

async function fixture<T>(run: (path: string) => Promise<T>): Promise<T> {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-journal-test-"));
  try {
    return await run(organizationScopeLaunchJournalPath(base));
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
}

it("holds an identity-less post-spawn failure across journal replay", async () =>
  fixture(async (path) => {
    const journal = await OrganizationScopeLaunchJournal.open(path);
    const unit = allocateOrganizationScopedUnitName();
    await journal.reserve("attempt-1", unit);
    let enteredHost = false;
    await NodeAssert.rejects(
      journal.prepare(
        "attempt-1",
        { reservedUnitName: unit, argv: ["/usr/bin/true"] },
        async () => {
          // This is the observable state after systemd-run was submitted but
          // before its invocation identity could be returned.
          enteredHost = true;
          throw new Error("identity lost after spawn");
        },
      ),
      /identity lost after spawn/,
    );
    NodeAssert.equal(enteredHost, true);
    await journal.close();

    const restarted = await OrganizationScopeLaunchJournal.open(path);
    let unsafeStopCalls = 0;
    const recovery = await restarted.reconcile(async () => {
      unsafeStopCalls++;
    });
    NodeAssert.deepEqual(recovery, { stopped: [], neverDispatched: [], held: ["attempt-1"] });
    NodeAssert.equal(unsafeStopCalls, 0);
    NodeAssert.equal(restarted.list()[0]?.phase, "dispatching");
    await NodeAssert.rejects(
      restarted.prepare("attempt-1", { reservedUnitName: unit, argv: ["/usr/bin/true"] }),
      /phase is invalid or replayed/,
    );
    await restarted.close();
  }));

it("replays a prepared identity into one exact stop, then stays stopped", async () =>
  fixture(async (path) => {
    const journal = await OrganizationScopeLaunchJournal.open(path);
    const unit = allocateOrganizationScopedUnitName();
    const identity = {
      unitName: unit,
      invocationId: "a".repeat(32),
      controlGroup: `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/${unit}`,
      sandboxPid: 42,
      pidNamespace: 43,
    };
    await journal.reserve("attempt-2", unit);
    await journal.prepare(
      "attempt-2",
      { reservedUnitName: unit, argv: ["/usr/bin/true"] },
      async () => ({
        ...identity,
        workDirectory: "/unlinked",
        start: async () => undefined,
        discard: async () => ({
          exitCode: 125,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          outputLimitExceeded: false,
        }),
        wait: async () => ({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          outputLimitExceeded: false,
        }),
        stop: async () => ({
          exitCode: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          timedOut: false,
          outputLimitExceeded: false,
        }),
      }),
    );
    await journal.close();

    const restarted = await OrganizationScopeLaunchJournal.open(path);
    let stops = 0;
    const first = await restarted.reconcile(async (received) => {
      NodeAssert.deepEqual(received, identity);
      stops++;
    });
    const second = await restarted.reconcile(async () => {
      stops++;
    });
    NodeAssert.deepEqual(first, { stopped: ["attempt-2"], neverDispatched: [], held: [] });
    NodeAssert.deepEqual(second, { stopped: [], neverDispatched: [], held: [] });
    NodeAssert.equal(stops, 1);
    await restarted.close();
  }));

it("refuses a torn tail rather than assuming a safe no-launch state", async () =>
  fixture(async (path) => {
    const journal = await OrganizationScopeLaunchJournal.open(path);
    await journal.reserve("attempt-3", allocateOrganizationScopedUnitName());
    await journal.close();
    await NodeFSP.appendFile(path, '{"partial":');
    await NodeAssert.rejects(OrganizationScopeLaunchJournal.open(path), /partial final record/);
  }));

it("permanently aborts a reservation that never reached OS dispatch", async () =>
  fixture(async (path) => {
    const journal = await OrganizationScopeLaunchJournal.open(path);
    const unit = allocateOrganizationScopedUnitName();
    await journal.reserve("attempt-reserved", unit);
    const recovery = await journal.reconcile(async () => {
      throw new Error("OS stop must not be attempted");
    });
    NodeAssert.deepEqual(recovery, {
      stopped: [],
      neverDispatched: ["attempt-reserved"],
      held: [],
    });
    await NodeAssert.rejects(
      journal.prepare("attempt-reserved", { reservedUnitName: unit, argv: ["/usr/bin/true"] }),
      /phase is invalid or replayed/,
    );
    await journal.close();
  }));

it("stops only the selected persisted identity after restart and returns durable evidence", async () =>
  fixture(async (path) => {
    const journal = await OrganizationScopeLaunchJournal.open(path);
    const selectedUnit = allocateOrganizationScopedUnitName();
    const otherUnit = allocateOrganizationScopedUnitName();
    const identity = {
      unitName: selectedUnit,
      invocationId: "b".repeat(32),
      controlGroup: `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/${selectedUnit}`,
      sandboxPid: 51,
      pidNamespace: 52,
    };
    await journal.reserve("selected", selectedUnit);
    await journal.prepare(
      "selected",
      { reservedUnitName: selectedUnit, argv: ["/usr/bin/true"] },
      async () => ({
        ...identity,
        workDirectory: "/unlinked",
        start: async () => undefined,
        wait: async () => {
          throw new Error("unused");
        },
        stop: async () => {
          throw new Error("unused");
        },
        discard: async () => {
          throw new Error("unused");
        },
      }),
    );
    await journal.reserve("other", otherUnit);
    await journal.close();

    const restarted = await OrganizationScopeLaunchJournal.open(path);
    NodeAssert.deepEqual(
      await restarted.stopAndVerifyOperation("selected", async (received) => {
        NodeAssert.deepEqual(received, identity);
        throw new Error("stop verifier unavailable");
      }),
      { operationId: "selected", disposition: "held", identity },
    );
    NodeAssert.equal(
      restarted.list().find((entry) => entry.operationId === "selected")?.phase,
      "prepared",
    );
    await restarted.close();

    const recovered = await OrganizationScopeLaunchJournal.open(path);
    let calls = 0;
    const stop = async (received: typeof identity) => {
      NodeAssert.deepEqual(received, identity);
      calls++;
    };
    NodeAssert.deepEqual(await recovered.stopAndVerifyOperation("selected", stop), {
      operationId: "selected",
      disposition: "stopped",
      identity,
    });
    NodeAssert.deepEqual(await recovered.stopAndVerifyOperation("selected", stop), {
      operationId: "selected",
      disposition: "stopped",
      identity,
    });
    NodeAssert.equal(calls, 1);
    NodeAssert.equal(
      recovered.list().find((entry) => entry.operationId === "other")?.phase,
      "reserved",
    );
    await recovered.close();

    const replay = await OrganizationScopeLaunchJournal.open(path);
    NodeAssert.deepEqual(await replay.stopAndVerifyOperation("selected", stop), {
      operationId: "selected",
      disposition: "stopped",
      identity,
    });
    NodeAssert.equal(calls, 1);
    await replay.close();
  }));

it("holds identity-less dispatch and verifies a never-dispatched reservation", async () =>
  fixture(async (path) => {
    const journal = await OrganizationScopeLaunchJournal.open(path);
    const uncertainUnit = allocateOrganizationScopedUnitName();
    await journal.reserve("uncertain", uncertainUnit);
    await NodeAssert.rejects(
      journal.prepare(
        "uncertain",
        {
          reservedUnitName: uncertainUnit,
          argv: ["/usr/bin/true"],
        },
        async () => {
          throw new Error("host returned without identity");
        },
      ),
    );
    await journal.reserve("safe", allocateOrganizationScopedUnitName());
    await journal.close();

    const replay = await OrganizationScopeLaunchJournal.open(path);
    let stopCalls = 0;
    const stop = async () => {
      stopCalls++;
    };
    NodeAssert.deepEqual(await replay.stopAndVerifyOperation("uncertain", stop), {
      operationId: "uncertain",
      disposition: "held",
      identity: null,
    });
    NodeAssert.deepEqual(await replay.stopAndVerifyOperation("safe", stop), {
      operationId: "safe",
      disposition: "never-dispatched",
      identity: null,
    });
    NodeAssert.equal(stopCalls, 0);
    await NodeAssert.rejects(
      replay.stopAndVerifyOperation("missing", stop),
      /operation is unknown/,
    );
    await replay.close();
  }));

it.skipIf(!isOrganizationScopedSandboxAvailable())(
  "recovers a real prepared scope by exact invocation and namespace",
  async () =>
    fixture(async (path) => {
      const journal = await OrganizationScopeLaunchJournal.open(path);
      const unit = allocateOrganizationScopedUnitName();
      await journal.reserve("attempt-real", unit);
      await journal.close();
      const moduleUrl = new URL("./OrganizationScopeLaunchJournal.ts", import.meta.url).href;
      const script = `
        import { OrganizationScopeLaunchJournal } from ${JSON.stringify(moduleUrl)};
        const journal = await OrganizationScopeLaunchJournal.open(${JSON.stringify(path)});
        const handle = await journal.prepare('attempt-real', {
          reservedUnitName: ${JSON.stringify(unit)}, argv: ['/usr/bin/true']
        });
        await journal.close();
        process.stdout.write(JSON.stringify({ unitName: handle.unitName }) + '\\n');
        setInterval(() => {}, 1000);
      `;
      const supervisor = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          let stdout = "";
          let stderr = "";
          supervisor.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            if (stdout.includes("\n")) {
              try {
                NodeAssert.deepEqual(JSON.parse(stdout.split("\n")[0]!), { unitName: unit });
                resolve();
              } catch (error) {
                reject(error);
              }
            }
          });
          supervisor.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          supervisor.once("close", (code) =>
            reject(new Error(`Supervisor exited ${code}: ${stderr}`)),
          );
        });
        if (!supervisor.pid) throw new Error("Supervisor PID unavailable");
        process.kill(supervisor.pid, "SIGKILL");
        await new Promise<void>((resolve) => supervisor.once("close", () => resolve()));
      } finally {
        if (supervisor.pid && supervisor.exitCode === null) {
          try {
            process.kill(supervisor.pid, "SIGKILL");
          } catch {
            /* The captured child may already have exited. */
          }
        }
      }
      const restarted = await OrganizationScopeLaunchJournal.open(path);
      const recovery = await restarted.reconcile();
      NodeAssert.deepEqual(recovery, { stopped: ["attempt-real"], neverDispatched: [], held: [] });
      await restarted.close();
    }),
);

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Local OS launch supervisor.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import {
  createOrganizationLaunchBrokerToken,
  organizationLaunchBrokerAddress,
  organizationLaunchSuspendMarkerPath,
  ORGANIZATION_LAUNCH_BROKER_PROTOCOL,
  requestOrganizationLaunchBroker,
  type OrganizationLaunchBrokerRequest,
} from "./OrganizationScopeLaunchBrokerProtocol.ts";
import {
  OrganizationScopeLaunchJournal,
  organizationScopeLaunchJournalPath,
} from "./OrganizationScopeLaunchJournal.ts";
import {
  allocateOrganizationScopedUnitName,
  type PreparedOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";
import type {
  OrganizationSandboxInput,
  OrganizationSandboxResult,
} from "./OrganizationSandboxHost.ts";
import type { OrganizationWorkScopeIdentity } from "./OrganizationWorkScopeStore.ts";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

function decodeInput(
  value: unknown,
  unitName: string,
): OrganizationSandboxInput & { readonly reservedUnitName: string } {
  if (!value || typeof value !== "object") throw new Error("Broker sandbox input is invalid");
  const argv = Reflect.get(value, "argv");
  const encodedFiles = Reflect.get(value, "files");
  const runtimeMs = Reflect.get(value, "runtimeMs");
  const maxOutputBytes = Reflect.get(value, "maxOutputBytes");
  const workspaceBytes = Reflect.get(value, "workspaceBytes");
  if (!Array.isArray(argv) || !argv.length || !argv.every((arg) => typeof arg === "string"))
    throw new Error("Broker sandbox argv is invalid");
  if (!encodedFiles || typeof encodedFiles !== "object" || Array.isArray(encodedFiles))
    throw new Error("Broker sandbox files are invalid");
  const files: Record<string, Uint8Array> = {};
  for (const [name, encoded] of Object.entries(encodedFiles)) {
    if (typeof encoded !== "string") throw new Error("Broker sandbox file is invalid");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw new Error("Broker sandbox file encoding is invalid");
    files[name] = bytes;
  }
  if (
    (runtimeMs !== undefined && typeof runtimeMs !== "number") ||
    (maxOutputBytes !== undefined && typeof maxOutputBytes !== "number") ||
    (workspaceBytes !== undefined && typeof workspaceBytes !== "number")
  )
    throw new Error("Broker sandbox limits are invalid");
  return {
    reservedUnitName: unitName,
    argv: argv as [string, ...string[]],
    files,
    ...(runtimeMs === undefined ? {} : { runtimeMs }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(workspaceBytes === undefined ? {} : { workspaceBytes }),
  };
}

async function suspended(baseDir: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(organizationLaunchSuspendMarkerPath(baseDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function requiredOperationId(request: OrganizationLaunchBrokerRequest): string {
  if (typeof request.operationId !== "string") throw new Error("Broker operation ID is missing");
  return request.operationId;
}

function requiredUnitName(request: OrganizationLaunchBrokerRequest): string {
  if (typeof request.unitName !== "string") throw new Error("Broker unit name is missing");
  return request.unitName;
}

async function ownerIdentity(pid: number): Promise<{ pid: number; startTicks: string }> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Broker owner PID is invalid");
  const [stat, status] = await Promise.all([
    NodeFSP.readFile(`/proc/${pid}/stat`, "utf8"),
    NodeFSP.readFile(`/proc/${pid}/status`, "utf8"),
  ]);
  const startTicks = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)[19];
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  if (!startTicks || Number(uid) !== process.getuid?.())
    throw new Error("Broker owner process identity is unavailable");
  return { pid, startTicks };
}

/** One process owns this abstract socket, journal, and every live scoped handle.
 * Every launch and suspension transition is serialized. A broker crash closes
 * both start gates; replay stops known identities and retains unknown dispatches.
 */
export async function serveOrganizationScopeLaunchBroker(baseDir: string): Promise<{
  readonly address: string;
  close(): Promise<void>;
}> {
  const token = await createOrganizationLaunchBrokerToken(baseDir);
  let dispatch: (request: OrganizationLaunchBrokerRequest) => Promise<unknown> = () =>
    Promise.reject(new Error("Organization launch broker is initializing"));
  const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
    let body = "";
    socket.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) socket.destroy();
    });
    socket.once("end", () => {
      void (async () => {
        try {
          if (!body.endsWith("\n")) throw new Error("Broker request is incomplete");
          const raw: unknown = JSON.parse(body.slice(0, -1));
          if (!raw || typeof raw !== "object") throw new Error("Broker request is invalid");
          if (Reflect.get(raw, "protocol") !== ORGANIZATION_LAUNCH_BROKER_PROTOCOL)
            throw new Error("Broker protocol version differs");
          if (Reflect.get(raw, "token") !== token) throw new Error("Broker authentication failed");
          const action = Reflect.get(raw, "action");
          if (typeof action !== "string") throw new Error("Broker action is missing");
          const request = raw as OrganizationLaunchBrokerRequest;
          const value = await dispatch(request);
          socket.end(`${JSON.stringify({ ok: true, value })}\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Broker request failed";
          socket.end(`${JSON.stringify({ ok: false, error: message.slice(0, 240) })}\n`);
        }
      })();
    });
  });
  const address = organizationLaunchBrokerAddress(baseDir);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let journal: OrganizationScopeLaunchJournal;
  try {
    journal = await OrganizationScopeLaunchJournal.open(
      organizationScopeLaunchJournalPath(baseDir),
    );
    await journal.reconcile();
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  const handles = new Map<string, PreparedOrganizationScopedSandbox>();
  let queue = Promise.resolve();
  let activeOwner: { pid: number; startTicks: string; epoch: string } | null = null;
  const requireEpoch = (request: OrganizationLaunchBrokerRequest) => {
    if (!activeOwner || request.epoch !== activeOwner.epoch)
      throw new Error("Organization launch owner epoch is stale or absent");
  };

  const run = async (request: OrganizationLaunchBrokerRequest): Promise<unknown> => {
    switch (request.action) {
      case "health":
        return true;
      case "activate": {
        const owner = await ownerIdentity(request.ownerPid ?? 0);
        if (activeOwner?.pid === owner.pid && activeOwner.startTicks === owner.startTicks)
          return activeOwner.epoch;
        if (activeOwner) {
          const prior = await ownerIdentity(activeOwner.pid).catch(() => null);
          if (prior?.startTicks === activeOwner.startTicks)
            throw new Error("Another live server owns Organization launch authority");
        }
        for (const [operationId, handle] of handles) {
          await handle.stop();
          handles.delete(operationId);
        }
        const recovery = await journal.reconcile();
        if (recovery.held.length)
          throw new Error(
            `Organization launch recovery remains unresolved for: ${recovery.held.join(", ")}`,
          );
        const epoch = NodeCrypto.randomBytes(32).toString("hex");
        activeOwner = { ...owner, epoch };
        return epoch;
      }
      case "get":
        return (
          journal.list().find((entry) => entry.operationId === requiredOperationId(request)) ?? null
        );
      case "status":
        return journal.list();
      case "reserve": {
        requireEpoch(request);
        if (await suspended(baseDir))
          throw new Error("Organization launch is suspended for an update trial");
        const operationId = requiredOperationId(request);
        const unitName = requiredUnitName(request);
        await journal.reserve(operationId, unitName);
        return null;
      }
      case "prepare": {
        requireEpoch(request);
        if (await suspended(baseDir))
          throw new Error("Organization launch is suspended for an update trial");
        if (journal.list().some((entry) => entry.phase === "dispatching"))
          throw new Error("An identity-less Organization launch requires recovery");
        const operationId = requiredOperationId(request);
        const unitName = requiredUnitName(request);
        const handle = await journal.prepare(operationId, decodeInput(request.input, unitName));
        handles.set(operationId, handle);
        return {
          unitName: handle.unitName,
          invocationId: handle.invocationId,
          controlGroup: handle.controlGroup,
          sandboxPid: handle.sandboxPid,
          pidNamespace: handle.pidNamespace,
          workDirectory: handle.workDirectory,
        };
      }
      case "start": {
        requireEpoch(request);
        if (await suspended(baseDir))
          throw new Error("Organization launch is suspended for an update trial");
        const handle = handles.get(requiredOperationId(request));
        if (!handle) throw new Error("Broker has no live prepared scope handle");
        await handle.start();
        return null;
      }
      case "stop":
      case "discard": {
        const operationId = requiredOperationId(request);
        const handle = handles.get(operationId);
        if (!handle) throw new Error("Broker has no live prepared scope handle");
        const result = request.action === "stop" ? await handle.stop() : await handle.discard();
        handles.delete(operationId);
        return result;
      }
      case "reconcile": {
        requireEpoch(request);
        for (const [operationId, handle] of handles) {
          try {
            await handle.stop();
            handles.delete(operationId);
          } catch {
            // The journal's exact identity remains open and the caller sees it held.
          }
        }
        return journal.reconcile();
      }
      case "quiesce": {
        if (!(await suspended(baseDir)))
          throw new Error("Organization launch suspension marker is absent");
        for (const [operationId, handle] of handles) {
          await handle.stop();
          handles.delete(operationId);
        }
        const result = await journal.reconcile();
        if (result.held.length) throw new Error("Organization launch recovery remains unresolved");
        return result;
      }
      case "wait":
        throw new Error("Broker wait is handled separately");
      default: {
        const exhaustive: never = request.action;
        throw new Error(`Unsupported broker action: ${exhaustive}`);
      }
    }
  };

  dispatch = (request: OrganizationLaunchBrokerRequest): Promise<unknown> => {
    if (request.action === "wait") {
      const handle = handles.get(requiredOperationId(request));
      if (!handle) return Promise.reject(new Error("Broker has no live prepared scope handle"));
      return handle.wait().then((result) => {
        handles.delete(requiredOperationId(request));
        return result;
      });
    }
    const pending = queue.then(() => run(request));
    queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  return {
    address,
    close: async () => {
      await queue;
      for (const handle of handles.values()) await handle.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await journal.close();
    },
  };
}

/** Client adapter used by the worker and QA paths after live activation is reviewed. */
const processOwnerEpochs = new Map<string, string>();
export function organizationScopeLaunchBrokerClient(baseDir: string, initialEpoch?: string) {
  let epoch = initialEpoch;
  const owned = () => {
    const current = epoch ?? processOwnerEpochs.get(baseDir);
    return current === undefined ? {} : { epoch: current };
  };
  return {
    activate: async (ownerPid = process.pid) => {
      epoch = await requestOrganizationLaunchBroker<string>(baseDir, {
        action: "activate",
        ownerPid,
      });
      processOwnerEpochs.set(baseDir, epoch);
      return epoch;
    },
    reserve: (operationId: string, unitName: string) =>
      requestOrganizationLaunchBroker<void>(baseDir, {
        action: "reserve",
        operationId,
        unitName,
        ...owned(),
      }),
    status: () =>
      requestOrganizationLaunchBroker<
        readonly {
          operationId: string;
          unitName: string;
          phase: string;
          identity: OrganizationWorkScopeIdentity | null;
        }[]
      >(baseDir, { action: "status" }),
    get: (operationId: string) =>
      requestOrganizationLaunchBroker<{
        operationId: string;
        unitName: string;
        phase: string;
        identity: OrganizationWorkScopeIdentity | null;
      } | null>(baseDir, { action: "get", operationId }),
    reconcile: () =>
      requestOrganizationLaunchBroker<{
        stopped: readonly string[];
        neverDispatched: readonly string[];
        held: readonly string[];
      }>(baseDir, { action: "reconcile", ...owned() }),
    prepare: async (
      operationId: string,
      input: OrganizationSandboxInput & { readonly reservedUnitName?: string },
    ): Promise<PreparedOrganizationScopedSandbox> => {
      const unitName = input.reservedUnitName ?? allocateOrganizationScopedUnitName();
      const files = Object.fromEntries(
        Object.entries(input.files ?? {}).map(([name, bytes]) => [
          name,
          Buffer.from(bytes).toString("base64"),
        ]),
      );
      const identity = await requestOrganizationLaunchBroker<
        OrganizationWorkScopeIdentity & { workDirectory: string }
      >(baseDir, {
        action: "prepare",
        operationId,
        unitName,
        ...owned(),
        input: {
          argv: input.argv,
          files,
          runtimeMs: input.runtimeMs,
          maxOutputBytes: input.maxOutputBytes,
          workspaceBytes: input.workspaceBytes,
        },
      });
      const result = (action: "wait" | "stop" | "discard") =>
        requestOrganizationLaunchBroker<OrganizationSandboxResult>(baseDir, {
          action,
          operationId,
          ...owned(),
        });
      return {
        ...identity,
        start: () =>
          requestOrganizationLaunchBroker<void>(baseDir, {
            action: "start",
            operationId,
            ...owned(),
          }),
        wait: () => result("wait"),
        stop: () => result("stop"),
        discard: () => result("discard"),
      };
    },
  };
}

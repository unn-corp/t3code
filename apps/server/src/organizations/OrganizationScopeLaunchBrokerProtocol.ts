// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Kept on Node built-ins for the version-stable service launcher.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

export const ORGANIZATION_LAUNCH_BROKER_PROTOCOL = 1;
export const organizationLaunchSuspendMarkerPath = (baseDir: string): string =>
  NodePath.join(baseDir, "runtime", "organization-launch-suspended.json");
export const organizationLaunchBrokerTokenPath = (baseDir: string): string =>
  NodePath.join(baseDir, "runtime", "organization-launch", "token");

/** Abstract AF_UNIX names are released by the kernel on broker exit. */
export function organizationLaunchBrokerAddress(baseDir: string): string {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Version-stable launcher protocol uses Node built-ins only.
  if (process.platform !== "linux" || process.getuid?.() === undefined)
    throw new Error("Organization launch broker requires Linux and a host UID");
  const canonical = NodeFS.realpathSync(baseDir);
  const digest = NodeCrypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return `\0t3-org-launch-${process.getuid()}-${digest}`;
}

export async function readOrganizationLaunchBrokerToken(baseDir: string): Promise<string> {
  const path = organizationLaunchBrokerTokenPath(baseDir);
  const handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size !== 65
    )
      throw new Error("Organization launch broker token file is unsafe");
    const token = (await handle.readFile("utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Organization launch broker token is invalid");
    return token;
  } finally {
    await handle.close();
  }
}

export async function createOrganizationLaunchBrokerToken(baseDir: string): Promise<string> {
  const runtime = NodePath.dirname(organizationLaunchBrokerTokenPath(baseDir));
  await NodeFSP.mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await NodeFSP.stat(runtime);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error("Organization launch broker runtime directory is not private");
  const path = organizationLaunchBrokerTokenPath(baseDir);
  try {
    const handle = await NodeFSP.open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${NodeCrypto.randomBytes(32).toString("hex")}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directoryHandle = await NodeFSP.open(runtime, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readOrganizationLaunchBrokerToken(baseDir);
}

export interface OrganizationLaunchBrokerRequest {
  readonly action:
    | "health"
    | "authorization-version"
    | "activate"
    | "check-owner"
    | "get"
    | "reserve"
    | "prepare"
    | "start"
    | "wait"
    | "stop"
    | "stop-and-verify-operation"
    | "discard"
    | "status"
    | "reconcile"
    | "quiesce";
  readonly operationId?: string;
  readonly unitName?: string;
  readonly input?: unknown;
  readonly epoch?: string;
  readonly ownerPid?: number;
}

export async function requestOrganizationLaunchBroker<T>(
  baseDir: string,
  request: OrganizationLaunchBrokerRequest,
): Promise<T> {
  const token = await readOrganizationLaunchBrokerToken(baseDir);
  const address = organizationLaunchBrokerAddress(baseDir);
  const body = JSON.stringify({ protocol: ORGANIZATION_LAUNCH_BROKER_PROTOCOL, token, ...request });
  if (Buffer.byteLength(body) > 2 * 1024 * 1024)
    throw new Error("Organization launch broker request exceeds its limit");
  return new Promise<T>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    let received = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(120_000, () => fail(new Error("Organization launch broker timed out")));
    socket.once("connect", () => socket.end(`${body}\n`));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (Buffer.byteLength(received) > 2 * 1024 * 1024)
        fail(new Error("Organization launch broker response exceeds its limit"));
    });
    socket.once("error", fail);
    socket.once("end", () => {
      if (settled) return;
      try {
        const response: unknown = JSON.parse(received);
        if (!response || typeof response !== "object") throw new Error("Invalid broker response");
        const ok = Reflect.get(response, "ok");
        if (ok !== true) {
          const reason = Reflect.get(response, "error");
          throw new Error(
            typeof reason === "string" ? reason : "Organization launch broker refused request",
          );
        }
        settled = true;
        resolve(Reflect.get(response, "value") as T);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Invalid broker response"));
      }
    });
  });
}

/** Called after the durable suspension marker, before a trial DB backup. */
export async function quiesceOrganizationLaunchBroker(baseDir: string): Promise<void> {
  await requestOrganizationLaunchBroker(baseDir, { action: "quiesce" });
}

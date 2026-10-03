// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Detached CLI process bootstrap.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { requestOrganizationLaunchBroker } from "./OrganizationScopeLaunchBrokerProtocol.ts";

function retryable(error: unknown): boolean {
  const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    (error instanceof Error && error.message.includes("broker is initializing"))
  );
}

async function probe(baseDir: string): Promise<boolean> {
  try {
    if (await requestOrganizationLaunchBroker<boolean>(baseDir, { action: "health" })) return true;
    throw new Error("Organization launch broker returned an invalid health response");
  } catch (error) {
    if (retryable(error)) return false;
    throw error;
  }
}

/** All server entry modes call this after resolving their isolated T3 home.
 * The broker survives the child server and Electron backend process lifetimes.
 */
export async function ensureOrganizationScopeLaunchBroker(baseDir: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Linux-only OS broker bootstrap runs before Effect layers.
  if (process.platform !== "linux") return;
  if (await probe(baseDir)) return;
  const entry = process.argv[1];
  const script =
    entry && NodePath.isAbsolute(entry) && /\.(?:[cm]?js|ts)$/.test(entry) ? [entry] : [];
  const args = [...script, "__organization-launch-broker", "--base-dir", baseDir];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
  };
  const child = NodeChildProcess.spawn(process.execPath, args, {
    cwd: "/",
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stderr = "";
  try {
    const ready = await new Promise<boolean>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(
        () => reject(new Error("Organization launch broker startup timed out")),
        10_000,
      );
      const settle = (value: boolean) => {
        clearTimeout(timer);
        resolve(value);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 1_024)
          return reject(new Error("Organization launch broker readiness output is invalid"));
        if (stdout.includes("READY\n")) settle(true);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
      });
      child.once("error", reject);
      child.once("close", () => settle(false));
    });
    if (!ready) {
      // A concurrent server may have won the abstract socket. Its health
      // response, rather than this child's exit status, establishes readiness.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await probe(baseDir)) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Organization launch broker exited before ready: ${stderr}`);
    }
    if (!(await probe(baseDir))) throw new Error("Organization launch broker did not become ready");
  } finally {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
}

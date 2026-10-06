// @effect-diagnostics nodeBuiltinImport:off globalDate:off — the handoff plan is read by a process that outlives this one.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  decodeHandoffPlan,
  encodeHandoffPlan,
  type HandoffPlan,
} from "@t3tools/shared/forkDesktopHandoff";
import { recoveryInvocation, type RecoveryCommand } from "@t3tools/shared/forkRecoveryCache";
import { ensurePrivateDirectory } from "./privateDirectory.ts";

export { HandoffPlan } from "@t3tools/shared/forkDesktopHandoff";

export const HANDOFF_EXIT_WAIT_MS = 60_000;

/** Owner-only plan, written atomically. The helper refuses a plan it does not own. */
export async function writeHandoffPlan(directory: string, plan: HandoffPlan): Promise<string> {
  await ensurePrivateDirectory(directory);
  const file = NodePath.join(directory, `${plan.transactionId}-${plan.mode}.json`);
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(encodeHandoffPlan(plan));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
  return file;
}

/**
 * `<transactionId>-<mode>.json`, renamed to `.consumed` once the helper claimed it. The consumed file is kept on purpose:
 * it is the only record outside the application of which installer replaced which, which the recovery helper's
 * `recover --desktop-plan` needs to put a broken main binary back without this application.
 */
const PLAN_FILE = /^(.+)-(install|revert)\.json(\.consumed)?$/;

export interface RetainedHandoffPlan {
  readonly path: string;
  readonly plan: HandoffPlan;
}

const readdirOrEmpty = async (directory: string) =>
  NodeFSP.readdir(directory).catch((cause: unknown) => {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return [];
    throw cause;
  });

/** Every readable plan the device still holds, consumed or not. A file that does not decode is not a plan and is left alone. */
export async function listHandoffPlans(
  directory: string,
): Promise<ReadonlyArray<RetainedHandoffPlan>> {
  const plans: RetainedHandoffPlan[] = [];
  for (const name of await readdirOrEmpty(directory)) {
    if (!PLAN_FILE.test(name)) continue;
    const file = NodePath.join(directory, name);
    try {
      plans.push({ path: file, plan: decodeHandoffPlan(await NodeFSP.readFile(file, "utf8")) });
    } catch {
      // Unreadable or foreign: never deleted, never trusted.
    }
  }
  return plans;
}

/** The retained install plan of a transaction (the one a recovery reverses), claimed or still waiting. */
export async function retainedInstallPlan(
  directory: string,
  transactionId: string,
): Promise<RetainedHandoffPlan | null> {
  const plans = (await listHandoffPlans(directory)).filter(
    (entry) => entry.plan.transactionId === transactionId && entry.plan.mode === "install",
  );
  return plans.find((entry) => entry.path.endsWith(".consumed")) ?? plans[0] ?? null;
}

/**
 * Drops the plans of transactions nothing can recover any more. A plan whose transaction is kept stays, with its payload
 * digests returned so the installer cache keeps exactly the payloads those plans name.
 */
export async function pruneHandoffPlans(
  directory: string,
  keepTransactions: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const protectedDigests = new Set<string>();
  for (const entry of await listHandoffPlans(directory)) {
    if (keepTransactions.has(entry.plan.transactionId)) {
      protectedDigests.add(entry.plan.installer.sha256);
      if (entry.plan.previousInstaller !== null)
        protectedDigests.add(entry.plan.previousInstaller.sha256);
    } else await NodeFSP.rm(entry.path, { force: true });
  }
  return protectedDigests;
}

export type SpawnDetached = (command: string, args: ReadonlyArray<string>) => Promise<void>;

/**
 * Variables that belong to the process being replaced, not to the person's session. Electron's node mode and any Node options
 * would change what the helper's runtime does; the AppImage runtime points loader and data paths into a mount that disappears
 * when this process exits, which would also break the system tools (`pkexec`, `dpkg`) and the relaunched application.
 */
const PROCESS_BOUND = new Set([
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_ENV",
  "T3CODE_MAINTENANCE_TRIAL",
  "APPIMAGE",
  "APPDIR",
  "ARGV0",
  "OWD",
  "CHROME_DESKTOP",
]);
const PATH_LISTS = new Set([
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "GSETTINGS_SCHEMA_DIR",
  "GIO_EXTRA_MODULES",
  "GTK_PATH",
  "GDK_PIXBUF_MODULE_FILE",
  "PYTHONPATH",
  "QT_PLUGIN_PATH",
  "PERLLIB",
]);

/**
 * The environment the helper runs with: the person's own session (display, session bus, runtime directory, home, locale),
 * so the authorization prompt of `pkexec` appears and the relaunched application opens a window, minus whatever this
 * process owns. Nothing from the session is dropped and nothing is invented.
 */
export function helperEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  delimiter: string,
): Record<string, string> {
  const mount = env.APPDIR;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || PROCESS_BOUND.has(name)) continue;
    if (PATH_LISTS.has(name)) {
      const kept = value
        .split(delimiter)
        .filter(
          (entry) =>
            entry.length > 0 &&
            (mount === undefined || mount.length === 0 || !entry.startsWith(mount)),
        );
      if (kept.length > 0) result[name] = kept.join(delimiter);
      continue;
    }
    result[name] = value;
  }
  return result;
}

/** Starts the helper detached, so it survives this process, and resolves once the OS has accepted the launch. */
export const spawnDetached: SpawnDetached = (command, args) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: helperEnvironment(process.env, NodePath.delimiter),
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

export async function launchHandoff(input: {
  readonly directory: string;
  readonly plan: HandoffPlan;
  readonly command: RecoveryCommand;
  readonly spawn?: SpawnDetached;
}): Promise<void> {
  const file = await writeHandoffPlan(input.directory, input.plan);
  const invocation = recoveryInvocation(input.command, ["handoff", "--plan", file]);
  await (input.spawn ?? spawnDetached)(invocation.command, invocation.args);
}

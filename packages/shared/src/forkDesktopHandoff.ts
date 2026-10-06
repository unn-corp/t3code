// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off processEnv:off globalConsole:off — an external process outlives the app it replaces.
/**
 * The external half of a desktop binary swap. The desktop writes a plan, starts this through the cached recovery
 * runtime and exits; this waits for exactly that process to be gone, verifies the payload it was told to install,
 * replaces the application, and starts it again. It changes nothing else: it never touches data homes, journals or the
 * coordinator fence, and never reads user backups. The (new or previous) desktop finishes the transaction from the
 * coordinator journal when it starts.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { capacityShortfalls } from "./forkMaintenanceAdmission.ts";
import { CoordinatorStore, processCreationIdentity } from "./forkMaintenanceStore.ts";

export const HandoffPlan = Schema.Struct({
  protocol: Schema.Literal(1),
  mode: Schema.Literals(["install", "revert"]),
  transactionId: Schema.String,
  coordinatorDirectory: Schema.String,
  /** The desktop process that must have exited before anything is replaced, identified by creation time. */
  owner: Schema.Struct({ pid: Schema.Int, started: Schema.String }),
  packaging: Schema.Literals(["nsis", "appimage", "deb"]),
  /** The build to put in place: the target for `install`, the previous build for `revert`. */
  installer: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
  /** The build the other mode would put back. Verified too, so a later revert cannot be fed a different payload. */
  previousInstaller: Schema.NullOr(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  /** The AppImage file replaced in place, or the executable relaunched. */
  installTarget: Schema.String,
  relaunch: Schema.Struct({ command: Schema.String, args: Schema.Array(Schema.String) }),
  /** The helper gives up waiting for the owner to exit after this long and changes nothing. */
  waitForExitMs: Schema.Int,
});
export type HandoffPlan = typeof HandoffPlan.Type;
export const decodeHandoffPlan = Schema.decodeUnknownSync(Schema.fromJsonString(HandoffPlan));
export const encodeHandoffPlan = Schema.encodeSync(Schema.fromJsonString(HandoffPlan));

export const HANDOFF_EXIT = {
  ok: 0,
  badPlan: 2,
  ownerStillRunning: 3,
  payloadMismatch: 4,
  installFailed: 5,
  admissionRefused: 6,
  relaunchFailed: 7,
} as const;
const POLL_MS = 250;

export interface HandoffIo {
  readonly identity: (pid: number) => Promise<string | null>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Runs a program to completion and returns its exit code; a program that cannot start is code 127. */
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<number>;
  readonly startDetached: (command: string, args: ReadonlyArray<string>) => Promise<void>;
  readonly log: (line: string) => void;
  readonly platform: NodeJS.Platform;
  /** The current user's id, for the plan ownership check (not applicable on Windows). */
  readonly uid: number | null;
  /** Tests use the real store in an isolated namespace with a simulated owner table. */
  readonly availableBytes?: (directory: string) => Promise<number>;
  readonly openCoordinator?: (directory: string) => Promise<CoordinatorStore>;
}

const hashFile = async (file: string) => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

export const defaultHandoffIo = (
  log: (line: string) => void = (line) => console.error(line),
): HandoffIo => ({
  identity: (pid) => processCreationIdentity(pid),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  run: (command, args) =>
    new Promise((resolve) => {
      const child = NodeChildProcess.spawn(command, [...args], {
        stdio: "ignore",
        windowsHide: false,
      });
      child.once("error", () => resolve(127));
      child.once("exit", (code) => resolve(code ?? 1));
    }),
  startDetached: (command, args) =>
    new Promise((resolve, reject) => {
      // Not Electron's node mode and not this helper's environment: the application starts as a user launched it.
      const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
      const child = NodeChildProcess.spawn(command, [...args], {
        detached: true,
        stdio: "ignore",
        env,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }),
  log,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The external helper runs without an Effect runtime; the host OS decides ownership checks.
  platform: process.platform,
  uid: process.getuid?.() ?? null,
});

/** AppImage: the new file is written beside the old one and renamed over it, keeping the old as `.previous`. */
async function replaceAppImage(installer: string, target: string) {
  const incoming = `${target}.new`;
  await NodeFSP.copyFile(installer, incoming);
  await NodeFSP.chmod(incoming, 0o755);
  try {
    await NodeFSP.copyFile(target, `${target}.previous`);
  } catch (cause) {
    if (
      !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
    )
      throw cause;
  }
  await NodeFSP.rename(incoming, target);
}

/** Returns the process exit code. */
export async function runDesktopHandoff(
  planFile: string,
  io: HandoffIo = defaultHandoffIo(),
): Promise<number> {
  let plan: HandoffPlan;
  try {
    const stat = await NodeFSP.lstat(planFile);
    if (!stat.isFile()) throw new Error("The plan is not a regular file.");
    if (
      io.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || (io.uid !== null && stat.uid !== io.uid))
    )
      throw new Error("The plan must be owned by this user with no group or world access.");
    plan = decodeHandoffPlan(await NodeFSP.readFile(planFile, "utf8"));
  } catch (cause) {
    io.log(
      `The handoff plan was refused: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return HANDOFF_EXIT.badPlan;
  }

  // Exactly the process that wrote the plan, by creation identity: a reused pid is a different process.
  const deadline = io.now() + plan.waitForExitMs;
  while ((await io.identity(plan.owner.pid)) === plan.owner.started) {
    if (io.now() >= deadline) {
      io.log("The desktop did not exit in time; nothing was changed.");
      return HANDOFF_EXIT.ownerStillRunning;
    }
    await io.sleep(POLL_MS);
  }

  // Nothing is replaced until every payload this transaction may need is byte for byte what was verified.
  for (const payload of [
    plan.installer,
    ...(plan.previousInstaller === null ? [] : [plan.previousInstaller]),
  ]) {
    let actual: string | null = null;
    try {
      actual = await hashFile(payload.path);
    } catch {
      actual = null;
    }
    if (actual !== payload.sha256) {
      io.log(
        `${NodePath.basename(payload.path)} does not match its recorded digest; nothing was changed.`,
      );
      return HANDOFF_EXIT.payloadMismatch;
    }
  }

  if (plan.packaging === "appimage") {
    try {
      const filesystem = NodePath.dirname(plan.installTarget);
      const available = io.availableBytes
        ? await io.availableBytes(filesystem)
        : await NodeFSP.statfs(filesystem).then((stat) => Number(stat.bavail) * Number(stat.bsize));
      const incoming = (await NodeFSP.stat(plan.installer.path)).size;
      const current = await NodeFSP.stat(plan.installTarget)
        .then((stat) => stat.size)
        .catch((cause) => {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
            return 0;
          throw cause;
        });
      if (
        capacityShortfalls([
          { filesystem, requiredAdditionalBytes: incoming + current, availableBytes: available },
        ]).length > 0
      )
        throw new Error(
          "The AppImage filesystem has insufficient space for replacement and its prior binary copy.",
        );
    } catch (cause) {
      io.log(cause instanceof Error ? cause.message : String(cause));
      return HANDOFF_EXIT.admissionRefused;
    }
  }

  let coordinator: CoordinatorStore;
  try {
    coordinator = await (io.openCoordinator?.(plan.coordinatorDirectory) ??
      CoordinatorStore.open(plan.coordinatorDirectory));
    await coordinator.claimDesktopHandoff(
      plan.transactionId,
      plan.mode,
      plan.installer.sha256,
      plan.owner,
      plan.previousInstaller?.sha256 ?? null,
    );
    // A renamed plan is deliberately retained for diagnosis, never accepted as a fresh transaction.
    await NodeFSP.rename(planFile, `${planFile}.consumed`);
  } catch (cause) {
    io.log(
      `Binary replacement was refused: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return HANDOFF_EXIT.admissionRefused;
  }

  let installed = false;
  try {
    switch (plan.packaging) {
      case "nsis":
        // Launch separately after dropping only the installer hold, so startup cannot race replacement.
        installed = (await io.run(plan.installer.path, ["/S", "--updated"])) === 0;
        break;
      case "deb":
        // The operating-system authorization prompt is the person's to answer; nothing runs elevated until they do.
        installed = (await io.run("pkexec", ["dpkg", "-i", plan.installer.path])) === 0;
        break;
      case "appimage":
        await replaceAppImage(plan.installer.path, plan.installTarget);
        installed = true;
        break;
    }
  } catch (cause) {
    io.log(
      `The installer could not run: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  try {
    await coordinator.finishDesktopHandoff(plan.transactionId);
  } catch (cause) {
    io.log(
      `The installer hold could not be released: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return HANDOFF_EXIT.admissionRefused;
  }

  // After a failed install the application that was there is started anyway: the desktop's own journal decides what happens next.
  {
    try {
      await io.startDetached(plan.relaunch.command, plan.relaunch.args);
    } catch (cause) {
      io.log(
        `The application could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return HANDOFF_EXIT.relaunchFailed;
    }
  }
  return installed ? HANDOFF_EXIT.ok : HANDOFF_EXIT.installFailed;
}

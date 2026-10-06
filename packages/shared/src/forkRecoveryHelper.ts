// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off processEnv:off globalTimers:off
/**
 * The external recovery helper: the part of recovery that works when the application directory
 * has been replaced or is broken. Release tooling bundles this implementation through the dedicated
 * `forkRecoveryHelperMain.ts` entry (every dependency inlined) into `t3-recovery-helper-<platform>.mjs`; a device caches it OUTSIDE the app directory
 * together with its own Node runtime (`t3-recovery-node-<platform>`), so recovery needs neither a
 * system Node nor the main app. `print-runtime` shows the exact cached command.
 *
 * It is not a shortcut around the update machinery; it runs the same services:
 *   - the same coordinator store: admission fence, five-minute idle window for every registered
 *     participant, orphaned-process blocking, and the durable journal;
 *   - the same transaction engine and snapshot code (verified rescue copies, idempotent restore);
 *   - the same cohort: ALL homes of the recorded transaction (Windows and every explicitly
 *     registered WSL member) are checked, fenced, rescued and restored together, or none is.
 * It never writes a health receipt, never marks a runtime verified, and never releases the fence:
 * it stops at "restored" and the next healthy start (the service successor, or the desktop
 * controller) verifies the restored runtimes, pins the reverted build, holds restored automation for
 * review, and only then releases admission. If anything fails it fails closed and leaves the fence held.
 *
 * `recover --desktop-plan <retained install plan>` additionally puts the previous desktop build back for a main
 * application that cannot start. The retained plan, both installer payloads and the cached helper/Node pair are verified
 * before anything is replaced; only after EVERY home is rescued and restored is the revert authorized in the journal and
 * handed to a detached `handoff` that waits for this process to exit. The fence stays held until a healthy prior runtime
 * releases it.
 *
 * Commands (the operator is local and explicit; nothing is inferred):
 *   --self-test                          snapshot a temporary home, change it, restore it, verify
 *   print-runtime                        the cached verified runtime and exact command line
 *   handoff --plan <file>                replace or revert the desktop binary from a desktop-written plan (see forkDesktopHandoff)
 *   status  [--coordinator <dir>]        fence, journals, registered runtimes
 *   options [--coordinator <dir>]        recoverable transactions with each home's restore cutoff
 *   recover --transaction <id> --confirm <home>=<restore-point-created> [--confirm ...]
 *           [--members <file>] [--coordinator <dir>]
 *           [--desktop-plan <file>]
 *           `--confirm` must name every home of the transaction with its exact recorded cutoff. `--desktop-plan` names the
 *           retained private `<transaction>-install.json[.consumed]` and is a local file path only, never fetched or inferred.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { newJournal, type MaintenanceJournal } from "./forkMaintenanceJournal.ts";
import {
  createSnapshot,
  restoreSnapshot,
  restrictWindowsAcl,
  verifySnapshot,
  type RestrictAccess,
} from "./forkMaintenanceSnapshot.ts";
import { CoordinatorStore, coordinatorDirectory } from "./forkMaintenanceStore.ts";
import {
  advanceTransaction,
  MaintenanceTransactionError,
  type TransactionPorts,
} from "./forkMaintenanceTransaction.ts";
import {
  createCohortStorage,
  createLocalHomeControl,
  createWslFenceControl,
  createWslHomeControl,
  decodeWslMembership,
  mirrorJournalToMembers,
  parseWslHomeId,
  wslHomeId,
  type CohortHome,
  type Exec,
  type FenceControl,
  type WslMember,
} from "./forkMaintenanceWsl.ts";
import {
  decodeHandoffPlan,
  defaultHandoffIo,
  encodeHandoffPlan,
  runDesktopHandoff,
  type HandoffPlan,
} from "./forkDesktopHandoff.ts";
import {
  readRecoveryCommand,
  recoveryInvocation,
  type RecoveryCommand,
} from "./forkRecoveryCache.ts";

export const RECOVERY_HELPER_PROTOCOL = 1;
export const RECOVERY_HELPER_MIN_NODE_MAJOR = 24;

export interface HelperIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}
const processIo: HelperIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const flagsOf = (args: ReadonlyArray<string>) => {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (!key.startsWith("--")) continue;
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) flags.set(key.slice(2), "true");
    else {
      flags.set(key.slice(2), next);
      index += 1;
    }
  }
  return flags;
};

/** Snapshot, change, restore, verify, against a throwaway home. Uses the coordinator's real restore path. */
export async function runSelfTest(io: HelperIo = processIo): Promise<void> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-recovery-self-test-"));
  try {
    const state = NodePath.join(root, "userdata");
    await NodeFSP.mkdir(NodePath.join(state, "secrets"), { recursive: true });
    const database = new NodeSqlite.DatabaseSync(NodePath.join(state, "statev2.sqlite"));
    database.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('before')",
    );
    await NodeFSP.writeFile(NodePath.join(state, "secrets", "pairing"), "device-credential");
    await NodeFSP.writeFile(NodePath.join(state, "settings.json"), '{"theme":"dark"}');
    const id = await createSnapshot(root, "self-test");
    database.exec("INSERT INTO messages VALUES ('after the update')");
    database.close();
    await NodeFSP.writeFile(NodePath.join(state, "settings.json"), '{"theme":"changed"}');
    await NodeFSP.rm(NodePath.join(state, "secrets", "pairing"));
    await verifySnapshot(root, id);
    await restoreSnapshot(root, id, "self-test");
    const restored = new NodeSqlite.DatabaseSync(NodePath.join(state, "statev2.sqlite"), {
      readOnly: true,
    });
    try {
      const rows = restored
        .prepare("SELECT text FROM messages ORDER BY rowid")
        .all()
        .map((row) => row.text);
      if (JSON.stringify(rows) !== JSON.stringify(["before"]))
        throw new Error(`restore mismatch: database rows ${JSON.stringify(rows)}`);
    } finally {
      restored.close();
    }
    if (
      (await NodeFSP.readFile(NodePath.join(state, "settings.json"), "utf8")) !== '{"theme":"dark"}'
    )
      throw new Error("restore mismatch: settings were not restored");
    if (
      (await NodeFSP.readFile(NodePath.join(state, "secrets", "pairing"), "utf8")) !==
      "device-credential"
    )
      throw new Error("restore mismatch: pairing credential was not restored");
    io.out(`recovery-helper-protocol=${RECOVERY_HELPER_PROTOCOL}`);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

/** A transaction an operator may recover: its cohort and the exact restore cutoff of every home. */
export interface RecoveryOption {
  readonly transactionId: string;
  readonly mode: "resume-held" | "revert-committed";
  readonly phase: MaintenanceJournal["phase"];
  readonly homes: ReadonlyArray<{
    readonly id: string;
    readonly restorePointId: string;
    readonly createdAt: string;
  }>;
}

export interface CohortContext {
  readonly store: CoordinatorStore;
  readonly members: ReadonlyArray<{ readonly member: WslMember; readonly exec: Exec }>;
  readonly now: () => number;
  /** Test seam for the filesystem restore of local homes. */
  readonly restore?: (home: string, snapshotId: string, transactionId: string) => Promise<void>;
}

const homeControls = (context: CohortContext, homeIds: ReadonlyArray<string>) => {
  const homes: CohortHome[] = [];
  const fences: FenceControl[] = [];
  const members: WslMember[] = [];
  for (const id of homeIds) {
    const wsl = parseWslHomeId(id);
    if (wsl === null) {
      homes.push({ id, label: id, control: createLocalHomeControl(id) });
      continue;
    }
    const entry = context.members.find((candidate) => wslHomeId(candidate.member) === id);
    // Membership is explicit. A distribution that was never registered is not guessed at, and not skipped.
    if (entry === undefined)
      throw new Error(
        `${wsl.distro} is part of this transaction but is not in the registered WSL membership. Nothing was changed.`,
      );
    homes.push({
      id,
      label: `${wsl.distro} (WSL)`,
      control: createWslHomeControl(entry.member, entry.exec),
    });
    fences.push(createWslFenceControl(entry.member, entry.exec));
    members.push(entry.member);
  }
  return { homes, fences, members };
};

/** Source journals an operator can act on: a held, abandoned transaction, or a committed update with complete restore points. */
export async function listRecoveryOptions(
  context: CohortContext,
): Promise<ReadonlyArray<RecoveryOption>> {
  const status = await context.store.status(context.now());
  const options: RecoveryOption[] = [];
  for (const journal of [...(await context.store.listJournals())].sort(
    (a, b) => b.createdAt - a.createdAt,
  )) {
    const held = status.fence?.transactionId === journal.id;
    const revertable = journal.kind === "update" && journal.phase === "committed";
    if (!held && !revertable) continue;
    if (held && ["fenced", "snapshotted", "aborted"].includes(journal.phase)) continue;
    if (journal.homes.some((home) => journal.snapshots[home] === undefined)) continue;
    const { homes } = homeControls(context, journal.homes);
    const described: Array<{ id: string; restorePointId: string; createdAt: string }> = [];
    let complete = true;
    for (const home of homes) {
      const points = await createCohortStorage([home])
        .restorePoints(home.id)
        .catch(() => []);
      const point = points.find((candidate) => candidate.id === journal.snapshots[home.id]);
      if (point === undefined) {
        complete = false;
        break;
      }
      described.push({ id: home.id, restorePointId: point.id, createdAt: point.createdAt });
    }
    if (complete)
      options.push({
        transactionId: journal.id,
        mode: held ? "resume-held" : "revert-committed",
        phase: journal.phase,
        homes: described,
      });
  }
  return options;
}

/** How long the detached handoff waits for this process to exit before it changes nothing. */
const HELPER_HANDOFF_WAIT_MS = 60_000;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Host effects of the desktop binary revert. Tests replace the cached-command read and the launch; nothing else is simulated. */
export interface DesktopRecoveryPorts {
  /** The verified cached helper and Node pair. Must throw unless both are present and byte for byte what was recorded. */
  readonly readCommand: (cacheDir: string) => Promise<RecoveryCommand>;
  /** Starts the cached command detached so it outlives this process; resolves once the OS accepted the launch. */
  readonly spawn: (command: string, args: ReadonlyArray<string>) => Promise<void>;
  readonly platform: NodeJS.Platform;
  /** The current user's id for ownership checks (not applicable on Windows). */
  readonly uid: number | null;
  readonly restrictWindows: RestrictAccess;
}

const startDetachedHelper: DesktopRecoveryPorts["spawn"] = (command, args) =>
  new Promise((resolve, reject) => {
    // The person's own session (display, session bus, runtime directory) is kept; only Electron's node mode is not inherited.
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
    const child = NodeChildProcess.spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

const defaultDesktopRecoveryPorts: DesktopRecoveryPorts = {
  readCommand: readRecoveryCommand,
  spawn: startDetachedHelper,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The external helper runs without an Effect runtime; the host OS decides ownership checks.
  platform: process.platform,
  uid: process.getuid?.() ?? null,
  restrictWindows: restrictWindowsAcl,
};

export interface DesktopRecoveryInput {
  /** The retained `<transaction>-install.json[.consumed]` plan the desktop wrote outside the application. */
  readonly planFile: string;
  /** Defaults to `<plan directory>/../recovery`, the cache that sits beside the private handoff directory. */
  readonly cacheDir?: string;
  readonly ports?: Partial<DesktopRecoveryPorts>;
}

interface Payload {
  readonly path: string;
  readonly sha256: string;
}
interface PreparedDesktopRecovery {
  readonly plan: HandoffPlan;
  readonly installer: Payload;
  readonly previousInstaller: Payload;
  readonly directory: string;
  readonly cacheDir: string;
  readonly command: RecoveryCommand;
  readonly ports: DesktopRecoveryPorts;
}

const hashFile = async (file: string) => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

async function requirePrivate(
  target: string,
  kind: "file" | "directory",
  ports: DesktopRecoveryPorts,
) {
  const stat = await NodeFSP.lstat(target);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory())
    throw new Error(`${target} is not a regular ${kind}.`);
  if (
    ports.platform !== "win32" &&
    ((stat.mode & 0o077) !== 0 || (ports.uid !== null && stat.uid !== ports.uid))
  )
    throw new Error(`${target} must be owned by this user with no group or world access.`);
}

const sameBuild = (left: MaintenanceJournal["previous"], right: MaintenanceJournal["previous"]) =>
  left.version === right.version &&
  left.artifactSha256 === right.artifactSha256 &&
  (left.commit ?? null) === (right.commit ?? null);

/**
 * Proves, before any data is replaced, that the revert can be completed: the retained plan is private, is the install plan
 * of exactly this source transaction, names this coordinator, and agrees with the authorization the controller durably recorded
 * for it; both installer payloads are byte for byte the recorded ones; and the cached helper/Node pair is intact. Nothing is
 * inferred: the previous build's installer digest is the one the source journal recorded, which a legacy previous build
 * identity does not equal.
 */
async function prepareDesktopRecovery(
  store: CoordinatorStore,
  source: MaintenanceJournal,
  input: DesktopRecoveryInput,
): Promise<PreparedDesktopRecovery> {
  const ports: DesktopRecoveryPorts = { ...defaultDesktopRecoveryPorts, ...input.ports };
  const refuse: (reason: string) => never = (reason) => {
    throw new Error(`${reason} Nothing was changed.`);
  };
  const planFile = NodePath.resolve(input.planFile);
  const directory = NodePath.dirname(planFile);
  let plan: HandoffPlan;
  try {
    if (!/\.json(\.consumed)?$/.test(planFile)) throw new Error("It is not a handoff plan file.");
    await requirePrivate(planFile, "file", ports);
    if (ports.platform === "win32") await ports.restrictWindows(directory);
    else await requirePrivate(directory, "directory", ports);
    plan = decodeHandoffPlan(await NodeFSP.readFile(planFile, "utf8"));
  } catch (cause) {
    refuse(
      `The desktop plan was refused: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (plan.mode !== "install") refuse("The desktop plan is not an install plan.");
  if (plan.transactionId !== source.id)
    refuse(`The desktop plan belongs to transaction ${plan.transactionId}, not ${source.id}.`);
  const realpaths = await Promise.all([
    NodeFSP.realpath(plan.coordinatorDirectory),
    NodeFSP.realpath(store.directory),
  ]).catch(() => null);
  if (realpaths === null || realpaths[0] !== realpaths[1])
    refuse("The desktop plan was written for a different coordinator.");
  const { installer, previousInstaller } = plan;
  if (previousInstaller === null)
    refuse("The desktop plan has no previous installer, so the previous build cannot be put back.");
  for (const payload of [installer, previousInstaller]) {
    if (!SHA256_HEX.test(payload.sha256) || !NodePath.isAbsolute(payload.path))
      refuse("The desktop plan names a payload without an absolute path and a SHA-256 digest.");
  }
  if (!NodePath.isAbsolute(plan.installTarget))
    refuse("The desktop plan names a relative install target.");
  const recorded = source.desktopHandoffs?.install;
  if (recorded === undefined)
    refuse(
      "The transaction journal has no recorded install handoff, so the plan cannot be matched to it.",
    );
  if (
    recorded.owner.pid !== plan.owner.pid ||
    recorded.owner.started !== plan.owner.started ||
    recorded.artifactSha256 !== installer.sha256 ||
    recorded.counterpartSha256 !== previousInstaller.sha256 ||
    (source.target !== null && source.target.artifactSha256 !== installer.sha256)
  )
    refuse(
      "The desktop plan does not match the install handoff the journal recorded (owner, installer digest or previous installer digest).",
    );
  const fence = await store.fenceSnapshot();
  if (fence?.transactionId === source.id && fence.consumedHandoffs?.includes("revert") === true)
    refuse("A revert handoff was already consumed for this transaction.");

  // Every payload and the cached pair are read in full before any data is touched.
  for (const payload of [installer, previousInstaller]) {
    const actual = await hashFile(payload.path).catch(() => null);
    if (actual !== payload.sha256)
      refuse(`${NodePath.basename(payload.path)} does not match its recorded digest.`);
  }
  const cacheDir = input.cacheDir ?? NodePath.join(directory, "..", "recovery");
  const command = await ports
    .readCommand(cacheDir)
    .catch((cause: unknown) =>
      refuse(
        `The cached recovery helper and Node runtime could not be verified (${cause instanceof Error ? cause.message : String(cause)}).`,
      ),
    );
  return { plan, installer, previousInstaller, directory, cacheDir, command, ports };
}

async function writePlanAtomically(file: string, plan: HandoffPlan) {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(encodeHandoffPlan(plan));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
}

/**
 * Runs after EVERY home is rescued and restored. It authorizes exactly one revert in the journal, writes the revert plan to the
 * private handoff directory and starts the cached helper detached. The helper waits for this process to exit (the plan's owner
 * is this store's owner), verifies both payloads again, and replaces the binary. The fence stays held by the journal's
 * `restored` phase until a healthy prior runtime verifies and releases it.
 */
async function handOffDesktopRevert(
  store: CoordinatorStore,
  source: MaintenanceJournal,
  journalId: string,
  prepared: PreparedDesktopRecovery,
): Promise<string> {
  const journal = await store.readJournal(journalId);
  const fence = await store.fenceSnapshot();
  if (
    journal === null ||
    journal.kind !== "recovery" ||
    journal.phase !== "restored" ||
    !sameBuild(journal.previous, source.previous) ||
    fence?.transactionId !== journalId
  ) {
    throw new Error(
      "The restored recovery is not the held transaction on the previous build, so the desktop application was not replaced. Admission stays fenced.",
    );
  }
  const { plan, installer, previousInstaller } = prepared;
  await store.recordDesktopHandoffAuthorization(journalId, {
    mode: "revert",
    buildArtifactSha256: journal.previous.artifactSha256,
    artifactSha256: previousInstaller.sha256,
    counterpartSha256: installer.sha256,
  });
  const revert: HandoffPlan = {
    protocol: 1,
    mode: "revert",
    transactionId: journalId,
    coordinatorDirectory: plan.coordinatorDirectory,
    owner: store.owner,
    packaging: plan.packaging,
    installer: previousInstaller,
    previousInstaller: installer,
    installTarget: plan.installTarget,
    relaunch: plan.relaunch,
    waitForExitMs: HELPER_HANDOFF_WAIT_MS,
  };
  const file = NodePath.join(prepared.directory, `${journalId}-revert.json`);
  await writePlanAtomically(file, revert);
  // The cached pair is read again here: restoring took time, and the process that is started is exactly what is verified now.
  const command = await prepared.ports.readCommand(prepared.cacheDir);
  if (
    command.nodeSha256 !== prepared.command.nodeSha256 ||
    command.helperSha256 !== prepared.command.helperSha256
  )
    throw new Error(
      "The cached recovery helper changed while data was being restored. Admission stays fenced.",
    );
  const invocation = recoveryInvocation(command, ["handoff", "--plan", file]);
  try {
    await prepared.ports.spawn(invocation.command, invocation.args);
  } catch (cause) {
    throw new Error(
      `Data is restored and the revert is authorized, but the previous desktop build could not be started (${cause instanceof Error ? cause.message : String(cause)}). Admission stays fenced. After this command exits, run: "${invocation.command}" ${invocation.args.map((arg) => `"${arg}"`).join(" ")}`,
      { cause },
    );
  }
  return file;
}

export interface RecoverCohortInput extends CohortContext {
  readonly transactionId: string;
  /** Home id to the restore point creation time the operator confirmed. Must cover every home, exactly. */
  readonly confirm: Readonly<Record<string, string>>;
  readonly helperId?: string;
  /** Also puts the previous desktop binary back, after every home is restored. Without it recovery only restores data. */
  readonly desktop?: DesktopRecoveryInput;
}

/**
 * Restores every home of one recorded transaction, or none. Stops at `restored` with the fence held:
 * the next healthy start verifies the restored runtimes and releases admission. Fails closed.
 */
export async function recoverCohort(input: RecoverCohortInput): Promise<ReadonlyArray<string>> {
  const { store } = input;
  const helperId = input.helperId ?? `helper-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const source = await store.readJournal(input.transactionId);
  if (source === null) throw new Error("That device transaction has no journal.");
  const option = (await listRecoveryOptions(input)).find(
    (candidate) => candidate.transactionId === input.transactionId,
  );
  if (option === undefined)
    throw new Error(
      "That transaction is not recoverable: it needs a held fence or a committed update, and a retained restore point for every home.",
    );

  // The confirmation is bound to the exact cohort and cutoffs shown by `options`; a changed set invalidates it.
  const confirmed = Object.keys(input.confirm);
  if (
    confirmed.length !== option.homes.length ||
    option.homes.some((home) => input.confirm[home.id] !== home.createdAt)
  ) {
    throw new Error(
      "The confirmation must name every home of the transaction with its exact restore-point cutoff (see `options`). Nothing was changed.",
    );
  }
  // Everything the binary revert needs is proven before any file or fence changes; a missing or altered piece changes nothing.
  const desktop =
    input.desktop === undefined ? null : await prepareDesktopRecovery(store, source, input.desktop);
  const { homes, fences, members } = homeControls(input, source.homes);
  const storage = createCohortStorage(homes);
  const now = input.now();
  const status = await store.status(now);

  // Every runtime that owns an affected home must be gone, trial owners included. A live or orphaned owner means files
  // would be replaced under a running database, so any such participant blocks, whatever its role.
  const localHomes = new Set(source.homes.filter((home) => parseWslHomeId(home) === null));
  const owner = status.participants.find((participant) =>
    participant.homes.some((home) => localHomes.has(home)),
  );
  if (owner !== undefined)
    throw new Error(
      `${owner.label} still owns ${owner.homes.join(", ")}${owner.orphaned ? " (processes it started are still running)" : ""}. Stop it first; recovery never replaces files under a running runtime.`,
    );
  for (const [index, fence] of fences.entries()) {
    const member = members[index]!;
    const answer = await fence.run({ op: "status" });
    if (!answer.ok)
      throw new Error(
        `${member.distro} could not be checked over its control channel: ${answer.reason}`,
      );
    const view = answer.value as {
      participants: ReadonlyArray<{
        label: string;
        homes: ReadonlyArray<string>;
        orphaned: boolean;
      }>;
    };
    const memberOwner = view.participants.find((participant) =>
      participant.homes.includes(member.home),
    );
    if (memberOwner !== undefined)
      throw new Error(
        `${memberOwner.label} in ${member.distro} still owns its data home. Stop it first.`,
      );
  }

  let journalId: string;
  const mode = option.mode;
  if (mode === "resume-held") {
    if (status.fence === null || status.fence.transactionId !== source.id)
      throw new Error("The device transaction is no longer held.");
    if (status.fence.holderAlive !== false)
      throw new Error(
        "The transaction's owner is still running or holds it over a control channel; it must finish or exit first.",
      );
    await store.takeOverAbandonedFence(source.id);
    journalId = source.id;
  } else {
    journalId = `r${now}-${NodeCrypto.randomUUID().slice(0, 8)}`;
    // Admission for the whole device: every participant must have been idle for five minutes, with nothing orphaned.
    await store.freeze(journalId, now, { forRecovery: true });
  }
  // Members freeze under the same transaction, held remotely by this helper. A member that cannot freeze aborts the cohort.
  const frozenMembers: FenceControl[] = [];
  /** Before any file is replaced a new recovery is simply abandoned: nothing changed, so admission is released. */
  const abandon = async () => {
    if (mode === "resume-held") return;
    const aborted: MaintenanceJournal = {
      ...newJournal({
        id: journalId,
        kind: "recovery",
        homes: source.homes,
        previous: source.previous,
        target: null,
        now: input.now(),
      }),
      phase: "aborted",
      failure: "Recovery did not begin; nothing was changed.",
    };
    await store.writeJournal(aborted).catch(() => undefined);
    await mirrorJournalToMembers(aborted, frozenMembers).catch(() => undefined);
    for (const fence of frozenMembers)
      await fence.run({ op: "release", transactionId: journalId }).catch(() => undefined);
    await store.releaseFence(journalId).catch(() => undefined);
  };
  let restoreBegan = false;
  try {
    for (const fence of fences) {
      const status = await fence.run({ op: "status" });
      const alreadyHeld =
        status.ok &&
        (status.value as { fence: { transactionId: string } | null }).fence?.transactionId ===
          journalId;
      if (alreadyHeld) {
        frozenMembers.push(fence);
        continue;
      }
      const frozen = await fence.run({
        op: "freeze",
        transactionId: journalId,
        parent: helperId,
        forRecovery: true,
      });
      if (!frozen.ok) throw new Error(`A WSL member could not be fenced: ${frozen.reason}`);
      frozenMembers.push(fence);
    }
    // Peak capacity: current data is copied (rescue) before it is replaced, on every home's own filesystem.
    await storage.assertCapacity(source.homes, { rescue: true });
    // Verified rescue copies of every home first. Failing here changes nothing.
    const rescues: Record<string, string> = {};
    for (const home of source.homes) rescues[home] = await storage.rescue(home, journalId);
    const recovery: MaintenanceJournal = {
      ...newJournal({
        id: journalId,
        kind: "recovery",
        homes: source.homes,
        previous: source.previous,
        target: null,
        now: input.now(),
        snapshots: source.snapshots,
      }),
      phase: "restoring",
      rescues,
      // The recorded handoff authorizations stay with the transaction so a retried recovery can still be matched to its plan.
      ...(source.desktopHandoffs === undefined ? {} : { desktopHandoffs: source.desktopHandoffs }),
    };
    await store.writeJournal(recovery);
    await mirrorJournalToMembers(recovery, fences);
    // From the first durable `restoring`, files may be replaced: this helper never releases the fence again.
    restoreBegan = true;
    const ports: TransactionPorts = {
      now: input.now,
      load: (id) => store.readJournal(id),
      persist: async (journal) => {
        await store.writeJournal(journal);
        await mirrorJournalToMembers(journal, fences);
      },
      snapshot: async () => {
        throw new Error("Recovery never takes new restore points.");
      },
      discardSnapshot: storage.discardSnapshot,
      rescue: storage.rescue,
      startTrial: async () => {
        throw new Error("The recovery helper never starts a runtime.");
      },
      verifyTrial: async () => {
        throw new Error("The recovery helper never verifies a runtime.");
      },
      restore: async (home, snapshotId, transactionId) =>
        input.restore !== undefined && parseWslHomeId(home) === null
          ? input.restore(home, snapshotId, transactionId)
          : storage.restore(home, snapshotId, transactionId),
      verifyRestored: async () => {
        throw new Error("Only a healthy start verifies a restored runtime.");
      },
      release: async () => {
        throw new Error("The recovery helper never releases admission.");
      },
    };
    const result = await advanceTransaction(journalId, ports, { stopAt: "restored" });
    if (result.phase !== "restored")
      throw new MaintenanceTransactionError("Restoration did not complete.", result.phase);
  } catch (cause) {
    if (!restoreBegan) await abandon();
    throw cause;
  }
  const restored = `Restored all ${source.homes.length} home(s) of transaction ${source.id} to their recorded restore points; rescue copies of the replaced data were verified first.`;
  if (desktop === null) {
    return [
      restored,
      "Admission stays fenced. Start T3 Code: the first healthy start verifies the restored runtimes, pins the reverted build, holds restored schedules and queues for your review, and then releases admission.",
    ];
  }
  // Only now, with every home restored, is the binary touched. A failure here leaves the restored data and the held fence as they are.
  const plan = await handOffDesktopRevert(store, source, journalId, desktop);
  return [
    restored,
    `The previous desktop build is being put back by a detached helper (${plan}) that starts when this command exits, verifies both installers again, replaces the application and starts it.`,
    "Admission stays fenced. The previous build's first healthy start verifies the restored runtimes, pins the reverted build, holds restored schedules and queues for your review, and then releases admission.",
  ];
}

const realExec: Exec = (command, args) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

async function readMembers(file: string): Promise<CohortContext["members"]> {
  try {
    return decodeWslMembership(JSON.parse(await NodeFSP.readFile(file, "utf8"))).members.map(
      (member) => ({ member, exec: realExec }),
    );
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return [];
    throw cause;
  }
}

export async function main(argv: ReadonlyArray<string>, io: HelperIo = processIo): Promise<number> {
  const [command, ...rest] = argv;
  const flags = flagsOf(rest);
  const confirms = rest.flatMap((arg, index) =>
    arg === "--confirm" && rest[index + 1] !== undefined ? [rest[index + 1]!] : [],
  );
  try {
    if (command === "--self-test") {
      await runSelfTest(io);
      return 0;
    }
    const coordinator = coordinatorDirectory(flags.get("coordinator"));
    const context = async (): Promise<CohortContext> => ({
      store: await CoordinatorStore.open(coordinator),
      members: await readMembers(
        flags.get("members") ?? NodePath.join(coordinator, "wsl-membership.json"),
      ),
      now: () => Date.now(),
    });
    switch (command) {
      // Replaces or reverts the desktop binary from a plan the desktop wrote and a recorded, digest-checked installer. It never
      // touches data or the fence: the desktop finishes the transaction from its journal on the next start.
      case "handoff":
        return runDesktopHandoff(flags.get("plan") ?? "", defaultHandoffIo(io.err));
      case "print-runtime": {
        io.out(`recovery-helper-protocol=${RECOVERY_HELPER_PROTOCOL}`);
        // The runtime that proves and runs recovery is the cached, digest-verified one outside the app. A device
        // without it has not completed a verified update install yet and cannot recover in-product.
        const cached = await readRecoveryCommand(
          flags.get("cache") ?? NodePath.join(coordinator, "recovery"),
        ).catch(() => null);
        if (cached === null) {
          io.out(
            "No verified recovery runtime is cached on this device. Install or update T3 Code once so it caches the helper and its Node runtime, then run this again.",
          );
          return 1;
        }
        const invocation = recoveryInvocation(cached, ["options"]);
        io.out(`Cached runtime: ${cached.nodePath}`);
        io.out(`Cached helper:  ${cached.helperPath} (release ${cached.version})`);
        io.out(
          `Run: "${invocation.command}" ${invocation.args.map((arg) => `"${arg}"`).join(" ")}`,
        );
        return 0;
      }
      case "status": {
        const { store } = await context();
        const status = await store.status(Date.now());
        io.out(
          JSON.stringify(
            {
              coordinatorId: status.coordinatorId,
              bootstrapped: status.bootstrapped,
              fence: status.fence,
              participants: status.participants.map((participant) => ({
                id: participant.id,
                label: participant.label,
                kind: participant.kind,
                homes: participant.homes,
                orphaned: participant.orphaned,
              })),
              blockers: status.blockers,
              journals: (await store.listJournals()).map((journal) => ({
                id: journal.id,
                kind: journal.kind,
                phase: journal.phase,
                homes: journal.homes,
              })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      case "options": {
        io.out(JSON.stringify(await listRecoveryOptions(await context()), null, 2));
        return 0;
      }
      case "recover": {
        const transactionId = flags.get("transaction");
        if (transactionId === undefined || confirms.length === 0)
          throw new Error(
            "--transaction and at least one --confirm <home>=<restore-point-created> are required.",
          );
        const confirm: Record<string, string> = {};
        for (const entry of confirms) {
          const split = entry.lastIndexOf("=");
          if (split <= 0) throw new Error(`Malformed --confirm ${entry}.`);
          confirm[entry.slice(0, split)] = entry.slice(split + 1);
        }
        const desktopPlan = flags.get("desktop-plan");
        if (desktopPlan === "true")
          throw new Error("--desktop-plan needs the path of the retained install plan.");
        for (const line of await recoverCohort({
          ...(await context()),
          transactionId,
          confirm,
          ...(desktopPlan === undefined ? {} : { desktop: { planFile: desktopPlan } }),
        }))
          io.out(line);
        return 0;
      }
      default:
        io.err(
          "Usage: --self-test | print-runtime | handoff --plan <file> | status | options | recover --transaction <id> --confirm <home>=<created> [--confirm ...] [--members <file>] [--desktop-plan <file>]",
        );
        return 2;
    }
  } catch (cause) {
    io.err(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

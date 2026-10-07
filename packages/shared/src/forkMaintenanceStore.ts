/* oxlint-disable t3code/no-global-process-runtime -- node-only filesystem coordinator: the host platform is the point */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off — the host coordinator is a cross-process filesystem protocol.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { ForkActivityBlocker } from "@t3tools/contracts/maintenance";
import {
  CURRENT_ACTIVITY_PROTOCOL,
  participantBlockers,
  type MaintenanceParticipant,
} from "./forkMaintenanceAdmission.ts";
import { restrictWindowsAcl } from "./forkMaintenanceSnapshot.ts";
import { decodeJournal, MaintenanceJournal, RELEASABLE_PHASES } from "./forkMaintenanceJournal.ts";

const Owner = Schema.Struct({ pid: Schema.Int, started: Schema.String });
type Owner = typeof Owner.Type;
const Participant = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["desktop", "service", "standalone", "development", "wsl"]),
  owner: Owner,
  homes: Schema.Array(Schema.String),
  updateTarget: Schema.Boolean,
  parentId: Schema.NullOr(Schema.String),
  observedAt: Schema.Number,
  idleSince: Schema.NullOr(Schema.Number),
  frozenFor: Schema.NullOr(Schema.String),
  trialFor: Schema.NullOr(Schema.String),
  descendants: Schema.Array(
    Schema.Struct({ pid: Schema.Int, started: Schema.String, label: Schema.String }),
  ),
  orphaned: Schema.Boolean,
  blockers: Schema.Array(ForkActivityBlocker),
  activityProtocol: Schema.optionalKey(Schema.Int),
});
const Fence = Schema.Struct({
  transactionId: Schema.String,
  // A WSL runtime's fence is held by its Windows parent over the control channel,
  // so it cannot be tied to a process this registry can inspect.
  holder: Schema.Union([Owner, Schema.Struct({ remote: Schema.String })]),
  since: Schema.Number,
  trials: Schema.Record(
    Schema.String,
    Schema.Struct({ nonceHash: Schema.String, consumed: Schema.Boolean }),
  ),
  /** A live external installer owns admission until binary replacement finishes. */
  handoffOwner: Schema.optionalKey(Owner),
  consumedHandoffs: Schema.optionalKey(Schema.Array(Schema.Literals(["install", "revert"]))),
});
const Registry = Schema.Struct({
  version: Schema.Literal(2),
  id: Schema.String,
  bootstrapped: Schema.Boolean,
  participants: Schema.Array(Participant),
  fence: Schema.NullOr(Fence),
});
type Registry = typeof Registry.Type;
type Fence = typeof Fence.Type;
const decodeRegistry = Schema.decodeUnknownSync(Registry);
const decodeOwner = Schema.decodeUnknownSync(Owner);
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const PROCESS_IDENTITY_TIMEOUT_MS = 10_000;
/** Startup may pay the cold Windows PowerShell launch cost; uncertainty still refuses registration. */
export const STARTUP_OWNER_IDENTITY_TIMEOUT_MS = 30_000;

export class UnsupportedPlatformError extends Error {
  override readonly name = "UnsupportedPlatformError";
}

const isCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

export type ProcessIdentity = (pid: number) => Promise<string | null>;
export type ProcessIdentityResult =
  | { readonly kind: "present"; readonly identity: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly cause: Error };
/** Stored identity marker for a process whose PID was visible but whose creation identity was unreadable. */
export const UNKNOWN_PROCESS_IDENTITY = "unknown-process-identity";
export const ORPHAN_ATTESTATION_CONFIRMATION = "I checked for unrecorded processes";
const ORPHANED_ACTIVITY_UNVERIFIED =
  "A previous runtime's process activity could not be verified; operator verification is required.";

/** OS creation identity prevents PID reuse from clearing a live registration. */
async function processCreationIdentityWithTimeout(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: typeof exec = exec,
  timeoutMs = PROCESS_IDENTITY_TIMEOUT_MS,
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process owner.");
  if (platform === "linux") {
    try {
      const [stat, boot] = await Promise.all([
        NodeFSP.readFile(`/proc/${pid}/stat`, "utf8"),
        NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = fields[19];
      if (ticks === undefined || !/^\d+$/.test(ticks))
        throw new Error("Unreadable process identity.");
      return `${boot.trim()}:${ticks}`;
    } catch (cause) {
      if (isCode(cause, "ENOENT")) return null;
      throw cause;
    }
  }
  if (platform === "darwin") {
    // `lstart` is the kernel's process start time; a reused PID has a different one.
    try {
      const { stdout } = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { LC_ALL: "C" },
      });
      const started = stdout.trim();
      return started.length === 0 ? null : started;
    } catch (cause) {
      // ps exits 1 when the process does not exist.
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === 1)
        return null;
      throw cause;
    }
  }
  if (platform === "win32") {
    const [result] = await processCreationIdentitiesWithTimeout([pid], platform, run, timeoutMs);
    if (result?.kind === "present") return result.identity;
    if (result?.kind === "absent") return null;
    throw result?.cause ?? new Error("Unreadable process identity.");
  }
  throw new UnsupportedPlatformError(
    `Process ownership verification is unsupported on ${platform}.`,
  );
}

export const processCreationIdentity = (
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: typeof exec = exec,
): Promise<string | null> =>
  processCreationIdentityWithTimeout(pid, platform, run, PROCESS_IDENTITY_TIMEOUT_MS);

/** Startup-only owner proof gets more time for a cold PowerShell launch; ordinary reads stay at 10s. */
export const processCreationIdentityForStartup = (
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: typeof exec = exec,
): Promise<string | null> =>
  processCreationIdentityWithTimeout(
    pid,
    platform,
    run,
    platform === "win32" ? STARTUP_OWNER_IDENTITY_TIMEOUT_MS : PROCESS_IDENTITY_TIMEOUT_MS,
  );

export const coordinatorOwnerIdentity = (
  pid: number,
  identity: ProcessIdentity = processCreationIdentity,
  platform: NodeJS.Platform = process.platform,
  run: typeof exec = exec,
): Promise<string | null> =>
  identity === processCreationIdentity && platform === "win32"
    ? processCreationIdentityForStartup(pid, platform, run)
    : identity(pid);

const describeWindowsProbeFailure = (cause: unknown, timeoutMs: number): Error => {
  const details =
    typeof cause === "object" && cause !== null
      ? (cause as {
          code?: unknown;
          killed?: unknown;
          signal?: unknown;
        })
      : {};
  if (details.killed === true || details.code === "ETIMEDOUT")
    return new Error(`Windows process identity probe timed out after ${timeoutMs} ms.`);
  if (details.code === "ENOENT")
    return new Error("Windows process identity probe could not start PowerShell (ENOENT).");
  if (typeof details.code === "number" && Number.isInteger(details.code))
    return new Error(`Windows process identity probe exited with code ${details.code}.`);
  if (typeof details.signal === "string" && /^[A-Z0-9]+$/.test(details.signal))
    return new Error(`Windows process identity probe ended with signal ${details.signal}.`);
  return new Error("Windows process identity probe failed without a classifiable OS status.");
};

/**
 * Reads many creation identities without starting one PowerShell process per PID.
 * Windows batches are bounded by both count and command length; each batch is
 * complete or reported unreadable, never silently truncated. The PowerShell
 * timeout is intentionally shorter than the coordinator's stale-heartbeat window.
 */
export const processCreationIdentities = (
  pids: ReadonlyArray<number>,
  platform: NodeJS.Platform = process.platform,
  run: typeof exec = exec,
): Promise<ReadonlyArray<ProcessIdentityResult>> =>
  processCreationIdentitiesWithTimeout(pids, platform, run, PROCESS_IDENTITY_TIMEOUT_MS);

async function processCreationIdentitiesWithTimeout(
  pids: ReadonlyArray<number>,
  platform: NodeJS.Platform = process.platform,
  run: typeof exec = exec,
  timeoutMs = PROCESS_IDENTITY_TIMEOUT_MS,
): Promise<ReadonlyArray<ProcessIdentityResult>> {
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
    throw new Error("Invalid process owner.");
  if (pids.length === 0) return [];
  if (platform !== "win32") {
    return Promise.all(
      pids.map(async (pid) => {
        try {
          const identity = await processCreationIdentity(pid, platform, run);
          return identity === null
            ? { kind: "absent" as const }
            : { kind: "present" as const, identity };
        } catch (cause) {
          return {
            kind: "unreadable" as const,
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          };
        }
      }),
    );
  }

  const output: ProcessIdentityResult[] = Array.from({ length: pids.length }, () => ({
    kind: "unreadable",
    cause: new Error("Windows process identity response was incomplete."),
  }));
  // Numeric-only literals make the command injection-safe. Keep ample space
  // below Windows' command-line limit after executable and wrapper arguments.
  const batches: Array<{ start: number; ids: number[] }> = [];
  let start = 0;
  let ids: number[] = [];
  let chars = 0;
  for (let index = 0; index < pids.length; index++) {
    const pid = pids[index]!;
    const size = String(pid).length + 2;
    if (ids.length > 0 && (ids.length >= 256 || chars + size > 8_000)) {
      batches.push({ start, ids });
      start = index;
      ids = [];
      chars = 0;
    }
    ids.push(pid);
    chars += size;
  }
  batches.push({ start, ids });

  const readBatch = async (batch: (typeof batches)[number]) => {
    const command = [
      "$ErrorActionPreference='Stop';",
      `$ids=@(${batch.ids.join(",")});`,
      "foreach($id in $ids){",
      // Direct .NET APIs avoid first-use cmdlet discovery in a private USERPROFILE. Only
      // GetProcessById's verified not-found error means absent; denied StartTime stays unknown.
      "$p=$null;",
      "try{",
      "try{$p=[Diagnostics.Process]::GetProcessById($id)}catch{$cause=$_.Exception.GetBaseException();if($cause -is [ArgumentException]){[Console]::WriteLine($id.ToString()+[char]9+'A')}else{[Console]::WriteLine($id.ToString()+[char]9+'U')};continue}",
      "try{$ticks=$p.StartTime.ToUniversalTime().Ticks;[Console]::WriteLine($id.ToString()+[char]9+'P'+[char]9+$ticks.ToString())}catch{[Console]::WriteLine($id.ToString()+[char]9+'U')}",
      "}finally{if($null -ne $p){$p.Dispose()}}",
      "}",
    ].join("");
    try {
      const { stdout } = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const byPid = new Map<number, ProcessIdentityResult>();
      for (const line of stdout.split(/\r?\n/)) {
        if (line.length === 0) continue;
        const fields = line.split("\t");
        const pid = Number(fields[0]);
        if (!batch.ids.includes(pid) || byPid.has(pid)) continue;
        if (fields[1] === "P" && fields.length === 3 && /^\d+$/.test(fields[2]!))
          byPid.set(pid, { kind: "present", identity: fields[2]! });
        else if (fields[1] === "A" && fields.length === 2) byPid.set(pid, { kind: "absent" });
        else
          byPid.set(pid, {
            kind: "unreadable",
            cause: new Error(`Cannot read process identity for PID ${pid}.`),
          });
      }
      for (let offset = 0; offset < batch.ids.length; offset++) {
        output[batch.start + offset] = byPid.get(batch.ids[offset]!) ?? {
          kind: "unreadable",
          cause: new Error("Windows process identity response omitted a PID."),
        };
      }
    } catch (cause) {
      const error = describeWindowsProbeFailure(cause, timeoutMs);
      for (let offset = 0; offset < batch.ids.length; offset++)
        output[batch.start + offset] = { kind: "unreadable", cause: error };
    }
  };
  // A bounded worker pool avoids making large process trees wait for one
  // PowerShell startup per batch without flooding the host with subprocesses.
  let nextBatch = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, batches.length) }, async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++]!;
        await readBatch(batch);
      }
    }),
  );
  return output;
}

export function coordinatorDirectory(namespace = process.env.T3CODE_MAINTENANCE_NAMESPACE): string {
  if (namespace !== undefined && namespace.trim().length === 0)
    throw new Error("Empty coordinator namespace.");
  return namespace === undefined
    ? NodePath.join(NodeOS.homedir(), ".local", "state", "t3-fork-maintenance")
    : NodePath.resolve(namespace);
}

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const safeName = (value: string) => {
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value.startsWith("."))
    throw new Error("Invalid identifier.");
  return value;
};

export type ReceiptSlot = "trial" | "restored";

/** The registry operations the update controller depends on. */
export type CoordinatorStorePort = Pick<
  CoordinatorStore,
  "status" | "freeze" | "recheck" | "writeJournal" | "readJournal" | "listJournals" | "releaseFence"
>;

export interface TrialCapability {
  readonly transactionId: string;
  readonly home: string;
  readonly nonce: string;
}

export interface CoordinatorStatus {
  readonly coordinatorId: string;
  readonly bootstrapped: boolean;
  readonly blockers: ReadonlyArray<typeof ForkActivityBlocker.Type>;
  readonly participants: ReadonlyArray<MaintenanceParticipant>;
  readonly fence: {
    readonly transactionId: string;
    readonly holderAlive: boolean | null;
    readonly since: number;
  } | null;
}

/**
 * Filesystem adapter. A short lock serializes registry, fence and work admission.
 * The lock is never stolen on a timeout: an unreadable or live owner blocks, and
 * an exited owner requires explicit repair, because pathname removal races.
 */
export class CoordinatorStore {
  readonly directory: string;
  readonly owner: Owner;
  private readonly identity: ProcessIdentity;
  private constructor(directory: string, owner: Owner, identity: ProcessIdentity) {
    this.directory = directory;
    this.owner = owner;
    this.identity = identity;
  }
  static async open(
    directory = coordinatorDirectory(),
    identity: ProcessIdentity = processCreationIdentity,
    selfPid: number = process.pid,
  ): Promise<CoordinatorStore> {
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") await restrictWindowsAcl(directory);
    const stat = await NodeFSP.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Coordinator directory must be a real private directory.");
    if (
      process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    ) {
      throw new Error("Coordinator directory must be owned by this user with mode 0700.");
    }
    await NodeFSP.mkdir(NodePath.join(directory, "journals"), { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(NodePath.join(directory, "receipts"), { recursive: true, mode: 0o700 });
    // Only initial proof of our own process gets the cold-start allowance.
    // All lock owners and later activity scans continue through the 10s default.
    const started = await coordinatorOwnerIdentity(selfPid, identity);
    if (started === null) throw new Error("Cannot verify coordinator owner.");
    return new CoordinatorStore(directory, { pid: selfPid, started }, identity);
  }

  /** Reads another process's lock record. An instance member so tests can interleave a release at exactly this point. */
  protected readLockFile(file: string): Promise<string> {
    return NodeFSP.readFile(file, "utf8");
  }
  private async alive(owner: Owner): Promise<boolean> {
    return (await this.identity(owner.pid)) === owner.started;
  }
  private async identities(
    pids: ReadonlyArray<number>,
  ): Promise<ReadonlyMap<number, ProcessIdentityResult>> {
    const results = new Map<number, ProcessIdentityResult>();
    if (this.identity === processCreationIdentity) {
      const batch = await processCreationIdentities(pids);
      pids.forEach((pid, index) => results.set(pid, batch[index]!));
      return results;
    }
    for (const pid of pids) {
      try {
        const identity = await this.identity(pid);
        results.set(pid, identity === null ? { kind: "absent" } : { kind: "present", identity });
      } catch (cause) {
        results.set(pid, {
          kind: "unreadable",
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    }
    return results;
  }
  private owns(owner: Owner) {
    return owner.pid === this.owner.pid && owner.started === this.owner.started;
  }
  private async atomicWrite(file: string, value: unknown): Promise<void> {
    const temporary = NodePath.join(NodePath.dirname(file), `.${NodeCrypto.randomUUID()}.tmp`);
    const handle = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, file);
    if (process.platform !== "win32") {
      const directory = await NodeFSP.open(NodePath.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  private async locked<A>(run: (registry: Registry) => Promise<A>, attempt = 0): Promise<A> {
    const lockPath = NodePath.join(this.directory, "registry.lock");
    const candidate = NodePath.join(this.directory, `.lock-${NodeCrypto.randomUUID()}`);
    const handle = await NodeFSP.open(candidate, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.owner));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Publish an already complete owner record. An O_EXCL open followed by a
    // write exposes an empty lock to racing readers.
    try {
      await NodeFSP.link(candidate, lockPath);
    } catch (cause) {
      await NodeFSP.unlink(candidate);
      if (!isCode(cause, "EEXIST")) throw cause;
      let text: string;
      try {
        text = await this.readLockFile(lockPath);
      } catch (readCause) {
        // Windows can report EPERM/EACCES while an unlinked file is pending deletion. Retry only
        // the read race, bounded like live-owner contention; persistent permission failures still
        // block, and no unreadable lock is ever stolen or treated as proof of an idle device.
        if (
          ["ENOENT", "EPERM", "EACCES"].some((code) => isCode(readCause, code)) &&
          attempt < 100
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return this.locked(run, attempt + 1);
        }
        throw readCause;
      }
      // Lock files are published whole (hard-linked from a complete candidate), so content that does not decode is
      // damage, not a write in flight, and keeps blocking rather than being retried or stolen.
      const owner = decodeOwner(JSON.parse(text));
      if (await this.alive(owner)) {
        if (attempt >= 100) throw new Error("Coordinator is busy.", { cause });
        await new Promise((resolve) => setTimeout(resolve, 10));
        return this.locked(run, attempt + 1);
      }
      throw new Error("Exited coordinator lock requires offline repair.", { cause });
    }
    await NodeFSP.unlink(candidate);
    try {
      let registry: Registry;
      try {
        registry = decodeRegistry(
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(this.directory, "registry.json"), "utf8"),
          ),
        );
      } catch (cause) {
        if (!isCode(cause, "ENOENT")) throw cause;
        registry = {
          version: 2,
          id: NodeCrypto.randomUUID(),
          bootstrapped: false,
          participants: [],
          fence: null,
        };
        await this.save(registry);
      }
      return await run(registry);
    } finally {
      await NodeFSP.unlink(lockPath);
    }
  }
  private save(registry: Registry) {
    return this.atomicWrite(NodePath.join(this.directory, "registry.json"), registry);
  }

  /** Removes a lock whose owner is proven exited. Offline operator action; never automatic. */
  async repairExitedLock(): Promise<boolean> {
    const lockPath = NodePath.join(this.directory, "registry.lock");
    let owner: Owner;
    try {
      owner = decodeOwner(JSON.parse(await NodeFSP.readFile(lockPath, "utf8")));
    } catch (cause) {
      if (isCode(cause, "ENOENT")) return false;
      throw cause;
    }
    if (await this.alive(owner)) throw new Error("The coordinator lock owner is still running.");
    await NodeFSP.unlink(lockPath);
    return true;
  }

  private async leases(): Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly participantId: string;
      readonly owner: Owner;
      readonly passive: boolean;
    }>
  > {
    const result: Array<{
      name: string;
      participantId: string;
      owner: Owner;
      passive: boolean;
    }> = [];
    for (const name of await NodeFSP.readdir(this.directory)) {
      // Keep the work-* filename understood by older coordinators; only new readers interpret
      // the additive passive marker as non-agent activity.
      const match = /^work-(.+)-[0-9a-f-]{36}$/.exec(name);
      if (match === null) continue;
      let owner: Owner;
      let passive = false;
      try {
        const raw: unknown = JSON.parse(
          await NodeFSP.readFile(NodePath.join(this.directory, name), "utf8"),
        );
        owner = decodeOwner(raw);
        passive =
          typeof raw === "object" && raw !== null && "passive" in raw && raw.passive === true;
      } catch (cause) {
        // Unreadable lease: treat as a live local operation rather than guessing it ended.
        if (isCode(cause, "ENOENT")) continue;
        result.push({
          name,
          participantId: match[1]!,
          owner: { pid: 0, started: "" },
          passive: false,
        });
        continue;
      }
      result.push({ name, participantId: match[1]!, owner, passive });
    }
    return result;
  }
  /** Leases owned by exited processes can never complete; clearing them keeps a crash from blocking updates forever. */
  private async liveLeases() {
    const live = [];
    const leases = await this.leases();
    const identities = await this.identities(
      leases.filter((lease) => lease.owner.pid > 0).map((lease) => lease.owner.pid),
    );
    for (const lease of leases) {
      const identity = identities.get(lease.owner.pid);
      if (
        lease.owner.pid > 0 &&
        (identity?.kind === "absent" ||
          (identity?.kind === "present" && identity.identity !== lease.owner.started))
      ) {
        await NodeFSP.unlink(NodePath.join(this.directory, lease.name)).catch((cause: unknown) => {
          if (!isCode(cause, "ENOENT")) throw cause;
        });
        continue;
      }
      live.push(lease);
    }
    return live;
  }

  /**
   * Participants whose owner exited are dropped, unless processes they started still run: those keep a
   * blocking tombstone until verified gone. A terminal, provider or background command that outlives its
   * parent is still activity; clearing only the parent's registration would call the device idle.
   */
  private async reconcile(
    registry: Registry,
  ): Promise<{ readonly kept: ReadonlyArray<MaintenanceParticipant>; readonly changed: boolean }> {
    const kept: MaintenanceParticipant[] = [];
    let changed = false;
    const ownerIdentities = await this.identities(
      registry.participants.map((participant) => participant.owner.pid),
    );
    const deadParticipants = registry.participants.filter((participant) => {
      const identity = ownerIdentities.get(participant.owner.pid);
      return (
        identity?.kind === "absent" ||
        (identity?.kind === "present" && identity.identity !== participant.owner.started)
      );
    });
    const childIdentities = await this.identities(
      deadParticipants.flatMap((participant) =>
        participant.descendants.map((descendant) => descendant.pid),
      ),
    );
    for (const participant of registry.participants) {
      const ownerIdentity = ownerIdentities.get(participant.owner.pid);
      if (ownerIdentity === undefined || ownerIdentity.kind === "unreadable") {
        const blocker = {
          participantId: participant.id,
          reason: "unknown-participant" as const,
          label: `${participant.label} process identity could not be verified.`,
        };
        const blockers = participant.blockers.some(
          (entry) => entry.reason === blocker.reason && entry.label === blocker.label,
        )
          ? participant.blockers
          : [...participant.blockers, blocker];
        kept.push({ ...participant, blockers, idleSince: null, frozenFor: null });
        if (
          blockers !== participant.blockers ||
          participant.idleSince !== null ||
          participant.frozenFor !== null
        )
          changed = true;
        continue;
      }
      if (
        ownerIdentity.kind === "present" &&
        ownerIdentity.identity === participant.owner.started
      ) {
        kept.push(participant);
        continue;
      }
      const survivors: MaintenanceParticipant["descendants"][number][] = [];
      for (const descendant of participant.descendants) {
        const current = childIdentities.get(descendant.pid);
        if (current?.kind === "unreadable") survivors.push(descendant);
        else if (current?.kind === "present") {
          if (descendant.started === UNKNOWN_PROCESS_IDENTITY)
            survivors.push({ ...descendant, started: current.identity });
          else if (current.identity === descendant.started) survivors.push(descendant);
        }
      }
      if (survivors.length === 0) {
        const unknownActivity = participant.blockers.filter(
          (blocker) => blocker.reason === "unknown-participant",
        );
        if (unknownActivity.length > 0) {
          kept.push({
            ...participant,
            orphaned: true,
            descendants: [],
            blockers: unknownActivity,
          });
          if (!participant.orphaned || participant.descendants.length > 0) changed = true;
          continue;
        }
        changed = true;
        continue;
      }
      const uncertainty = participant.blockers.filter(
        (blocker) => blocker.reason === "unknown-participant",
      );
      if (
        !participant.orphaned ||
        survivors.length !== participant.descendants.length ||
        uncertainty.length !== participant.blockers.length
      )
        changed = true;
      kept.push({
        ...participant,
        orphaned: true,
        descendants: survivors,
        blockers: uncertainty,
      });
    }
    return { kept, changed };
  }

  /**
   * Registers a runtime. While a transaction holds the fence this is atomic with that fence: an ordinary
   * runtime is rejected, a trial runtime must present its one-use capability (validated and consumed
   * in this same critical section), and a service runtime may adopt a fence whose local owner exited.
   * Checking the fence before calling register would race a transaction that freezes in between.
   */
  async register(
    input: Pick<MaintenanceParticipant, "id" | "label" | "kind" | "homes" | "updateTarget"> & {
      readonly parentId?: string | null;
    },
    now: number,
    options: { readonly trial?: TrialCapability; readonly adoptAbandonedFence?: boolean } = {},
  ): Promise<string> {
    safeName(input.id);
    if (input.homes.length === 0)
      throw new Error("A participant must name at least one data home.");
    return this.locked(async (registry) => {
      const parentId = input.parentId ?? null;
      if (parentId !== null) {
        const parent = registry.participants.find((entry) => entry.id === parentId);
        if (parent === undefined || !this.owns(parent.owner))
          throw new Error("A control-channel child needs a parent owned by this process.");
        if (input.kind !== "wsl")
          throw new Error("Only WSL runtimes use a parent control channel.");
      } else if (input.kind === "wsl") {
        throw new Error("WSL runtimes require an explicit parent control channel.");
      }
      const homes = await Promise.all(
        input.homes.map((home) =>
          parentId === null ? NodeFSP.realpath(home) : Promise.resolve(home),
        ),
      );
      const existing = registry.participants.find((participant) => participant.id === input.id);
      if (
        existing !== undefined &&
        !this.owns(existing.owner) &&
        (await this.alive(existing.owner))
      ) {
        throw new Error("Participant belongs to another live process.");
      }
      let trialFor: string | null = null;
      let fence = registry.fence;
      if (fence !== null) {
        if (fence.handoffOwner !== undefined && (await this.alive(fence.handoffOwner)))
          throw new Error("The external installer is still replacing this device's application.");
        if (options.trial !== undefined) {
          const trial = fence.trials[options.trial.home];
          if (fence.transactionId !== options.trial.transactionId || trial === undefined)
            throw new Error("Trial capability is not valid for the current transaction.");
          if (trial.consumed || trial.nonceHash !== sha256(options.trial.nonce))
            throw new Error("Trial capability was already used or does not match.");
          if (!homes.includes(options.trial.home))
            throw new Error("Trial capability does not match this runtime's home.");
          fence = {
            ...fence,
            trials: { ...fence.trials, [options.trial.home]: { ...trial, consumed: true } },
          };
          trialFor = fence.transactionId;
        } else if (options.adoptAbandonedFence === true) {
          if (input.kind !== "service")
            throw new Error("Only a service runtime may adopt an abandoned transaction.");
          if (!("pid" in fence.holder) || (await this.alive(fence.holder)))
            throw new Error("The transaction owner is still running or is not local.");
          trialFor = fence.transactionId;
        } else {
          throw new Error(
            "Device maintenance holds new work. Try again after verification or recovery.",
          );
        }
      } else if (options.trial !== undefined) {
        throw new Error("Trial capability is not valid for the current transaction.");
      }
      // The same data home cannot be owned by two live participants of different cohorts.
      for (const other of registry.participants) {
        if (other.id === input.id || other.parentId === input.id || input.parentId === other.id)
          continue;
        if (other.homes.some((home) => homes.includes(home)) && (await this.alive(other.owner))) {
          throw new Error("Another live runtime already owns this data home.");
        }
      }
      // Registering again as the same live owner, for the same homes and no fence, only refreshes the record. Observed activity
      // (the idle window, last observation, blockers, descendants) belongs to what was observed, not to the registration, so a
      // caller that re-registers on every pass (the Windows parent of a WSL member) must not restart a five-minute idle window.
      const sameRegistration =
        existing !== undefined &&
        this.owns(existing.owner) &&
        !existing.orphaned &&
        fence === null &&
        JSON.stringify(existing.homes) === JSON.stringify(homes) &&
        existing.parentId === parentId;
      const participant: MaintenanceParticipant = {
        id: input.id,
        label: input.label,
        kind: input.kind,
        updateTarget: input.updateTarget,
        parentId,
        homes,
        owner: this.owner,
        observedAt: sameRegistration ? existing.observedAt : now,
        idleSince: sameRegistration ? existing.idleSince : null,
        frozenFor: sameRegistration ? existing.frozenFor : null,
        trialFor,
        descendants:
          sameRegistration ||
          (existing !== undefined && JSON.stringify(existing.homes) === JSON.stringify(homes))
            ? existing.descendants
            : [],
        orphaned: false,
        blockers: sameRegistration
          ? existing.blockers
          : [
              ...(existing?.orphaned === true
                ? existing.blockers
                    .filter((blocker) => blocker.reason === "unknown-participant")
                    .map((blocker) => ({
                      ...blocker,
                      label: ORPHANED_ACTIVITY_UNVERIFIED,
                    }))
                : []),
              {
                participantId: input.id,
                reason: "unknown-participant",
                label: "Activity has not been verified.",
              },
            ],
        activityProtocol: CURRENT_ACTIVITY_PROTOCOL,
      };
      await this.save({
        ...registry,
        fence,
        participants: [
          ...registry.participants.filter((entry) => entry.id !== input.id),
          participant,
        ],
      });
      return registry.id;
    });
  }
  async unregister(id: string): Promise<void> {
    await this.locked(async (registry) => {
      const participant = registry.participants.find((entry) => entry.id === id);
      if (participant === undefined || !this.owns(participant.owner)) return;
      await this.save({
        ...registry,
        participants: registry.participants.filter(
          (entry) => entry.id !== id && entry.parentId !== id,
        ),
      });
    });
  }
  /**
   * Offline operator resolution for an exact orphan record. The confirmation covers work which a
   * failed census could not record; no runtime, known child, or transaction may still be live.
   */
  async attestOrphanResolved(input: {
    readonly participantId: string;
    readonly owner: { readonly pid: number; readonly started: string };
    readonly confirmation: string;
  }): Promise<void> {
    if (input.confirmation !== ORPHAN_ATTESTATION_CONFIRMATION)
      throw new Error(`Type exactly: ${ORPHAN_ATTESTATION_CONFIRMATION}.`);
    const participantId = safeName(input.participantId);
    await this.locked(async (registry) => {
      if (!registry.bootstrapped)
        throw new Error("Confirm device bootstrap before resolving an orphan.");
      if (registry.fence !== null)
        throw new Error("A transaction fence is active; resolve its recovery first.");
      for (const name of await NodeFSP.readdir(NodePath.join(this.directory, "journals"))) {
        if (!name.endsWith(".json") || name.startsWith(".")) continue;
        const journal = decodeJournal(
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(this.directory, "journals", name), "utf8"),
          ),
        );
        if (!RELEASABLE_PHASES.has(journal.phase))
          throw new Error(`Transaction ${journal.id} still needs recovery.`);
      }
      const target = registry.participants.find((participant) => participant.id === participantId);
      if (
        target === undefined ||
        target.owner.pid !== input.owner.pid ||
        target.owner.started !== input.owner.started
      )
        throw new Error("The participant owner changed; read the orphan list and retry.");
      if (!target.orphaned)
        throw new Error("Only an exited orphan record can be resolved by operator attestation.");

      const ownerIdentities = await this.identities(
        registry.participants.map((participant) => participant.owner.pid),
      );
      for (const participant of registry.participants) {
        const identity = ownerIdentities.get(participant.owner.pid);
        if (identity?.kind === "unreadable" || identity === undefined)
          throw new Error(`Cannot verify whether ${participant.label} is still running.`);
        if (identity.kind === "present" && identity.identity === participant.owner.started)
          throw new Error(`${participant.label} is still running.`);
      }
      if ((await this.liveLeases()).length > 0)
        throw new Error(
          "A work lease is active or unreadable; resolve it before clearing an orphan.",
        );
      const childIdentities = await this.identities(
        target.descendants.map((descendant) => descendant.pid),
      );
      for (const descendant of target.descendants) {
        const result = childIdentities.get(descendant.pid);
        if (result?.kind === "unreadable" || result === undefined)
          throw new Error(`Cannot verify recorded child PID ${descendant.pid}.`);
        const current = result.kind === "present" ? result.identity : null;
        if (
          current !== null &&
          (descendant.started === UNKNOWN_PROCESS_IDENTITY || current === descendant.started)
        )
          throw new Error(`Recorded child PID ${descendant.pid} is still running.`);
      }

      await this.save({
        ...registry,
        participants: registry.participants.filter(
          (participant) => participant.id !== participantId,
        ),
      });
    });
  }
  /**
   * Records one observation. `alreadyIdleFor` is for a control-channel child whose activity comes from a registry that has itself
   * already enforced the idle window (its aggregate blockers were empty): the child is then idle for at least that long, not
   * starting a second window on top of the first.
   */
  async observe(
    id: string,
    blockers: ReadonlyArray<typeof ForkActivityBlocker.Type>,
    now: number,
    descendants: ReadonlyArray<MaintenanceParticipant["descendants"][number]> = [],
    options: { readonly alreadyIdleFor?: number; readonly descendantsKnown?: boolean } = {},
  ): Promise<void> {
    await this.locked(async (registry) => {
      const participant = registry.participants.find((entry) => entry.id === id);
      if (participant === undefined || !this.owns(participant.owner))
        throw new Error("Unregistered participant.");
      const hasWork = (await this.liveLeases()).some(
        (lease) => lease.participantId === id && !lease.passive,
      );
      const actual = hasWork
        ? [
            ...blockers,
            {
              participantId: id,
              reason: "background-work" as const,
              label: "A local operation is still running.",
            },
          ]
        : blockers;
      const unresolvedPriorActivity = participant.blockers.filter(
        (blocker) => blocker.label === ORPHANED_ACTIVITY_UNVERIFIED,
      );
      const observedBlockers = [...actual, ...unresolvedPriorActivity];
      const inheritedDescendants: MaintenanceParticipant["descendants"][number][] = [];
      const unreadablePriorDescendants: MaintenanceParticipant["descendants"][number][] = [];
      if (options.descendantsKnown !== false) {
        const priorIdentities = await this.identities(
          participant.descendants.map((entry) => entry.pid),
        );
        for (const descendant of participant.descendants) {
          const current = priorIdentities.get(descendant.pid);
          if (current?.kind === "unreadable" || current === undefined) {
            inheritedDescendants.push(descendant);
            unreadablePriorDescendants.push(descendant);
          } else if (current.kind === "present") {
            if (descendant.started === UNKNOWN_PROCESS_IDENTITY)
              inheritedDescendants.push({ ...descendant, started: current.identity });
            else if (current.identity === descendant.started) inheritedDescendants.push(descendant);
          }
        }
      }
      const unreportedInherited = inheritedDescendants.filter(
        (entry) =>
          !descendants.some(
            (candidate) => candidate.pid === entry.pid && candidate.started === entry.started,
          ),
      );
      if (unreportedInherited.length > 0)
        observedBlockers.push({
          participantId: id,
          reason: "commands",
          label: `${unreportedInherited.length} process(es) started by a previous runtime are still running.`,
        });
      if (unreadablePriorDescendants.length > 0)
        observedBlockers.push({
          participantId: id,
          reason: "unknown-participant",
          label: `Previously recorded process identity could not be verified for ${unreadablePriorDescendants.length} child process(es).`,
        });
      const next: MaintenanceParticipant = {
        ...participant,
        activityProtocol: CURRENT_ACTIVITY_PROTOCOL,
        observedAt: now,
        blockers: observedBlockers,
        descendants: (() => {
          const previous =
            options.descendantsKnown === false ? participant.descendants : inheritedDescendants;
          const byPid = new Map(previous.map((entry) => [entry.pid, entry]));
          for (const candidate of descendants) {
            const existing = byPid.get(candidate.pid);
            if (
              candidate.started === UNKNOWN_PROCESS_IDENTITY &&
              existing !== undefined &&
              existing.started !== UNKNOWN_PROCESS_IDENTITY
            )
              continue;
            byPid.set(candidate.pid, candidate);
          }
          return [...byPid.values()];
        })(),
        idleSince:
          observedBlockers.length === 0
            ? (participant.idleSince ?? now - (options.alreadyIdleFor ?? 0))
            : null,
        // The acknowledgement is only meaningful for a fence that existed when activity was observed idle.
        frozenFor: observedBlockers.length === 0 ? (registry.fence?.transactionId ?? null) : null,
      };
      await this.save({
        ...registry,
        participants: registry.participants.map((entry) => (entry.id === id ? next : entry)),
      });
    });
  }
  async beginWork(id: string): Promise<() => Promise<void>> {
    return this.beginLease(id, false);
  }
  /** A short diagnostic write blocks the fence while active but does not restart the agent idle window. */
  async beginPassiveWork(id: string): Promise<() => Promise<void>> {
    return this.beginLease(id, true);
  }
  private async beginLease(id: string, passive: boolean): Promise<() => Promise<void>> {
    const name = `work-${safeName(id)}-${NodeCrypto.randomUUID()}`;
    await this.locked(async (registry) => {
      if (registry.fence !== null)
        throw new Error(
          "Device maintenance holds new work. Try again after verification or recovery.",
        );
      const participant = registry.participants.find((entry) => entry.id === id);
      if (participant === undefined || !this.owns(participant.owner))
        throw new Error("Unregistered work owner.");
      await this.atomicWrite(
        NodePath.join(this.directory, name),
        passive ? { ...this.owner, passive: true } : this.owner,
      );
      await this.save({
        ...registry,
        participants: passive
          ? registry.participants
          : registry.participants.map((entry) =>
              entry.id === id ? { ...entry, idleSince: null } : entry,
            ),
      });
    });
    return async () => {
      await NodeFSP.unlink(NodePath.join(this.directory, name));
    };
  }
  /** Checks admission without holding a lease. Streams and long-lived subscriptions use this. */
  async assertAdmitting(id: string): Promise<void> {
    await this.locked(async (registry) => {
      if (registry.fence !== null)
        throw new Error(
          "Device maintenance holds new work. Try again after verification or recovery.",
        );
      const participant = registry.participants.find((entry) => entry.id === id);
      if (participant === undefined || !this.owns(participant.owner))
        throw new Error("Unregistered work owner.");
    });
  }
  async status(now: number): Promise<CoordinatorStatus> {
    return this.locked(async (registry) => {
      const { kept: living, changed } = await this.reconcile(registry);
      await this.liveLeases();
      if (changed) await this.save({ ...registry, participants: living });
      const fence =
        registry.fence === null
          ? null
          : {
              transactionId: registry.fence.transactionId,
              since: registry.fence.since,
              holderAlive:
                registry.fence.handoffOwner !== undefined &&
                (await this.alive(registry.fence.handoffOwner))
                  ? true
                  : "pid" in registry.fence.holder
                    ? await this.alive(registry.fence.holder)
                    : null,
            };
      return {
        coordinatorId: registry.id,
        bootstrapped: registry.bootstrapped,
        participants: living,
        fence,
        blockers: registry.bootstrapped
          ? participantBlockers(living, now)
          : [
              {
                participantId: "coordinator",
                reason: "bootstrap" as const,
                label: "Known fork installations must be registered before automatic installation.",
              },
            ],
      };
    });
  }
  /** Operator confirmation that every fork installation on this device is registered. */
  async confirmBootstrap(): Promise<void> {
    await this.locked(async (registry) => {
      if (registry.participants.length === 0) throw new Error("No runtime is registered.");
      await this.save({ ...registry, bootstrapped: true });
    });
  }

  /**
   * Acquires admission for one transaction. `remote` names a parent that holds
   * this registry's fence over an explicit control channel (a WSL runtime's
   * Windows parent) instead of a local process.
   */
  async freeze(
    transactionId: string,
    now: number,
    options: {
      readonly remote?: string;
      readonly forRecovery?: boolean;
      /** Required, persisted before the fence while holding the same coordinator lock. */
      readonly intent: MaintenanceJournal;
    },
  ): Promise<void> {
    safeName(transactionId);
    if (options === undefined || options.intent === undefined)
      throw new Error("A device fence requires its matching transaction journal.");
    await this.locked(async (registry) => {
      if (registry.fence !== null) throw new Error("Another device transaction is in progress.");
      const intent = options.intent;
      if (intent.id !== transactionId)
        throw new Error("A device fence requires its matching transaction journal.");
      const { kept: living } = await this.reconcile(registry);
      // A recovery fences a device whose affected runtimes are all stopped, so a registry with nobody in it is
      // not "unbootstrapped": there is simply nothing running to wait for. Anything registered still must be idle.
      const emptyForRecovery = options.forRecovery === true && living.length === 0;
      if (!registry.bootstrapped && !emptyForRecovery)
        throw new Error("Device bootstrap is incomplete.");
      const blockers = emptyForRecovery ? [] : participantBlockers(living, now);
      if (blockers.length > 0) throw new Error(blockers.map((entry) => entry.label).join(" "));
      if ((await this.liveLeases()).length > 0) throw new Error("Local operations are running.");
      // If this write lands but the registry save below does not, the journal is inert: no caller
      // may perform a side effect until freeze returns. A published fence therefore always has
      // a durable record from which startup can safely resume or abort.
      const existing = await this.readJournal(transactionId);
      if (existing === null) {
        if (intent.phase !== "fenced")
          throw new Error("A new device fence must begin with a fenced transaction journal.");
        await this.writeJournal(intent);
      } else if (JSON.stringify(existing) !== JSON.stringify(intent))
        throw new Error("A different transaction journal already exists for this device fence.");
      await this.save({
        ...registry,
        participants: living,
        fence: {
          transactionId,
          holder: options.remote === undefined ? this.owner : { remote: options.remote },
          since: now,
          trials: {},
        },
      });
    });
  }
  /** Rechecks every participant after the fence. Returns the participants that must be affected. */
  async recheck(
    transactionId: string,
    now: number,
  ): Promise<ReadonlyArray<MaintenanceParticipant>> {
    return this.locked(async (registry) => {
      if (registry.fence?.transactionId !== transactionId)
        throw new Error("Transaction does not own admission.");
      for (const participant of registry.participants) {
        if (!participant.orphaned && !(await this.alive(participant.owner)))
          throw new Error("Participant ownership changed after admission.");
      }
      if ((await this.liveLeases()).length > 0) throw new Error("Local operations are running.");
      const blockers = participantBlockers(registry.participants, now, transactionId);
      if (blockers.length > 0) throw new Error(blockers.map((entry) => entry.label).join(" "));
      return registry.participants;
    });
  }

  async writeJournal(journal: MaintenanceJournal): Promise<void> {
    safeName(journal.id);
    await this.atomicWrite(
      NodePath.join(this.directory, "journals", `${journal.id}.json`),
      journal,
    );
  }
  async readJournal(transactionId: string): Promise<MaintenanceJournal | null> {
    try {
      return decodeJournal(
        JSON.parse(
          await NodeFSP.readFile(
            NodePath.join(this.directory, "journals", `${safeName(transactionId)}.json`),
            "utf8",
          ),
        ),
      );
    } catch (cause) {
      if (isCode(cause, "ENOENT")) return null;
      throw cause;
    }
  }
  async listJournals(): Promise<ReadonlyArray<MaintenanceJournal>> {
    const result: MaintenanceJournal[] = [];
    for (const name of await NodeFSP.readdir(NodePath.join(this.directory, "journals"))) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      result.push(
        decodeJournal(
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(this.directory, "journals", name), "utf8"),
          ),
        ),
      );
    }
    return [...result].sort((left, right) => left.createdAt - right.createdAt);
  }
  /** The controller records its exact verified payloads before handing its transaction to an external helper. */
  async recordDesktopHandoffAuthorization(
    transactionId: string,
    input: {
      readonly mode: "install" | "revert";
      readonly buildArtifactSha256: string;
      readonly artifactSha256: string;
      readonly counterpartSha256: string | null;
    },
  ): Promise<void> {
    await this.locked(async (registry) => {
      const fence = registry.fence;
      if (
        fence?.transactionId !== transactionId ||
        !("pid" in fence.holder) ||
        (!this.owns(fence.holder) && (await this.alive(fence.holder)))
      )
        throw new Error(
          "This controller cannot authorize the device transaction's binary handoff.",
        );
      if (fence.consumedHandoffs?.includes(input.mode))
        throw new Error("This handoff was already consumed.");
      if (fence.handoffOwner !== undefined && (await this.alive(fence.handoffOwner)))
        throw new Error("The external installer is still running.");
      const journal = await this.readJournal(transactionId);
      const build = input.mode === "install" ? journal?.target : journal?.previous;
      if (
        journal === null ||
        (input.mode === "install" ? journal.phase !== "trial" : journal.phase !== "restored") ||
        build?.artifactSha256 !== input.buildArtifactSha256 ||
        !/^[a-f0-9]{64}$/.test(input.artifactSha256) ||
        (input.counterpartSha256 !== null && !/^[a-f0-9]{64}$/.test(input.counterpartSha256))
      )
        throw new Error(
          "The handoff authorization does not match the transaction's recorded build.",
        );
      await this.writeJournal({
        ...journal,
        desktopHandoffs: {
          ...journal.desktopHandoffs,
          [input.mode]: {
            owner: this.owner,
            artifactSha256: input.artifactSha256,
            counterpartSha256: input.counterpartSha256,
          },
        },
      });
    });
  }

  /** One-use external binary replacement; a retained/recreated plan cannot bypass admission. */
  async claimDesktopHandoff(
    transactionId: string,
    mode: "install" | "revert",
    artifactSha256: string,
    owner: Owner,
    counterpartSha256: string | null,
  ): Promise<void> {
    await this.locked(async (registry) => {
      const fence = registry.fence;
      if (fence === null || fence.transactionId !== transactionId)
        throw new Error("The handoff does not own an active device transaction.");
      if (!("pid" in fence.holder) || (await this.alive(fence.holder)))
        throw new Error("The transaction owner must have exited before binary replacement.");
      if (fence.handoffOwner !== undefined && (await this.alive(fence.handoffOwner)))
        throw new Error("Another external installer is still running.");
      if (fence.consumedHandoffs?.includes(mode))
        throw new Error("This handoff was already consumed.");
      const journal = await this.readJournal(transactionId);
      if (
        journal === null ||
        journal.id !== transactionId ||
        (mode === "install"
          ? journal.phase !== "trial" || journal.target?.artifactSha256 !== artifactSha256
          : journal.phase !== "restored")
      )
        throw new Error("The handoff no longer matches its transaction phase or target build.");
      const authorization = journal.desktopHandoffs?.[mode];
      if (
        authorization === undefined ||
        authorization.owner.pid !== owner.pid ||
        authorization.owner.started !== owner.started ||
        authorization.artifactSha256 !== artifactSha256 ||
        authorization.counterpartSha256 !== counterpartSha256 ||
        (await this.alive(owner))
      )
        throw new Error(
          "The handoff owner or payloads do not match the journal's recorded authorization.",
        );
      await this.save({
        ...registry,
        fence: {
          ...fence,
          handoffOwner: this.owner,
          consumedHandoffs: [...(fence.consumedHandoffs ?? []), mode],
        },
      });
    });
  }

  /** Binary replacement is over; the ordinary startup path still must verify before admission. */
  async finishDesktopHandoff(transactionId: string): Promise<void> {
    await this.locked(async (registry) => {
      if (
        registry.fence?.transactionId !== transactionId ||
        registry.fence.handoffOwner === undefined ||
        !this.owns(registry.fence.handoffOwner)
      )
        throw new Error("This helper does not own binary replacement.");
      const { handoffOwner: _finished, ...fence } = registry.fence;
      await this.save({ ...registry, fence });
    });
  }

  /**
   * Admission is released only against a durable terminal journal. The store
   * enforces this so no adapter can resume external writes ahead of the commit.
   */
  async releaseFence(transactionId: string): Promise<void> {
    await this.locked(async (registry) => {
      if (registry.fence?.transactionId !== transactionId)
        throw new Error("Transaction does not own admission.");
      if (
        registry.fence.handoffOwner !== undefined &&
        (await this.alive(registry.fence.handoffOwner))
      )
        throw new Error("The external installer is still replacing this device's application.");
      const journal = await this.readJournal(transactionId);
      if (journal === null || !RELEASABLE_PHASES.has(journal.phase))
        throw new Error("The transaction journal is not at a durable releasable boundary.");
      // An aborted transaction changed nothing, so the stopped window it earned stands. Anything
      // that reached the trial restarts it: the runtimes are not the ones that were observed.
      const keepIdle = journal.phase === "aborted";
      await this.save({
        ...registry,
        fence: null,
        participants: registry.participants.map((entry) => ({
          ...entry,
          frozenFor: null,
          trialFor: null,
          idleSince: keepIdle ? entry.idleSince : null,
        })),
      });
    });
  }

  /** One-use launch capability for a trial runtime of one exact home and transaction. */
  async issueTrial(transactionId: string, home: string): Promise<TrialCapability> {
    const nonce = NodeCrypto.randomBytes(32).toString("hex");
    await this.locked(async (registry) => {
      if (registry.fence?.transactionId !== transactionId)
        throw new Error("Transaction does not own admission.");
      await this.save({
        ...registry,
        fence: {
          ...registry.fence,
          trials: {
            ...registry.fence.trials,
            [home]: { nonceHash: sha256(nonce), consumed: false },
          },
        },
      });
    });
    return { transactionId, home, nonce };
  }
  /** A trial runtime's health receipt: only a participant that consumed that home's capability may write it. */
  async writeReceipt(
    transactionId: string,
    participantId: string,
    home: string,
    receipt: string,
    slot: ReceiptSlot = "trial",
  ): Promise<void> {
    await this.locked(async (registry) => {
      const participant = registry.participants.find((entry) => entry.id === participantId);
      if (
        participant === undefined ||
        !this.owns(participant.owner) ||
        participant.trialFor !== transactionId ||
        !participant.homes.includes(home)
      ) {
        throw new Error(
          "Only the transaction's trial runtime may record a health receipt for its home.",
        );
      }
      await this.atomicWrite(
        NodePath.join(
          this.directory,
          "receipts",
          `${safeName(transactionId)}-${slot}-${sha256(home)}.json`,
        ),
        { home, receipt },
      );
    });
  }
  async readReceipt(
    transactionId: string,
    home: string,
    slot: ReceiptSlot = "trial",
  ): Promise<string | null> {
    try {
      const value = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(
            this.directory,
            "receipts",
            `${safeName(transactionId)}-${slot}-${sha256(home)}.json`,
          ),
          "utf8",
        ),
      ) as { home?: unknown; receipt?: unknown };
      return value.home === home && typeof value.receipt === "string" && value.receipt.length > 0
        ? value.receipt
        : null;
    } catch (cause) {
      if (isCode(cause, "ENOENT")) return null;
      throw cause;
    }
  }
  /**
   * Takes over a fence whose local holder exited, so the recovery helper can finish or reverse that
   * very transaction. Refuses while the holder lives, or for a remote (control-channel) holder.
   */
  async takeOverAbandonedFence(transactionId: string): Promise<void> {
    await this.locked(async (registry) => {
      const fence = registry.fence;
      if (fence === null || fence.transactionId !== transactionId)
        throw new Error("There is no such device transaction to take over.");
      if (fence.handoffOwner !== undefined && (await this.alive(fence.handoffOwner)))
        throw new Error("The external installer is still running.");
      if (!("pid" in fence.holder))
        throw new Error(
          "The transaction is held over a control channel by its parent and must be resolved there.",
        );
      if (!this.owns(fence.holder) && (await this.alive(fence.holder)))
        throw new Error("The transaction owner is still running.");
      await this.save({ ...registry, fence: { ...fence, holder: this.owner } });
    });
  }
  async fenceSnapshot(): Promise<Fence | null> {
    return this.locked(async (registry) => registry.fence);
  }
}

// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This is the durable OS launch boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  prepareOrganizationScopedSandbox,
  stopAndVerifyOrganizationScopedSandbox,
  type PreparedOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";
import type { OrganizationSandboxInput } from "./OrganizationSandboxHost.ts";
import type { OrganizationWorkScopeIdentity } from "./OrganizationWorkScopeStore.ts";

const UNIT = /^t3-org-sandbox-[a-f0-9]{32}\.scope$/;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 4_096;
type Phase =
  | "reserved"
  | "never-dispatched"
  | "dispatching"
  | "prepared"
  | "start-intent"
  | "started"
  | "stopped";

export interface OrganizationScopeLaunchOperation {
  readonly operationId: string;
  readonly unitName: string;
  readonly phase: Phase;
  readonly identity: OrganizationWorkScopeIdentity | null;
}

type Event = {
  readonly operationId: string;
  readonly unitName: string;
  readonly phase: Phase;
  readonly identity: OrganizationWorkScopeIdentity | null;
};
type Line = { readonly previous: string; readonly event: Event; readonly checksum: string };

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const validOperationId = (value: string): boolean =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(value);

function validIdentity(value: OrganizationWorkScopeIdentity | null, unitName: string): boolean {
  return (
    value !== null &&
    value.unitName === unitName &&
    /^[a-f0-9]{32}$/.test(value.invocationId) &&
    value.controlGroup.endsWith(`/${unitName}`) &&
    Number.isSafeInteger(value.sandboxPid) &&
    value.sandboxPid > 0 &&
    Number.isSafeInteger(value.pidNamespace) &&
    value.pidNamespace > 0
  );
}

function advance(previous: OrganizationScopeLaunchOperation | undefined, event: Event): void {
  if (!validOperationId(event.operationId) || !UNIT.test(event.unitName))
    throw new Error("Organization launch journal contains an invalid operation or unit");
  if (!previous) {
    if (event.phase !== "reserved" || event.identity !== null)
      throw new Error("Organization launch journal begins outside reservation");
    return;
  }
  if (previous.operationId !== event.operationId || previous.unitName !== event.unitName)
    throw new Error("Organization launch journal operation identity changed");
  const allowed: Record<Phase, readonly Phase[]> = {
    reserved: ["dispatching", "never-dispatched"],
    "never-dispatched": [],
    dispatching: ["prepared"],
    prepared: ["start-intent", "stopped"],
    "start-intent": ["started", "stopped"],
    started: ["stopped"],
    stopped: [],
  };
  if (!allowed[previous.phase].includes(event.phase))
    throw new Error("Organization launch journal phase is invalid or replayed");
  if (
    event.phase === "reserved" ||
    event.phase === "never-dispatched" ||
    event.phase === "dispatching"
      ? event.identity !== null
      : !validIdentity(event.identity, event.unitName)
  )
    throw new Error("Organization launch journal scope identity is invalid");
  if (previous.identity && JSON.stringify(previous.identity) !== JSON.stringify(event.identity))
    throw new Error("Organization launch journal scope identity changed");
}

/** The launcher must place this beside runtime state, outside its SQLite backup. */
export const organizationScopeLaunchJournalPath = (baseDir: string): string =>
  NodePath.join(baseDir, "runtime", "organization-launch", "scope-launch.jsonl");

/** Append-only, fsynced launch history. Only one protected launch supervisor may open
 * this writer. A truncated or contradictory history refuses dispatch instead of
 * guessing that an uncertain systemd request is safe to retry or release.
 */
export class OrganizationScopeLaunchJournal {
  readonly #handle: NodeFSP.FileHandle;
  readonly #operations: Map<string, OrganizationScopeLaunchOperation>;
  readonly #units: Set<string>;
  #checksum: string;
  #queued: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    handle: NodeFSP.FileHandle,
    operations: Map<string, OrganizationScopeLaunchOperation>,
    units: Set<string>,
    checksum: string,
  ) {
    this.#handle = handle;
    this.#operations = operations;
    this.#units = units;
    this.#checksum = checksum;
  }

  static async open(filePath: string): Promise<OrganizationScopeLaunchJournal> {
    const directory = NodePath.dirname(filePath);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await NodeFSP.stat(directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)
      throw new Error("Organization launch journal directory is not private");
    const flags =
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_RDWR |
      NodeFS.constants.O_APPEND |
      NodeFS.constants.O_NOFOLLOW;
    const handle = await NodeFSP.open(filePath, flags, 0o600);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_JOURNAL_BYTES
      )
        throw new Error("Organization launch journal file is unsafe");
      const raw = await handle.readFile("utf8");
      if (raw && !raw.endsWith("\n"))
        throw new Error("Organization launch journal has a partial final record");
      const operations = new Map<string, OrganizationScopeLaunchOperation>();
      const units = new Set<string>();
      let previous = "0".repeat(64);
      for (const text of raw ? raw.slice(0, -1).split("\n") : []) {
        if (!text || Buffer.byteLength(text) > MAX_RECORD_BYTES)
          throw new Error("Organization launch journal record is invalid");
        let line: Line;
        try {
          line = JSON.parse(text) as Line;
        } catch {
          throw new Error("Organization launch journal record is invalid JSON");
        }
        if (
          !line ||
          line.previous !== previous ||
          line.checksum !== sha256(`${line.previous}:${JSON.stringify(line.event)}`)
        )
          throw new Error("Organization launch journal checksum chain is invalid");
        const event = line.event;
        advance(operations.get(event.operationId), event);
        if (!operations.has(event.operationId) && units.has(event.unitName))
          throw new Error("Organization launch journal unit was reused");
        operations.set(event.operationId, event);
        units.add(event.unitName);
        previous = line.checksum;
      }
      // A newly created directory entry must also survive a power failure.
      await handle.sync();
      const directoryHandle = await NodeFSP.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return new OrganizationScopeLaunchJournal(handle, operations, units, previous);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  list(): readonly OrganizationScopeLaunchOperation[] {
    return [...this.#operations.values()].map((entry) => ({
      ...entry,
      identity: entry.identity && { ...entry.identity },
    }));
  }

  async #append(event: Event, ifAlreadyStopped = false): Promise<void> {
    const work = async () => {
      if (this.#closed) throw new Error("Organization launch journal is closed");
      const previous = this.#operations.get(event.operationId);
      if (
        ifAlreadyStopped &&
        event.phase === "stopped" &&
        previous?.phase === "stopped" &&
        JSON.stringify(previous.identity) === JSON.stringify(event.identity)
      )
        return;
      advance(previous, event);
      if (!previous && this.#units.has(event.unitName))
        throw new Error("Organization launch journal unit was reused");
      const checksum = sha256(`${this.#checksum}:${JSON.stringify(event)}`);
      const line = `${JSON.stringify({ previous: this.#checksum, event, checksum })}\n`;
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES)
        throw new Error("Organization launch journal record exceeds its limit");
      await this.#handle.writeFile(line, "utf8");
      await this.#handle.sync();
      this.#checksum = checksum;
      this.#operations.set(event.operationId, event);
      this.#units.add(event.unitName);
    };
    const pending = this.#queued.then(work);
    this.#queued = pending.catch(() => undefined);
    await pending;
  }

  async reserve(operationId: string, unitName: string): Promise<void> {
    await this.#append({ operationId, unitName, phase: "reserved", identity: null });
  }

  /** The exclusive broker can close a reservation before any OS dispatch.
   * Later prepare calls for the same operation are permanently rejected.
   */
  async abortReserved(operationId: string): Promise<void> {
    const entry = this.#operations.get(operationId);
    if (!entry || entry.phase !== "reserved")
      throw new Error("Organization launch reservation is not pending");
    await this.#append({ ...entry, phase: "never-dispatched" });
  }

  /** fsync `dispatching` before entering the host's first possible OS spawn. */
  async prepare(
    operationId: string,
    input: OrganizationSandboxInput & { readonly reservedUnitName: string },
    host: typeof prepareOrganizationScopedSandbox = prepareOrganizationScopedSandbox,
  ): Promise<PreparedOrganizationScopedSandbox> {
    const unitName = input.reservedUnitName;
    await this.#append({ operationId, unitName, phase: "dispatching", identity: null });
    // A rejection may occur after systemd-run was spawned. It deliberately
    // leaves `dispatching` durable and cannot be interpreted as no launch.
    const handle = await host(input);
    const identity: OrganizationWorkScopeIdentity = {
      unitName: handle.unitName,
      invocationId: handle.invocationId,
      controlGroup: handle.controlGroup,
      sandboxPid: handle.sandboxPid,
      pidNamespace: handle.pidNamespace,
    };
    try {
      await this.#append({ operationId, unitName, phase: "prepared", identity });
    } catch (error) {
      await handle.stop().catch(() => undefined);
      throw error;
    }
    const recordStopped = async () => {
      await this.#append({ operationId, unitName, phase: "stopped", identity }, true);
    };
    return {
      ...handle,
      start: async () => {
        await this.#append({ operationId, unitName, phase: "start-intent", identity });
        await handle.start();
        await this.#append({ operationId, unitName, phase: "started", identity });
      },
      discard: async () => {
        const result = await handle.discard();
        await recordStopped();
        return result;
      },
      wait: async () => {
        const result = await handle.wait();
        await recordStopped();
        return result;
      },
      stop: async () => {
        const result = await handle.stop();
        await recordStopped();
        return result;
      },
    };
  }

  /** Recovery never clears a dispatch whose host identity was not journaled. */
  async reconcile(
    stop: typeof stopAndVerifyOrganizationScopedSandbox = stopAndVerifyOrganizationScopedSandbox,
  ): Promise<{
    readonly stopped: readonly string[];
    readonly neverDispatched: readonly string[];
    readonly held: readonly string[];
  }> {
    const stopped: string[] = [];
    const neverDispatched: string[] = [];
    const held: string[] = [];
    for (const entry of this.list()) {
      if (entry.phase === "stopped" || entry.phase === "never-dispatched") continue;
      if (entry.phase === "reserved") {
        try {
          await this.abortReserved(entry.operationId);
          neverDispatched.push(entry.operationId);
        } catch {
          held.push(entry.operationId);
        }
        continue;
      }
      if (!entry.identity) {
        held.push(entry.operationId);
        continue;
      }
      try {
        await stop(entry.identity);
        await this.#append({ ...entry, phase: "stopped" });
        stopped.push(entry.operationId);
      } catch {
        held.push(entry.operationId);
      }
    }
    return { stopped, neverDispatched, held };
  }

  async close(): Promise<void> {
    await this.#queued;
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}

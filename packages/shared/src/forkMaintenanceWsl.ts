// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Explicit Windows/WSL cohort protocol. Which WSL distributions belong to a Windows device's update
 * is stated membership, persisted by the desktop and confirmed by the person; it is never inferred from
 * listening addresses, hostnames, or `wsl.exe -l` output. Windows and every member form ONE cohort:
 * one fence, one multi-home snapshot set, one verification, one restore.
 *
 * A member is driven only through `wsl.exe -d <distro> -- <t3> maintenance ...`, so a stopped
 * distribution fails the whole transaction instead of being skipped, and nothing reaches into
 * \\wsl$ paths from Windows.
 */
import * as Schema from "effect/Schema";
import { AGENT_IDLE_WINDOW_MS } from "./forkMaintenanceAdmission.ts";
import {
  runFenceOperation,
  type FenceOperation,
  type FenceOperationResult,
} from "./forkMaintenanceFenceOperations.ts";
import {
  runHomeOperation,
  type HomeOperation,
  type HomeOperationResult,
} from "./forkMaintenanceHomeOperations.ts";
import { newJournal, type MaintenanceJournal } from "./forkMaintenanceJournal.ts";
import type { CoordinatorStore } from "./forkMaintenanceStore.ts";

export const WslMember = Schema.Struct({
  /** Stable member id, also the coordinator participant id of the `wsl` child. */
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]+$/)),
  distro: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)),
  /** Linux path of the T3 home inside the distribution (the directory that contains `userdata`). */
  home: Schema.String.check(Schema.isPattern(/^\/[^\0]*$/)),
  /**
   * Absolute path of the `t3` executable inside the distribution, for the built-in `wsl.exe --exec` transport only.
   * A caller that supplies its own `DistroRunner` (the desktop, which resolves PATH and the staged command itself) omits it.
   */
  executable: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\/[^\0]*$/))),
});
export type WslMember = typeof WslMember.Type;
export const WslMembership = Schema.Struct({
  version: Schema.Literal(1),
  members: Schema.Array(WslMember),
});
export type WslMembership = typeof WslMembership.Type;
export const decodeWslMembership = Schema.decodeUnknownSync(WslMembership);

/** The home identifier a member contributes to a journal. Distinct from any Windows path. */
export const wslHomeId = (member: Pick<WslMember, "distro" | "home">) =>
  `wsl:${member.distro}:${member.home}`;
export const parseWslHomeId = (
  id: string,
): { readonly distro: string; readonly home: string } | null => {
  const match = /^wsl:([A-Za-z0-9._-]+):(\/.*)$/.exec(id);
  return match === null ? null : { distro: match[1]!, home: match[2]! };
};

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type Exec = (command: string, args: ReadonlyArray<string>) => Promise<ExecResult>;

const parseResult = (
  result: ExecResult,
  what: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } => {
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(last) as { ok?: unknown; value?: unknown; reason?: unknown };
    if (parsed.ok === true) return { ok: true, value: parsed.value };
    if (parsed.ok === false && typeof parsed.reason === "string")
      return { ok: false, reason: parsed.reason };
  } catch {
    // fall through
  }
  return {
    ok: false,
    reason: `${what} did not answer (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(-300)}`,
  };
};

/** Argument vectors of the CLI verbs (`t3 maintenance home|fence ...`). */
export const homeOperationArgs = (
  home: string,
  operation: HomeOperation,
): ReadonlyArray<string> => {
  const base = ["home", operation.op, "--home", home];
  switch (operation.op) {
    case "requirement":
    case "list":
    case "canonical":
      return base;
    case "capacity":
      return [
        ...base,
        ...(operation.rescue === true ? ["--rescue", "true"] : []),
        ...(operation.artifactBytes === undefined
          ? []
          : ["--artifact-bytes", String(operation.artifactBytes)]),
      ];
    case "snapshot":
    case "rescue":
      return [...base, "--transaction", operation.transactionId];
    case "verify":
    case "discard":
      return [...base, "--snapshot", operation.snapshotId];
    case "restore":
      return [
        ...base,
        "--snapshot",
        operation.snapshotId,
        "--transaction",
        operation.transactionId,
      ];
    case "prune":
      return [
        ...base,
        "--keep",
        String(operation.keep),
        ...operation.pinned.flatMap((id) => ["--pin", id]),
      ];
  }
};
export const fenceOperationArgs = (operation: FenceOperation): ReadonlyArray<string> => {
  switch (operation.op) {
    case "status":
    case "confirm-bootstrap":
      return ["fence", operation.op];
    case "receipt":
      return [
        "fence",
        "receipt",
        "--transaction",
        operation.transactionId,
        "--home",
        operation.home,
        "--slot",
        operation.slot,
      ];
    case "freeze":
      return [
        "fence",
        "freeze",
        "--transaction",
        operation.transactionId,
        "--parent",
        operation.parent,
        ...(operation.forRecovery === true ? ["--for-recovery", "true"] : []),
      ];
    case "recheck":
    case "release":
      return ["fence", operation.op, "--transaction", operation.transactionId];
    case "issue-trial":
      return [
        "fence",
        "issue-trial",
        "--transaction",
        operation.transactionId,
        "--home",
        operation.home,
      ];
    case "journal":
      return [
        "fence",
        "journal",
        "--journal-base64",
        Buffer.from(JSON.stringify(operation.journal)).toString("base64"),
      ];
  }
};

/** One data home's storage verbs, whether it lives on this OS or in a distribution. */
export interface HomeControl {
  readonly run: (operation: HomeOperation) => Promise<HomeOperationResult>;
}
export interface FenceControl {
  readonly run: (operation: FenceOperation) => Promise<FenceOperationResult>;
}

export const createLocalHomeControl = (home: string, store?: CoordinatorStore): HomeControl => ({
  run: (operation) => runHomeOperation(home, operation, store === undefined ? {} : { store }),
});
export const createLocalFenceControl = (
  store: CoordinatorStore,
  now: () => number,
): FenceControl => ({ run: (operation) => runFenceOperation(store, operation, now()) });

/** `wsl.exe -d <distro> --exec <t3> maintenance <args>` (no shell between wsl.exe and t3). A missing distro, stopped service or absent t3 is a failure, never a skip. */
export const wslInvocation = (member: WslMember, args: ReadonlyArray<string>) => {
  if (member.executable === undefined)
    throw new Error(
      `${member.distro} has no registered t3 executable; supply a DistroRunner instead.`,
    );
  return {
    command: "wsl.exe",
    args: ["-d", member.distro, "--exec", member.executable, "maintenance", ...args],
  };
};
/**
 * A caller-owned transport into one distribution: it receives the arguments that follow the `t3` executable
 * (always starting with `maintenance`) and resolves to stdout, rejecting on a non-zero exit or any failure to run.
 * The desktop supplies this (PATH, the staged t3 command, timeouts); the protocol on top of it lives here.
 */
export type DistroRunner = (
  args: ReadonlyArray<string>,
  options?: { readonly timeoutMs?: number },
) => Promise<string>;

const viaRunner = async (
  runner: DistroRunner,
  args: ReadonlyArray<string>,
  what: string,
): Promise<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }
> => {
  let stdout: string;
  try {
    stdout = await runner(["maintenance", ...args]);
  } catch (cause) {
    // A distribution that cannot run the verb is unknown, never idle and never skipped.
    return {
      ok: false,
      reason: `${what} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  return parseResult({ code: 0, stdout, stderr: "" }, what);
};
export const createRunnerHomeControl = (
  runner: DistroRunner,
  member: Pick<WslMember, "distro" | "home">,
): HomeControl => ({
  run: (operation) =>
    viaRunner(runner, homeOperationArgs(member.home, operation), `Distribution ${member.distro}`),
});
export const createRunnerFenceControl = (
  runner: DistroRunner,
  member: Pick<WslMember, "distro">,
): FenceControl => ({
  run: (operation) =>
    viaRunner(runner, fenceOperationArgs(operation), `Distribution ${member.distro}`),
});

export const createWslHomeControl = (member: WslMember, exec: Exec): HomeControl => ({
  run: async (operation) => {
    try {
      const call = wslInvocation(member, homeOperationArgs(member.home, operation));
      return parseResult(await exec(call.command, call.args), `Distribution ${member.distro}`);
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  },
});
export const createWslFenceControl = (member: WslMember, exec: Exec): FenceControl => ({
  run: async (operation) => {
    try {
      const call = wslInvocation(member, fenceOperationArgs(operation));
      return parseResult(await exec(call.command, call.args), `Distribution ${member.distro}`);
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  },
});

export interface CohortHome {
  /** Journal home id: the canonical Windows path, or `wsl:<distro>:<home>`. */
  readonly id: string;
  readonly label: string;
  readonly control: HomeControl;
}

const unwrap = <A>(result: HomeOperationResult, home: CohortHome): A => {
  if (!result.ok) throw new Error(`${home.label}: ${result.reason}`);
  return result.value as A;
};

/**
 * Storage ports for the whole cohort, dispatching by home id. Each call is all-or-nothing from the
 * transaction's view: any home failing throws and the engine aborts or restores the entire set.
 */
export function createCohortStorage(homes: ReadonlyArray<CohortHome>) {
  const find = (id: string) => {
    const home = homes.find((candidate) => candidate.id === id);
    if (home === undefined) throw new Error(`${id} is not a member of this update's cohort.`);
    return home;
  };
  return {
    affectedHomes: async () => homes.map((home) => home.id),
    homeLabel: (id: string) => homes.find((home) => home.id === id)?.label ?? id,
    snapshot: async (id: string, transactionId: string) =>
      unwrap<string>(await find(id).control.run({ op: "snapshot", transactionId }), find(id)),
    rescue: async (id: string, transactionId: string) =>
      unwrap<string>(await find(id).control.run({ op: "rescue", transactionId }), find(id)),
    discardSnapshot: async (id: string, snapshotId: string) =>
      void unwrap(await find(id).control.run({ op: "discard", snapshotId }), find(id)),
    restore: async (id: string, snapshotId: string, transactionId: string) =>
      void unwrap(
        await find(id).control.run({ op: "restore", snapshotId, transactionId }),
        find(id),
      ),
    restorePoints: async (id: string) =>
      unwrap<
        ReadonlyArray<{
          id: string;
          transactionId: string;
          kind: string;
          createdAt: string;
          bytes: number;
        }>
      >(await find(id).control.run({ op: "list" }), find(id))
        .filter((point) => point.kind === "restore-point")
        .map(({ id: pointId, transactionId, createdAt, bytes }) => ({
          id: pointId,
          transactionId,
          createdAt,
          bytes,
        })),
    /** Every home checks its own filesystem; the cohort fails if any one cannot hold its restore points. */
    assertCapacity: async (
      ids: ReadonlyArray<string>,
      reserve: { readonly rescue?: boolean; readonly artifactBytes?: number } = {},
    ) => {
      for (const id of ids) {
        const home = find(id);
        unwrap(
          await home.control.run({
            op: "capacity",
            ...(reserve.rescue === undefined ? {} : { rescue: reserve.rescue }),
            ...(reserve.artifactBytes === undefined
              ? {}
              : { artifactBytes: reserve.artifactBytes }),
          }),
          home,
        );
      }
    },
  };
}

/** Mirrors the transaction journal into a member's registry so its remotely held fence can be released against a durable terminal phase. */
export async function mirrorJournalToMembers(
  journal: MaintenanceJournal,
  fences: ReadonlyArray<FenceControl>,
): Promise<void> {
  for (const fence of fences) {
    const result = await fence.run({ op: "journal", journal });
    if (!result.ok)
      throw new Error(`A distribution could not record the transaction journal: ${result.reason}`);
  }
}

/**
 * The controller's view of a cohort whose members keep their own registries. Freezing is all or
 * nothing: if any member refuses, those already frozen are released against a mirrored aborted
 * journal and the failure propagates.
 */
export function createCohortFence(input: {
  readonly parentId: string;
  readonly members: ReadonlyArray<{ readonly member: WslMember; readonly fence: FenceControl }>;
  readonly forRecovery?: boolean;
}) {
  const fences = input.members.map((entry) => entry.fence);
  const frozen: FenceControl[] = [];
  return {
    freeze: async (transactionId: string) => {
      for (const { member, fence } of input.members) {
        const result = await fence.run({
          op: "freeze",
          transactionId,
          parent: input.parentId,
          ...(input.forRecovery === true ? { forRecovery: true } : {}),
        });
        if (!result.ok) {
          const aborted = {
            ...newJournal({
              id: transactionId,
              kind: "update",
              homes: [],
              previous: { version: "0", artifactSha256: "" },
              target: null,
              now: Date.now(),
            }),
            phase: "aborted" as const,
            failure: "A member could not be fenced.",
          };
          await mirrorJournalToMembers(aborted, frozen).catch(() => undefined);
          for (const done of frozen)
            await done.run({ op: "release", transactionId }).catch(() => undefined);
          frozen.length = 0;
          throw new Error(`${member.distro}: ${result.reason}`);
        }
        frozen.push(fence);
      }
    },
    mirrorJournal: (journal: MaintenanceJournal) => mirrorJournalToMembers(journal, fences),
    // Only members that actually hold this transaction release it. After a restart this object has no
    // memory of what it froze, so each member's own registry is asked.
    release: async (transactionId: string) => {
      for (const fence of fences) {
        const status = await fence.run({ op: "status" });
        if (!status.ok)
          throw new Error(`A distribution could not be checked before releasing: ${status.reason}`);
        if (
          (status.value as { fence: { transactionId: string } | null }).fence?.transactionId !==
          transactionId
        )
          continue;
        const result = await fence.run({ op: "release", transactionId });
        if (!result.ok)
          throw new Error(`A distribution could not release its fence: ${result.reason}`);
      }
      frozen.length = 0;
    },
  };
}

/**
 * Registers each member as a `wsl` child of the Windows parent (explicit control channel) and records
 * its current blockers from the distribution's own registry. An unreachable member is recorded as
 * unknown, which blocks installation: the cohort never proceeds on a member it cannot see.
 */
export async function observeWslMembers(input: {
  readonly store: CoordinatorStore;
  readonly parentId: string;
  readonly members: ReadonlyArray<{ readonly member: WslMember; readonly fence: FenceControl }>;
  readonly now: number;
}): Promise<void> {
  const registered = new Set(
    (await input.store.status(input.now)).participants.map((participant) => participant.id),
  );
  for (const { member, fence } of input.members) {
    // Register a child once; later passes only observe it (register would also be harmless now, but needs no lock round trip).
    if (!registered.has(member.id))
      await input.store
        .register(
          {
            id: member.id,
            label: `${member.distro} (WSL)`,
            kind: "wsl",
            homes: [wslHomeId(member)],
            updateTarget: true,
            parentId: input.parentId,
          },
          input.now,
        )
        .catch((cause: unknown) => {
          // Re-registering an existing child is expected on every pass.
          if (
            !(cause instanceof Error) ||
            !cause.message.includes("belongs to another live process")
          )
            throw cause;
        });
    const result = await fence.run({ op: "status" });
    if (!result.ok) {
      await input.store.observe(
        member.id,
        [
          {
            participantId: member.id,
            reason: "unknown-participant",
            label: `${member.distro} could not be reached over its control channel.`,
          },
        ],
        input.now,
      );
      continue;
    }
    const status = result.value as {
      readonly blockers: ReadonlyArray<{
        readonly participantId: string;
        readonly reason: never;
        readonly label: string;
        readonly threadId?: string;
      }>;
      readonly participants: ReadonlyArray<unknown>;
      readonly bootstrapped: boolean;
    };
    // A distribution with no registered runtime, or not yet bootstrapped, cannot be shown idle.
    const blockers =
      status.participants.length === 0
        ? [
            {
              participantId: member.id,
              reason: "bootstrap" as const,
              label: `${member.distro} has no registered T3 runtime.`,
            },
          ]
        : !status.bootstrapped
          ? [
              {
                participantId: member.id,
                reason: "bootstrap" as const,
                label: `${member.distro} has not confirmed its installations.`,
              },
            ]
          : status.blockers.map((blocker) => ({ ...blocker, participantId: member.id }));
    // An empty aggregate from the distribution already includes its own five-minute idle window.
    await input.store.observe(
      member.id,
      blockers,
      input.now,
      [],
      blockers.length === 0 ? { alreadyIdleFor: AGENT_IDLE_WINDOW_MS } : {},
    );
  }
}

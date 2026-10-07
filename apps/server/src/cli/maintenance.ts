// @effect-diagnostics nodeBuiltinImport:off processEnv:off globalDate:off preferSchemaOverJson:off
import * as Console from "effect/Console";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ForkRecoveryRequest, type ForkUpdatePolicyPatch } from "@t3tools/contracts";
import {
  parseFenceOperation,
  runFenceOperation,
} from "@t3tools/shared/forkMaintenanceFenceOperations";
import {
  parseHomeOperation,
  runHomeOperation,
} from "@t3tools/shared/forkMaintenanceHomeOperations";
import {
  CoordinatorStore,
  coordinatorDirectory,
  ORPHAN_ATTESTATION_CONFIRMATION,
} from "@t3tools/shared/forkMaintenanceStore";
import { main as recoveryHelperMain } from "@t3tools/shared/forkRecoveryHelper";
import {
  callOperator,
  describeStatus,
  discoverOperatorTarget,
  type OperatorResult,
} from "../maintenance/operatorClient.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const decodeRecoveryRequest = Schema.decodeUnknownEffect(ForkRecoveryRequest);
class MaintenanceCliError extends Schema.TaggedError<MaintenanceCliError>()("MaintenanceCliError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON."),
  Flag.withDefault(false),
);
const baseDir = (flag: Option.Option<string>) =>
  resolveBaseDir(Option.getOrUndefined(flag) ?? process.env.T3CODE_HOME);

/** Every stateful command goes through the running server's one controller; nothing here installs anything itself. */
const operate = (
  flag: Option.Option<string>,
  json: boolean,
  call: (target: Awaited<ReturnType<typeof discoverOperatorTarget>>) => Promise<OperatorResult>,
) =>
  Effect.gen(function* () {
    const home = yield* baseDir(flag);
    const result = yield* Effect.tryPromise({
      try: async () => call(await discoverOperatorTarget(home)),
      catch: (cause) =>
        new MaintenanceCliError({ reason: cause instanceof Error ? cause.message : String(cause) }),
    });
    if (!result.ok) {
      yield* Console.error(result.reason);
      for (const blocker of result.blockers ?? []) yield* Console.error(`  - ${blocker.label}`);
      return yield* new MaintenanceCliError({ reason: "Device maintenance refused the request." });
    }
    yield* json
      ? Console.log(JSON.stringify(result.status, null, 2))
      : Effect.forEach(describeStatus(result.status), (line) => Console.log(line), {
          discard: true,
        });
  });

const simple = (name: string, description: string, action: Parameters<typeof callOperator>[2]) =>
  Command.make(name, { baseDir: baseDirFlag, json: jsonFlag }).pipe(
    Command.withDescription(description),
    Command.withHandler(({ baseDir: flag, json }) =>
      operate(flag, json, (target) => callOperator(target, "action", action)),
    ),
  );

const statusCommand = Command.make("status", { baseDir: baseDirFlag, json: jsonFlag }).pipe(
  Command.withDescription(
    "Show this device's update state: build, target, what blocks installation, and recovery options.",
  ),
  Command.withHandler(({ baseDir: flag, json }) =>
    operate(flag, json, (target) => callOperator(target, "status", {})),
  ),
);
const installCommand = Command.make("install", {
  baseDir: baseDirFlag,
  json: jsonFlag,
  digest: Flag.String("digest"),
}).pipe(
  Command.withDescription(
    "Install the staged build. The digest must be the exact target artifact digest you reviewed in `status`.",
  ),
  Command.withHandler(({ baseDir: flag, json, digest }) =>
    operate(flag, json, (target) =>
      callOperator(target, "action", { action: "install", targetArtifactSha256: digest }),
    ),
  ),
);
const policyCommand = Command.make("policy", {
  baseDir: baseDirFlag,
  json: jsonFlag,
  channel: Flag.Literals("channel", ["stable", "nightly"] as const).pipe(Flag.optional),
  auto: Flag.Literals("auto", ["on", "off"] as const).pipe(Flag.optional),
  pin: Flag.Boolean("pin").pipe(
    Flag.withDescription("Hold updates on the installed build."),
    Flag.withDefault(false),
  ),
  resume: Flag.Boolean("resume").pipe(
    Flag.withDescription("Resume updates after a pin. Does not resume held automation."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Change this device's update channel, automatic installation, or pin."),
  Command.withHandler(({ baseDir: flag, json, channel, auto, pin, resume }) =>
    operate(flag, json, async (target) => {
      const current = await callOperator(target, "status", {});
      if (!current.ok) return current;
      const patch: ForkUpdatePolicyPatch = {
        ...(Option.isSome(channel) ? { channel: channel.value } : {}),
        ...(Option.isSome(auto) ? { automaticInstallation: auto.value === "on" } : {}),
        ...(pin ? { pinnedBuild: current.status.currentBuild.artifactSha256 } : {}),
        ...(resume ? { pinnedBuild: null } : {}),
      };
      return callOperator(target, "policy", patch);
    }),
  ),
);
const recoverCommand = Command.make("recover", {
  baseDir: baseDirFlag,
  json: jsonFlag,
  option: Flag.String("option"),
  transaction: Flag.String("transaction"),
  restore: Flag.KeyValuePair("restore").pipe(
    Flag.withDescription(
      "homeId=restore-timestamp, repeated for every home, exactly as shown by `status`.",
    ),
  ),
  confirm: Flag.String("confirm").pipe(
    Flag.withDescription("Type the option id again to confirm restoring older data."),
  ),
}).pipe(
  Command.withDescription(
    "Restore the previous build's data from a retained restore point. Needs the exact option id, every home's timestamp, and your typed confirmation.",
  ),
  Command.withHandler(({ baseDir: flag, json, option, transaction, restore, confirm }) =>
    Effect.gen(function* () {
      if (confirm !== option)
        return yield* new MaintenanceCliError({
          reason: "--confirm must repeat the option id exactly. Nothing was changed.",
        });
      const request = yield* decodeRecoveryRequest({
        optionId: option,
        transactionId: transaction,
        restoreTimestamps: restore,
        acknowledgeDataRestore: true,
      }).pipe(
        Effect.mapError(
          () => new MaintenanceCliError({ reason: "The recovery request is not valid." }),
        ),
      );
      yield* operate(flag, json, (target) => callOperator(target, "recover", request));
    }),
  ),
);
const repairLockCommand = Command.make("repair-lock", {}).pipe(
  Command.withDescription(
    "Remove the coordinator lock left by a process that exited while holding it. Refuses while that process lives.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const store = yield* Effect.tryPromise({
        try: () =>
          CoordinatorStore.open(coordinatorDirectory(process.env.T3CODE_MAINTENANCE_NAMESPACE)),
        catch: (cause) => new MaintenanceCoordinatorOpenError({ reason: String(cause) }),
      });
      const removed = yield* Effect.tryPromise({
        try: () => store.repairExitedLock(),
        catch: (cause) =>
          new MaintenanceCliError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      yield* Console.log(
        removed ? "Removed the exited coordinator lock." : "There is no coordinator lock.",
      );
    }),
  ),
);
const orphanListCommand = Command.make("orphans", { json: jsonFlag }).pipe(
  Command.withDescription(
    "List exact exited participant owners and recorded children for offline operator verification.",
  ),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const store = yield* Effect.tryPromise({
        try: () =>
          CoordinatorStore.open(coordinatorDirectory(process.env.T3CODE_MAINTENANCE_NAMESPACE)),
        catch: (cause) => new MaintenanceCoordinatorOpenError({ reason: String(cause) }),
      });
      const now = yield* Clock.currentTimeMillis;
      const status = yield* Effect.tryPromise({
        try: () => store.status(now),
        catch: (cause) =>
          new MaintenanceCliError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const result = {
        bootstrapped: status.bootstrapped,
        fence: status.fence,
        blockers: status.blockers,
        participants: status.participants.map((participant) => ({
          id: participant.id,
          label: participant.label,
          owner: participant.owner,
          orphaned: participant.orphaned,
          descendants: participant.descendants,
          blockers: participant.blockers,
        })),
      };
      if (json) yield* Console.log(JSON.stringify(result, null, 2));
      else if (result.participants.filter((participant) => participant.orphaned).length === 0)
        yield* Console.log("No orphaned runtimes are recorded.");
      else
        yield* Effect.forEach(
          result.participants.filter((participant) => participant.orphaned),
          (participant) =>
            Console.log(
              `${participant.id} (${participant.label}): owner PID ${participant.owner.pid} started ${participant.owner.started}; ${participant.descendants.length} recorded child process(es). Use --json for identities.`,
            ),
          { discard: true },
        );
    }),
  ),
);
const attestOrphanCommand = Command.make("attest-orphan", {
  participant: Flag.String("participant"),
  ownerPid: Flag.Int("owner-pid"),
  ownerStarted: Flag.String("owner-started"),
  confirm: Flag.String("confirm").pipe(
    Flag.withDescription(`Type exactly: ${ORPHAN_ATTESTATION_CONFIRMATION}`),
  ),
}).pipe(
  Command.withDescription(
    "Offline-only: clear one exact exited orphan after all runtimes and recorded children are proven gone and you checked for unrecorded work.",
  ),
  Command.withHandler(({ participant, ownerPid, ownerStarted, confirm }) =>
    Effect.gen(function* () {
      const store = yield* Effect.tryPromise({
        try: () =>
          CoordinatorStore.open(coordinatorDirectory(process.env.T3CODE_MAINTENANCE_NAMESPACE)),
        catch: (cause) => new MaintenanceCoordinatorOpenError({ reason: String(cause) }),
      });
      yield* Effect.tryPromise({
        try: () =>
          store.attestOrphanResolved({
            participantId: participant,
            owner: { pid: ownerPid, started: ownerStarted },
            confirmation: confirm,
          }),
        catch: (cause) =>
          new MaintenanceCliError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      yield* Console.log(`Cleared the exact orphan record ${participant}.`);
    }),
  ),
);
class MaintenanceCoordinatorOpenError extends Schema.TaggedError<MaintenanceCoordinatorOpenError>()(
  "MaintenanceCoordinatorOpenError",
  { reason: Schema.String },
) {}

export const maintenanceCommand = Command.make("maintenance").pipe(
  Command.withDescription(
    "Device maintenance: update state, installation, policy and recovery for this device. `home`, `fence` and `helper` are machine verbs used by the desktop's WSL control channel and the recovery path.",
  ),
  Command.withSubcommands([
    statusCommand,
    simple("check", "Check for a newer eligible release and stage it. Never installs.", {
      action: "check",
    }),
    installCommand,
    simple(
      "cancel-countdown",
      "Cancel the automatic installation countdown for the staged build.",
      { action: "cancel-countdown" },
    ),
    simple("acknowledge-review", "Confirm you reviewed restored schedules and queues.", {
      action: "acknowledge-automation-review",
    }),
    simple(
      "bootstrap",
      "Confirm every Arcwright Code installation on this device is registered, which lifts the bootstrap blocker.",
      { action: "confirm-bootstrap" },
    ),
    policyCommand,
    recoverCommand,
    repairLockCommand,
    orphanListCommand,
    attestOrphanCommand,
  ]),
);

/**
 * Raw verbs for machine callers: `t3 maintenance home|fence|helper ...`. They bypass the flag parser (their
 * arguments are positional vectors) and print one JSON line, so a Windows desktop can drive a WSL distribution
 * through `wsl.exe -d <distro> -- t3 maintenance ...` and read exactly what happened. Returns the exit code.
 */
export async function runMaintenanceMachineVerb(
  argv: ReadonlyArray<string>,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "helper")
    return recoveryHelperMain(rest, {
      out: write,
      err: (line) => process.stderr.write(`${line}\n`),
    });
  const store = await CoordinatorStore.open(
    coordinatorDirectory(process.env.T3CODE_MAINTENANCE_NAMESPACE),
  ).catch(() => null);
  if (verb === "home") {
    const parsed = parseHomeOperation(rest);
    if ("error" in parsed) {
      write(JSON.stringify({ ok: false, reason: parsed.error }));
      return 2;
    }
    const result = await runHomeOperation(
      parsed.home,
      parsed.operation,
      store === null ? {} : { store },
    );
    write(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  if (verb === "fence") {
    const parsed = parseFenceOperation(rest);
    if ("error" in parsed || store === null) {
      write(
        JSON.stringify({
          ok: false,
          reason: "error" in parsed ? parsed.error : "The device coordinator could not be opened.",
        }),
      );
      return 2;
    }
    const result = await runFenceOperation(store, parsed, Date.now());
    write(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  write(JSON.stringify({ ok: false, reason: `Unknown machine verb ${verb ?? "(none)"}.` }));
  return 2;
}

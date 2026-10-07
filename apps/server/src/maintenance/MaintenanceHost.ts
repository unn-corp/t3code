// @effect-diagnostics nodeBuiltinImport:off globalDate:off processEnv:off — the host registry is a process-wide filesystem resource.
import * as NodeCrypto from "node:crypto";
import {
  FORK_ACTIVITY_PROTOCOL,
  FORK_MAINTENANCE_PROTOCOL,
  type ForkMaintenanceCapability,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CoordinatorStore,
  coordinatorDirectory,
  UnsupportedPlatformError,
  type TrialCapability,
} from "@t3tools/shared/forkMaintenanceStore";
import type { MaintenanceParticipantKind } from "@t3tools/shared/forkMaintenanceAdmission";
import {
  decodeServiceLauncherContext,
  SERVICE_LAUNCHER_CONTEXT_ENV,
} from "../cloud/serviceProtocol.ts";
import { resolveAbandonedFenceForService } from "./serviceStartupRecovery.ts";

export const MAINTENANCE_TRIAL_ENV = "T3CODE_MAINTENANCE_TRIAL";

export class MaintenanceStartupHeld extends Schema.TaggedError<MaintenanceStartupHeld>()(
  "MaintenanceStartupHeld",
  {
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason;
  }
}

const isStartupHeld = Schema.is(MaintenanceStartupHeld);

export interface MaintenanceHostInput {
  readonly maintenance?: { readonly namespace: string | undefined } | undefined;
  readonly baseDir: string;
  readonly mode: "web" | "desktop";
  readonly devUrl: URL | undefined;
}

export type MaintenanceHost =
  /** No host files are touched (isolated tests). */
  | { readonly mode: "disabled" }
  /** Unsupported OS: no local automatic update target exists and no capability is advertised. */
  | { readonly mode: "unavailable"; readonly reason: string }
  | {
      readonly mode: "active";
      readonly store: CoordinatorStore;
      readonly participantId: string;
      readonly coordinatorId: string;
      /** Canonical data home: the directory that contains `userdata`, never `userdata` itself. */
      readonly home: string;
      readonly kind: MaintenanceParticipantKind;
      readonly updateTarget: boolean;
      readonly trial: TrialCapability | null;
      /** Set when this runtime started under an abandoned transaction it must finish before admitting work. */
      readonly successorOf: string | null;
    };

export function participantKindFor(
  input: Pick<MaintenanceHostInput, "mode" | "devUrl">,
  env: NodeJS.ProcessEnv = process.env,
): { readonly kind: MaintenanceParticipantKind; readonly updateTarget: boolean } {
  // Standalone and development runtimes are checked but are never binary update targets.
  if (input.devUrl !== undefined) return { kind: "development", updateTarget: false };
  if (input.mode === "desktop") return { kind: "desktop", updateTarget: true };
  if (env[SERVICE_LAUNCHER_CONTEXT_ENV] !== undefined)
    return { kind: "service", updateTarget: true };
  return { kind: "standalone", updateTarget: false };
}

const launcherContext = (env: NodeJS.ProcessEnv) => {
  const raw = env[SERVICE_LAUNCHER_CONTEXT_ENV];
  return raw === undefined ? undefined : decodeServiceLauncherContext(raw);
};
const decodeTrial = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ transactionId: Schema.String, home: Schema.String, nonce: Schema.String }),
  ),
);

export const describeCapability = (
  host: MaintenanceHost,
  recovery: boolean,
): ForkMaintenanceCapability | undefined =>
  host.mode === "active"
    ? {
        protocol: FORK_MAINTENANCE_PROTOCOL,
        coordinatorId: host.coordinatorId,
        participantId: host.participantId,
        admission: true,
        activityProtocol: FORK_ACTIVITY_PROTOCOL,
        recovery,
      }
    : undefined;

const hosts = new Map<string, Promise<MaintenanceHost>>();

async function open(input: MaintenanceHostInput, env: NodeJS.ProcessEnv): Promise<MaintenanceHost> {
  if (input.maintenance === undefined) return { mode: "disabled" };
  let store: CoordinatorStore;
  try {
    store = await CoordinatorStore.open(coordinatorDirectory(input.maintenance.namespace));
  } catch (cause) {
    // An OS without process-identity verification must still run: only installation fails closed.
    if (cause instanceof UnsupportedPlatformError)
      return { mode: "unavailable", reason: cause.message };
    throw new MaintenanceStartupHeld({
      reason: `This runtime could not join device maintenance: ${cause instanceof Error ? cause.message : String(cause)}. Resolve the coordinator before starting Arcwright Code.`,
    });
  }
  const { kind, updateTarget } = participantKindFor(input, env);
  const participantId = `rt-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const rawTrial = env[MAINTENANCE_TRIAL_ENV];
  // A trial capability is single-use: strip it so no child process inherits it.
  delete env[MAINTENANCE_TRIAL_ENV];
  let trial: TrialCapability | null = null;
  if (rawTrial !== undefined) {
    try {
      trial = decodeTrial(rawTrial);
    } catch {
      throw new MaintenanceStartupHeld({
        reason:
          "The maintenance trial capability is malformed; this runtime was not started by an update transaction.",
      });
    }
  }
  let status;
  try {
    status = await store.status(Date.now());
  } catch (cause) {
    // Supported runtimes must register before opening a database. Even a temporary lock/read failure
    // cannot start an invisible runtime which another participant could miss when its next read succeeds.
    throw new MaintenanceStartupHeld({
      reason: `This runtime could not read device maintenance: ${cause instanceof Error ? cause.message : String(cause)}. Resolve the coordinator before starting Arcwright Code.`,
    });
  }
  const heldReason =
    "Device maintenance is in progress. Wait for the update to finish verification or recovery, then start Arcwright Code again.";
  const abandonedOwner = status.fence !== null && status.fence.holderAlive === false;
  if (status.fence !== null && trial === null && !(kind === "service" && abandonedOwner)) {
    throw new MaintenanceStartupHeld({ reason: heldReason });
  }
  // The data home is the directory that contains `userdata`; the registry canonicalizes it.
  const home = input.baseDir;
  let successorOf: string | null = null;
  const adopting = trial === null && status.fence !== null;
  try {
    // The fence is validated inside register, atomically: a transaction that freezes after the
    // status read above still cannot admit this runtime.
    await store.register(
      { id: participantId, label: `${kind} runtime`, kind, homes: [home], updateTarget },
      Date.now(),
      trial !== null ? { trial } : adopting ? { adoptAbandonedFence: true } : {},
    );
    if (adopting && status.fence !== null) {
      const canonicalHome =
        (await store.status(Date.now())).participants.find((entry) => entry.id === participantId)
          ?.homes[0] ?? home;
      const decision = await resolveAbandonedFenceForService({
        store,
        home: canonicalHome,
        transactionId: status.fence.transactionId,
        launcher: launcherContext(env),
        now: () => Date.now(),
      });
      if (decision.action === "blocked")
        throw new MaintenanceStartupHeld({ reason: decision.reason });
      if (decision.action === "adopt") successorOf = decision.transactionId;
    }
  } catch (cause) {
    if (isStartupHeld(cause)) throw cause;
    if (cause instanceof Error && cause.message.includes("holds new work"))
      throw new MaintenanceStartupHeld({ reason: heldReason });
    throw new MaintenanceStartupHeld({
      reason: `This runtime could not join device maintenance: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  const registered = (await store.status(Date.now())).participants.find(
    (entry) => entry.id === participantId,
  );
  return {
    mode: "active",
    store,
    participantId,
    coordinatorId: (await store.status(Date.now())).coordinatorId,
    home: registered?.homes[0] ?? home,
    kind,
    updateTarget,
    trial,
    successorOf,
  };
}

/**
 * The one host per process and namespace. Every database opener, work gate and
 * descriptor goes through this, so a CLI command, the server and the descriptor
 * agree on one participant. Held startup rejects before any database is touched.
 */
export const acquireMaintenanceHost = (
  input: MaintenanceHostInput,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<MaintenanceHost, MaintenanceStartupHeld> => {
  if (input.maintenance === undefined) return Effect.succeed({ mode: "disabled" });
  const key = `${input.maintenance.namespace ?? ""}|${input.baseDir}`;
  return Effect.tryPromise({
    try: () => {
      let host = hosts.get(key);
      if (host === undefined) {
        host = open(input, env);
        hosts.set(key, host);
        // A refusal is not cached: the next attempt re-reads the fence.
        host.catch(() => hosts.delete(key));
      }
      return host;
    },
    catch: (cause) =>
      isStartupHeld(cause)
        ? cause
        : new MaintenanceStartupHeld({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
  });
};

/** Test seam: forget memoized hosts so one process can exercise several simulated runtimes. */
export const resetMaintenanceHostsForTests = () => hosts.clear();

import {
  DesktopUpdateChannelSchema,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopForkMaintenance from "../maintenance/DesktopForkMaintenance.ts";
import { ACTIVE_PHASES, INSTALL_PHASES, toDesktopUpdateState } from "./maintenanceUpdateState.ts";

interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export type DesktopUpdateConfigureError = never;
export type DesktopUpdateSetChannelError = DesktopUpdateActionInProgressError;

/**
 * The legacy desktop update surface (IPC check/download/install, menu, server-relayed updates). It holds no
 * update logic of its own: every action is the one maintenance controller's, so an install from here passes
 * the same coordinator admission, idle window and confirmation checks as every other entry point. When the
 * controller refuses, this refuses; there is no direct install path.
 */
export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    /** True while a check, download or install holds the controller. */
    readonly isActionActive: Effect.Effect<boolean>;
    /** True only while an install transaction is in flight. */
    readonly isInstallActive: Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    /** Stages the verified payload. The controller verifies and stages when it checks, so this never downloads outside it. */
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const { logInfo: logUpdaterInfo, logWarning: logUpdaterWarning } =
  DesktopObservability.makeComponentLogger("desktop-updater");

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const maintenance = yield* DesktopForkMaintenance.DesktopForkMaintenance;
  const electronWindow = yield* ElectronWindow.ElectronWindow;

  const disabledReason = yield* maintenance.disabledReason;
  const checkedAtRef = yield* Ref.make<string | null>(null);
  const statusRef = yield* Ref.make<Option.Option<ForkUpdateStatus>>(Option.none());
  const stateRef = yield* Ref.make<DesktopUpdateState>(
    toDesktopUpdateState({
      status: yield* maintenance.status,
      currentVersion: environment.appVersion,
      runtimeInfo: environment.runtimeInfo,
      checkedAt: null,
      disabledReason: Option.getOrNull(disabledReason),
    }),
  );
  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Writes and publishes are atomic against subscribe, so a snapshot never overlaps a subscriber's first change.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(stateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );
  const apply = (status: ForkUpdateStatus) =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(statusRef);
      // The moment a check finishes is the moment the person last learned something: record it.
      if (
        Option.isSome(previous) &&
        previous.value.phase === "checking" &&
        status.phase !== "checking"
      ) {
        yield* Ref.set(checkedAtRef, yield* currentIsoTimestamp);
      }
      yield* Ref.set(statusRef, Option.some(status));
      const state = toDesktopUpdateState({
        status,
        currentVersion: environment.appVersion,
        runtimeInfo: environment.runtimeInfo,
        checkedAt: yield* Ref.get(checkedAtRef),
        disabledReason: Option.getOrNull(disabledReason),
      });
      yield* stateMutex.withPermits(1)(
        Ref.set(stateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      );
      yield* emitState;
    });

  // Always the controller's own answer: a cached copy could lag the action it is asked about.
  const currentStatus = maintenance.status;
  const resultOf = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    return state;
  });

  /** Installation only ever goes through the controller, bound to the digest of the staged build the person saw. */
  const install = (expectedVersion: string | undefined) =>
    Effect.gen(function* () {
      const status = yield* maintenance.status;
      const target = status.targetBuild;
      if (
        target === null ||
        status.installable !== true ||
        (expectedVersion !== undefined && target.version !== expectedVersion)
      ) {
        yield* apply(status);
        return { accepted: false, completed: false, failed: false, state: yield* resultOf };
      }
      const outcome = yield* maintenance.install(target.artifactSha256).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        yield* logUpdaterWarning("device update install was refused", {
          reason: outcome.failure.reason,
        });
        yield* apply({ ...status, lastError: outcome.failure.reason, phase: "failed" });
        return { accepted: true, completed: false, failed: true, state: yield* resultOf };
      }
      yield* apply(outcome.success);
      return {
        accepted: true,
        completed: false,
        failed: outcome.success.phase === "failed",
        state: yield* resultOf,
      };
    }).pipe(Effect.withSpan("desktop.updates.install"));

  return DesktopUpdates.of({
    getState: Ref.get(stateRef),
    isActionActive: currentStatus.pipe(Effect.map((status) => ACTIVE_PHASES.has(status.phase))),
    isInstallActive: currentStatus.pipe(Effect.map((status) => INSTALL_PHASES.has(status.phase))),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(stateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: Effect.succeed(disabledReason),
    configure: Effect.gen(function* () {
      const { latest, changes } = yield* maintenance.subscribe;
      yield* apply(latest);
      yield* Stream.runForEach(changes, apply).pipe(Effect.forkScoped);
      yield* logUpdaterInfo("desktop update surface follows the maintenance controller", {
        disabled: Option.isSome(disabledReason),
      });
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const outcome = yield* maintenance
        .updatePolicy({ channel: nextChannel === "latest" ? "stable" : "nightly" })
        .pipe(Effect.result);
      if (outcome._tag === "Failure") {
        return yield* Effect.fail(
          new DesktopUpdateActionInProgressError({
            action: "install",
            requestedChannel: nextChannel,
          }),
        );
      }
      yield* apply(outcome.success);
      return yield* resultOf;
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (Option.isSome(disabledReason)) return { checked: false, state: yield* resultOf };
      const outcome = yield* maintenance.check.pipe(Effect.result);
      if (outcome._tag === "Success") yield* apply(outcome.success);
      return { checked: outcome._tag === "Success", state: yield* resultOf };
    }),
    download: Effect.gen(function* () {
      // Staging happens inside the controller's check; there is nothing separate to start, and nothing that downloads around it.
      const status = yield* currentStatus;
      const staged =
        status.targetBuild !== null &&
        ["staged", "downloaded", "waiting", "installing", "verifying"].includes(status.phase);
      return { accepted: staged, completed: staged, state: yield* resultOf };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: install(undefined).pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: (expectedVersion) => install(expectedVersion),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  DesktopUpdateState,
  ForkMaintenanceError,
  ForkUpdateStatus,
} from "@t3tools/contracts";
import { ForkMaintenanceError as MaintenanceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopForkMaintenance from "../maintenance/DesktopForkMaintenance.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

/** Shared test harness: the legacy update facade over a scripted maintenance controller. */

export const flushCallbacks = Effect.yieldNow;

const NEW_DIGEST = "b".repeat(64);
const build = (version: string, artifactSha256: string) => ({
  version,
  commit: "c".repeat(40),
  channel: "stable" as const,
  artifactSha256,
});

export const idleStatus = (overrides: Partial<ForkUpdateStatus> = {}): ForkUpdateStatus => ({
  coordinatorId: "device",
  phase: "idle",
  policy: { channel: "stable", automaticInstallation: false, pinnedBuild: null },
  currentBuild: build("1.2.3", "a".repeat(64)),
  targetBuild: null,
  blockers: [],
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: false,
  installable: false,
  ...overrides,
});

export const stagedStatus = (overrides: Partial<ForkUpdateStatus> = {}): ForkUpdateStatus =>
  idleStatus({
    phase: "staged",
    targetBuild: build("1.2.4", NEW_DIGEST),
    installable: true,
    ...overrides,
  });

export interface UpdatesHarnessOptions {
  readonly initial?: ForkUpdateStatus;
  /** What a check leaves the controller in. */
  readonly afterCheck?: ForkUpdateStatus;
  readonly checkFailure?: string;
  readonly installFailure?: string;
  readonly afterInstall?: ForkUpdateStatus;
  readonly policyFailure?: string;
  readonly disabledReason?: string | undefined;
}

export function makeHarness(options: UpdatesHarnessOptions = {}) {
  const installs: string[] = [];
  const policies: unknown[] = [];
  let checks = 0;
  const sentStates: DesktopUpdateState[] = [];

  const make = Effect.gen(function* () {
    const current = yield* Ref.make<ForkUpdateStatus>(options.initial ?? idleStatus());
    const changes = yield* PubSub.unbounded<ForkUpdateStatus>();
    const set = (status: ForkUpdateStatus) =>
      Ref.set(current, status).pipe(
        Effect.andThen(PubSub.publish(changes, status)),
        Effect.as(status),
      );
    const fail = (reason: string): Effect.Effect<never, ForkMaintenanceError> =>
      Effect.fail(new MaintenanceError({ reason }));
    const controller = DesktopForkMaintenance.DesktopForkMaintenance.of({
      status: Ref.get(current),
      subscribe: Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return { latest: yield* Ref.get(current), changes: Stream.fromSubscription(subscription) };
      }),
      // Like the real controller: it announces the check, then settles on what it found.
      check: Effect.sync(() => void (checks += 1)).pipe(
        Effect.andThen(
          Ref.get(current).pipe(Effect.flatMap((status) => set({ ...status, phase: "checking" }))),
        ),
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(
          options.checkFailure === undefined
            ? set(options.afterCheck ?? idleStatus())
            : fail(options.checkFailure),
        ),
      ),
      install: (digest) =>
        Effect.sync(() => void installs.push(digest)).pipe(
          Effect.andThen(
            options.installFailure === undefined
              ? set(options.afterInstall ?? idleStatus({ phase: "installing" }))
              : fail(options.installFailure),
          ),
        ),
      cancelCountdown: Ref.get(current),
      updatePolicy: (patch) =>
        Effect.sync(() => void policies.push(patch)).pipe(
          Effect.andThen(
            options.policyFailure === undefined
              ? Ref.get(current).pipe(
                  Effect.flatMap((status) =>
                    set({
                      ...status,
                      policy: {
                        ...status.policy,
                        ...(patch.channel === undefined ? {} : { channel: patch.channel }),
                      },
                    }),
                  ),
                )
              : fail(options.policyFailure),
          ),
        ),
      runAction: () => Ref.get(current),
      recover: () => Ref.get(current),
      reportInteraction: () => Effect.void,
      disabledReason: Effect.succeed(Option.fromNullishOr(options.disabledReason)),
      prepareStartup: Effect.succeed({ kind: "idle" } as const),
      resumeInBackground: Effect.void,
      configure: Effect.void,
    });
    return { controller, set };
  });

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}` }),
      ),
    ),
  );

  const controllerLayer = Layer.effect(
    DesktopForkMaintenance.DesktopForkMaintenance,
    make.pipe(Effect.map(({ controller, set }) => Object.assign(controller, { __set: set }))),
  );
  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(controllerLayer),
    Layer.provideMerge(windowLayer),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    installs,
    policies,
    checks: () => checks,
    sentStates,
    /** Moves the scripted controller to a new status, as its own timers and the relay do. */
    publish: (status: ForkUpdateStatus) =>
      Effect.gen(function* () {
        const controller =
          (yield* DesktopForkMaintenance.DesktopForkMaintenance) as DesktopForkMaintenance.DesktopForkMaintenance["Service"] & {
            __set: (status: ForkUpdateStatus) => Effect.Effect<ForkUpdateStatus>;
          };
        yield* controller.__set(status);
        // The facade follows the controller from its own fiber; let it deliver this change before the caller reads.
        for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
      }),
  };
}

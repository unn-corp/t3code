// @effect-diagnostics nodeBuiltinImport:off globalFetch:off processEnv:off — the controller talks to the fork's release origin and the host registry.
import * as NodeFSP from "node:fs/promises";
import {
  ForkMaintenanceError,
  type DesktopMaintenanceOperation,
  type ForkMaintenanceActionInput,
  type ForkMaintenanceInteraction,
  type ForkRecoveryRequest,
  type ForkUpdatePolicyPatch,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import { detectForkPackaging, forkPlatformKey } from "@t3tools/shared/forkMaintenance";
import { listForkReleases, type FetchLike } from "@t3tools/shared/forkMaintenanceFeed";
import { processCreationIdentity } from "@t3tools/shared/forkMaintenanceStore";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import { DesktopMaintenanceBridge } from "./DesktopMaintenanceBridge.ts";
import {
  createDesktopMaintenance,
  type DesktopMaintenance,
  type ManagedWslRuntime,
  type StartupPlan,
  type TrialTarget,
} from "./maintenanceCore.ts";
import { wslCommandFromStartArgs } from "./wslTransport.ts";

const { logInfo, logError } = DesktopObservability.makeComponentLogger("desktop-maintenance");

/** The desktop keeps its existing check cadence; the managed-host cadence is slower. */
const CHECK_INTERVAL = Duration.minutes(4);
const STARTUP_CHECK_DELAY = Duration.seconds(15);
const TICK_INTERVAL = Duration.seconds(5);
const RELEASES_PER_CHECK = 12;

const isMaintenanceError = Schema.is(ForkMaintenanceError);
const toMaintenanceError = (cause: unknown) =>
  isMaintenanceError(cause)
    ? cause
    : new ForkMaintenanceError({ reason: cause instanceof Error ? cause.message : String(cause) });

export class DesktopForkMaintenance extends Context.Service<
  DesktopForkMaintenance,
  {
    readonly status: Effect.Effect<ForkUpdateStatus>;
    /** Current status plus every later one. The controller is the only source: there is no second copy of update state. */
    readonly subscribe: Effect.Effect<
      { readonly latest: ForkUpdateStatus; readonly changes: Stream.Stream<ForkUpdateStatus> },
      never,
      Scope.Scope
    >;
    /** Check the release origin and stage what it finds. */
    readonly check: Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly install: (
      targetArtifactSha256: string,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly cancelCountdown: Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly updatePolicy: (
      patch: ForkUpdatePolicyPatch,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly runAction: (
      input: ForkMaintenanceActionInput,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly recover: (
      request: ForkRecoveryRequest,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly reportInteraction: (input: ForkMaintenanceInteraction) => Effect.Effect<void>;
    /** Why in-product installation is not available on this installation, or None. */
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    /**
     * Opens the device coordinator and decides how this launch starts. Must run before any backend does: a
     * transaction that must finish first (a restore) is resumed here, and a trial runtime is told so.
     */
    readonly prepareStartup: Effect.Effect<StartupPlan>;
    /** After the backends started: finish an interrupted transaction while they are health-checked. */
    readonly resumeInBackground: Effect.Effect<void, never, Scope.Scope>;
    /** Check/stage poller, the automatic-install gate, activity registration and the server relay. */
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/maintenance/DesktopForkMaintenance") {}

const readCommit = async (
  packageJsonPath: string,
  override: string | undefined,
): Promise<string | null> => {
  if (override !== undefined && /^[0-9a-f]{40}$/i.test(override)) return override.toLowerCase();
  try {
    const parsed = JSON.parse(await NodeFSP.readFile(packageJsonPath, "utf8")) as {
      t3codeCommitHash?: unknown;
    };
    return typeof parsed.t3codeCommitHash === "string" &&
      /^[0-9a-f]{40}$/i.test(parsed.t3codeCommitHash)
      ? parsed.t3codeCommitHash.toLowerCase()
      : null;
  } catch {
    return null;
  }
};
const exists = async (target: string) =>
  NodeFSP.access(target).then(
    () => true,
    () => false,
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const bridge = yield* DesktopMaintenanceBridge;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const platform = forkPlatformKey(environment.platform, environment.processArch);
  const installedByDpkg =
    environment.platform === "linux" && environment.isPackaged
      ? yield* Effect.promise(() =>
          NodeFSP.readFile(
            environment.path.join(environment.resourcesPath, "package-type"),
            "utf8",
          ).then(
            (value) => value.trim() === "deb",
            () => false,
          ),
        )
      : false;
  const appImage = Option.getOrUndefined(config.appImagePath);
  const packaging = detectForkPackaging({
    platform: environment.platform,
    env: appImage === undefined ? {} : { APPIMAGE: appImage },
    installedByDpkg,
  });
  const desktopPackaging = packaging === "service" ? null : packaging;
  const disabledReason =
    environment.isDevelopment || !environment.isPackaged
      ? "Updates are only available in packaged production builds."
      : config.disableAutoUpdate
        ? "Updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting."
        : null;
  const commit = yield* Effect.promise(() =>
    readCommit(
      environment.path.join(environment.appRoot, "package.json"),
      Option.getOrUndefined(environment.commitHashOverride),
    ),
  );

  const statusChanges = yield* PubSub.sliding<ForkUpdateStatus>(16);
  const latestRef = yield* Ref.make(Option.none<ForkUpdateStatus>());
  const emit = (status: ForkUpdateStatus) => {
    void runPromise(
      Ref.set(latestRef, Option.some(status)).pipe(
        Effect.andThen(PubSub.publish(statusChanges, status)),
        Effect.andThen(electronWindow.sendAll(IpcChannels.MAINTENANCE_STATUS_CHANNEL, status)),
      ),
    );
  };

  const fetchLike: FetchLike = (input, init) => fetch(input, init);

  const managedWsl = async (): Promise<ReadonlyArray<ManagedWslRuntime>> => {
    const current = await runPromise(settings.get);
    if (
      !current.localEnvironmentEnabled ||
      !current.wslBackendEnabled ||
      environment.platform !== "win32"
    )
      return [];
    const instances = await runPromise(pool.list);
    const result = new Map<string, ManagedWslRuntime>();
    for (const instance of instances) {
      const started = Option.getOrNull(await runPromise(instance.currentConfig));
      if (started === null || started.runningDistro === undefined) continue;
      result.set(started.runningDistro, {
        distro: started.runningDistro,
        command: wslCommandFromStartArgs(started.args),
      });
    }
    // Enabled but not yet resolved: still a managed home. It blocks (no command) instead of vanishing from the set.
    if (result.size === 0)
      result.set(current.wslDistro ?? "(default)", {
        distro: current.wslDistro ?? "(default)",
        command: null,
      });
    return [...result.values()];
  };

  const core: DesktopMaintenance = createDesktopMaintenance({
    namespace: process.env.T3CODE_MAINTENANCE_NAMESPACE,
    baseDir: environment.baseDir,
    version: environment.appVersion,
    commit,
    platform,
    packaging: desktopPackaging,
    installTarget:
      appImage !== undefined && desktopPackaging === "appimage" ? appImage : process.execPath,
    disabledReason,
    authorizationRequired: () =>
      desktopPackaging === "deb"
        ? "Installing a Debian package asks for your system password. Choose Install to start it yourself."
        : null,
    feed: () => listForkReleases(fetchLike, { perPage: RELEASES_PER_CHECK }),
    fetch: (url, init) => fetch(url, init),
    runtime: {
      stopRuntimes: () =>
        runPromise(
          pool.list.pipe(
            Effect.flatMap((instances) =>
              Effect.forEach(
                instances,
                (instance) => instance.stop({ timeout: Duration.seconds(5) }),
                { concurrency: "unbounded", discard: true },
              ),
            ),
          ),
        ),
      startRuntimes: () =>
        runPromise(
          pool.list.pipe(
            Effect.flatMap((instances) =>
              Effect.forEach(instances, (instance) => instance.start, {
                concurrency: "unbounded",
                discard: true,
              }),
            ),
          ),
        ),
      quit: () =>
        runPromise(Ref.set(desktopState.quitting, true).pipe(Effect.andThen(electronApp.quit))),
      self: async () => ({
        pid: process.pid,
        started: (await processCreationIdentity(process.pid)) ?? "",
      }),
    },
    managedWsl,
    descendants: async () => {
      const instances = await runPromise(pool.list);
      const found: Array<{ pid: number; started: string; label: string }> = [];
      for (const instance of instances) {
        const pid = Option.getOrNull((await runPromise(instance.snapshot)).activePid);
        if (pid === null) continue;
        const started = await processCreationIdentity(pid).catch(() => null);
        if (started !== null) found.push({ pid, started, label: "T3 Code backend" });
      }
      return found;
    },
    hasWindow: () => Option.isSome(Effect.runSyncWith(context)(electronWindow.currentMainOrFirst)),
    onStatus: emit,
    userHasExistingData: async () =>
      (await exists(environment.path.join(environment.baseDir, "userdata", "statev2.sqlite"))) ||
      (await exists(environment.path.join(environment.baseDir, "userdata", "state.sqlite"))),
  });
  yield* bridge.provide({
    trialEnv: (target: TrialTarget) => core.trialEnv(target),
    recordWslRuntime: (runtimeId) => core.recordWslRuntime(runtimeId),
    retainedWslRuntimes: () => core.retainedWslRuntimes(),
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => core.stop()).pipe(Effect.ignore));

  const attempt = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: toMaintenanceError });
  const publishing = (work: () => Promise<ForkUpdateStatus>) =>
    attempt(work).pipe(Effect.tap((status) => Effect.sync(() => emit(status))));

  /**
   * Resolves how this launch starts. A transaction that has to finish first is finished inside `core.start`, and a launch it
   * cannot finish comes back as `blocked`: nothing here falls through to a normal start.
   */
  const prepareStartup = Effect.gen(function* () {
    const plan = yield* Effect.promise(() => core.start());
    if (plan.kind === "unavailable")
      yield* logInfo("device maintenance unavailable", { reason: plan.reason });
    if (plan.kind === "blocked")
      yield* logError("device maintenance holds this launch", { reason: plan.reason });
    // Subscribers (the settings page, the sidebar) hold a placeholder until the coordinator is open.
    yield* Effect.promise(() => core.status().then(emit)).pipe(Effect.ignore);
    return plan;
  });

  const resumeInBackground = Effect.promise(() => core.resumeInterrupted()).pipe(
    Effect.catchCause((cause) =>
      logError("interrupted device update could not be resumed", { cause: String(cause) }),
    ),
    Effect.forkScoped,
    Effect.asVoid,
  );

  const handleRelayedRequest = Effect.fn("desktop.maintenance.relayedRequest")(function* (request: {
    readonly requestId: string;
    readonly operation: DesktopMaintenanceOperation;
  }) {
    const operation = request.operation;
    const run = (): Promise<ForkUpdateStatus> => {
      switch (operation.op) {
        case "status":
          return core.status();
        case "policy":
          return core.updatePolicy(operation.patch);
        case "action":
          return core.runAction(operation.input);
        case "recover":
          return core.recover(operation.request);
      }
    };
    const outcome = yield* Effect.tryPromise({ try: run, catch: toMaintenanceError }).pipe(
      Effect.result,
    );
    if (outcome._tag === "Success") {
      yield* publisher.publishMaintenanceReport({
        version: 1,
        type: "desktopMaintenance",
        requestId: request.requestId,
        status: outcome.success,
      });
    } else {
      yield* publisher.publishMaintenanceReport({
        version: 1,
        type: "desktopMaintenance",
        requestId: request.requestId,
        error: {
          reason: outcome.failure.reason,
          ...(outcome.failure.blockers === undefined ? {} : { blockers: outcome.failure.blockers }),
        },
      });
    }
  });

  const configure = Effect.gen(function* () {
    const checkAndStage = Effect.promise(() => core.check()).pipe(
      Effect.catchCause(() => Effect.void),
    );
    // Four-minute checks after a short startup delay, and a five second tick for activity and the automatic gate.
    yield* Effect.sleep(STARTUP_CHECK_DELAY).pipe(
      Effect.andThen(checkAndStage.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)))),
      Effect.forkScoped,
    );
    yield* Effect.promise(() => core.tick()).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      Effect.forkScoped,
    );
    // A server on this device relays remote and agent requests here; concurrent identical ones share one outcome.
    yield* Stream.runForEach(publisher.maintenanceRequests, (request) =>
      handleRelayedRequest(request).pipe(
        Effect.catchCause((cause) =>
          logError("maintenance request failed unexpectedly", { cause: String(cause) }),
        ),
        Effect.forkScoped,
      ),
    ).pipe(Effect.forkScoped);
  }).pipe(Effect.withSpan("desktop.maintenance.configure"));

  return DesktopForkMaintenance.of({
    status: Effect.promise(() => core.status()),
    subscribe: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(statusChanges);
      const latest = yield* Ref.get(latestRef);
      const initial = Option.isSome(latest)
        ? latest.value
        : yield* Effect.promise(() => core.status());
      return { latest: initial, changes: Stream.fromSubscription(subscription) };
    }),
    check: publishing(() => core.check()),
    install: (digest) => publishing(() => core.install(digest)),
    cancelCountdown: publishing(() => core.cancelCountdown()),
    updatePolicy: (patch) => publishing(() => core.updatePolicy(patch)),
    runAction: (input) => publishing(() => core.runAction(input)),
    recover: (request) => publishing(() => core.recover(request)),
    reportInteraction: (input) => Effect.sync(() => core.reportInteraction(input)),
    disabledReason: Effect.sync(() => Option.fromNullishOr(disabledReason)),
    prepareStartup,
    resumeInBackground,
    configure,
  });
});

export const layer = Layer.effect(DesktopForkMaintenance, make);

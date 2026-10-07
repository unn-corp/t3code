/* oxlint-disable t3code/no-global-process-runtime -- node-only filesystem coordinator: the host platform is the point */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off — the controller owns real timers, files and the GitHub origin.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ForkMaintenanceError,
  type ForkActivityBlocker,
  type ForkMaintenanceActionInput,
  type ForkRecoveryRequest,
  type ForkUpdatePolicyPatch,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import {
  FORK_CHECK_INTERVAL_MS,
  forkAssetUrl,
  forkPlatformKey,
} from "@t3tools/shared/forkMaintenance";
import {
  createFilePolicyStore,
  createForkMaintenanceController,
  defaultChannelForBuild,
  deriveBuildIdentity,
  type ForkMaintenanceController,
} from "@t3tools/shared/forkMaintenanceController";
import { listForkReleases, type FetchLike } from "@t3tools/shared/forkMaintenanceFeed";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { APP_VERSION, BUILD_IDENTITY } from "../appVersion.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import {
  MaintenanceCoordinator,
  type MaintenanceCoordinatorError,
} from "./MaintenanceCoordinator.ts";
import { createServiceInstaller } from "./serviceInstaller.ts";

export class MaintenanceService extends Context.Service<
  MaintenanceService,
  {
    readonly status: Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly updatePolicy: (
      patch: ForkUpdatePolicyPatch,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly runAction: (
      input: ForkMaintenanceActionInput,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    readonly recover: (
      request: ForkRecoveryRequest,
    ) => Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>;
    /** True when this host can perform recovery itself or through its desktop controller. Drives the descriptor. */
    readonly recoverySupported: boolean;
  }
>()("t3/maintenance/MaintenanceService") {}

const isMaintenanceError = Schema.is(ForkMaintenanceError);
const asMaintenanceError = (cause: unknown) =>
  isMaintenanceError(cause)
    ? cause
    : new ForkMaintenanceError({ reason: cause instanceof Error ? cause.message : String(cause) });
const attempt = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: asMaintenanceError });

/** A host that is not a binary update target (standalone, development, unsupported OS): visible, checked, never updated in-product. */
const readOnlyStatus = (reason: string, coordinator: MaintenanceCoordinator["Service"]) =>
  Effect.gen(function* () {
    const status = yield* coordinator.status.pipe(Effect.orElseSucceed(() => null));
    const blockers: ForkActivityBlocker[] = [
      ...(status?.blockers ?? []),
      { participantId: "coordinator", reason: "launcher", label: reason },
    ];
    const current = deriveBuildIdentity({
      version: APP_VERSION,
      upstreamVersion: BUILD_IDENTITY.upstreamVersion,
      upstreamCommit: BUILD_IDENTITY.upstreamCommit,
      forkBuildNumber: BUILD_IDENTITY.forkBuildNumber,
      commit: BUILD_IDENTITY.commit,
      recordedArtifactSha256: null,
    });
    return {
      coordinatorId: status?.coordinatorId ?? "",
      phase: "idle",
      policy: {
        channel: defaultChannelForBuild(APP_VERSION),
        automaticInstallation: false,
        pinnedBuild: null,
      },
      currentBuild: current,
      targetBuild: null,
      blockers,
      recoveryOptions: [],
      transactionId: null,
      automationReviewRequired: false,
      installable: false,
      affectedHomes: [],
    } satisfies ForkUpdateStatus;
  });

/** Whole assets are read from the fork release origin only; the helper and its runtime are the largest. */
const MAX_RELEASE_ASSET_BYTES = 400 * 1024 * 1024;
const readReleaseAsset = async (tagName: string, assetName: string): Promise<Uint8Array> => {
  const url = forkAssetUrl(tagName, assetName);
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${assetName}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_RELEASE_ASSET_BYTES)
    throw new Error(`${assetName} is larger than expected.`);
  return bytes;
};

const fetchLike: FetchLike = (input, init) => fetch(input, init);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const coordinator = yield* MaintenanceCoordinator;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const context = yield* Effect.context<never>();
  const host = coordinator.host;

  const unavailable = (reason: string) => {
    const refuse = Effect.fail(new ForkMaintenanceError({ reason }));
    return MaintenanceService.of({
      status: readOnlyStatus(reason, coordinator),
      updatePolicy: () => refuse,
      runAction: (input) =>
        input.action === "confirm-bootstrap" && host.mode === "active"
          ? attempt(() => host.store.confirmBootstrap()).pipe(
              Effect.andThen(readOnlyStatus(reason, coordinator)),
            )
          : refuse,
      recover: () => refuse,
      recoverySupported: false,
    });
  };

  if (host.mode !== "active")
    return unavailable(
      host.mode === "unavailable"
        ? host.reason
        : "Device maintenance is not enabled for this runtime.",
    );
  const confirmBootstrap = attempt(() => host.store.confirmBootstrap());

  // Desktop-managed: the desktop app is the one controller for the device. This server relays.
  if (host.kind === "desktop") {
    if (config.desktopTelemetryControlFd === undefined)
      return unavailable("This server has no desktop controller attached.");
    const relay = (
      operation: Parameters<
        DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]["maintenance"]
      >[0],
    ) => receiver.maintenance(operation);
    return MaintenanceService.of({
      status: relay({ op: "status" }),
      updatePolicy: (patch) => relay({ op: "policy", patch }),
      runAction: (input) =>
        input.action === "confirm-bootstrap"
          ? confirmBootstrap.pipe(Effect.andThen(relay({ op: "status" })))
          : relay({ op: "action", input }),
      recover: (request) => relay({ op: "recover", request }),
      recoverySupported: true,
    });
  }

  if (host.kind !== "service")
    return unavailable(
      "Standalone and development runtimes are checked but never updated in-product. Update this install the way it was installed.",
    );
  if (!launcher.managed)
    return unavailable("This service is not supervised by the service launcher.");

  // Launcher-managed background service: this process is the controller.
  const platformKey = forkPlatformKey(platform, arch);
  const currentBuild = deriveBuildIdentity({
    version: APP_VERSION,
    upstreamVersion: BUILD_IDENTITY.upstreamVersion,
    upstreamCommit: BUILD_IDENTITY.upstreamCommit,
    forkBuildNumber: BUILD_IDENTITY.forkBuildNumber,
    commit: BUILD_IDENTITY.commit,
    recordedArtifactSha256: null,
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const runtimeExists = async (version: string) => {
    const dir = NodePath.join(config.baseDir, "runtime", "versions", version);
    try {
      const [entry, sentinel] = await Promise.all([
        NodeFSP.stat(NodePath.join(dir, process.platform === "win32" ? "t3.exe" : "t3")),
        NodeFSP.readFile(NodePath.join(dir, ".install-complete"), "utf8"),
      ]);
      return entry.isFile() && sentinel.trim() === version;
    } catch {
      return false;
    }
  };
  const installer = createServiceInstaller({
    home: host.home,
    store: host.store,
    platform: platformKey,
    currentBuild,
    launcher: {
      supportsMaintenanceTrial: launcher.supportsMaintenanceTrial,
      requestUpdate: (input) => Effect.runPromiseWith(context)(launcher.requestUpdate(input)),
    },
    dbPath: config.dbPath,
    stageRuntime: ({ version, expectedArchiveSha256 }) =>
      Effect.runPromiseWith(context)(
        selfUpdate.stage({ targetVersion: version, expectedArchiveSha256 }).pipe(Effect.asVoid),
      ),
    runtimeExists,
    recoveryCacheDir: NodePath.join(host.store.directory, "recovery"),
    fetchReleaseAsset: readReleaseAsset,
    now: () => Date.now(),
    sleep,
  });
  const controller: ForkMaintenanceController = createForkMaintenanceController({
    now: () => Date.now(),
    sleep,
    store: host.store,
    policy: createFilePolicyStore(NodePath.join(config.baseDir, "maintenance", "policy.json")),
    defaultPolicy: {
      channel: defaultChannelForBuild(APP_VERSION),
      automaticInstallation: false,
      pinnedBuild: null,
      failedArtifactSha256: [],
      automationReviewRequired: false,
      cancelledTargetSha256: null,
    },
    feed: () => listForkReleases(fetchLike),
    installer,
    // A headless host has no interactive surface: only agents and the countdown gate it.
    interaction: () => null,
  });

  // Continue anything a previous process left in flight. Receipts it waits for are written by startup itself.
  yield* Effect.forkScoped(
    Effect.promise(() => controller.resumeInterrupted()).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Interrupted device update could not be resumed.", cause),
      ),
    ),
  );
  // Four-hourly checks (staging what they find), and a five-second tick for the automatic gate.
  const check = Effect.promise(() => controller.check().then(() => controller.stage())).pipe(
    Effect.catchCause(() => Effect.void),
  );
  yield* check.pipe(
    Effect.repeat(Schedule.spaced(`${FORK_CHECK_INTERVAL_MS} millis`)),
    Effect.forkScoped,
  );
  yield* Effect.promise(() => controller.tick()).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.forkScoped,
  );

  return MaintenanceService.of({
    status: attempt(() => controller.status()),
    updatePolicy: (patch) => attempt(() => controller.updatePolicy(patch)),
    runAction: (input) => {
      switch (input.action) {
        case "check":
          return attempt(async () => {
            await controller.check();
            return controller.stage();
          });
        case "install":
          return attempt(() => controller.install(input.targetArtifactSha256));
        case "cancel-countdown":
          return attempt(() => controller.cancelCountdown());
        case "acknowledge-automation-review":
          return attempt(() => controller.acknowledgeAutomationReview());
        case "confirm-bootstrap":
          return confirmBootstrap.pipe(Effect.andThen(attempt(() => controller.status())));
      }
    },
    recover: (request) => attempt(() => controller.recover(request)),
    recoverySupported: launcher.supportsMaintenanceTrial,
  });
});

export const layer = Layer.effect(MaintenanceService, make);
export type { MaintenanceCoordinatorError };

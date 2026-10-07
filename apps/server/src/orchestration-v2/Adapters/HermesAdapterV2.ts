import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  defaultInstanceIdForDriver,
  HermesSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";
import * as ServerConfig from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import {
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  makeHermesAcpRuntime,
  resolveHermesAcpBaseModelId,
} from "../../provider/acp/HermesAcpSupport.ts";
import { makeHermesEnvironment } from "../../provider/Drivers/HermesHome.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";
export const HERMES_PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_DRIVER_KIND = HERMES_PROVIDER;
export const HERMES_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(HERMES_DRIVER_KIND);
const DEFAULT_HERMES_SETTINGS = Schema.decodeSync(HermesSettings)({});

export const HermesProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canForkThread: false,
    canForkFromTurn: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface HermesAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly hostPlatform: NodeJS.Platform;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export function makeHermesAcpAdapterFlavor(options: HermesAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: HERMES_PROVIDER,
    runtimeHarness: "Hermes",
    capabilities: HermesProviderCapabilitiesV2,
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeHermesAcpRuntime({
          ...input,
          hermesSettings: options.settings,
          environment: { ...options.environment, ...input.processEnvironment },
          childProcessSpawner: options.childProcessSpawner,
        })),
    resolveModelId: (selection) => resolveHermesAcpBaseModelId(selection.model),
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      applyHermesAcpModelSelection({
        runtime,
        currentModelId: startResult.sessionSetupResult.models?.currentModelId?.trim() || undefined,
        requestedModelId: resolveHermesAcpBaseModelId(modelSelection.model),
        mapError: (cause) => cause,
      }),
    sessionModeForPolicy: (policy) =>
      policy.runtimeMode === "full-access" ? "dont_ask" : "default",
    supportsImagePrompts: true,
  };
}
export function makeHermesAdapterV2(options: HermesAdapterV2Options) {
  const flavor = makeHermesAcpAdapterFlavor(options);
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
}

export type HermesAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const HermesAdapterV2Driver: ProviderAdapterDriver<
  HermesSettings,
  HermesAdapterV2DriverEnv
> = {
  driverKind: HERMES_DRIVER_KIND,
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => DEFAULT_HERMES_SETTINGS,
  create: Effect.fn("HermesAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<HermesSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const hostPlatform = yield* HostProcessPlatform;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeHermesAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* makeHermesEnvironment(
          input.config,
          mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        ),
        hostPlatform,
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: HERMES_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: HERMES_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Hermes ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};

const layer: Layer.Layer<
  ProviderAdapter.ProviderAdapterV2,
  never,
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
> = Layer.effect(
  ProviderAdapter.ProviderAdapterV2,
  Effect.gen(function* () {
    const hostEnvironment = yield* HostProcessEnvironment;
    const hostPlatform = yield* HostProcessPlatform;
    const selfInvocation = yield* resolveSelfInvocation();
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    return makeHermesAdapterV2({
      instanceId: HERMES_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_HERMES_SETTINGS,
      environment: hostEnvironment,
      hostPlatform,
      childProcessSpawner,
      crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      selfInvocation,
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: HERMES_PROVIDER,
          threadId,
        }),
    });
  }),
);

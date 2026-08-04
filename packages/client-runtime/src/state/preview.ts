import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const previewAutomationHostFocusConcurrencyKey = (value: {
  readonly environmentId: string;
  readonly input: {
    readonly clientId: string;
    readonly connectionId: string;
  };
}): string => JSON.stringify([value.environmentId, value.input.clientId, value.input.connectionId]);

export function createPreviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const statusScheduler = createAtomCommandScheduler();
  const automationScheduler = createAtomCommandScheduler();
  const frameScheduler = createAtomCommandScheduler();
  const inputScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:preview:list",
      tag: WS_METHODS.previewList,
      staleTimeMs: 5_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:events",
      tag: WS_METHODS.subscribePreviewEvents,
    }),
    discoveredServers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:discovered-servers",
      tag: WS_METHODS.subscribeDiscoveredLocalServers,
    }),
    automationRequests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:automation-requests",
      tag: WS_METHODS.previewAutomationConnect,
      // Automation requests are commands, not cached query data. Dispose the
      // stream immediately with its owner so stale requests cannot replay when
      // a thread remounts and the server can clear disconnected hosts promptly.
      idleTtlMs: 0,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:open",
      tag: WS_METHODS.previewOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:navigate",
      tag: WS_METHODS.previewNavigate,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:resize",
      tag: WS_METHODS.previewResize,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:refresh",
      tag: WS_METHODS.previewRefresh,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:close",
      tag: WS_METHODS.previewClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    reportStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:report-status",
      tag: WS_METHODS.previewReportStatus,
      scheduler: statusScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    }),
    respondToAutomation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-respond",
      tag: WS_METHODS.previewAutomationRespond,
      scheduler: automationScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.connectionId, input.requestId]),
      },
    }),
    focusAutomationHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-focus-host",
      tag: WS_METHODS.previewAutomationFocusHost,
      scheduler: automationScheduler,
      concurrency: {
        mode: "latest",
        key: previewAutomationHostFocusConcurrencyKey,
      },
    }),
    /**
     * Frames for a tab this client cannot render itself. Disposed with its
     * owner like automation requests: a stream left alive would keep the host
     * screencasting for a panel nobody is looking at.
     */
    frames: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:frames",
      tag: WS_METHODS.previewAttach,
      idleTtlMs: 0,
    }),
    publishFrame: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:publish-frame",
      tag: WS_METHODS.previewPublishFrame,
      scheduler: frameScheduler,
      concurrency: {
        // Only the newest frame matters. Dropping an in-flight publish for a
        // fresher one is the whole point of a screencast.
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    }),
    sendInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:input",
      tag: WS_METHODS.previewInput,
      scheduler: inputScheduler,
      concurrency: {
        // Serial, not latest: dropping a mouseup because a mousemove overtook
        // it would leave the page holding a button down.
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    }),
  };
}

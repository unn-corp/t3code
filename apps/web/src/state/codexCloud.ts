import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const codexCloud = {
  read: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cloud:read",
    tag: WS_METHODS.codexCloudRead,
  }),
  command: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cloud:command",
    tag: WS_METHODS.codexCloudCommand,
  }),
  setupWorker: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cloud:worker-setup",
    tag: WS_METHODS.codexCloudWorkerSetup,
  }),
};

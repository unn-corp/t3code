import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentDashboardEnvironment = {
  snapshot: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:agent-dashboard:snapshot",
    tag: WS_METHODS.agentDashboardGetSnapshot,
    staleTimeMs: 5_000,
    refreshIntervalMs: 15_000,
  }),
};

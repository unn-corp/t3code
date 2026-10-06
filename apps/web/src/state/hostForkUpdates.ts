import type { EnvironmentId } from "@t3tools/contracts";
import { supportsForkMaintenanceAdmission, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { ForkUpdateController } from "./forkUpdates";
import { createHostUpdateBatcher } from "./hostUpdateBatcher";
import { environmentServerConfigsAtom } from "./server";

const commands = {
  status: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork-maintenance:status",
    tag: WS_METHODS.serverGetMaintenanceStatus,
  }),
  policy: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork-maintenance:policy",
    tag: WS_METHODS.serverUpdateMaintenancePolicy,
  }),
  action: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork-maintenance:action",
    tag: WS_METHODS.serverRunMaintenanceAction,
  }),
  recovery: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork-maintenance:recovery",
    tag: WS_METHODS.serverRecoverMaintenance,
  }),
};
const controllers = new Map<EnvironmentId, ForkUpdateController>();
export function hostForkUpdateController(environmentId: EnvironmentId): ForkUpdateController {
  const existing = controllers.get(environmentId);
  if (existing) return existing;
  const status = async () => {
    const result = await runAtomCommand(
      appAtomRegistry,
      commands.status,
      { environmentId, input: {} },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const requireAdmission = () => {
    const capability = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)
      ?.environment.capabilities.forkMaintenance;
    if (!supportsForkMaintenanceAdmission(capability))
      throw new Error("This host needs manual bootstrap to the current device-maintenance build.");
  };
  const controller = new ForkUpdateController({
    status,
    policy: async (input) => {
      requireAdmission();
      const result = await runAtomCommand(
        appAtomRegistry,
        commands.policy,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    action: async (input) => {
      requireAdmission();
      const result = await runAtomCommand(
        appAtomRegistry,
        commands.action,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    recover: async (input) => {
      requireAdmission();
      const result = await runAtomCommand(
        appAtomRegistry,
        commands.recovery,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
  });
  controllers.set(environmentId, controller);
  return controller;
}
/** One batch queue per local coordinator, with separate requests for its independently replaced installations. */
export const requestHostUpdates = createHostUpdateBatcher(hostForkUpdateController);

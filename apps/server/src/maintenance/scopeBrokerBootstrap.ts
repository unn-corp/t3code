// @effect-diagnostics nodeBuiltinImport:off globalDate:off processEnv:off -- Native operator bootstrap; never opens a database or installs a runtime.
import * as NodeFSP from "node:fs/promises";
import { ForkUpdateStatus } from "@t3tools/contracts";
import {
  CoordinatorStore,
  coordinatorDirectory,
  type CoordinatorStatus,
} from "@t3tools/shared/forkMaintenanceStore";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ensureOrganizationScopeLaunchBroker } from "../organizations/OrganizationScopeLaunchBrokerBootstrap.ts";
import { callOperator, discoverOperatorTarget, type OperatorResult } from "./operatorClient.ts";

interface BootstrapPorts {
  readonly platform: NodeJS.Platform;
  readonly canonicalHome: (home: string) => Promise<string>;
  readonly controllerStatus: (home: string) => Promise<OperatorResult>;
  readonly open: (namespace: string | undefined) => Promise<{
    status(now: number): Promise<CoordinatorStatus>;
  }>;
  readonly ensure: (home: string) => Promise<void>;
  readonly now: () => number;
}
const nativePorts: BootstrapPorts = {
  platform: HostProcessPlatform.defaultValue(),
  canonicalHome: NodeFSP.realpath,
  controllerStatus: async (home) => callOperator(await discoverOperatorTarget(home), "status", {}),
  open: (namespace) => CoordinatorStore.open(coordinatorDirectory(namespace)),
  ensure: ensureOrganizationScopeLaunchBroker,
  now: Date.now,
};
const isUpdateStatus = Schema.is(ForkUpdateStatus);

/** An older managed runtime can provision its missing broker from a verified newer CLI,
 * then retry its own normal update. This does not activate the CLI's build or grant install admission. */
export async function bootstrapManagedScopeBroker(
  input: { readonly home: string; readonly namespace: string | undefined },
  ports: BootstrapPorts = nativePorts,
): Promise<void> {
  if (ports.platform !== "linux") throw new Error("Organization launch broker requires Linux.");
  const home = await ports.canonicalHome(input.home);
  const store = await ports.open(input.namespace);
  const verify = async () => {
    const response = await ports.controllerStatus(home);
    if (!response.ok) throw new Error(response.reason);
    if (!isUpdateStatus(response.status))
      throw new Error("The native controller returned unreadable maintenance status.");
    const status = response.status;
    const census = await store.status(ports.now());
    if (
      status.coordinatorId !== census.coordinatorId ||
      !census.participants.some(
        (participant) =>
          participant.updateTarget &&
          (participant.kind === "service" || participant.kind === "desktop") &&
          participant.homes.includes(home),
      )
    )
      throw new Error("The running managed home does not belong to this coordinator.");
    if (
      status.transactionId !== null ||
      status.phase === "installing" ||
      status.phase === "verifying" ||
      status.phase === "recovery" ||
      status.countdown != null ||
      census.fence !== null ||
      !census.bootstrapped ||
      status.blockers.length !== 0 ||
      census.blockers.length !== 0
    )
      throw new Error(
        "Wait for the native maintenance cohort to finish its work and idle window before provisioning the broker.",
      );
  };
  await verify();
  await ports.ensure(home);
  // Work that arrived during provisioning remains a refusal, never update admission.
  await verify();
}

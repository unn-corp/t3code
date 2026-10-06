import type {
  EnvironmentId,
  ForkMaintenanceActionInput,
  ForkUpdateStatus,
} from "@t3tools/contracts";

interface HostController {
  refresh(): Promise<ForkUpdateStatus>;
  action(input: ForkMaintenanceActionInput): Promise<ForkUpdateStatus>;
}
export interface HostUpdateTarget {
  environmentId: EnvironmentId;
  serverLabel: string;
}
export interface HostUpdateResult {
  label: string;
  message: string;
  failed: boolean;
}

/** Devices proceed independently; distinct replacements on one device queue, and aliases share one request. */
export function createHostUpdateBatcher(resolve: (environmentId: EnvironmentId) => HostController) {
  const queues = new Map<string, Promise<void>>();
  const pending = new Map<string, Promise<ForkUpdateStatus>>();
  return async (targets: ReadonlyArray<HostUpdateTarget>): Promise<HostUpdateResult[]> => {
    const outcomes = await Promise.all(
      targets.map(async (target) => {
        const controller = resolve(target.environmentId);
        try {
          const observed = await controller.refresh();
          // Missing identity cannot merge unrelated hosts or manufacture shared completion.
          const device = observed.coordinatorId || `environment:${target.environmentId}`;
          const replacement = `${device}:${observed.controllerId || `environment:${target.environmentId}`}`;
          let request = pending.get(replacement);
          if (!request) {
            const previous = queues.get(device) ?? Promise.resolve();
            request = previous.then(async () => {
              const checked = await controller.action({ action: "check" });
              return checked.targetBuild && ["staged", "waiting"].includes(checked.phase)
                ? controller.action({
                    action: "install",
                    targetArtifactSha256: checked.targetBuild.artifactSha256,
                  })
                : checked;
            });
            pending.set(replacement, request);
            const tail = request.then(
              () => {},
              () => {},
            );
            queues.set(device, tail);
            const owned = request;
            void tail.then(() => {
              if (pending.get(replacement) === owned) pending.delete(replacement);
              if (queues.get(device) === tail) queues.delete(device);
            });
          }
          const status = await request;
          return {
            label: target.serverLabel,
            failed: status.phase === "failed",
            message: status.blockers.length
              ? status.blockers.map((blocker) => blocker.label).join("; ")
              : status.phase,
          };
        } catch (error) {
          return {
            label: target.serverLabel,
            failed: true,
            message:
              error instanceof Error
                ? error.message
                : "Host offline or updater bootstrap required.",
          };
        }
      }),
    );
    return outcomes;
  };
}

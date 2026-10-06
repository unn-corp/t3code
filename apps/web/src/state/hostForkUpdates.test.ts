import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, FORK_ACTIVITY_PROTOCOL, type ForkUpdateStatus } from "@t3tools/contracts";

const state = vi.hoisted(() => ({ capability: undefined as unknown, run: vi.fn() }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map([
        ["guard-test", { environment: { capabilities: { forkMaintenance: state.capability } } }],
      ]),
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  runAtomCommand: (...args: unknown[]) => state.run(...args),
  squashAtomCommandFailure: (failure: unknown) => failure,
}));
import { hostForkUpdateController } from "./hostForkUpdates";

it("rechecks the current host capability before mutations, while allowing read-only status", async () => {
  const controller = hostForkUpdateController(EnvironmentId.make("guard-test"));
  const status: ForkUpdateStatus = {
    coordinatorId: "c",
    phase: "idle",
    policy: { channel: "nightly", automaticInstallation: false, pinnedBuild: null },
    currentBuild: {
      version: "1.0.0",
      commit: "a".repeat(40),
      channel: "nightly",
      artifactSha256: "b".repeat(64),
    },
    targetBuild: null,
    blockers: [],
    recoveryOptions: [],
    transactionId: null,
    automationReviewRequired: false,
  };
  state.run.mockResolvedValue({ _tag: "Success", value: status });
  const base = {
    protocol: 1,
    coordinatorId: "c",
    participantId: "p",
    admission: true,
    recovery: true,
  };
  for (const activityProtocol of [undefined, 1, FORK_ACTIVITY_PROTOCOL + 1]) {
    state.capability = { ...base, activityProtocol };
    await expect(
      controller.action({ action: "install", targetArtifactSha256: "b".repeat(64) }),
    ).rejects.toThrow("manual bootstrap");
    await expect(controller.setPolicy({ automaticInstallation: true })).rejects.toThrow(
      "manual bootstrap",
    );
    await expect(
      controller.recover({
        optionId: "r",
        transactionId: "t",
        restoreTimestamps: {},
        acknowledgeDataRestore: false,
      }),
    ).rejects.toThrow("manual bootstrap");
  }
  expect(state.run).not.toHaveBeenCalled();
  await expect(controller.refresh()).resolves.toEqual(status);
  state.capability = { ...base, activityProtocol: FORK_ACTIVITY_PROTOCOL };
  await expect(controller.action({ action: "check" })).resolves.toEqual(status);
  state.capability = undefined;
  await expect(
    controller.action({ action: "install", targetArtifactSha256: "b".repeat(64) }),
  ).rejects.toThrow("manual bootstrap");
  expect(state.run).toHaveBeenCalledTimes(2);
});

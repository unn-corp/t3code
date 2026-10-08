import { describe, expect, it, vi } from "vite-plus/test";
import type { ForkUpdateStatus } from "@t3tools/contracts";
import { ForkUpdateController } from "./forkUpdates";
import {
  recoveryFingerprint,
  forkStatusDescription,
  forkStatusDetail,
} from "../components/forkUpdatePresentation";
const build = {
  version: "1.0.0",
  commit: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  channel: "nightly" as const,
};
const waiting: ForkUpdateStatus = {
  coordinatorId: "fixture",
  phase: "waiting",
  policy: { channel: "nightly", automaticInstallation: true, pinnedBuild: null },
  currentBuild: build,
  targetBuild: build,
  blockers: [{ participantId: "dev", reason: "commands", label: "Development terminal command" }],
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: false,
};
describe("fork update UI controller", () => {
  it("keeps blocker detail while phases and alerts are displayed separately", () => {
    expect(forkStatusDetail(waiting)).toContain("Development terminal command");
    const idle = { ...waiting, phase: "idle" as const, blockers: [] };
    expect(forkStatusDetail(idle)).toBeNull();
    const failure = { ...idle, phase: "failed" as const, lastError: "Installer permission denied" };
    expect(forkStatusDetail(failure)).toBeNull();
    expect(forkStatusDescription(failure)).toBe("Installer permission denied");
    expect(forkStatusDetail({ ...waiting, lastError: "GitHub rate limit exceeded" })).toContain(
      "Development terminal command",
    );
  });

  it("preserves real waiting state without treating a request as installed", async () => {
    const controller = new ForkUpdateController({
      status: async () => waiting,
      action: async () => waiting,
      policy: async () => waiting,
      recover: async () => waiting,
    });
    await controller.action({ action: "install", targetArtifactSha256: build.artifactSha256 });
    expect(controller.getSnapshot().status?.phase).toBe("waiting");
    expect(forkStatusDescription(waiting)).toContain("Development terminal command");
  });
  it("serializes requests and allows an explicit retry after failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const controller = new ForkUpdateController({
      status: async () => waiting,
      action: async () => {
        order.push("action");
        await gate;
        throw new Error("OS permission denied");
      },
      policy: async () => {
        order.push("policy");
        return { ...waiting, policy: { ...waiting.policy, pinnedBuild: build.artifactSha256 } };
      },
      recover: async () => waiting,
    });
    const first = controller.action({
      action: "install",
      targetArtifactSha256: build.artifactSha256,
    });
    const failure = expect(first).rejects.toThrow("OS permission denied");
    const second = controller.setPolicy({ pinnedBuild: build.artifactSha256 });
    await Promise.resolve();
    expect(order).toEqual(["action"]);
    release();
    await failure;
    await second;
    expect(order).toEqual(["action", "policy"]);
    expect(controller.getSnapshot().status?.policy.pinnedBuild).toBe(build.artifactSha256);
    expect(controller.getSnapshot().error).toBeNull();
  });
  it("clearing an update pin does not request work resumption", async () => {
    const policy = vi.fn(async () => waiting);
    const action = vi.fn(async () => waiting);
    const controller = new ForkUpdateController({
      status: async () => waiting,
      policy,
      action,
      recover: async () => waiting,
    });
    await controller.setPolicy({ pinnedBuild: null });
    expect(policy).toHaveBeenCalledWith({ pinnedBuild: null });
    expect(action).not.toHaveBeenCalled();
  });
  it("retains a failed action across polling and native events until an explicit retry", async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error("Host cannot verify release eligibility"))
      .mockResolvedValue(waiting);
    const controller = new ForkUpdateController({
      status: async () => waiting,
      policy: async () => waiting,
      action,
      recover: async () => waiting,
    });
    await expect(controller.action({ action: "check" })).rejects.toThrow(
      "Host cannot verify release eligibility",
    );
    await controller.refresh();
    controller.accept(waiting);
    expect(controller.getSnapshot().error).toBe("Host cannot verify release eligibility");
    await controller.action({ action: "check" });
    expect(controller.getSnapshot().error).toBeNull();
  });
  it("clears a transient polling failure after status becomes readable", async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValue(waiting);
    const controller = new ForkUpdateController({
      status,
      policy: async () => waiting,
      action: async () => waiting,
      recover: async () => waiting,
    });
    await expect(controller.refresh()).rejects.toThrow("Disconnected");
    await controller.refresh();
    expect(controller.getSnapshot().error).toBeNull();
  });
  it("clears an old action failure when the native controller proves a new installed build", async () => {
    const controller = new ForkUpdateController({
      status: async () => waiting,
      policy: async () => waiting,
      action: async () => {
        throw new Error("Check failed");
      },
      recover: async () => waiting,
    });
    controller.accept(waiting);
    await expect(controller.action({ action: "check" })).rejects.toThrow("Check failed");
    controller.accept({
      ...waiting,
      phase: "completed",
      currentBuild: { ...build, artifactSha256: "d".repeat(64) },
      blockers: [],
    });
    expect(controller.getSnapshot().error).toBeNull();
  });
  it("invalidates confirmation when a cutoff or compatibility decision changes", () => {
    const option = {
      id: "point",
      transactionId: "tx",
      build,
      requiresDataRestore: true,
      homes: [
        {
          id: "wsl",
          label: "WSL",
          restoreTimestamp: "2026-10-01T00:00:00Z",
          binaryCompatible: false,
          additionalBytes: 100,
          requiresPairing: false,
        },
      ],
    };
    expect(recoveryFingerprint(option)).not.toBe(
      recoveryFingerprint({
        ...option,
        homes: [{ ...option.homes[0]!, restoreTimestamp: "2026-10-02T00:00:00Z" }],
      }),
    );
    expect(recoveryFingerprint(option)).not.toBe(
      recoveryFingerprint({ ...option, requiresDataRestore: false }),
    );
  });
});

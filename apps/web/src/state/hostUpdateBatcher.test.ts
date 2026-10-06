import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ForkUpdateStatus } from "@t3tools/contracts";
import { createHostUpdateBatcher } from "./hostUpdateBatcher";

const build = {
  version: "1.0.0",
  commit: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  channel: "stable" as const,
};
function status(device: string, controllerId?: string): ForkUpdateStatus {
  return {
    coordinatorId: device,
    ...(controllerId ? { controllerId } : {}),
    phase: "staged",
    policy: {
      channel: "stable",
      automaticInstallation: false,
      pinnedBuild: null,
    },
    currentBuild: build,
    targetBuild: build,
    blockers: [],
    recoveryOptions: [],
    transactionId: null,
    automationReviewRequired: false,
  };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const target = (id: string) => ({ environmentId: EnvironmentId.make(id), serverLabel: id });

describe("host update batches", () => {
  it("serializes different replacements on one device and reports their own outcomes", async () => {
    const started = gate(),
      release = gate();
    const order: string[] = [];
    const batch = createHostUpdateBatcher((id) => ({
      refresh: async () => status("laptop", id),
      action: async (action) => {
        order.push(`${id}:${action.action}`);
        if (id === "desktop" && action.action === "install") {
          started.resolve();
          await release.promise;
        }
        return action.action === "check"
          ? status("laptop", id)
          : {
              ...status("laptop", id),
              phase: id === "desktop" ? "completed" : "waiting",
              blockers:
                id === "service"
                  ? [
                      {
                        participantId: "dev",
                        reason: "commands",
                        label: "Development command still running",
                      },
                    ]
                  : [],
            };
      },
    }));
    const result = batch([target("desktop"), target("service")]);
    await started.promise;
    expect(order).toEqual(["desktop:check", "desktop:install"]);
    release.resolve();
    expect(await result).toEqual([
      { label: "desktop", failed: false, message: "completed" },
      { label: "service", failed: false, message: "Development command still running" },
    ]);
    expect(order).toEqual(["desktop:check", "desktop:install", "service:check", "service:install"]);
  });

  it("coalesces two aliases and a concurrent batch for the same controller", async () => {
    const started = gate(),
      release = gate();
    const action = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return { ...status("laptop", "desktop"), targetBuild: null, phase: "completed" as const };
    });
    const batch = createHostUpdateBatcher(() => ({
      refresh: async () => status("laptop", "desktop"),
      action,
    }));
    const first = batch([target("windows"), target("wsl")]);
    await started.promise;
    const second = batch([target("windows")]);
    release.resolve();
    expect((await first).map((result) => result.label)).toEqual(["windows", "wsl"]);
    expect(await second).toEqual([{ label: "windows", message: "completed", failed: false }]);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("allows independent devices to proceed while another device waits", async () => {
    const started = gate(),
      release = gate();
    const otherStarted = gate();
    const batch = createHostUpdateBatcher((id) => ({
      refresh: async () => status(id, "desktop"),
      action: async () => {
        if (id === "laptop") {
          started.resolve();
          await release.promise;
        } else otherStarted.resolve();
        return { ...status(id, "desktop"), targetBuild: null, phase: "completed" };
      },
    }));
    const result = batch([target("laptop"), target("deck")]);
    await started.promise;
    await otherStarted.promise;
    release.resolve();
    expect((await result).every((entry) => !entry.failed)).toBe(true);
  });

  it("keeps unidentified and offline hosts separate and retries after an earlier failure", async () => {
    const calls: string[] = [];
    const batch = createHostUpdateBatcher((id) => ({
      refresh: async () => {
        if (id === "offline") throw new Error("Host offline");
        return status("laptop");
      },
      action: async () => {
        calls.push(id);
        return { ...status("laptop"), targetBuild: null, phase: "completed" };
      },
    }));
    expect(await batch([target("one"), target("two"), target("offline")])).toEqual([
      { label: "one", message: "completed", failed: false },
      { label: "two", message: "completed", failed: false },
      { label: "offline", message: "Host offline", failed: true },
    ]);
    expect(calls).toEqual(["one", "two"]);
    await batch([target("one")]);
    expect(calls).toEqual(["one", "two", "one"]);
  });
});

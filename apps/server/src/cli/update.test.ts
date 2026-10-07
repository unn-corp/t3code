// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ForkUpdateStatus } from "@t3tools/contracts";
import { requestCoordinatedCliUpdate } from "../maintenance/coordinatedUpdate.ts";
import type { callOperator } from "../maintenance/operatorClient.ts";

const DIGEST = "b".repeat(64);
const status = (patch: Partial<ForkUpdateStatus> = {}): ForkUpdateStatus => ({
  coordinatorId: "device",
  phase: "idle",
  policy: { channel: "nightly", automaticInstallation: false, pinnedBuild: null },
  currentBuild: {
    version: "1.0.0",
    commit: "a".repeat(40),
    channel: "stable",
    artifactSha256: "a".repeat(64),
  },
  targetBuild: null,
  blockers: [],
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: false,
  ...patch,
});
const staged = status({
  phase: "staged",
  targetBuild: {
    version: "1.0.1",
    commit: "b".repeat(40),
    channel: "stable",
    artifactSha256: DIGEST,
  },
});
const ports = (call: typeof callOperator) => ({
  discover: async () => ({ origin: "http://fixture", token: "fixture" }),
  call,
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("coordinated CLI update", () => {
  it("returns the controller's waiting state when new work arrives after staging, without changing policy", async () => {
    const waiting = status({
      ...staged,
      phase: "waiting",
      blockers: [
        {
          participantId: "child",
          reason: "active-agents",
          label: "A child agent started during the download",
        },
      ],
    });
    const result = await requestCoordinatedCliUpdate(
      { baseDir: "fixture" },
      ports(async (_target, operation, body) => {
        if (operation === "status") return { ok: true, status: status() };
        if (operation === "action" && "action" in body && body.action === "check")
          return { ok: true, status: staged };
        expect(operation).toBe("action");
        expect(body).toEqual({ action: "install", targetArtifactSha256: DIGEST });
        return { ok: true, status: waiting };
      }),
    );
    expect(result.phase).toBe("waiting");
    expect(result.blockers[0]?.reason).toBe("active-agents");
    expect(result.policy.automaticInstallation).toBe(false);
    expect(result.currentBuild.version).toBe("1.0.0");
  });

  it("propagates admission refusal rather than installing or restarting through a legacy path", async () => {
    let installations = 0;
    await expect(
      requestCoordinatedCliUpdate(
        { baseDir: "fixture" },
        ports(async (_target, operation, body) => {
          if (operation === "status") return { ok: true, status: status() };
          if (operation === "action" && "action" in body && body.action === "check")
            return { ok: true, status: staged };
          installations += 1;
          return {
            ok: false,
            reason: "Installation refused",
            blockers: [{ label: "Compaction has not finished" }],
          };
        }),
      ),
    ).rejects.toThrow("Compaction has not finished");
    expect(installations).toBe(1);
  });

  it("rejects a requested version that differs from the freshly verified target", async () => {
    await expect(
      requestCoordinatedCliUpdate(
        { baseDir: "fixture", requestedVersion: "0.9.0" },
        ports(async (_target, operation, body) => {
          if (operation === "status") return { ok: true, status: status() };
          expect(body).toEqual({ action: "check" });
          return { ok: true, status: staged };
        }),
      ),
    ).rejects.toThrow("not the verified staged target");
  });

  it("requires recorded recovery even when the old allow-downgrade flag was passed", async () => {
    await expect(
      requestCoordinatedCliUpdate(
        { baseDir: "fixture", allowDowngrade: true },
        {
          discover: async () => {
            throw new Error("must not contact an installer");
          },
          call: async () => {
            throw new Error("must not contact an installer");
          },
        },
      ),
    ).rejects.toThrow("recorded option");
  });

  it("keeps a pin while applying an explicit channel preference and never resumes automation", async () => {
    let pinned = status({
      phase: "pinned",
      policy: { ...staged.policy, pinnedBuild: "a".repeat(64) },
    });
    const result = await requestCoordinatedCliUpdate(
      { baseDir: "fixture", channel: "stable" },
      ports(async (_target, operation, body) => {
        if (operation === "status") return { ok: true, status: pinned };
        expect(operation).toBe("policy");
        expect(body).toEqual({ channel: "stable" });
        pinned = { ...pinned, policy: { ...pinned.policy, channel: "stable" } };
        return { ok: true, status: pinned };
      }),
    );
    expect(result.phase).toBe("pinned");
    expect(result.policy.pinnedBuild).toBe("a".repeat(64));
    expect(result.policy.automaticInstallation).toBe(false);
  });

  it("does not install when the feed has no eligible update", async () => {
    const result = await requestCoordinatedCliUpdate(
      { baseDir: "fixture" },
      ports(async (_target, operation, body) => {
        if (operation !== "status") expect(body).toEqual({ action: "check" });
        return { ok: true, status: status() };
      }),
    );
    expect(result.targetBuild).toBeNull();
  });

  it("fails closed on a real pre-updater home and preserves its installation", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-coordinated-"));
    roots.push(root);
    const installed = NodePath.join(root, "legacy-runtime");
    await NodeFSP.writeFile(installed, "existing build");
    await expect(requestCoordinatedCliUpdate({ baseDir: root })).rejects.toThrow(
      "No legacy installer was run",
    );
    expect(await NodeFSP.readFile(installed, "utf8")).toBe("existing build");
  });
});

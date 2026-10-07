import { renderToStaticMarkup } from "react-dom/server";
import { AuthSessionState, type EnvironmentId, type ForkUpdateStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  action: vi.fn(),
  bulk: vi.fn(),
  toast: vi.fn(),
  session: null as AsyncResult.AsyncResult<AuthSessionState, Error> | null,
  sessionAtom: Symbol("session"),
}));
vi.mock("../state/hostForkUpdates", () => ({
  hostForkUpdateController: () => ({ action: state.action }),
  requestHostUpdates: state.bulk,
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.session } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.session }));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { reactHookHarness as hooks } from "../test/reactHookHarness";
const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);
const session = decodeSessionState({
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
    serverUpdateScope: "environment:maintain",
  },
});
import {
  ServerUpdateAction,
  ServerUpdatesAction,
  serverUpdateStageLabel,
} from "./ServerUpdateAction";
const capability = {
  protocol: 1 as const,
  coordinatorId: "device",
  participantId: "service",
  admission: true,
  activityProtocol: 2,
  recovery: true,
};
const build = {
  version: "1.0.0",
  commit: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  channel: "nightly" as const,
};
const waiting: ForkUpdateStatus = {
  coordinatorId: "device",
  phase: "waiting",
  policy: { channel: "nightly", automaticInstallation: false, pinnedBuild: null },
  currentBuild: build,
  targetBuild: build,
  blockers: [{ participantId: "dev", reason: "commands", label: "Dev command is working" }],
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: false,
};
const target = {
  environmentId: "env-test" as EnvironmentId,
  serverLabel: "Laptop",
  selfUpdate: "boot-service" as const,
  forkMaintenance: capability,
  targetVersion: "1.0.0",
};
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
describe("server update actions", () => {
  beforeEach(() => {
    hooks.reset();
    state.action.mockReset().mockResolvedValue(waiting);
    state.bulk.mockReset();
    state.toast.mockReset();
    state.session = AsyncResult.success(session);
  });
  it("offers bootstrap guidance when admission capability is absent", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateAction {...target} forkMaintenance={undefined} />,
    );
    expect(markup).toContain("Bootstrap updater on");
    expect(markup).not.toContain("<button");
    expect(state.action).not.toHaveBeenCalled();
  });
  it("requests the verified artifact and reports waiting instead of successful installation", async () => {
    hooks.beginRender();
    const button = ServerUpdateAction(target);
    (button.props.onClick as () => void)();
    await settle();
    expect(state.action).toHaveBeenNthCalledWith(1, { action: "check" });
    expect(state.action).toHaveBeenNthCalledWith(2, {
      action: "install",
      targetArtifactSha256: build.artifactSha256,
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Laptop: waiting",
        description: expect.stringContaining("Dev command"),
      }),
    );
  });
  it("deduplicates double clicks while the host request is pending", async () => {
    let finish!: (value: ForkUpdateStatus) => void;
    state.action.mockImplementationOnce(
      () =>
        new Promise<ForkUpdateStatus>((resolve) => {
          finish = resolve;
        }),
    );
    hooks.beginRender();
    const button = ServerUpdateAction(target);
    (button.props.onClick as () => void)();
    (button.props.onClick as () => void)();
    expect(state.action).toHaveBeenCalledOnce();
    finish({ ...waiting, targetBuild: null });
    await settle();
    expect(state.toast).toHaveBeenCalledOnce();
  });
  it("routes bulk requests through the shared coordinator grouping and reports each result", async () => {
    state.bulk.mockResolvedValue([
      { label: "Laptop", failed: false, message: "waiting" },
      { label: "Deck", failed: true, message: "Offline" },
    ]);
    hooks.beginRender();
    const button = ServerUpdatesAction({
      targets: [
        target,
        { ...target, environmentId: "env-deck" as EnvironmentId, serverLabel: "Deck" },
      ],
    });
    (button.props.onClick as () => void)();
    await settle();
    expect(state.bulk).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledWith({
      type: "info",
      title: "Laptop",
      description: "waiting",
    });
    expect(state.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Deck",
      description: "Offline",
    });
  });
  it("keeps installing distinct from downloading", () => {
    expect(serverUpdateStageLabel("installing")).toBe("Installing…");
    expect(serverUpdateStageLabel("downloading")).toBe("Downloading…");
  });
});

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ForkUpdateStatus } from "@t3tools/contracts";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { ForkUpdateController } from "../../state/forkUpdates";
import { UpdateSafetyReviewDialog } from "./UpdateSafetyReviewDialog";
const status: ForkUpdateStatus = {
  coordinatorId: "laptop-fixture",
  phase: "waiting",
  policy: { channel: "nightly", automaticInstallation: false, pinnedBuild: null },
  currentBuild: {
    version: "1.0.0",
    commit: "a".repeat(40),
    artifactSha256: "b".repeat(64),
    channel: "nightly",
  },
  targetBuild: null,
  blockers: [],
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: true,
};
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
describe("update safety review", () => {
  beforeEach(() => hooks.reset());
  it("requires a separate explicit review before restored automation is released", async () => {
    const action = vi.fn(async () => ({ ...status, automationReviewRequired: false }));
    const policy = vi.fn(async () => status);
    const controller = new ForkUpdateController({
      status: async () => status,
      action,
      policy,
      recover: async () => status,
    });
    const onClose = vi.fn();
    const render = () => {
      hooks.beginRender();
      return UpdateSafetyReviewDialog({
        controller,
        device: "Laptop",
        review: "automation",
        onClose,
      });
    };
    let tree = render();
    const confirm = () =>
      (
        visitElements(tree, (element) => element.props.children === "Confirm review")!.props
          .onClick as () => void
      )();
    confirm();
    await settle();
    expect(action).not.toHaveBeenCalled();
    (
      visitElements(tree, (element) => element.props.type === "checkbox")!.props.onChange as (
        event: unknown,
      ) => void
    )({ target: { checked: true } });
    tree = render();
    confirm();
    await settle();
    expect(action).toHaveBeenCalledWith({ action: "acknowledge-automation-review" });
    expect(policy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("keeps the review open on host authorization failure", async () => {
    const controller = new ForkUpdateController({
      status: async () => status,
      action: async () => {
        throw new Error("Host administrative authorization required");
      },
      policy: async () => status,
      recover: async () => status,
    });
    const onClose = vi.fn();
    const render = () => {
      hooks.beginRender();
      return UpdateSafetyReviewDialog({
        controller,
        device: "Laptop",
        review: "bootstrap",
        onClose,
      });
    };
    let tree = render();
    (
      visitElements(tree, (element) => element.props.type === "checkbox")!.props.onChange as (
        event: unknown,
      ) => void
    )({ target: { checked: true } });
    tree = render();
    (
      visitElements(tree, (element) => element.props.children === "Confirm review")!.props
        .onClick as () => void
    )();
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      visitElements(render(), (element) => element.props.role === "alert")?.props.children,
    ).toContain("administrative authorization");
  });
});

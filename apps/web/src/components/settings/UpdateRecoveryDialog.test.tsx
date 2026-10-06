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
import { UpdateRecoveryDialog } from "./UpdateRecoveryDialog";
const build = {
  version: "1.0.0",
  commit: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  channel: "nightly" as const,
};
const option = {
  id: "recorded-point",
  transactionId: "recorded-transaction",
  build: { ...build, version: "0.9.0", artifactSha256: "c".repeat(64) },
  requiresDataRestore: true,
  homes: [
    {
      id: "wsl-home",
      label: "WSL development home",
      restoreTimestamp: "2026-10-01T00:00:00Z",
      binaryCompatible: false,
      additionalBytes: 1024,
      requiresPairing: true,
    },
  ],
};
const status: ForkUpdateStatus = {
  coordinatorId: "device",
  phase: "idle",
  policy: { channel: "nightly", automaticInstallation: false, pinnedBuild: null },
  currentBuild: build,
  targetBuild: null,
  blockers: [],
  recoveryOptions: [option],
  transactionId: null,
  automationReviewRequired: false,
};
function setup(fresh = status) {
  const recover = vi.fn(async () => status);
  const refresh = vi.fn(async () => fresh);
  const onClose = vi.fn();
  const controller = new ForkUpdateController({
    status: refresh,
    policy: async () => status,
    action: async () => status,
    recover,
  });
  controller.accept(status);
  const render = () => {
    hooks.beginRender();
    return UpdateRecoveryDialog({ device: "Laptop", controller, option, onClose });
  };
  return { recover, refresh, onClose, render };
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
describe("recovery confirmation interaction", () => {
  beforeEach(() => hooks.reset());
  it("requires acknowledgement and sends recorded identifiers and exact home cutoffs", async () => {
    const fixture = setup();
    let tree = fixture.render();
    let button = visitElements(tree, (e) => e.props.children === "Recover this device")!;
    expect(button.props.disabled).toBe(true);
    const checkbox = visitElements(tree, (e) => e.props.type === "checkbox")!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = fixture.render();
    button = visitElements(tree, (e) => e.props.children === "Recover this device")!;
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    await settle();
    expect(fixture.refresh).toHaveBeenCalledOnce();
    expect(fixture.recover).toHaveBeenCalledWith({
      optionId: option.id,
      transactionId: option.transactionId,
      restoreTimestamps: { "wsl-home": option.homes[0]!.restoreTimestamp },
      acknowledgeDataRestore: true,
    });
    expect(fixture.onClose).toHaveBeenCalledOnce();
  });
  it("rejects stale snapshot state instead of restoring a newly selected point", async () => {
    const fixture = setup({
      ...status,
      recoveryOptions: [
        { ...option, homes: [{ ...option.homes[0]!, restoreTimestamp: "2026-10-02T00:00:00Z" }] },
      ],
    });
    let tree = fixture.render();
    const checkbox = visitElements(tree, (e) => e.props.type === "checkbox")!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    tree = fixture.render();
    (
      visitElements(tree, (e) => e.props.children === "Recover this device")!.props
        .onClick as () => void
    )();
    await settle();
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.onClose).not.toHaveBeenCalled();
    expect(
      visitElements(fixture.render(), (e) => e.props.role === "alert")?.props.children,
    ).toContain("recovery point changed");
  });
  it("rejects a confirmation if the current installed build changed", async () => {
    const fixture = setup({
      ...status,
      currentBuild: { ...build, artifactSha256: "d".repeat(64) },
    });
    const tree = fixture.render();
    (
      visitElements(tree, (e) => e.props.children === "Recover this device")!.props
        .onClick as () => void
    )();
    await settle();
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(
      visitElements(fixture.render(), (e) => e.props.role === "alert")?.props.children,
    ).toContain("installed build changed");
  });
});

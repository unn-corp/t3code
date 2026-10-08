import { afterEach, assert, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { DesktopBridge } from "@t3tools/contracts";
import * as IpcChannels from "./ipc/channels.ts";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  sendSync: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, sendSync: mocks.sendSync },
  webFrame: {},
  webUtils: {},
}));
vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));

const loadBridge = async (): Promise<DesktopBridge> => {
  await import("./preload.ts");
  const call = mocks.expose.mock.calls.find(([name]) => name === "desktopBridge");
  assert.isDefined(call);
  return call![1] as DesktopBridge;
};

describe("desktop preload local environment controls", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.sendSync.mockImplementation(() => undefined);
    mocks.invoke.mockResolvedValue(undefined);
    vi.stubGlobal("window", { addEventListener: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("exposes the persisted local mode before the renderer bootstraps its primary session", async () => {
    mocks.sendSync.mockImplementation((channel) =>
      channel === IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL ? false : undefined,
    );
    const bridge = await loadBridge();
    assert.isFunction(bridge.getLocalEnvironmentEnabled);
    assert.isFalse(bridge.getLocalEnvironmentEnabled!());
    assert.isFunction(bridge.setLocalEnvironmentEnabled);
    assert.equal(mocks.invoke.mock.calls.length, 0);
  });

  it("forwards normal restart requests and preserves native lifecycle refusals", async () => {
    const bridge = await loadBridge();
    assert.isFunction(bridge.setLocalEnvironmentEnabled);
    await bridge.setLocalEnvironmentEnabled!(false);
    assert.deepEqual(mocks.invoke.mock.calls.at(-1), [
      IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
      false,
    ]);
    const refused = new Error("Local work must finish before restarting");
    mocks.invoke.mockRejectedValueOnce(refused);
    await expect(bridge.setLocalEnvironmentEnabled!(true)).rejects.toThrow(refused.message);
    assert.deepEqual(mocks.invoke.mock.calls.at(-1), [
      IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
      true,
    ]);
  });
});

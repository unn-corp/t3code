import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { usePwaNotificationSetup } from "./usePwaNotificationSetup";

const { getConfig, registerWorker } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  registerWorker: vi.fn(),
}));
vi.mock("./pwaPushRelay", () => ({ getPwaPushConfig: getConfig }));
vi.mock("../pwa", () => ({ registerPwaServiceWorker: registerWorker }));

let renderer: ReactTestRenderer;
let setup: ReturnType<typeof usePwaNotificationSetup>;
let page: EventTarget & { visibilityState: string };
let browser: EventTarget;

function Probe() {
  const value = usePwaNotificationSetup();
  useLayoutEffect(() => {
    setup = value;
  });
  return null;
}

beforeEach(() => {
  getConfig.mockReset().mockResolvedValue("push-key");
  registerWorker.mockReset().mockResolvedValue({ type: "ready" });
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  browser = new EventTarget();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", browser);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each(["online", "focus", "visibilitychange"])(
  "recovers failed push configuration on %s without reloading",
  async (event) => {
    getConfig.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      renderer = create(<Probe />);
    });
    expect(setup.vapidPublicKey).toBeNull();
    expect(setup.isConfigLoading).toBe(false);
    await act(async () => {
      (event === "visibilitychange" ? page : browser).dispatchEvent(new Event(event));
    });
    expect(setup.vapidPublicKey).toBe("push-key");
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(registerWorker).toHaveBeenCalledTimes(2);
    await act(async () => browser.dispatchEvent(new Event("focus")));
    expect(getConfig).toHaveBeenCalledTimes(2);
  },
);

it("allows an enable interaction to retry a failed preload", async () => {
  getConfig.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    renderer = create(<Probe />);
  });
  await act(async () => setup.retry());
  expect(setup.vapidPublicKey).toBe("push-key");
});

it("deduplicates recovery events during a pending configuration request", async () => {
  let resolveConfig: (key: string) => void = () => {};
  getConfig.mockReturnValue(new Promise<string>((resolve) => (resolveConfig = resolve)));
  await act(async () => {
    renderer = create(<Probe />);
    browser.dispatchEvent(new Event("focus"));
    browser.dispatchEvent(new Event("online"));
  });
  expect(getConfig).toHaveBeenCalledOnce();
  expect(setup.isConfigLoading).toBe(true);
  await act(async () => resolveConfig("push-key"));
  expect(setup.vapidPublicKey).toBe("push-key");
  expect(setup.isConfigLoading).toBe(false);
});

it("stops retrying after unmount", async () => {
  getConfig.mockRejectedValue(new Error("offline"));
  await act(async () => {
    renderer = create(<Probe />);
  });
  act(() => renderer.unmount());
  browser.dispatchEvent(new Event("online"));
  page.dispatchEvent(new Event("visibilitychange"));
  expect(getConfig).toHaveBeenCalledOnce();
});

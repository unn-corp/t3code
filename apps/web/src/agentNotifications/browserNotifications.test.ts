import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { subscribeBrowserPush } from "./browserNotifications";

const { getRegistration, registerWorker } = vi.hoisted(() => ({
  getRegistration: vi.fn(),
  registerWorker: vi.fn(),
}));
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("../pwa", () => ({
  getActivePwaServiceWorkerRegistration: getRegistration,
  registerPwaServiceWorker: registerWorker,
}));

beforeEach(() => {
  getRegistration.mockReset();
  registerWorker.mockReset().mockResolvedValue({ type: "ready" });
  vi.stubGlobal("window", {
    isSecureContext: true,
    Notification: {},
    matchMedia: () => ({ matches: true }),
  });
  vi.stubGlobal("navigator", { serviceWorker: {} });
  vi.stubGlobal("Notification", { permission: "granted" });
});

afterEach(() => vi.unstubAllGlobals());

it("prepares a missing worker so another enable tap can succeed without reloading", async () => {
  getRegistration.mockReturnValue(null);
  const result = subscribeBrowserPush({ applicationServerKey: "AQID" });
  expect(registerWorker).toHaveBeenCalledOnce();
  expect(await result).toEqual({ state: "worker-failed", subscription: null });

  const subscription = { endpoint: "https://push.example/installation" };
  const subscribe = vi.fn().mockResolvedValue(subscription);
  getRegistration.mockReturnValue({ pushManager: { subscribe } });
  const retry = subscribeBrowserPush({ applicationServerKey: "AQID" });
  // The browser must see subscribe synchronously, while the iOS gesture is active.
  expect(subscribe).toHaveBeenCalledOnce();
  expect(await retry).toEqual({ state: "subscribed", subscription });
  expect(registerWorker).toHaveBeenCalledOnce();
});

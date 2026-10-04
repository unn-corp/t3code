import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./env", () => ({ isElectron: false }));

const registration = { active: {}, installing: null, waiting: null };
const register = vi.fn();
const reload = vi.fn();

beforeEach(() => {
  vi.resetModules();
  register.mockReset().mockResolvedValue(registration);
  reload.mockReset();
  vi.stubGlobal("navigator", { serviceWorker: { register } });
  vi.stubGlobal("window", {
    isSecureContext: true,
    setTimeout,
    clearTimeout,
    location: {
      origin: "https://t3.example",
      href: "https://t3.example/threads/remote/thread-1?panel=files#entry-2",
      reload,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retries a failed registration without a reload and shares successful setup", async () => {
  register.mockRejectedValueOnce(new Error("offline"));
  const pwa = await import("./pwa");
  expect(await pwa.registerPwaServiceWorker()).toMatchObject({ type: "failed" });
  expect(pwa.getActivePwaServiceWorkerRegistration()).toBeNull();

  const retry = pwa.registerPwaServiceWorker();
  expect(pwa.registerPwaServiceWorker()).toBe(retry);
  expect(await retry).toEqual({ type: "ready", registration });
  expect(pwa.getActivePwaServiceWorkerRegistration()).toBe(registration);
  expect(pwa.registerPwaServiceWorker()).toBe(retry);
  expect(register).toHaveBeenCalledTimes(2);
});

it("recovers after slow worker activation times out", async () => {
  vi.useFakeTimers();
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const worker = Object.assign(new EventTarget(), { state: "installing" });
  const slowRegistration = { active: null as object | null, installing: worker, waiting: null };
  register.mockResolvedValue(slowRegistration);
  const pwa = await import("./pwa");
  const first = pwa.registerPwaServiceWorker();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await first).toMatchObject({ type: "failed" });
  slowRegistration.active = worker;
  worker.state = "activated";
  worker.dispatchEvent(new Event("statechange"));
  expect(await pwa.registerPwaServiceWorker()).toEqual({
    type: "ready",
    registration: slowRegistration,
  });
});

it("clears stale workers and caches while preserving the full thread URL", async () => {
  const unregister = vi.fn().mockResolvedValue(true);
  Object.assign(navigator.serviceWorker, {
    getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
  });
  const deleteCache = vi.fn().mockResolvedValue(true);
  Object.assign(window, { caches: { keys: async () => ["old-shell"], delete: deleteCache } });
  const { clearPwaCachesAndReload } = await import("./pwa");
  await clearPwaCachesAndReload();
  expect(unregister).toHaveBeenCalledOnce();
  expect(deleteCache).toHaveBeenCalledWith("old-shell");
  expect(reload).toHaveBeenCalledOnce();
  expect(window.location.href).toBe(
    "https://t3.example/threads/remote/thread-1?panel=files#entry-2",
  );
});

it("still refreshes the same URL when cache cleanup is refused", async () => {
  Object.assign(navigator.serviceWorker, {
    getRegistrations: vi.fn().mockRejectedValue(new Error("denied")),
  });
  Object.assign(window, { caches: { keys: vi.fn().mockRejectedValue(new Error("denied")) } });
  const { clearPwaCachesAndReload } = await import("./pwa");
  await clearPwaCachesAndReload();
  expect(reload).toHaveBeenCalledOnce();
});

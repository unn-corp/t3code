import { afterEach, expect, it, vi } from "vite-plus/test";

import { isInstalledPwa } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("uses installed-PWA behavior inside the bundled Android WebView", async () => {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), navigator: {} });
  expect(isInstalledPwa()).toBe(false);
  vi.stubEnv("VITE_ANDROID_PWA", "1");
  vi.resetModules();
  const android = await import("./env");
  expect(android.isInstalledPwa()).toBe(true);
});

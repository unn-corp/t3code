// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_ANDROID_PWA", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  delete window.t3Browser;
});
function bridge() {
  const sent: { id: string; action: string }[] = [];
  window.t3Browser = { postMessage: (raw) => sent.push(JSON.parse(raw)), onmessage: null };
  return {
    sent,
    reply: (response: unknown) => window.t3Browser!.onmessage!({ data: JSON.stringify(response) }),
  };
}
it("routes concurrent native replies and reports native failures", async () => {
  const native = bridge();
  const { androidBrowserRequest } = await import("./browser");
  const first = androidBrowserRequest("command"),
    second = androidBrowserRequest("ensure");
  native.reply({ id: native.sent[1]!.id, result: { available: true } });
  native.reply({ id: native.sent[0]!.id, error: "Tab closed" });
  await expect(second).resolves.toEqual({ available: true });
  await expect(first).rejects.toThrow("Tab closed");
});
it("tracks actual native tab presentation and removes closed tabs", async () => {
  const native = bridge();
  const {
    androidBrowserRequest,
    subscribeAndroidBrowser,
    closeAndroidBrowserTab,
    useAndroidBrowserTabs,
  } = await import("./browser");
  const listener = vi.fn();
  const unsubscribe = subscribeAndroidBrowser(listener);
  const initial = androidBrowserRequest("ensure");
  native.reply({ id: native.sent[0]!.id, result: {} });
  await initial;
  native.reply({
    event: { key: "one", environmentId: "env", threadId: "thread", tabId: "tab", visible: false },
  });
  native.reply({ presentation: { key: "one", visible: true } });
  expect(useAndroidBrowserTabs.getState().tabs.one!.visible).toBe(true);
  native.reply({ foreground: false });
  expect(useAndroidBrowserTabs.getState().foreground).toBe(false);
  const closing = closeAndroidBrowserTab("one");
  native.reply({ id: native.sent[1]!.id, result: {} });
  await closing;
  expect(useAndroidBrowserTabs.getState().tabs.one).toBeUndefined();
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
});
it("keeps tab identity separate across environments and server restarts", async () => {
  const { androidBrowserKey } = await import("./browser");
  expect(androidBrowserKey("one", "epoch", "thread", "tab")).not.toBe(
    androidBrowserKey("two", "epoch", "thread", "tab"),
  );
  expect(androidBrowserKey("one", "epoch", "thread", "tab")).not.toBe(
    androidBrowserKey("one", "new-epoch", "thread", "tab"),
  );
});
it("times out lost messages and does not enable the bridge in ordinary browsers", async () => {
  vi.useFakeTimers();
  bridge();
  const { androidBrowserRequest } = await import("./browser");
  const failed = expect(androidBrowserRequest("command", {}, 100)).rejects.toThrow(
    "did not respond",
  );
  await vi.advanceTimersByTimeAsync(100);
  await failed;
  vi.stubEnv("VITE_ANDROID_PWA", "0");
  vi.resetModules();
  const regular = await import("./browser");
  await expect(regular.androidBrowserRequest("ensure")).rejects.toThrow("Update");
});

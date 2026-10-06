// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_ANDROID_PWA", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  delete window.t3Notifications;
});

function native() {
  const sent: { id: string; action: string; payload?: unknown }[] = [];
  window.t3Notifications = { postMessage: (raw) => sent.push(JSON.parse(raw)), onmessage: null };
  return {
    sent,
    reply: (id: string, result: unknown) =>
      window.t3Notifications?.onmessage?.({ data: JSON.stringify({ id, result }) }),
  };
}

it("matches concurrent replies to their requests and tolerates unrelated messages", async () => {
  const bridge = native();
  const { androidNotificationRequest } = await import("./notifications");
  const first = androidNotificationRequest("status");
  const second = androidNotificationRequest("background", { enabled: true });
  window.t3Notifications?.onmessage?.({ data: "invalid" });
  bridge.reply("unrelated", { permission: "ready", background: true });
  bridge.reply(bridge.sent[1]!.id, { permission: "ready", background: true });
  bridge.reply(bridge.sent[0]!.id, { permission: "permission-needed", background: false });
  await expect(first).resolves.toEqual({ permission: "permission-needed", background: false });
  await expect(second).resolves.toEqual({ permission: "ready", background: true });
});
it("propagates native permission errors without enabling notifications", async () => {
  const bridge = native();
  const { androidNotificationRequest } = await import("./notifications");
  const promise = androidNotificationRequest("requestPermission");
  window.t3Notifications?.onmessage?.({
    data: JSON.stringify({ id: bridge.sent[0]!.id, error: "Permission blocked" }),
  });
  await expect(promise).rejects.toThrow("Permission blocked");
});
it("times out a lost native response and ignores its eventual reply", async () => {
  vi.useFakeTimers();
  const bridge = native();
  const { androidNotificationRequest } = await import("./notifications");
  const promise = androidNotificationRequest("status");
  const failure = expect(promise).rejects.toThrow("did not respond");
  await vi.advanceTimersByTimeAsync(60_000);
  await failure;
  bridge.reply(bridge.sent[0]!.id, { permission: "ready", background: false });
});
it("does not expose native notification requests in a regular browser", async () => {
  native();
  vi.stubEnv("VITE_ANDROID_PWA", "0");
  const { androidNotificationRequest } = await import("./notifications");
  await expect(androidNotificationRequest("configure", {})).rejects.toThrow("unavailable");
});

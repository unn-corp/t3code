// @effect-diagnostics nodeBuiltinImport:off - Executes the shipped worker in an isolated Node context.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

const workerSource = NodeFS.readFileSync(
  new URL("../public/service-worker.js", import.meta.url),
  "utf8",
);
const origin = "https://t3.example";
const deepLink = "/threads/remote/thread-1";

function client(path: string) {
  return {
    url: `${origin}${path}`,
    focus: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
  };
}

async function clickNotification(openClients: ReturnType<typeof client>[], link = deepLink) {
  const event = {
    notification: { close: vi.fn(), data: { deepLink: link } },
    waitUntil: vi.fn<(work: Promise<unknown>) => void>(),
  };
  const handlers = new Map<string, (notificationEvent: typeof event) => void>();
  const openWindow = vi.fn().mockResolvedValue(undefined);
  NodeVM.runInNewContext(workerSource, {
    URL,
    self: {
      location: { origin },
      addEventListener: (name: string, handler: (notificationEvent: typeof event) => void) =>
        handlers.set(name, handler),
    },
    clients: { matchAll: async () => openClients, openWindow },
  });
  handlers.get("notificationclick")?.(event);
  await event.waitUntil.mock.calls[0]?.[0];
  return { openWindow, event };
}

it("focuses the matching thread without reloading it, even when another tab comes first", async () => {
  const other = client("/threads/remote/thread-2");
  const matching = client(`${deepLink}?panel=files#entry-2`);
  const { openWindow } = await clickNotification([other, matching]);
  expect(matching.focus).toHaveBeenCalledOnce();
  expect(matching.navigate).not.toHaveBeenCalled();
  expect(other.focus).not.toHaveBeenCalled();
  expect(openWindow).not.toHaveBeenCalled();
});

it("navigates an existing same-origin tab when the target thread is not open", async () => {
  const other = client("/");
  await clickNotification([other]);
  expect(other.focus).toHaveBeenCalledOnce();
  expect(other.navigate).toHaveBeenCalledWith(deepLink);
});

it("opens a new window when there is no same-origin tab", async () => {
  const foreign = { ...client("/"), url: "https://other.example/" };
  const { openWindow } = await clickNotification([foreign]);
  expect(openWindow).toHaveBeenCalledWith(deepLink);
  expect(foreign.focus).not.toHaveBeenCalled();
});

it.each(["https://other.example/", "/threads/remote%2Fother/thread-1", "/settings"])(
  "ignores an invalid notification destination: %s",
  async (link) => {
    const existing = client("/");
    const { openWindow, event } = await clickNotification([existing], link);
    expect(event.waitUntil).not.toHaveBeenCalled();
    expect(existing.navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  },
);

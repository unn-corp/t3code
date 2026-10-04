// @effect-diagnostics nodeBuiltinImport:off - Executes the shipped worker in an isolated Node context.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

const workerSource = NodeFS.readFileSync(
  new URL("../public/service-worker.js", import.meta.url),
  "utf8",
);
const origin = "https://t3.example";
const deepLink = "/remote/thread-1";

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
  const other = client("/remote/thread-2");
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

it("translates a saved legacy notification to the canonical thread URL", async () => {
  const other = client("/");
  await clickNotification([other], "/threads/remote/thread-1");
  expect(other.navigate).toHaveBeenCalledWith(deepLink);
});

it("focuses a canonical thread tab for a legacy notification", async () => {
  const matching = client(deepLink);
  await clickNotification([matching], "/threads/remote/thread-1");
  expect(matching.focus).toHaveBeenCalledOnce();
  expect(matching.navigate).not.toHaveBeenCalled();
});

it.each(["/threads/remote%20host/thread%3A1", "/remote%20host/thread%3A1"])(
  "preserves encoded thread identifiers: %s",
  async (link) => {
    const matching = client("/remote%20host/thread%3A1");
    await clickNotification([matching], link);
    expect(matching.focus).toHaveBeenCalledOnce();
    expect(matching.navigate).not.toHaveBeenCalled();
  },
);

it("opens the app root for a generic notification", async () => {
  const { openWindow } = await clickNotification([], "/");
  expect(openWindow).toHaveBeenCalledWith("/");
});

it("stores a canonical destination when receiving a push without exposing private titles", async () => {
  const event = {
    data: { json: () => ({ deepLink: "/threads/remote/thread-1", title: "Private thread" }) },
    waitUntil: vi.fn<(work: Promise<unknown>) => void>(),
  };
  const handlers = new Map<string, (pushEvent: typeof event) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  NodeVM.runInNewContext(workerSource, {
    self: {
      registration: { showNotification },
      addEventListener: (name: string, handler: (pushEvent: typeof event) => void) =>
        handlers.set(name, handler),
    },
  });
  handlers.get("push")?.(event);
  await event.waitUntil.mock.calls[0]?.[0];
  expect(showNotification).toHaveBeenCalledWith("T3 Code", {
    body: "Agent activity needs your attention.",
    data: { deepLink },
    tag: undefined,
  });
});

it("activates worker updates without waiting for existing app windows to close", async () => {
  const handlers = new Map<
    string,
    (event: { waitUntil: (work: Promise<unknown>) => void }) => void
  >();
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);
  NodeVM.runInNewContext(workerSource, {
    self: {
      skipWaiting,
      addEventListener: (
        name: string,
        handler: (event: { waitUntil: (work: Promise<unknown>) => void }) => void,
      ) => handlers.set(name, handler),
    },
    clients: { claim },
  });
  const pending: Promise<unknown>[] = [];
  const event = { waitUntil: (work: Promise<unknown>) => pending.push(work) };
  handlers.get("install")?.(event);
  handlers.get("activate")?.(event);
  await Promise.all(pending);
  expect(skipWaiting).toHaveBeenCalledOnce();
  expect(claim).toHaveBeenCalledOnce();
  expect(pending).toHaveLength(2);
});

it.each([
  "/remote%2Fother/thread-1",
  "/remote%5Cother/thread-1",
  "/remote%zz/thread-1",
  "/remote%FF/thread-1",
  "/remote/thread-1?token=x",
  "/remote/thread-1/extra",
  "/../thread-1",
  "/%2e%2e/thread-1",
  "/threads/remote/..",
  "/threads/remote\\other/thread-1",
])("rejects an unsafe thread destination: %s", async (link) => {
  const existing = client("/");
  const { event, openWindow } = await clickNotification([existing], link);
  expect(event.waitUntil).not.toHaveBeenCalled();
  expect(existing.navigate).not.toHaveBeenCalled();
  expect(openWindow).not.toHaveBeenCalled();
});

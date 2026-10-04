import { expect, it, vi } from "vite-plus/test";
import { installBrowserConnectionWakeups } from "./browserWakeups";

function browser() {
  const page = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const wake = vi.fn();
  const dispose = installBrowserConnectionWakeups(page, document, wake);
  return { page, document, wake, dispose };
}

it.each(["focus", "resume", "pageshow"])(
  "checks a resumed connection after %s without requiring a visibility change",
  async (type) => {
    const { page, document, wake, dispose } = browser();
    const event = Object.assign(new Event(type), { persisted: true });
    (type === "resume" ? document : page).dispatchEvent(event);
    await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(1);
    dispose();
  },
);

it("checks once when one return raises resume, pageshow, visibility and focus together", async () => {
  const { page, document, wake, dispose } = browser();
  document.dispatchEvent(new Event("resume"));
  page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  document.dispatchEvent(new Event("visibilitychange"));
  page.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(wake).toHaveBeenCalledTimes(1);
  dispose();
});

it("does not probe a hidden resume or a fresh page's initial pageshow", async () => {
  const { page, document, wake, dispose } = browser();
  page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
  await Promise.resolve();
  expect(wake).not.toHaveBeenCalled();
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("resume"));
  page.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(wake).not.toHaveBeenCalled();
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(wake).toHaveBeenCalledTimes(1);
  dispose();
});

it("cancels a queued return when disposed and ignores later events", async () => {
  const { page, document, wake, dispose } = browser();
  document.dispatchEvent(new Event("visibilitychange"));
  dispose();
  await Promise.resolve();
  page.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("resume"));
  document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(wake).not.toHaveBeenCalled();
});

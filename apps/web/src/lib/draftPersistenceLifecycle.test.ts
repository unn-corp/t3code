import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDeferredStorage, createMemoryStorage } from "./storage";
import { installDraftPersistenceLifecycle } from "./draftPersistenceLifecycle";

afterEach(() => vi.useRealTimers());
it.each(["pagehide", "hidden", "freeze"])(
  "retains the final keystroke when the PWA leaves through %s before the debounce fires",
  (event) => {
    vi.useFakeTimers();
    const base = createMemoryStorage();
    const writes: string[] = [];
    const storage = createDeferredStorage(base, (value: { prompt: string }) => {
      const saved = JSON.stringify(value);
      writes.push(saved);
      return saved;
    });
    const page = new EventTarget();
    const visibility = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const dispose = installDraftPersistenceLifecycle(page, visibility, () => storage.flush());
    storage.setItem("draft", { prompt: "Keep the final keystroke" });
    expect(base.getItem("draft")).toBeNull();
    if (event === "hidden") {
      visibility.visibilityState = "hidden";
      visibility.dispatchEvent(new Event("visibilitychange"));
    } else if (event === "freeze") visibility.dispatchEvent(new Event("freeze"));
    else page.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(base.getItem("draft") as string)).toEqual({
      prompt: "Keep the final keystroke",
    });
    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(1);
    dispose();
  },
);
it("leaves ordinary typing debounced when visibility remains visible", () => {
  vi.useFakeTimers();
  const base = createMemoryStorage();
  const storage = createDeferredStorage(base, JSON.stringify);
  const page = new EventTarget();
  const visibility = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const dispose = installDraftPersistenceLifecycle(page, visibility, () => storage.flush());
  storage.setItem("draft", { prompt: "Still typing" });
  visibility.dispatchEvent(new Event("visibilitychange"));
  expect(base.getItem("draft")).toBeNull();
  vi.advanceTimersByTime(300);
  expect(JSON.parse(base.getItem("draft") as string)).toEqual({ prompt: "Still typing" });
  dispose();
});

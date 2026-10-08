import { EnvironmentId, ThreadId, type DesktopPreviewAnnotationSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createPreviewAnnotationEditorStore } from "./previewAnnotationEditorStore";
import { createMemoryStorage } from "./lib/storage";

const target = {
  environmentId: EnvironmentId.make("annotation-server"),
  threadId: ThreadId.make("annotation-thread"),
};
const snapshot: DesktopPreviewAnnotationSnapshot = {
  pageUrl: "https://example.com/original",
  pageTitle: "Original page",
  createdAt: "2026-10-08T00:00:00.000Z",
  width: 800,
  height: 600,
  elements: [],
  screenshot: {
    dataUrl: "data:image/png;base64,aW1hZ2U=",
    width: 1600,
    height: 1200,
    cropRect: { x: 0, y: 0, width: 800, height: 600 },
  },
};

describe("durable annotation draft", () => {
  it("restores the screenshot, marks, comment and original thread after client reload", () => {
    const storage = createMemoryStorage();
    const first = createPreviewAnnotationEditorStore(storage);
    const id = first.getState().begin(target, "original-tab")!;
    first.getState().complete(id, snapshot);
    first.getState().update(id, (annotation) => ({
      ...annotation,
      comment: "Make the button blue",
      regions: [{ id: "region-1", rect: { x: 12, y: 20, width: 30, height: 40 } }],
    }));
    const saved = first.getState().session;
    const restored = createPreviewAnnotationEditorStore(storage);
    expect(restored.getState().session).toEqual(saved);
    expect(
      restored
        .getState()
        .begin({ ...target, threadId: ThreadId.make("another-thread") }, "new-page"),
    ).toBeNull();
    expect(restored.getState().session).toEqual(saved);
    restored.getState().discard(id, false);
    expect(restored.getState().session).toEqual(saved);
    restored.getState().discard(id, true);
    expect(restored.getState().session).toBeNull();
    expect(createPreviewAnnotationEditorStore(storage).getState().session).toBeNull();
  });

  it("never lets cancelled capture or transcription results change a replacement annotation", () => {
    const store = createPreviewAnnotationEditorStore(createMemoryStorage());
    const old = store.getState().begin(target, "old-tab")!;
    store.getState().discard(old, true);
    const current = store.getState().begin(target, "new-tab")!;
    store.getState().complete(current, snapshot);
    store.getState().complete(old, { ...snapshot, pageTitle: "Late old page" });
    store.getState().fail(old, "Late failure");
    store.getState().update(old, (annotation) => ({ ...annotation, comment: "Late transcript" }));
    const session = store.getState().session;
    expect(session?.id).toBe(current);
    expect(session?.status === "ready" && session.annotation.comment).toBe("");
    expect(session?.status === "ready" && session.snapshot.pageTitle).toBe("Original page");
  });

  it("keeps capture failures open and restores interrupted captures as recoverable errors", () => {
    const storage = createMemoryStorage();
    const store = createPreviewAnnotationEditorStore(storage);
    const id = store.getState().begin(target, "tab")!;
    const restored = createPreviewAnnotationEditorStore(storage);
    expect(restored.getState().session).toMatchObject({ id, status: "error", threadRef: target });
    store.getState().fail(id, "Page changed during capture");
    expect(store.getState().session).toMatchObject({
      id,
      status: "error",
      error: "Page changed during capture",
    });
  });
});

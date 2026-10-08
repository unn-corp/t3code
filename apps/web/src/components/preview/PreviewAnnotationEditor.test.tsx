// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type DesktopPreviewAnnotationSnapshot } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PreviewAnnotationEditorHost } from "./PreviewAnnotationEditor";
import {
  usePreviewAnnotationEditorStore,
  usePreviewAnnotationSenders,
  registerPreviewAnnotationSender,
} from "~/previewAnnotationEditorStore";

const mocks = vi.hoisted(() => ({
  addAnnotation: vi.fn(),
  addImage: vi.fn(),
  render: vi.fn(),
  send: vi.fn(),
  keybinds: [],
  canSend: true,
}));
vi.mock("~/composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: {
    getState: () => ({ addPreviewAnnotation: mocks.addAnnotation, addImage: mocks.addImage }),
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({
    dictationMicrophoneDeviceId: "default",
    dictationStartKeybinds: mocks.keybinds,
    dictationEndKeybinds: mocks.keybinds,
  }),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => mocks.canSend,
  readEnvironmentScope: () => mocks.canSend,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/lib/previewAnnotationEditor", async (original) => ({
  ...(await original<typeof import("~/lib/previewAnnotationEditor")>()),
  renderAnnotationScreenshot: mocks.render,
}));

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
    width: 800,
    height: 600,
    cropRect: { x: 0, y: 0, width: 800, height: 600 },
  },
};
let root: Root;
let container: HTMLDivElement;
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent === text)!;
const click = async (text: string) => act(async () => button(text).click());

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.addAnnotation.mockReset();
  mocks.addImage.mockReset();
  mocks.send.mockReset();
  mocks.render.mockReset().mockImplementation(async (annotation) => annotation);
  mocks.canSend = true;
  usePreviewAnnotationEditorStore.setState({ session: null, hydrated: true });
  usePreviewAnnotationSenders.setState({ senders: new Map() });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const id = usePreviewAnnotationEditorStore.getState().begin(target, "original-tab")!;
  usePreviewAnnotationEditorStore.getState().complete(id, snapshot);
  usePreviewAnnotationEditorStore
    .getState()
    .update(id, (annotation) => ({ ...annotation, comment: "Make it smaller" }));
  await act(async () => root.render(<PreviewAnnotationEditorHost />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePreviewAnnotationEditorStore.setState({ session: null });
  vi.unstubAllGlobals();
});

it("requires approval to discard after Escape and allows the user to keep editing", async () => {
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(usePreviewAnnotationEditorStore.getState().session?.status).toBe("ready");
  await click("Keep editing");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Make it smaller");
  expect(document.querySelector<HTMLImageElement>("img")?.src).toBe(snapshot.screenshot.dataUrl);
  await click("Close");
  expect(usePreviewAnnotationEditorStore.getState().session).not.toBeNull();
  await click("Discard annotation");
  expect(usePreviewAnnotationEditorStore.getState().session).toBeNull();
});

it("retains the frozen draft after route changes and attachment failure, then attaches explicitly", async () => {
  await act(async () =>
    root.render(
      <>
        <PreviewAnnotationEditorHost />
        <div>New preview page</div>
      </>,
    ),
  );
  expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Make it smaller");
  mocks.render.mockRejectedValueOnce(new Error("Image decoding failed"));
  await click("Attach to draft");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Image decoding failed");
  expect(usePreviewAnnotationEditorStore.getState().session?.status).toBe("ready");
  expect(mocks.addAnnotation).not.toHaveBeenCalled();
  await click("Attach to draft");
  expect(mocks.addAnnotation).toHaveBeenCalledWith(
    target,
    expect.objectContaining({
      comment: "Make it smaller",
      pageUrl: snapshot.pageUrl,
      screenshot: snapshot.screenshot,
    }),
  );
  expect(mocks.addImage).toHaveBeenCalledWith(
    target,
    expect.objectContaining({ type: "image", previewUrl: snapshot.screenshot.dataUrl }),
  );
  expect(usePreviewAnnotationEditorStore.getState().session).toBeNull();
});

it("sends the original snapshot through the registered thread composer on Ctrl+Enter", async () => {
  let unregister!: () => void;
  await act(async () => {
    unregister = registerPreviewAnnotationSender(target, mocks.send);
  });
  try {
    await act(async () =>
      document
        .querySelector("textarea")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
        ),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ comment: "Make it smaller", pageUrl: snapshot.pageUrl }),
      expect.objectContaining({ type: "image", previewUrl: snapshot.screenshot.dataUrl }),
    );
    expect(usePreviewAnnotationEditorStore.getState().session).toBeNull();
  } finally {
    unregister();
  }
});

it("keeps Send unavailable when the original thread composer is no longer mounted", async () => {
  expect(button("Send annotation").disabled).toBe(true);
  await act(async () =>
    document
      .querySelector("textarea")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })),
  );
  expect(mocks.render).not.toHaveBeenCalled();
  expect(usePreviewAnnotationEditorStore.getState().session?.status).toBe("ready");
});

it("resizes the comment from the outside handle with keyboard access and preserves the draft", async () => {
  const handle = document.querySelector<HTMLButtonElement>(
    '[aria-label="Resize annotation composer"]',
  )!;
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(textarea.style.height).toBe("128px");
  await act(async () =>
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  expect(textarea.style.height).toBe("152px");
  for (let i = 0; i < 5; i++) {
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
    );
  }
  expect(textarea.style.height).toBe("96px");
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  const pointer = (type: string, y: number, id = 1) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientY: y });
    Object.defineProperty(event, "pointerId", { value: id });
    return event;
  };
  await act(async () => handle.dispatchEvent(pointer("pointerdown", 100)));
  await act(async () => handle.dispatchEvent(pointer("pointermove", 170, 2)));
  expect(textarea.style.height).toBe("96px");
  await act(async () => handle.dispatchEvent(pointer("pointermove", 170)));
  expect(textarea.style.height).toBe("166px");
  await act(async () => handle.dispatchEvent(pointer("pointerup", 170)));
  await act(async () => handle.dispatchEvent(pointer("pointermove", 240)));
  expect(textarea.style.height).toBe("166px");
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(textarea.value).toBe("Make it smaller");
  expect(usePreviewAnnotationEditorStore.getState().session?.status).toBe("ready");
});

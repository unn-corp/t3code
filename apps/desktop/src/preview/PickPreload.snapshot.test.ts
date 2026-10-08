// @vitest-environment jsdom
import type { DesktopPreviewAnnotationPage } from "@t3tools/contracts";
import {
  CAPTURE_ANNOTATION_PAGE_CHANNEL,
  ANNOTATION_PAGE_CAPTURED_CHANNEL,
} from "./GuestProtocol.ts";
import { expect, it, vi } from "vite-plus/test";

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: (...args: unknown[]) => void) =>
      ipc.handlers.set(channel, handler),
    send: ipc.send,
  },
}));
vi.mock("react-grab/primitives", () => ({ getElementContext: vi.fn(async () => null) }));

it("extracts visible page details into a bounded snapshot independent of subsequent page changes", async () => {
  document.title = "Captured page";
  document.body.innerHTML =
    '<button id="target">Original label</button><div id="hidden" style="display:none">Hidden</div><div data-t3code-annotation-ui="true">Editor chrome</div>';
  const target = document.querySelector("button")!;
  const rect = {
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    top: 20,
    left: 10,
    bottom: 60,
    right: 110,
    toJSON: () => ({}),
  };
  for (const element of document.querySelectorAll("body *"))
    element.getBoundingClientRect = () => rect;
  await import("./PickPreload.ts");
  const capture = () =>
    new Promise<DesktopPreviewAnnotationPage>((resolve) => {
      ipc.send.mockImplementation((channel, id, page) => {
        if (channel === ANNOTATION_PAGE_CAPTURED_CHANNEL && id === "test-capture") resolve(page);
      });
      ipc.handlers.get(CAPTURE_ANNOTATION_PAGE_CHANNEL)!({}, "test-capture");
    });
  expect(Reflect.has(globalThis, "__t3CaptureAnnotationPage")).toBe(false);
  const snapshot = await capture();
  expect(snapshot).toMatchObject({
    pageTitle: "Captured page",
    width: window.innerWidth,
    height: window.innerHeight,
  });
  expect(snapshot.elements).toHaveLength(1);
  expect(snapshot.elements[0]).toMatchObject({
    rect: { x: 10, y: 20, width: 100, height: 40 },
    element: { tagName: "button", htmlPreview: '<button id="target">Original label</button>' },
  });
  target.textContent = "Replacement label";
  document.title = "Next page";
  expect(snapshot.elements[0]?.element.htmlPreview).toContain("Original label");
  expect(snapshot.pageTitle).toBe("Captured page");

  document.body.innerHTML = Array.from(
    { length: 300 },
    (_, index) => `<button>${index}</button>`,
  ).join("");
  for (const element of document.querySelectorAll("button"))
    element.getBoundingClientRect = () => rect;
  expect((await capture()).elements).toHaveLength(256);
});

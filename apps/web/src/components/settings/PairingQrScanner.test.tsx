// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { PairingQrScanner } from "./PairingQrScanner";

vi.mock("jsqr", () => ({
  default: () => ({ data: "https://host.tailnet.ts.net/pair#token=PHONECODE" }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("fills the scanned pairing URL once and releases the camera before handing it to Connections", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stop = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }),
    // The scanner asks for 2d; the DOM declaration's final overload is WebGPU.
  } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  const onScan = vi.fn(() => expect(stop).toHaveBeenCalledOnce());
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<PairingQrScanner onScan={onScan} onClose={vi.fn()} />));
    expect(onScan).toHaveBeenCalledExactlyOnceWith(
      "https://host.tailnet.ts.net/pair#token=PHONECODE",
    );
  } finally {
    await act(async () => root.unmount());
  }
  expect(stop).toHaveBeenCalledOnce();
});

it("keeps manual pairing available when camera permission is denied", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")),
    },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onScan = vi.fn();
  try {
    await act(async () => root.render(<PairingQrScanner onScan={onScan} onClose={vi.fn()} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Allow camera access in Android Settings",
    );
    expect(onScan).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import jsQR from "jsqr";
import { QrCode } from "@t3tools/shared/qrCode";
import { openPairingCamera, readPairingQr } from "./pairingQr";

afterEach(() => vi.unstubAllGlobals());

describe("APK pairing QR codes", () => {
  const direct = "https://desktop.tailnet.ts.net/pair#token=PHONECODE";
  const hosted =
    "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net#token=PHONECODE";

  it.each([direct, hosted, "http://192.168.1.44:3773/pair?token=PHONECODE"])(
    "decodes the desktop QR image and accepts its pairing URL: %s",
    (url) => {
      const qr = QrCode.encodeText(url, QrCode.Ecc.MEDIUM);
      const scale = 4;
      const width = (qr.size + 8) * scale;
      const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
      for (let y = 0; y < width; y++) {
        for (let x = 0; x < width; x++) {
          if (!qr.getModule(Math.floor(x / scale) - 4, Math.floor(y / scale) - 4)) continue;
          const offset = (y * width + x) * 4;
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
        }
      }
      const decoded = jsQR(pixels, width, width);
      expect(decoded?.data).toBe(url);
      expect(readPairingQr(decoded!.data)).toBe(url);
    },
  );

  it("unwraps mobile pairing deep links", () => {
    expect(readPairingQr(`t3code://pair?pairingUrl=${encodeURIComponent(direct)}`)).toBe(direct);
  });

  it.each(["https://example.com/", "javascript:alert(1)", "not a URL", "t3code://pair"])(
    "rejects unrelated QR content: %s",
    (payload) => expect(() => readPairingQr(payload)).toThrow(),
  );

  it("releases the camera when scanning closes", async () => {
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
    });
    const controller = new AbortController();
    await openPairingCamera(controller.signal);
    controller.abort();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("releases a camera granted after the scanner was closed", async () => {
    const stop = vi.fn();
    let grant!: (stream: unknown) => void;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    const controller = new AbortController();
    const opening = openPairingCamera(controller.signal);
    const rejected = expect(opening).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    grant({ getTracks: () => [{ stop }] });
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
  });
});

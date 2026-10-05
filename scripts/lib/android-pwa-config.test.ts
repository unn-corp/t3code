import { describe, expect, it } from "vite-plus/test";
import { androidAssetLinks, normalizePwaOrigin } from "./android-pwa-config.ts";

describe("Android PWA configuration", () => {
  it("normalizes an HTTPS origin and preserves a custom Tailscale Serve port", () => {
    expect(normalizePwaOrigin("https://workstation.example:8443")).toBe(
      "https://workstation.example:8443/",
    );
  });

  it.each([
    "http://workstation.example",
    "https://user:secret@workstation.example",
    "https://workstation.example/pair",
    "https://workstation.example/?token=secret",
    "https://workstation.example/#token=secret",
  ])("rejects unsafe launch configuration %s", (url) => {
    expect(() => normalizePwaOrigin(url)).toThrow();
  });

  it("binds website access to the selected package and signing certificate", () => {
    const fingerprint = "ab".repeat(32);
    expect(androidAssetLinks("com.example.privateapp", fingerprint)[0]?.target).toEqual({
      namespace: "android_app",
      package_name: "com.example.privateapp",
      sha256_cert_fingerprints: [Array(32).fill("AB").join(":")],
    });
    expect(() => androidAssetLinks("not-a-package", fingerprint)).toThrow();
    expect(() => androidAssetLinks("com.example.privateapp", "AB")).toThrow();
  });
});

import { describe, expect, it } from "@effect/vitest";

import { resolveAppVersion } from "./appVersion.ts";

describe("resolveAppVersion", () => {
  it("uses the build version when the artifact builder injects one", () => {
    expect(resolveAppVersion("0.0.32-local.1", "0.0.31")).toBe("0.0.32-local.1");
  });

  it("falls back to the package version in development", () => {
    expect(resolveAppVersion(undefined, "0.0.31")).toBe("0.0.31");
  });
});

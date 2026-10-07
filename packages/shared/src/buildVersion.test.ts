import { describe, expect, it } from "vite-plus/test";
import { formatBuildVersion, includedUpstreamVersion } from "./buildVersion.ts";

describe("build version presentation", () => {
  it("keeps the included upstream version separate from the Arcwright nightly counter", () => {
    const build = { version: "1.0.1-nightly.20261007.35", upstreamVersion: "0.0.45" };
    expect(formatBuildVersion(build)).toBe("0.0.45 · Arcwright build 35 · Nightly");
    expect(build.version).toBe("1.0.1-nightly.20261007.35");
  });
  it("presents legacy hosts without putting the fork suffix on the T3 version", () => {
    expect(formatBuildVersion({ version: "0.0.45-fork.4" })).toBe(
      "0.0.45 · Arcwright build 4 · Legacy",
    );
  });
  it("does not invent upstream provenance for a historical independent release", () => {
    const build = { version: "1.0.1-nightly.20261006.31" };
    expect(includedUpstreamVersion(build)).toBeNull();
    expect(formatBuildVersion(build)).toBe("Arcwright build 31 · Nightly");
  });
  it("uses a separate stable build number", () => {
    expect(
      formatBuildVersion({ version: "1.0.1", upstreamVersion: "0.0.45", forkBuildNumber: 36 }),
    ).toBe("0.0.45 · Arcwright build 36 · Stable");
  });
  it("leaves unknown and upstream-only identities intact", () => {
    expect(formatBuildVersion({ version: "dev" })).toBe("dev");
    expect(formatBuildVersion({ version: "0.0.45" })).toBe("0.0.45");
  });
});

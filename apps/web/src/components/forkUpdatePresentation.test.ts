import { expect, it } from "vite-plus/test";
import type { ForkUpdateStatus } from "@t3tools/contracts";
import { forkPinnedBuildLabel, forkStatusDisplayBuild } from "./forkUpdatePresentation";

const currentBuild: ForkUpdateStatus["currentBuild"] = {
  version: "1.0.0",
  upstreamVersion: "0.0.49",
  forkBuildNumber: 49,
  commit: "a".repeat(40),
  channel: "stable",
  artifactSha256: "b".repeat(64),
};
const stagedBuild: ForkUpdateStatus["currentBuild"] = {
  version: "1.0.0",
  upstreamVersion: "0.0.66",
  forkBuildNumber: 66,
  commit: "c".repeat(40),
  channel: "nightly",
  artifactSha256: "d".repeat(64),
};

const status = (overrides: Partial<ForkUpdateStatus> = {}): ForkUpdateStatus => ({
  coordinatorId: "android-native-updater",
  phase: "waiting",
  policy: { channel: "nightly", automaticInstallation: true, pinnedBuild: null },
  currentBuild,
  targetBuild: stagedBuild,
  blockers: [],
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: false,
  ...overrides,
});

it.each(["pinned", "completed"] as const)(
  "shows the installed build for %s even when a newer target remains staged",
  (phase) => {
    expect(forkStatusDisplayBuild(status({ phase }))).toEqual(currentBuild);
  },
);

it("shows the requested target during an install transition", () => {
  expect(forkStatusDisplayBuild(status({ phase: "waiting" }))).toEqual(stagedBuild);
});

it("labels a pin with the installed build instead of its artifact digest", () => {
  expect(
    forkPinnedBuildLabel(
      status({
        phase: "pinned",
        policy: {
          channel: "nightly",
          automaticInstallation: true,
          pinnedBuild: currentBuild.artifactSha256,
        },
      }),
    ),
  ).toBe("Pinned: 0.0.49 · Arcwright build 49 · Stable");
});

it("keeps an abbreviated reference if a pin does not match the installed build", () => {
  expect(
    forkPinnedBuildLabel(
      status({
        policy: {
          channel: "nightly",
          automaticInstallation: true,
          pinnedBuild: "e".repeat(64),
        },
      }),
    ),
  ).toBe(`Pinned: ${"e".repeat(12)}`);
});

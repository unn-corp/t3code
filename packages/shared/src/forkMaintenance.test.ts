import { describe, expect, it } from "@effect/vitest";
// Parity: the publisher and the device must agree on which releases exist for a device.
import {
  classifyRelease as publisherClassify,
  selectUpdateCandidate as publisherSelect,
} from "../../../scripts/fork-release-policy.ts";
import type { ForkReleaseManifest } from "@t3tools/contracts";
import {
  classifyForkRelease,
  compareForkVersions,
  defaultForkChannel,
  evaluateAutomaticInstall,
  detectForkPackaging,
  forkAssetFor,
  forkDesktopAssetFor,
  forkInstallAssetFor,
  forkRecoveryAssetsFor,
  forkAssetUrl,
  forkCheckBackoffMs,
  FORK_CHECK_INTERVAL_MS,
  isForkReleaseUrl,
  selectForkTarget,
  type ForkReleaseRecord,
} from "./forkMaintenance.ts";

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const commit = (seed: string) => seed.repeat(40).slice(0, 40);

function release(
  version: string,
  options: {
    id?: number;
    commitSeed?: string;
    checks?: boolean;
    withdrawn?: boolean;
    publishedAt?: string;
    windowsDigest?: string;
  } = {},
): ForkReleaseRecord {
  const channel = version.includes("nightly") ? "nightly" : "stable";
  const sourceCommit = commit(options.commitSeed ?? "a");
  const assets = [
    {
      name: `T3-Code-${version}-x64.exe`,
      sha256: options.windowsDigest ?? sha("b"),
      bytes: 100,
      kind: "desktop" as const,
      platform: "windows-x64" as const,
    },
    {
      name: `T3-Code-${version}-x64.AppImage`,
      sha256: sha("c"),
      bytes: 100,
      kind: "desktop" as const,
      platform: "linux-x64" as const,
    },
    {
      name: "recovery-helper-linux-x64",
      sha256: sha("d"),
      bytes: 10,
      kind: "recovery-helper" as const,
      platform: "linux-x64" as const,
    },
    {
      name: `t3-${version}-android.apk`,
      sha256: sha("e"),
      bytes: 10,
      kind: "android" as const,
      platform: "android" as const,
    },
    {
      name: `t3-${version}-android-recovery.apk`,
      sha256: sha("f"),
      bytes: 10,
      kind: "android-recovery" as const,
      platform: "android" as const,
    },
  ];
  const manifest: ForkReleaseManifest = {
    format: 1,
    repository: "unn-corp/t3code",
    version,
    commit: sourceCommit,
    channel,
    releasedAt: "2026-10-05T07:23:00Z",
    assets,
    android: {
      normal: {
        asset: assets[3]!.name,
        versionCode: 10,
        sourceVersion: version,
        sourceCommit,
        packageName: "com.devotek.t3code.pwa",
        signerSha256: sha("9"),
        updaterProtocol: 1,
      },
      recovery: {
        asset: assets[4]!.name,
        versionCode: 11,
        sourceVersion: "1.0.0",
        sourceCommit: commit("0"),
        packageName: "com.devotek.t3code.pwa",
        signerSha256: sha("9"),
        updaterProtocol: 1,
      },
    },
    checks: { build: true, install: true, update: true, recovery: options.checks ?? true },
  };
  return {
    id: options.id ?? 1,
    tagName: `fork-v${version}`,
    draft: false,
    body:
      options.withdrawn === true
        ? "<!-- t3-fork-release:withdrawn at=2026-10-05 reason=bad -->"
        : "",
    createdAt: options.publishedAt ?? "2026-10-05T07:30:00Z",
    publishedAt: options.publishedAt ?? "2026-10-05T07:30:00Z",
    assets: [
      ...assets.map((asset) => ({ name: asset.name, size: asset.bytes })),
      { name: "fork-release.json", size: 5 },
    ],
    manifest,
  };
}
const digestOf = (manifest: ForkReleaseManifest) =>
  forkAssetFor(manifest, "desktop", "windows-x64")?.sha256 ?? null;
const select = (
  input: Partial<Parameters<typeof selectForkTarget>[0]> & {
    releases: ReadonlyArray<ForkReleaseRecord>;
  },
) =>
  selectForkTarget({
    channel: "nightly",
    installedVersion: "1.0.0",
    pinnedBuild: null,
    artifactSha256: digestOf,
    ...input,
  });

describe("fork version precedence", () => {
  it("orders stable above same-core nightlies, then by date and run", () => {
    expect(compareForkVersions("1.0.1", "1.0.1-nightly.20261005.9")).toBe(1);
    expect(compareForkVersions("1.0.1-nightly.20261005.2", "1.0.1-nightly.20261005.10")).toBe(-1);
    expect(compareForkVersions("1.0.1-nightly.20261006.1", "1.0.1-nightly.20261005.9")).toBe(1);
    expect(compareForkVersions("1.0.1-nightly.20261005.1", "1.0.0")).toBe(1);
    expect(() => compareForkVersions("1.0", "1.0.0")).toThrow("not a fork release version");
  });
  it("defaults existing installations to nightly and fresh installations to stable", () => {
    expect(defaultForkChannel({ existingInstallation: true })).toBe("nightly");
    expect(defaultForkChannel({ existingInstallation: false })).toBe("stable");
  });
});

describe("target selection", () => {
  const nightly = release("1.0.1-nightly.20261005.1", { id: 2, commitSeed: "2" });
  const stable = release("1.0.1", { id: 3, commitSeed: "3" });
  it("never selects a downgrade or the installed version", () => {
    expect(select({ releases: [nightly], installedVersion: "1.0.1" })).toBeNull();
    expect(
      select({ releases: [nightly], installedVersion: "1.0.1-nightly.20261005.1" }),
    ).toBeNull();
    expect(
      select({
        releases: [release("1.0.0", { id: 4, commitSeed: "4" })],
        installedVersion: "1.0.1-nightly.20261005.1",
      }),
    ).toBeNull();
  });
  it("lets stable devices ignore nightlies and nightly devices take the stable that outranks them", () => {
    expect(select({ channel: "stable", releases: [nightly] })).toBeNull();
    expect(select({ channel: "nightly", releases: [nightly, stable] })?.manifest.version).toBe(
      "1.0.1",
    );
    expect(select({ channel: "stable", releases: [nightly, stable] })?.manifest.version).toBe(
      "1.0.1",
    );
  });
  it("skips withdrawn, partial, and check-incomplete releases", () => {
    expect(select({ releases: [release("1.0.1", { withdrawn: true })] })).toBeNull();
    expect(select({ releases: [release("1.0.1", { checks: false })] })).toBeNull();
    const partial = { ...release("1.0.1"), assets: [] };
    expect(classifyForkRelease(partial, [partial]).reasons).toContain("partial");
    expect(select({ releases: [partial] })).toBeNull();
  });
  it("holds a pinned build and never retries a digest that failed on this device", () => {
    expect(select({ releases: [stable], pinnedBuild: sha("1") })).toBeNull();
    expect(select({ releases: [stable], memory: { failedArtifactSha256: [sha("b")] } })).toBeNull();
    const rebuilt = release("1.0.2", { id: 5, commitSeed: "5", windowsDigest: sha("7") });
    expect(
      select({ releases: [stable, rebuilt], memory: { failedArtifactSha256: [sha("b")] } })
        ?.manifest.version,
    ).toBe("1.0.2");
  });
  it("keeps only the earliest of releases that claim one commit and channel", () => {
    const first = release("1.0.1-nightly.20261005.1", {
      id: 6,
      commitSeed: "6",
      publishedAt: "2026-10-05T07:30:00Z",
    });
    const rerun = release("1.0.1-nightly.20261005.2", {
      id: 7,
      commitSeed: "6",
      publishedAt: "2026-10-05T09:00:00Z",
    });
    expect(select({ releases: [first, rerun] })?.manifest.version).toBe("1.0.1-nightly.20261005.1");
  });
  it("treats a platform with ambiguous or missing assets as having no target", () => {
    const ambiguous = release("1.0.1", { id: 8, commitSeed: "8" });
    const extra = {
      name: "other.exe",
      sha256: sha("1"),
      bytes: 100,
      kind: "desktop" as const,
      platform: "windows-x64" as const,
    };
    (ambiguous.manifest as { assets: unknown }).assets = [...ambiguous.manifest!.assets, extra];
    expect(forkAssetFor(ambiguous.manifest!, "desktop", "windows-x64")).toBeNull();
    expect(select({ releases: [ambiguous] })).toBeNull();
  });
});

describe("packaging-aware desktop assets", () => {
  const both = () => {
    const record = release("1.0.1", { id: 9, commitSeed: "9" });
    const extra = {
      name: "T3-Code-1.0.1-amd64.deb",
      sha256: sha("4"),
      bytes: 100,
      kind: "desktop" as const,
      platform: "linux-x64" as const,
    };
    (record.manifest as { assets: unknown }).assets = [...record.manifest!.assets, extra];
    return record.manifest!;
  };
  it("gives a Debian install the .deb and an AppImage install the AppImage, never the other", () => {
    const manifest = both();
    expect(forkDesktopAssetFor(manifest, "linux-x64", "deb")?.name).toBe("T3-Code-1.0.1-amd64.deb");
    expect(forkDesktopAssetFor(manifest, "linux-x64", "appimage")?.name).toBe(
      "T3-Code-1.0.1-x64.AppImage",
    );
    expect(forkDesktopAssetFor(manifest, "windows-x64", "nsis")?.name).toBe(
      "T3-Code-1.0.1-x64.exe",
    );
    expect(forkDesktopAssetFor(manifest, "windows-x64", "deb")).toBeNull();
    expect(forkInstallAssetFor(manifest, "linux-x64", "deb")?.sha256).toBe(sha("4"));
  });
  it("treats a missing or duplicated payload for the packaging as absent", () => {
    const manifest = both();
    const withoutDeb = {
      ...manifest,
      assets: manifest.assets.filter((asset) => !asset.name.endsWith(".deb")),
    };
    expect(forkDesktopAssetFor(withoutDeb, "linux-x64", "deb")).toBeNull();
    const twice = {
      ...manifest,
      assets: [
        ...manifest.assets,
        {
          name: "other.deb",
          sha256: sha("5"),
          bytes: 1,
          kind: "desktop" as const,
          platform: "linux-x64" as const,
        },
      ],
    };
    expect(forkDesktopAssetFor(twice, "linux-x64", "deb")).toBeNull();
  });
  it("detects packaging from the platform, the AppImage environment and dpkg ownership, and fails closed otherwise", () => {
    expect(detectForkPackaging({ platform: "win32", env: {}, installedByDpkg: false })).toBe(
      "nsis",
    );
    expect(
      detectForkPackaging({
        platform: "linux",
        env: { APPIMAGE: "/x.AppImage" },
        installedByDpkg: false,
      }),
    ).toBe("appimage");
    expect(detectForkPackaging({ platform: "linux", env: {}, installedByDpkg: true })).toBe("deb");
    expect(detectForkPackaging({ platform: "linux", env: {}, installedByDpkg: false })).toBeNull();
    expect(detectForkPackaging({ platform: "darwin", env: {}, installedByDpkg: false })).toBeNull();
  });
});

describe("recovery assets", () => {
  const withRecovery = (
    extra: ReadonlyArray<{
      name: string;
      platform: "linux-x64" | "windows-x64" | "android" | "shared";
    }> = [],
  ) => {
    const manifest = release("1.0.1", { id: 11, commitSeed: "b" }).manifest!;
    const assets = [
      {
        name: "t3-recovery-helper-linux-x64.mjs",
        sha256: sha("1"),
        bytes: 10,
        kind: "recovery-helper" as const,
        platform: "linux-x64" as const,
      },
      {
        name: "t3-recovery-node-linux-x64",
        sha256: sha("2"),
        bytes: 10,
        kind: "recovery-helper" as const,
        platform: "linux-x64" as const,
      },
      {
        name: "t3-recovery-helper-windows-x64.mjs",
        sha256: sha("3"),
        bytes: 10,
        kind: "recovery-helper" as const,
        platform: "windows-x64" as const,
      },
      {
        name: "t3-recovery-node-windows-x64.exe",
        sha256: sha("4"),
        bytes: 10,
        kind: "recovery-helper" as const,
        platform: "windows-x64" as const,
      },
      ...extra.map((entry) => ({
        ...entry,
        sha256: sha("5"),
        bytes: 1,
        kind: "recovery-helper" as const,
      })),
    ];
    return { ...manifest, assets: assets } as ForkReleaseManifest;
  };
  it("selects the script and the Node runtime separately for each platform, by exact name", () => {
    const manifest = withRecovery();
    expect(forkRecoveryAssetsFor(manifest, "linux-x64")).toMatchObject({
      helper: { sha256: sha("1") },
      node: { sha256: sha("2") },
    });
    expect(forkRecoveryAssetsFor(manifest, "windows-x64")).toMatchObject({
      helper: { name: "t3-recovery-helper-windows-x64.mjs" },
      node: { name: "t3-recovery-node-windows-x64.exe" },
    });
  });
  it("treats a missing, duplicated or wrong-platform asset as no recovery, never the other platform's", () => {
    const manifest = withRecovery();
    expect(
      forkRecoveryAssetsFor(
        {
          ...manifest,
          assets: manifest.assets.filter((asset) => asset.name !== "t3-recovery-node-linux-x64"),
        },
        "linux-x64",
      ),
    ).toBeNull();
    expect(
      forkRecoveryAssetsFor(
        withRecovery([{ name: "t3-recovery-node-linux-x64", platform: "linux-x64" }]),
        "linux-x64",
      ),
    ).toBeNull();
    expect(
      forkRecoveryAssetsFor(
        {
          ...manifest,
          assets: manifest.assets.map((asset) =>
            asset.name === "t3-recovery-node-linux-x64"
              ? { ...asset, platform: "windows-x64" as const }
              : asset,
          ),
        },
        "linux-x64",
      ),
    ).toBeNull();
  });
});

describe("release origin", () => {
  it("builds download URLs only from fork tags and plain asset names, and accepts only that origin", () => {
    expect(forkAssetUrl("fork-v1.0.1", "app.exe")).toBe(
      "https://github.com/unn-corp/t3code/releases/download/fork-v1.0.1/app.exe",
    );
    expect(() => forkAssetUrl("v1.0.1", "app.exe")).toThrow();
    expect(() => forkAssetUrl("fork-v1.0.1", "../app.exe")).toThrow();
    expect(
      isForkReleaseUrl("https://github.com/unn-corp/t3code/releases/download/fork-v1.0.1/a"),
    ).toBe(true);
    expect(
      isForkReleaseUrl("http://github.com/unn-corp/t3code/releases/download/fork-v1.0.1/a"),
    ).toBe(false);
    expect(
      isForkReleaseUrl("https://github.com.evil.example/unn-corp/t3code/releases/download/x"),
    ).toBe(false);
    expect(isForkReleaseUrl("https://user@github.com/unn-corp/t3code/releases/download/x")).toBe(
      false,
    );
  });
});

describe("check backoff", () => {
  it("uses the four hour cadence on success and doubles from one minute on failure up to that cap", () => {
    expect(forkCheckBackoffMs(0)).toBe(FORK_CHECK_INTERVAL_MS);
    expect([1, 2, 3, 4].map(forkCheckBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(forkCheckBackoffMs(50)).toBe(FORK_CHECK_INTERVAL_MS);
  });
});

describe("automatic installation gate", () => {
  const target = sha("b");
  const base = {
    now: 1_000_000,
    blockers: [],
    automaticInstallation: true,
    targetArtifactSha256: target,
    interaction: { inputActiveAt: null, uploadsInFlight: 0 },
    countdown: null,
    automationReviewRequired: false,
  };
  it("is idle without opt-in or target", () => {
    expect(evaluateAutomaticInstall({ ...base, automaticInstallation: false }).state).toBe("idle");
    expect(evaluateAutomaticInstall({ ...base, targetArtifactSha256: null }).state).toBe("idle");
  });
  it("is hard-blocked by agent activity regardless of idle input", () => {
    const blockers = [{ participantId: "p", reason: "active-agents" as const, label: "agent" }];
    expect(evaluateAutomaticInstall({ ...base, blockers })).toEqual({ state: "blocked", blockers });
  });
  it("waits for recent input and unfinished uploads", () => {
    expect(
      evaluateAutomaticInstall({
        ...base,
        interaction: { inputActiveAt: base.now - 1000, uploadsInFlight: 0 },
      }),
    ).toMatchObject({ state: "waiting", blockers: [{ reason: "input-active" }] });
    expect(
      evaluateAutomaticInstall({
        ...base,
        interaction: { inputActiveAt: null, uploadsInFlight: 1 },
      }),
    ).toMatchObject({ state: "waiting", blockers: [{ reason: "uploads" }] });
    expect(
      evaluateAutomaticInstall({
        ...base,
        interaction: { inputActiveAt: base.now - 5 * 60 * 1000, uploadsInFlight: 0 },
      }).state,
    ).toBe("countdown");
  });
  it("starts a fifteen second countdown, installs when it elapses, and restarts it for a different target", () => {
    const started = evaluateAutomaticInstall(base);
    expect(started).toMatchObject({
      state: "countdown",
      countdown: { installsAt: base.now + 15_000 },
    });
    const countdown = (started as unknown as { countdown: never }).countdown;
    expect(evaluateAutomaticInstall({ ...base, now: base.now + 14_999, countdown }).state).toBe(
      "countdown",
    );
    expect(evaluateAutomaticInstall({ ...base, now: base.now + 15_000, countdown }).state).toBe(
      "install",
    );
    expect(
      evaluateAutomaticInstall({
        ...base,
        now: base.now + 15_000,
        countdown,
        targetArtifactSha256: sha("c"),
      }).state,
    ).toBe("countdown");
  });
  it("stays cancelled for the digest the person cancelled and holds for automation review", () => {
    expect(evaluateAutomaticInstall({ ...base, cancelledTargetSha256: target }).state).toBe("idle");
    expect(evaluateAutomaticInstall({ ...base, cancelledTargetSha256: sha("c") }).state).toBe(
      "countdown",
    );
    expect(evaluateAutomaticInstall({ ...base, automationReviewRequired: true })).toMatchObject({
      state: "waiting",
      blockers: [{ reason: "automation-review" }],
    });
  });
  it("has no interaction surface for headless hosts, so only agents and the countdown gate them", () => {
    expect(evaluateAutomaticInstall({ ...base, interaction: null }).state).toBe("countdown");
  });
});

describe("parity with the publisher's eligibility rules", () => {
  const toPublisher = ({ manifestError, ...record }: ForkReleaseRecord) => ({
    ...record,
    ...(manifestError === undefined ? {} : { manifestError }),
    assets: record.assets.map((asset, id) => ({ id, ...asset })),
  });
  const all = [
    release("1.0.0", { id: 1, commitSeed: "1" }),
    release("1.0.1-nightly.20261004.1", { id: 2, commitSeed: "2" }),
    release("1.0.1-nightly.20261005.1", { id: 3, commitSeed: "3", checks: false }),
    release("1.0.1-nightly.20261006.1", {
      id: 4,
      commitSeed: "2",
      publishedAt: "2026-10-06T07:30:00Z",
    }),
    release("1.0.1", { id: 5, commitSeed: "5", withdrawn: true }),
    release("1.0.2", { id: 6, commitSeed: "6" }),
    { ...release("1.0.3", { id: 7, commitSeed: "7" }), assets: [] },
  ];
  it("classifies every release the same way", () => {
    for (const record of all) {
      expect(classifyForkRelease(record, all), record.tagName).toEqual(
        publisherClassify(toPublisher(record), all.map(toPublisher)),
      );
    }
  });
  it("selects the same candidate for every channel and installed version", () => {
    for (const channel of ["stable", "nightly"] as const) {
      for (const installedVersion of ["1.0.0", "1.0.1-nightly.20261004.1", "1.0.2"]) {
        const mine = select({ channel, installedVersion, releases: all })?.manifest.version ?? null;
        const theirs =
          publisherSelect({ channel, installedVersion, releases: all.map(toPublisher) })?.manifest
            ?.version ?? null;
        expect(mine, `${channel} ${installedVersion}`).toBe(theirs);
      }
    }
  });
});

// @effect-diagnostics globalDate:off - the policy takes an explicit clock, so tests pass fixed instants.
import { assert, describe, it } from "@effect/vitest";
import { makeRelease, sha } from "./fork-release-fixtures.ts";
import {
  ANDROID_BASELINE_VERSION_CODE,
  ANDROID_MAX_VERSION_CODE,
  buildPlan,
  classifyRelease,
  commissioningMarker,
  codeFromReservationTag,
  compareForkVersions,
  eligibleReleases,
  forkVersionFromTag,
  highestUsedAndroidCode,
  nextAndroidCodePair,
  nextAndroidCodeAllocation,
  reservedAndroidCodeEnd,
  nextStableVersion,
  nightlyVersionFor,
  parseForkVersion,
  parseRequiredAndroidRecoveryTags,
  planNightly,
  selectPredecessor,
  selectStableSource,
  selectUpdateCandidate,
  withWithdrawal,
  withoutWithdrawal,
  isWithdrawn,
} from "./fork-release-policy.ts";

const NOW = new Date("2026-10-11T08:30:00.000Z");

describe("fork versions", () => {
  it("parses stable and nightly versions and rejects everything else", () => {
    assert.equal(parseForkVersion("1.0.0")?.channel, "stable");
    assert.equal(parseForkVersion("1.0.1-nightly.20261006.12")?.run, 12);
    for (const bad of [
      "1.0",
      "01.0.0",
      "1.0.0-fork.1",
      "1.0.0-nightly.2026106.1",
      "1.0.0-nightly.20261006.0",
      "v1.0.0",
    ]) {
      assert.equal(parseForkVersion(bad), null, bad);
    }
  });

  it("orders stable above nightlies of the same core and nightlies by date then run", () => {
    assert.isBelow(compareForkVersions("1.0.1-nightly.20261006.12", "1.0.1"), 0);
    assert.isBelow(compareForkVersions("1.0.1-nightly.20261006.12", "1.0.1-nightly.20261007.1"), 0);
    assert.isBelow(compareForkVersions("1.0.1-nightly.20261006.9", "1.0.1-nightly.20261006.12"), 0);
    assert.isBelow(compareForkVersions("1.0.9", "1.0.10"), 0);
    assert.isBelow(compareForkVersions("1.0.1", "1.0.2-nightly.20261001.1"), 0);
  });

  it("recovers a version from a fork tag and ignores upstream tags", () => {
    assert.equal(forkVersionFromTag("fork-v1.0.2"), "1.0.2");
    assert.equal(forkVersionFromTag("v0.0.46-nightly.20261005.2667"), null);
    assert.equal(forkVersionFromTag("fork-v1.0"), null);
  });
});

describe("independent version allocation", () => {
  it("starts stable at 1.0.0 and then takes the next patch", () => {
    assert.equal(nextStableVersion([]), "1.0.0");
    assert.equal(nextStableVersion([makeRelease({ version: "1.0.0" })]), "1.0.1");
    assert.equal(
      nextStableVersion([makeRelease({ version: "1.0.0" }), makeRelease({ version: "1.0.4" })]),
      "1.0.5",
    );
  });

  it("never reuses a version consumed by a draft or a withdrawn release", () => {
    const withdrawn = makeRelease({
      version: "1.0.1",
      body: withWithdrawal("", "bad build", "2026-10-07T00:00:00Z"),
    });
    const draft = makeRelease({
      version: "1.0.2",
      draft: true,
      publishedAt: null,
    });
    assert.equal(nextStableVersion([makeRelease({ version: "1.0.0" }), withdrawn, draft]), "1.0.3");
  });

  it("does not let nightlies advance the stable counter", () => {
    const releases = [
      makeRelease({ version: "1.0.0" }),
      makeRelease({ version: "1.0.1-nightly.20261003.4" }),
    ];
    assert.equal(nextStableVersion(releases), "1.0.1");
  });

  it("builds nightlies on the next stable patch with the run number", () => {
    const releases = [makeRelease({ version: "1.0.0" })];
    assert.equal(
      nightlyVersionFor(releases, new Date("2026-10-06T07:23:00Z"), 42),
      "1.0.1-nightly.20261006.42",
    );
    assert.equal(
      nightlyVersionFor([], new Date("2026-10-06T07:23:00Z"), 1),
      "1.0.0-nightly.20261006.1",
    );
    assert.throws(() => nightlyVersionFor([], NOW, 0));
  });
});

describe("release eligibility", () => {
  it("accepts a complete, validated, published release", () => {
    const release = makeRelease({ version: "1.0.0" });
    assert.deepStrictEqual(classifyRelease(release, [release]), {
      eligible: true,
      reasons: [],
    });
  });

  it("excludes drafts and withdrawn releases", () => {
    const draft = makeRelease({
      version: "1.0.0",
      draft: true,
      publishedAt: null,
    });
    assert.deepStrictEqual(classifyRelease(draft, [draft]).reasons, ["draft"]);
    const withdrawn = makeRelease({
      version: "1.0.0",
      body: withWithdrawal("notes", "regression", "2026-10-07T00:00:00Z"),
    });
    assert.deepStrictEqual(classifyRelease(withdrawn, [withdrawn]).reasons, ["withdrawn"]);
  });

  it("excludes partial releases: no manifest, a missing asset, or a wrong asset size", () => {
    const noManifest = makeRelease({ version: "1.0.0", noManifest: true });
    assert.deepStrictEqual(classifyRelease(noManifest, [noManifest]).reasons, ["partial"]);
    const missing = makeRelease({ version: "1.0.0", dropAsset: true });
    assert.deepStrictEqual(classifyRelease(missing, [missing]).reasons, ["partial"]);
    const truncated = makeRelease({ version: "1.0.0" });
    const shrunk = {
      ...truncated,
      assets: truncated.assets.map((a, i) => (i === 0 ? { ...a, size: a.size - 1 } : a)),
    };
    assert.deepStrictEqual(classifyRelease(shrunk, [shrunk]).reasons, ["partial"]);
  });

  it("excludes a release whose manifest is unreadable or disagrees with its tag", () => {
    const base = makeRelease({ version: "1.0.0" });
    const unreadable = { ...base, manifest: null, manifestError: "bad sha" };
    assert.deepStrictEqual(classifyRelease(unreadable, [unreadable]).reasons, ["invalid-manifest"]);
    const mismatched = { ...base, tagName: "fork-v1.0.9" };
    assert.include(classifyRelease(mismatched, [mismatched]).reasons, "invalid-manifest");
  });

  it("excludes releases whose recorded checks are not all true", () => {
    for (const check of ["build", "install", "update", "recovery"] as const) {
      const release = makeRelease({
        version: "1.0.0",
        checks: { [check]: false },
      });
      assert.deepStrictEqual(
        classifyRelease(release, [release]).reasons,
        ["checks-incomplete"],
        check,
      );
    }
  });

  it("excludes a release whose recovery APK duplicates the normal source or is not above its code", () => {
    const sameSource = makeRelease({
      version: "1.0.0",
      commit: sha("c"),
      recoveryCommit: sha("c"),
      recoveryVersion: "1.0.0",
    });
    assert.deepStrictEqual(classifyRelease(sameSource, [sameSource]).reasons, [
      "duplicate-recovery",
    ]);
    const lowCode = makeRelease({
      version: "1.0.0",
      normalCode: 100,
      recoveryCode: 100,
    });
    assert.deepStrictEqual(classifyRelease(lowCode, [lowCode]).reasons, ["duplicate-recovery"]);
  });

  it("keeps the earliest of releases that claim the same commit and channel", () => {
    const commit = sha("same");
    const first = makeRelease({
      version: "1.0.1-nightly.20261006.1",
      commit,
      releasedAt: "2026-10-06T07:40:00Z",
    });
    const second = makeRelease({
      version: "1.0.1-nightly.20261006.2",
      commit,
      releasedAt: "2026-10-06T08:40:00Z",
    });
    const all = [first, second];
    assert.equal(classifyRelease(first, all).eligible, true);
    assert.deepStrictEqual(classifyRelease(second, all).reasons, ["duplicate"]);
  });

  it("round-trips withdrawal through the release notes only", () => {
    const body = "Fork nightly 1.0.1";
    const withdrawn = withWithdrawal(body, "boot loop", "2026-10-07T00:00:00Z");
    assert.equal(isWithdrawn({ body: withdrawn }), true);
    assert.equal(withWithdrawal(withdrawn, "again", "2026-10-08T00:00:00Z"), withdrawn);
    assert.equal(withoutWithdrawal(withdrawn), body);
    assert.equal(isWithdrawn({ body: "mentions t3-fork-release:withdrawn inline" }), false);
  });
});

describe("update candidate selection", () => {
  const stable100 = makeRelease({
    version: "1.0.0",
    releasedAt: "2026-10-01T08:30:00Z",
  });
  const nightlyOld = makeRelease({
    version: "1.0.1-nightly.20261003.9",
    releasedAt: "2026-10-03T07:40:00Z",
  });
  const stable101 = makeRelease({
    version: "1.0.1",
    releasedAt: "2026-10-04T08:30:00Z",
  });
  const nightlyNew = makeRelease({
    version: "1.0.2-nightly.20261005.3",
    releasedAt: "2026-10-05T07:40:00Z",
  });
  const all = [stable100, nightlyOld, stable101, nightlyNew];

  it("keeps stable devices on stable releases", () => {
    const pick = selectUpdateCandidate({
      channel: "stable",
      installedVersion: "1.0.0",
      releases: all,
    });
    assert.equal(pick?.manifest?.version, "1.0.1");
  });

  it("lets nightly devices follow nightlies but take a fresh stable that outranks them", () => {
    const behind = selectUpdateCandidate({
      channel: "nightly",
      installedVersion: "1.0.1-nightly.20261003.9",
      releases: all,
    });
    assert.equal(behind?.manifest?.version, "1.0.2-nightly.20261005.3");
    const onlyStable = selectUpdateCandidate({
      channel: "nightly",
      installedVersion: "1.0.1-nightly.20261003.9",
      releases: [stable100, nightlyOld, stable101],
    });
    assert.equal(onlyStable?.manifest?.version, "1.0.1");
  });

  it("never selects a downgrade, a draft, or a withdrawn release", () => {
    assert.equal(
      selectUpdateCandidate({
        channel: "nightly",
        installedVersion: "1.0.2-nightly.20261005.3",
        releases: all,
      }),
      null,
    );
    assert.equal(
      selectUpdateCandidate({
        channel: "stable",
        installedVersion: "1.0.1",
        releases: all,
      }),
      null,
    );
    const withdrawn = makeRelease({
      version: "1.0.2",
      body: withWithdrawal("", "bad", "2026-10-06T00:00:00Z"),
    });
    const draft = makeRelease({
      version: "1.0.3",
      draft: true,
      publishedAt: null,
    });
    assert.equal(
      selectUpdateCandidate({
        channel: "stable",
        installedVersion: "1.0.1",
        releases: [stable101, withdrawn, draft],
      }),
      null,
    );
  });
});

describe("nightly planning", () => {
  it("pins the supplied commit and skips a commit that already has a nightly", () => {
    const commit = sha("tip");
    const fresh = planNightly({
      commit,
      now: new Date("2026-10-06T07:23:00Z"),
      runNumber: 5,
      releases: [makeRelease({ version: "1.0.0" })],
    });
    assert.deepStrictEqual(
      fresh.kind === "release" ? [fresh.plan.version, fresh.plan.tag, fresh.plan.commit] : null,
      ["1.0.1-nightly.20261006.5", "fork-v1.0.1-nightly.20261006.5", commit],
    );
    const repeated = planNightly({
      commit,
      now: NOW,
      runNumber: 6,
      releases: [makeRelease({ version: "1.0.1-nightly.20261006.5", commit })],
    });
    assert.equal(repeated.kind, "skip");
  });

  it("treats an unpublished draft for the commit as already claimed", () => {
    const commit = sha("tip");
    const draft = makeRelease({
      version: "1.0.1-nightly.20261006.5",
      draft: true,
      publishedAt: null,
      noManifest: true,
      body: `<!-- t3-fork-release:candidate commit=${commit} channel=nightly -->`,
    });
    assert.equal(planNightly({ commit, now: NOW, runNumber: 6, releases: [draft] }).kind, "skip");
  });

  it("rejects a commit that is not a full SHA", () => {
    assert.throws(() => planNightly({ commit: "abc1234", now: NOW, runNumber: 1, releases: [] }));
  });

  it("commissioning rebuild binds the newest eligible same-source nightly and uses it as recovery predecessor", () => {
    const commit = sha("commission-source");
    const first = makeRelease({ version: "1.0.1-nightly.20261010.4", commit });
    const second = makeRelease({
      version: "1.0.1-nightly.20261010.5",
      commit,
      body: commissioningMarker({
        tag: first.tagName,
        version: first.manifest!.version,
        commit,
      }),
    });
    const outcome = buildPlan({
      channel: "nightly",
      commit,
      now: NOW,
      runNumber: 7,
      releases: [first, second],
      baseline: {
        tag: "fork-baseline",
        version: "1.0.0",
        commit: sha("commission-baseline"),
      },
      commission: true,
    });
    assert.equal(outcome.kind, "release");
    if (outcome.kind !== "release") return;
    assert.equal(outcome.plan.version, "1.0.1-nightly.20261011.7");
    assert.deepStrictEqual(outcome.plan.commissioningSource, {
      tag: second.tagName,
      version: second.manifest!.version,
      commit,
    });
    assert.equal(outcome.plan.predecessor.tag, second.tagName);
    assert.deepStrictEqual(
      outcome.plan.recoverySources
        .slice(0, 2)
        .map(({ version, commit: sourceCommit }) => [version, sourceCommit]),
      [
        [second.manifest!.version, commit],
        [first.manifest!.version, commit],
      ],
    );
  });

  it("allows the first explicit commissioning publication and rejects unsafe repeat history", () => {
    const commit = sha("commission-invalid");
    const plan = (releases: ReturnType<typeof makeRelease>[]) =>
      buildPlan({
        channel: "nightly",
        commit,
        now: NOW,
        runNumber: 8,
        releases,
        commission: true,
      });
    const first = buildPlan({
      channel: "nightly",
      commit,
      now: NOW,
      runNumber: 8,
      releases: [makeRelease({ version: "1.0.0" })],
      baseline: { tag: "fork-baseline", version: "1.0.0", commit: sha("commission-baseline") },
      commission: true,
    });
    assert.equal(first.kind, "release");
    if (first.kind === "release") {
      assert.equal(first.plan.commissioningSource, undefined);
      assert.equal(first.plan.predecessor.tag, "fork-v1.0.0");
    }
    const base = makeRelease({ version: "1.0.1-nightly.20261010.1", commit });
    const draft = makeRelease({
      version: "1.0.1-nightly.20261010.2",
      commit,
      draft: true,
      publishedAt: null,
      noManifest: true,
      body: `<!-- t3-fork-release:candidate commit=${commit} channel=nightly -->`,
    });
    assert.throws(() => plan([base, draft]), /not eligible/);
    const withdrawn = makeRelease({
      version: "1.0.1-nightly.20261010.3",
      commit,
      body: withWithdrawal("", "withdrawn", NOW.toISOString()),
    });
    assert.throws(() => plan([withdrawn]), /not eligible.*withdrawn/);
    const partial = makeRelease({
      version: "1.0.1-nightly.20261010.4",
      commit,
      dropAsset: true,
    });
    assert.throws(() => plan([partial]), /not eligible.*partial/);
    const invalid = makeRelease({
      version: "1.0.1-nightly.20261010.5",
      commit,
      checks: { recovery: false },
    });
    assert.throws(() => plan([invalid]), /not eligible.*checks-incomplete/);
  });

  it("keeps ordinary duplicate suppression and refuses a commissioning rerun that reuses a tag", () => {
    const commit = sha("commission-rerun");
    const prior = makeRelease({ version: "1.0.1-nightly.20261010.6", commit });
    assert.equal(
      buildPlan({
        channel: "nightly",
        commit,
        now: NOW,
        runNumber: 7,
        releases: [prior],
      }).kind,
      "skip",
    );
    const sameRun = buildPlan({
      channel: "nightly",
      commit,
      now: new Date("2026-10-10T08:30:00Z"),
      runNumber: 6,
      releases: [makeRelease({ version: "1.0.0" }), prior],
      commission: true,
    });
    assert.equal(sameRun.kind, "skip");
  });
});

describe("stable promotion", () => {
  const hours = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

  it("promotes the newest nightly whose checks completed at least 24 hours ago", () => {
    const old = makeRelease({
      version: "1.0.1-nightly.20261008.1",
      releasedAt: hours(60),
    });
    const mature = makeRelease({
      version: "1.0.1-nightly.20261009.2",
      releasedAt: hours(30),
    });
    const young = makeRelease({
      version: "1.0.1-nightly.20261010.3",
      releasedAt: hours(23),
    });
    assert.equal(
      selectStableSource({ now: NOW, releases: [old, mature, young] })?.manifest?.version,
      "1.0.1-nightly.20261009.2",
    );
  });

  it("does not promote when no nightly is old enough or every one is incomplete", () => {
    assert.equal(
      selectStableSource({
        now: NOW,
        releases: [
          makeRelease({
            version: "1.0.1-nightly.20261010.3",
            releasedAt: hours(23),
          }),
        ],
      }),
      null,
    );
    const failed = makeRelease({
      version: "1.0.1-nightly.20261008.1",
      releasedAt: hours(60),
      checks: { recovery: false },
    });
    assert.equal(selectStableSource({ now: NOW, releases: [failed] }), null);
  });

  it("skips commits already shipped as stable and nightlies at or before the previous stable's base", () => {
    const commit = sha("shipped");
    const base = makeRelease({
      version: "1.0.1-nightly.20261001.1",
      commit,
      releasedAt: hours(200),
    });
    const stable = makeRelease({
      version: "1.0.0",
      commit,
      releasedAt: hours(150),
    });
    const older = makeRelease({
      version: "1.0.1-nightly.20260930.9",
      releasedAt: hours(220),
    });
    assert.equal(selectStableSource({ now: NOW, releases: [base, stable, older] }), null);
    const newer = makeRelease({
      version: "1.0.1-nightly.20261005.2",
      releasedAt: hours(100),
    });
    assert.equal(
      selectStableSource({ now: NOW, releases: [base, stable, older, newer] })?.manifest?.version,
      "1.0.1-nightly.20261005.2",
    );
  });

  it("plans the stable build from the promoted nightly's commit with the next stable patch", () => {
    const commit = sha("nightly-commit");
    const stable = makeRelease({ version: "1.0.0", releasedAt: hours(300) });
    const nightly = makeRelease({
      version: "1.0.1-nightly.20261009.2",
      commit,
      releasedAt: hours(30),
    });
    const outcome = buildPlan({
      channel: "stable",
      now: NOW,
      runNumber: 1,
      releases: [stable, nightly],
    });
    assert.equal(outcome.kind, "release");
    if (outcome.kind === "release") {
      assert.deepStrictEqual(
        [
          outcome.plan.version,
          outcome.plan.commit,
          outcome.plan.source?.tag,
          outcome.plan.predecessor.version,
        ],
        ["1.0.1", commit, "fork-v1.0.1-nightly.20261009.2", "1.0.0"],
      );
    }
  });
});

describe("recovery predecessor", () => {
  it("keeps the verified baseline recoverable after later nightlies so a reverted phone can resume updates", () => {
    const baseline = { tag: "fork-baseline", version: "1.0.0", commit: sha("updater-baseline") };
    const previous = makeRelease({
      version: "1.0.1-nightly.20261009.1",
      commit: sha("previous-nightly"),
    });
    const outcome = buildPlan({
      channel: "nightly",
      commit: sha("next-nightly"),
      now: NOW,
      runNumber: 10,
      releases: [previous],
      baseline,
    });
    assert.equal(outcome.kind, "release");
    if (outcome.kind !== "release") return;
    assert.equal(outcome.plan.predecessor.tag, previous.tagName);
    const fromBaseline = outcome.plan.recoverySources.filter(
      (source) => source.version === baseline.version && source.commit === baseline.commit,
    );
    assert.lengthOf(fromBaseline, 1);
    assert.equal(fromBaseline[0]!.tag, baseline.tag);
    assert.equal(fromBaseline[0]!.channel, null);
    assert.include(fromBaseline[0]!.asset, "from-1.0.0");
  });
  it("freezes the newest three normal sources per channel plus the promotion source", () => {
    const stableOld = makeRelease({
      version: "1.0.0",
      commit: sha("stable-old"),
    });
    const stableNew = makeRelease({
      version: "1.0.1",
      commit: sha("stable-new"),
    });
    const nightlyOld = makeRelease({
      version: "1.0.2-nightly.20261008.1",
      commit: sha("nightly-old"),
    });
    const nightlyOlder = makeRelease({
      version: "1.0.2-nightly.20261006.1",
      commit: sha("nightly-older"),
    });
    const nightlyOutsideWindow = makeRelease({
      version: "1.0.2-nightly.20261005.1",
      commit: sha("nightly-outside-window"),
    });
    const promotedCommit = sha("promoted-nightly");
    const nightlyNew = makeRelease({
      version: "1.0.2-nightly.20261009.1",
      commit: promotedCommit,
    });
    const outcome = buildPlan({
      channel: "stable",
      now: NOW,
      runNumber: 9,
      releases: [stableOld, stableNew, nightlyOld, nightlyOlder, nightlyOutsideWindow, nightlyNew],
    });
    assert.equal(outcome.kind, "release");
    if (outcome.kind !== "release") return;
    const identities = outcome.plan.recoverySources.map(
      ({ version, commit }) => `${version}:${commit}`,
    );
    assert.isAtLeast(outcome.plan.recoverySources.length, 4);
    assert.include(identities, `1.0.2-nightly.20261009.1:${promotedCommit}`);
    assert.notInclude(identities, `1.0.2:${promotedCommit}`);
    assert.include(identities, `1.0.1:${sha("stable-new")}`);
    assert.include(identities, `1.0.2-nightly.20261006.1:${sha("nightly-older")}`);
    assert.notInclude(identities, `1.0.2-nightly.20261005.1:${sha("nightly-outside-window")}`);
    assert.equal(
      outcome.plan.recoverySources.filter((source) => source.channel === "nightly").length,
      3,
    );
    assert.equal(new Set(identities).size, identities.length);
  });

  it("keeps the newest three eligible Android sources and excludes older identities", () => {
    const releases = [66, 65, 58, 49, 34].map((run) =>
      makeRelease({
        version: `1.0.1-nightly.20261007.${run}`,
        commit: sha(`nightly-${run}`),
      }),
    );
    const outcome = buildPlan({
      channel: "nightly",
      commit: sha("next"),
      now: NOW,
      runNumber: 67,
      releases,
    });
    assert.equal(outcome.kind, "release");
    if (outcome.kind !== "release") return;

    const identities = outcome.plan.recoverySources.map(
      ({ version, commit }) => `${version}:${commit}`,
    );
    assert.include(identities, `1.0.1-nightly.20261007.66:${sha("nightly-66")}`);
    assert.include(identities, `1.0.1-nightly.20261007.65:${sha("nightly-65")}`);
    assert.include(identities, `1.0.1-nightly.20261007.58:${sha("nightly-58")}`);
    assert.notInclude(identities, `1.0.1-nightly.20261007.49:${sha("nightly-49")}`);
    assert.equal(
      outcome.plan.recoverySources.filter((source) => source.channel === "nightly").length,
      3,
    );
  });

  it("retains an explicitly requested older Android source outside the recent window", () => {
    const releases = [76, 74, 73, 70, 69].map((run) =>
      makeRelease({ version: `1.0.1-nightly.20261008.${run}`, commit: sha(`source-${run}`) }),
    );
    const old = releases.at(-1)!;
    const outcome = buildPlan({
      channel: "nightly",
      commit: sha("next-with-phone-recovery"),
      now: NOW,
      runNumber: 77,
      releases,
      requiredAndroidRecoveryTags: [old.tagName, old.tagName, releases[0]!.tagName],
    });
    assert.equal(outcome.kind, "release");
    if (outcome.kind !== "release") return;
    assert.equal(outcome.plan.predecessor.tag, releases[0]!.tagName);
    const retained = outcome.plan.recoverySources.filter((source) => source.tag === old.tagName);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.version, "1.0.1-nightly.20261008.69");
    assert.equal(retained[0]!.commit, sha("source-69"));
    assert.equal(outcome.plan.recoverySources.length, 4);
    assert.isFalse(
      outcome.plan.recoverySources.some((source) => source.tag === releases[3]!.tagName),
    );
  });

  it("refuses required recovery from missing, draft, withdrawn or failed releases", () => {
    const current = makeRelease({ version: "1.0.1-nightly.20261008.76", commit: sha("current") });
    const old = { version: "1.0.1-nightly.20261008.69", commit: sha("phone") };
    const tag = "fork-v1.0.1-nightly.20261008.69";
    for (const releases of [
      [current],
      [current, makeRelease({ ...old, draft: true })],
      [current, makeRelease({ ...old, body: withWithdrawal("", "unsafe", NOW.toISOString()) })],
      [current, makeRelease({ ...old, checks: { recovery: false } })],
    ]) {
      assert.throws(
        () =>
          buildPlan({
            channel: "nightly",
            commit: sha("next"),
            now: NOW,
            runNumber: 77,
            releases,
            requiredAndroidRecoveryTags: [tag],
          }),
        "Required Android recovery source is not eligible",
      );
    }
  });

  it("validates bounded JSON recovery-tag input before planning", () => {
    const tag = "fork-v1.0.1-nightly.20261008.69";
    assert.deepEqual(parseRequiredAndroidRecoveryTags(JSON.stringify([tag, tag])), [tag]);
    assert.deepEqual(parseRequiredAndroidRecoveryTags("[]"), []);
    for (const raw of [
      '"fork-v1.0.0"',
      "[null]",
      '["main"]',
      "{}",
      JSON.stringify(Array(9).fill(tag)),
    ])
      assert.throws(() => parseRequiredAndroidRecoveryTags(raw));
  });

  it("allocates above a hand-installed stable baseline for nightly and stable promotion", () => {
    const baseline = {
      tag: "fork-baseline",
      version: "1.0.0",
      commit: sha("baseline"),
    };
    const nightlyPlan = buildPlan({
      channel: "nightly",
      commit: sha("tip"),
      now: NOW,
      runNumber: 1,
      releases: [],
      baseline,
    });
    assert.equal(nightlyPlan.kind, "release");
    if (nightlyPlan.kind === "release") {
      assert.equal(nightlyPlan.plan.version, "1.0.1-nightly.20261011.1");
      assert.isAbove(compareForkVersions(nightlyPlan.plan.version, baseline.version), 0);
      assert.isTrue(nightlyPlan.plan.predecessor.baseline);
    }
    const nightly = makeRelease({
      version: "1.0.1-nightly.20261009.1",
      commit: sha("tip"),
      releasedAt: new Date(NOW.getTime() - 30 * 3600_000).toISOString(),
    });
    const stablePlan = buildPlan({
      channel: "stable",
      now: NOW,
      runNumber: 2,
      releases: [nightly],
      baseline,
    });
    assert.equal(stablePlan.kind, "release");
    if (stablePlan.kind === "release") assert.equal(stablePlan.plan.version, "1.0.1");
    assert.equal(nextStableVersion([], "0.0.45"), "1.0.0");
  });
  it("picks the newest eligible release built from a different commit", () => {
    const commit = sha("candidate");
    const older = makeRelease({ version: "1.0.0" });
    const sameSource = makeRelease({
      version: "1.0.1-nightly.20261006.1",
      commit,
    });
    const newer = makeRelease({ version: "1.0.1-nightly.20261005.1" });
    const draft = makeRelease({
      version: "1.0.1-nightly.20261007.1",
      draft: true,
      publishedAt: null,
    });
    const picked = selectPredecessor([older, sameSource, newer, draft], commit);
    assert.equal(picked?.version, "1.0.1-nightly.20261005.1");
    assert.equal(eligibleReleases([draft]).length, 0);
  });

  it("refuses to plan a release when there is no predecessor to recover to", () => {
    assert.throws(
      () =>
        buildPlan({
          channel: "nightly",
          commit: sha("tip"),
          now: NOW,
          runNumber: 1,
          releases: [],
        }),
      /baseline/,
    );
  });
});

describe("android installation codes", () => {
  it("allocates above the installed baseline when nothing is published", () => {
    const pair = nextAndroidCodePair(highestUsedAndroidCode({ releases: [], reservationTags: [] }));
    assert.deepStrictEqual(pair, {
      normal: ANDROID_BASELINE_VERSION_CODE + 1,
      recovery: ANDROID_BASELINE_VERSION_CODE + 2,
    });
  });

  it("allocates above every published normal and recovery code and every reservation", () => {
    const releases = [
      makeRelease({
        version: "1.0.0",
        normalCode: 29_853_700,
        recoveryCode: 29_853_701,
      }),
      makeRelease({
        version: "1.0.1",
        normalCode: 29_853_710,
        recoveryCode: 29_853_720,
      }),
    ];
    assert.equal(highestUsedAndroidCode({ releases, reservationTags: [] }), 29_853_720);
    assert.equal(
      highestUsedAndroidCode({
        releases,
        reservationTags: ["fork-android-code-29853730"],
      }),
      29_853_731,
    );
    assert.equal(
      nextAndroidCodePair(
        highestUsedAndroidCode({
          releases,
          reservationTags: ["fork-android-code-29853730"],
        }),
      ).normal,
      29_853_732,
    );
  });

  it("reserves a contiguous recovery range and honors its full extent after cancellation", () => {
    const allocation = nextAndroidCodeAllocation(29_853_700, 4);
    assert.deepStrictEqual(allocation, {
      normal: 29_853_701,
      recovery: 29_853_702,
      recoveries: [29_853_702, 29_853_703, 29_853_704, 29_853_705],
      reservedThrough: 29_853_705,
    });
    assert.equal(reservedAndroidCodeEnd("fork-android-code-range-29853701-29853705"), 29_853_705);
  });

  it("counts withdrawn and draft releases, which still occupy their codes", () => {
    const draft = makeRelease({
      version: "1.0.1",
      draft: true,
      publishedAt: null,
      normalCode: 29_900_000,
    });
    assert.equal(highestUsedAndroidCode({ releases: [draft], reservationTags: [] }), 29_900_001);
  });

  it("parses reservation tags strictly", () => {
    assert.equal(codeFromReservationTag("fork-android-code-29853700"), 29_853_700);
    assert.equal(codeFromReservationTag("fork-android-code-0"), null);
    assert.equal(codeFromReservationTag("fork-android-code-12x"), null);
    assert.equal(codeFromReservationTag("fork-v1.0.0"), null);
  });

  it("refuses to run past the maximum Android version code", () => {
    assert.deepStrictEqual(nextAndroidCodePair(ANDROID_MAX_VERSION_CODE - 2), {
      normal: ANDROID_MAX_VERSION_CODE - 1,
      recovery: ANDROID_MAX_VERSION_CODE,
    });
    assert.throws(() => nextAndroidCodePair(ANDROID_MAX_VERSION_CODE - 1), /exhausted/);
    assert.throws(() => nextAndroidCodePair(ANDROID_MAX_VERSION_CODE), /exhausted/);
  });
});

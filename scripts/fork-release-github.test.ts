// @effect-diagnostics nodeBuiltinImport:off globalDate:off - fixtures live on the real filesystem with fixed instants.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { FakeGitHub, makeManifest, prepareCandidate, sha } from "./fork-release-fixtures.ts";
import {
  GitHubApiError,
  createDraft,
  createGitHubApi,
  fetchRelease,
  loadReleaseRecords,
  publishDraft,
  reserveAndroidCodes,
  restoreRelease,
  withdrawRelease,
} from "./fork-release-github.ts";
import {
  ANDROID_BASELINE_VERSION_CODE,
  ANDROID_MAX_VERSION_CODE,
  classifyRelease,
  isWithdrawn,
  selectUpdateCandidate,
} from "./fork-release-policy.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-github-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("Android code reservation", () => {
  it("allocates above the installed baseline and then above its own previous reservation", async () => {
    const github = new FakeGitHub();
    const first = await reserveAndroidCodes(github, sha("a"));
    assert.deepStrictEqual(first, {
      normal: ANDROID_BASELINE_VERSION_CODE + 1,
      recovery: ANDROID_BASELINE_VERSION_CODE + 2,
      recoveries: [ANDROID_BASELINE_VERSION_CODE + 2],
      reservedThrough: ANDROID_BASELINE_VERSION_CODE + 2,
    });
    const second = await reserveAndroidCodes(github, sha("b"));
    assert.deepStrictEqual(second, {
      normal: ANDROID_BASELINE_VERSION_CODE + 3,
      recovery: ANDROID_BASELINE_VERSION_CODE + 4,
      recoveries: [ANDROID_BASELINE_VERSION_CODE + 4],
      reservedThrough: ANDROID_BASELINE_VERSION_CODE + 4,
    });
    assert.deepStrictEqual(
      [...github.tags.keys()],
      [
        "fork-android-code-range-29853679-29853680",
        "fork-android-code-29853679",
        "fork-android-code-range-29853681-29853682",
        "fork-android-code-29853681",
      ],
    );
  });

  it("allocates above every published normal and recovery code across channels", async () => {
    const github = new FakeGitHub();
    github.seedPublished(
      makeManifest({
        version: "1.0.0",
        normalCode: 29_860_000,
        recoveryCode: 29_860_001,
      }),
    );
    github.seedPublished(
      makeManifest({
        version: "1.0.1-nightly.20261006.3",
        normalCode: 29_860_010,
        recoveryCode: 29_860_050,
      }),
    );
    const pair = await reserveAndroidCodes(github, sha("a"));
    assert.deepStrictEqual(pair, {
      normal: 29_860_051,
      recovery: 29_860_052,
      recoveries: [29_860_052],
      reservedThrough: 29_860_052,
    });
  });

  it("never hands two concurrent runs the same code", async () => {
    const github = new FakeGitHub();
    const pairs = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => reserveAndroidCodes(github, sha(`run-${n}`))),
    );
    const codes = pairs.flatMap((pair) => [pair.normal, ...pair.recoveries]);
    assert.equal(new Set(codes).size, codes.length);
    assert.isAbove(Math.min(...codes), ANDROID_BASELINE_VERSION_CODE);
    const sorted = pairs.map((pair) => pair.normal).toSorted((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) assert.isAtLeast(sorted[i]! - sorted[i - 1]!, 2);
  });

  it("arbitrates concurrent reservations with different range lengths and burns interrupted ranges", async () => {
    const github = new FakeGitHub();
    const allocations = await Promise.all([
      reserveAndroidCodes(github, sha("short"), { recoveryCount: 1 }),
      reserveAndroidCodes(github, sha("long"), { recoveryCount: 4 }),
    ]);
    assert.notEqual(allocations[0]?.normal, allocations[1]?.normal);
    const allCodes = allocations.flatMap((entry) => [entry.normal, ...entry.recoveries]);
    assert.equal(new Set(allCodes).size, allCodes.length);

    const interrupted = new FakeGitHub();
    // Simulate a runner stopping after its durable range tag was created but before it
    // claimed the canonical start tag.
    interrupted.tags.set("fork-android-code-range-29853679-29853684", sha("cancelled"));
    const after = await reserveAndroidCodes(interrupted, sha("after"), {
      recoveryCount: 1,
    });
    assert.isAbove(after.normal, ANDROID_BASELINE_VERSION_CODE + 5);
    assert.isTrue(interrupted.tags.has("fork-android-code-range-29853679-29853684"));
  });

  it("retries after losing the race for a tag", async () => {
    const github = new FakeGitHub();
    let raced = false;
    github.beforeCreateTag = (name) => {
      if (!raced) {
        raced = true;
        github.tags.set(name, "other-run");
      }
    };
    const pair = await reserveAndroidCodes(github, sha("a"));
    assert.deepStrictEqual(pair, {
      normal: ANDROID_BASELINE_VERSION_CODE + 3,
      recovery: ANDROID_BASELINE_VERSION_CODE + 4,
      recoveries: [ANDROID_BASELINE_VERSION_CODE + 4],
      reservedThrough: ANDROID_BASELINE_VERSION_CODE + 4,
    });
  });

  it("claims nothing during a rehearsal", async () => {
    const github = new FakeGitHub();
    const pair = await reserveAndroidCodes(github, sha("a"), { dryRun: true });
    assert.equal(pair.normal, ANDROID_BASELINE_VERSION_CODE + 1);
    assert.equal(github.tags.size, 0);
  });

  it("stops when a published manifest is unreadable, because its codes are unknown", async () => {
    const github = new FakeGitHub();
    const release = github.seedPublished(makeManifest({ version: "1.0.0" }));
    const manifestId = [...release.assets].find(
      ([, asset]) => asset.name === "fork-release.json",
    )![0];
    release.assets.set(manifestId, {
      name: "fork-release.json",
      data: new TextEncoder().encode("{}"),
    });
    let failure: unknown;
    await reserveAndroidCodes(github, sha("a")).catch((cause) => (failure = cause));
    assert.match(String(failure), /unreadable fork-release\.json/);
  });

  it("fails once the Android code space is exhausted", async () => {
    const github = new FakeGitHub();
    github.seedPublished(
      makeManifest({
        version: "1.0.0",
        normalCode: ANDROID_MAX_VERSION_CODE - 1,
        recoveryCode: ANDROID_MAX_VERSION_CODE,
      }),
    );
    let failure: unknown;
    await reserveAndroidCodes(github, sha("a")).catch((cause) => (failure = cause));
    assert.match(String(failure), /exhausted/);
  });
});

describe("loading releases", () => {
  it("decodes manifests and records the reason when one is unreadable", async () => {
    const github = new FakeGitHub();
    github.seedPublished(makeManifest({ version: "1.0.0" }));
    const broken = github.seedPublished(makeManifest({ version: "1.0.1" }));
    const manifestId = [...broken.assets].find(
      ([, asset]) => asset.name === "fork-release.json",
    )![0];
    broken.assets.set(manifestId, {
      name: "fork-release.json",
      data: new TextEncoder().encode(JSON.stringify({ format: 2 })),
    });
    const records = await loadReleaseRecords(github);
    assert.equal(records.find((r) => r.tagName === "fork-v1.0.0")?.manifest?.version, "1.0.0");
    const unreadable = records.find((r) => r.tagName === "fork-v1.0.1")!;
    assert.equal(unreadable.manifest, null);
    assert.isString(unreadable.manifestError);
    assert.deepStrictEqual(classifyRelease(unreadable, records).reasons, ["invalid-manifest"]);
  });
});

describe("drafting a candidate", () => {
  it("uploads exactly the candidate files into a draft that is not yet visible as a release", async () => {
    const github = new FakeGitHub();
    const candidate = prepareCandidate(root);
    const draft = await createDraft(
      github,
      candidate.plan,
      candidate.candidateDir,
      "Nightly build.",
    );
    const stored = github.releases.get(draft.id)!;
    assert.equal(stored.draft, true);
    assert.equal(stored.prerelease, true);
    assert.equal(
      stored.name,
      `Arcwright Code Arcwright build ${candidate.plan.version.split(".").at(-1)} · Nightly`,
    );
    assert.include(
      stored.body,
      `<!-- t3-fork-release:candidate commit=${candidate.plan.commit} channel=nightly -->`,
    );
    const names = [...stored.assets.values()].map((asset) => asset.name).toSorted();
    const expected = NodeFS.readdirSync(candidate.candidateDir).toSorted();
    assert.deepStrictEqual(names, expected);
    assert.isFalse(github.tags.has(candidate.plan.tag));
  });

  it("refuses to draft when any required check is not true", async () => {
    const github = new FakeGitHub();
    const candidate = prepareCandidate(root, { failing: ["recovery"] });
    assert.deepStrictEqual(candidate.checks, {
      build: true,
      install: true,
      update: true,
      recovery: false,
    });
    let failure: unknown;
    await createDraft(github, candidate.plan, candidate.candidateDir, "").catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /required checks are not all true/);
    assert.equal(github.releases.size, 0);
  });

  it("refuses a manifest that does not describe the pinned plan", async () => {
    const github = new FakeGitHub();
    const candidate = prepareCandidate(root);
    let failure: unknown;
    await createDraft(
      github,
      { ...candidate.plan, commit: sha("different") },
      candidate.candidateDir,
      "",
    ).catch((cause) => (failure = cause));
    assert.match(String(failure), /does not describe the pinned plan/);
  });

  it("refuses a candidate whose files no longer match the manifest", async () => {
    const github = new FakeGitHub();
    const candidate = prepareCandidate(root);
    NodeFS.appendFileSync(
      NodePath.join(candidate.candidateDir, `T3-Code-${candidate.plan.version}-x64.exe`),
      "x",
    );
    let failure: unknown;
    await createDraft(github, candidate.plan, candidate.candidateDir, "").catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /incomplete/);
  });

  it("never overwrites an existing release or tag", async () => {
    const candidate = prepareCandidate(root);
    const withRelease = new FakeGitHub();
    withRelease.seedPublished(makeManifest({ version: candidate.plan.version }));
    let failure: unknown;
    await createDraft(withRelease, candidate.plan, candidate.candidateDir, "").catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /already exists/);
    const withTag = new FakeGitHub();
    withTag.tags.set(candidate.plan.tag, "x");
    failure = undefined;
    await createDraft(withTag, candidate.plan, candidate.candidateDir, "").catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /already exists/);
  });

  it("removes a half-uploaded draft so the retry is not blocked", async () => {
    const github = new FakeGitHub();
    github.failUploadNumber = 3;
    const candidate = prepareCandidate(root);
    let failure: unknown;
    await createDraft(github, candidate.plan, candidate.candidateDir, "").catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /upload interrupted/);
    assert.equal(github.releases.size, 0);
  });
});

describe("publishing", () => {
  const draftOf = async (github: FakeGitHub, candidate: ReturnType<typeof prepareCandidate>) =>
    (await createDraft(github, candidate.plan, candidate.candidateDir, "Notes.")).id;

  it("publishes a verified draft as an eligible nightly that devices then select", async () => {
    const github = new FakeGitHub();
    const candidate = prepareCandidate(root);
    const id = await draftOf(github, candidate);
    const published = await publishDraft(
      github,
      candidate.plan,
      id,
      NodePath.join(root, "scratch"),
    );
    assert.equal(published.draft, false);
    assert.equal(published.prerelease, true);
    const records = await loadReleaseRecords(github);
    const record = records.find((r) => r.id === id)!;
    assert.deepStrictEqual(classifyRelease(record, records), {
      eligible: true,
      reasons: [],
    });
    assert.equal(
      selectUpdateCandidate({
        channel: "nightly",
        installedVersion: "1.0.0",
        releases: records,
      })?.manifest?.version,
      candidate.plan.version,
    );
  });

  it("refuses to publish when an uploaded asset's bytes differ from the manifest", async () => {
    const github = new FakeGitHub();
    const candidate = prepareCandidate(root);
    const id = await draftOf(github, candidate);
    github.corruptAsset(id, `t3-code-android-${candidate.plan.version}.apk`);
    let failure: unknown;
    await publishDraft(github, candidate.plan, id, NodePath.join(root, "scratch")).catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /does not match its manifest/);
    assert.equal(github.releases.get(id)!.draft, true);
  });

  it("refuses to publish when another release took the tag or the commit meanwhile", async () => {
    const candidate = prepareCandidate(root);
    const taken = new FakeGitHub();
    const id = await draftOf(taken, candidate);
    taken.tags.set(candidate.plan.tag, "someone-else");
    let failure: unknown;
    await publishDraft(taken, candidate.plan, id, NodePath.join(root, "scratch-a")).catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /no longer publishable/);

    const raced = new FakeGitHub();
    const raceId = await draftOf(raced, candidate);
    raced.seedPublished(
      makeManifest({
        version: "1.0.1-nightly.20261006.99",
        commit: candidate.plan.commit,
      }),
    );
    failure = undefined;
    await publishDraft(raced, candidate.plan, raceId, NodePath.join(root, "scratch-b")).catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /already ships this commit/);
    assert.equal(raced.releases.get(raceId)!.draft, true);
  });

  it("publishes repeated commissioning builds only while their exact prior eligible source remains newest", async () => {
    const github = new FakeGitHub();
    const commit = sha("commission-chain");
    const sourceA = makeManifest({
      version: "1.0.1-nightly.20261010.10",
      commit,
      releasedAt: "2026-10-06T06:00:00.000Z",
    });
    github.seedPublished(sourceA);
    const sourceARef = {
      tag: `fork-v${sourceA.version}`,
      version: sourceA.version,
      commit,
    };

    const candidateB = prepareCandidate(NodePath.join(root, "commission-b"), {
      version: "1.0.1-nightly.20261010.11",
      commit,
    });
    const planB = { ...candidateB.plan, commissioningSource: sourceARef };
    const draftB = (await createDraft(github, planB, candidateB.candidateDir, "Commission B.")).id;
    const publishedB = await publishDraft(
      github,
      planB,
      draftB,
      NodePath.join(root, "commission-b-verify"),
    );
    assert.isFalse(publishedB.draft);
    const recordsB = await loadReleaseRecords(github);
    const recordB = recordsB.find((record) => record.id === draftB)!;
    assert.deepStrictEqual(classifyRelease(recordB, recordsB), {
      eligible: true,
      reasons: [],
    });

    const candidateC = prepareCandidate(NodePath.join(root, "commission-c"), {
      version: "1.0.1-nightly.20261010.12",
      commit,
    });
    const planC = {
      ...candidateC.plan,
      commissioningSource: {
        tag: recordB.tagName,
        version: recordB.manifest!.version,
        commit,
      },
    };
    const draftC = (await createDraft(github, planC, candidateC.candidateDir, "Commission C.")).id;
    const publishedC = await publishDraft(
      github,
      planC,
      draftC,
      NodePath.join(root, "commission-c-verify"),
    );
    assert.isFalse(publishedC.draft);
    const recordsC = await loadReleaseRecords(github);
    assert.deepStrictEqual(
      classifyRelease(
        recordsC.find((record) => record.id === draftC)!,
        recordsC,
      ),
      { eligible: true, reasons: [] },
    );
  });

  it("blocks a commissioning publish if the bound source is withdrawn or a concurrent same-source draft appears", async () => {
    const github = new FakeGitHub();
    const commit = sha("commission-race");
    const source = makeManifest({
      version: "1.0.1-nightly.20261010.20",
      commit,
    });
    const sourceRelease = github.seedPublished(source);
    const candidate = prepareCandidate(NodePath.join(root, "commission-race"), {
      version: "1.0.1-nightly.20261010.21",
      commit,
    });
    const plan = {
      ...candidate.plan,
      commissioningSource: {
        tag: `fork-v${source.version}`,
        version: source.version,
        commit,
      },
    };
    const draftId = (await createDraft(github, plan, candidate.candidateDir, "Commission race."))
      .id;
    github.seedPublished(makeManifest({ version: "1.0.1-nightly.20261010.22", commit }), {
      draft: true,
      body: `<!-- t3-fork-release:candidate commit=${commit} channel=nightly -->`,
    });
    let failure: unknown;
    await publishDraft(github, plan, draftId, NodePath.join(root, "commission-race-verify")).catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /blocks commissioning/);
    assert.isTrue(github.releases.get(draftId)!.draft);

    for (const [id, release] of github.releases) {
      if (id !== draftId && release.draft) github.releases.delete(id);
    }
    await withdrawRelease(
      github,
      source.version,
      "commission source changed",
      new Date("2026-10-11T08:40:00Z"),
    );
    failure = undefined;
    await publishDraft(
      github,
      plan,
      draftId,
      NodePath.join(root, "commission-race-verify-2"),
    ).catch((cause) => (failure = cause));
    assert.match(
      String(failure),
      /bound commissioning source is no longer eligible|blocks commissioning/,
    );
    assert.isTrue(github.releases.get(draftId)!.draft);
    assert.isTrue(github.releases.has(sourceRelease.id));
  });

  it("rechecks the source nightly of a stable release and stops when it was withdrawn during the build", async () => {
    const github = new FakeGitHub();
    const nightly = prepareCandidate(NodePath.join(root, "nightly"), {
      version: "1.0.1-nightly.20261004.2",
      now: new Date("2026-10-04T07:40:00Z"),
    });
    const nightlyId = (await createDraft(github, nightly.plan, nightly.candidateDir, "Nightly."))
      .id;
    await publishDraft(github, nightly.plan, nightlyId, NodePath.join(root, "scratch-nightly"));

    const stable = prepareCandidate(NodePath.join(root, "stable"), {
      version: "1.0.1",
      channel: "stable",
      commit: nightly.plan.commit,
      predecessorCommit: sha("older-source"),
    });
    const plan = {
      ...stable.plan,
      source: {
        tag: nightly.plan.tag,
        version: nightly.plan.version,
        releasedAt: nightly.manifest.releasedAt,
      },
    };
    const id = (await createDraft(github, plan, stable.candidateDir, "Stable.")).id;

    await withdrawRelease(
      github,
      nightly.plan.version,
      "regression found",
      new Date("2026-10-11T08:40:00Z"),
    );
    let failure: unknown;
    await publishDraft(github, plan, id, NodePath.join(root, "scratch")).catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /no longer eligible: withdrawn/);
    assert.equal(github.releases.get(id)!.draft, true);

    await restoreRelease(github, nightly.plan.version, NodePath.join(root, "restore"));
    const published = await publishDraft(github, plan, id, NodePath.join(root, "scratch-2"));
    assert.equal(published.prerelease, false);
  });
});

describe("withdrawal and restoration", () => {
  const publish = async (github: FakeGitHub) => {
    const candidate = prepareCandidate(root);
    const id = (await createDraft(github, candidate.plan, candidate.candidateDir, "Notes.")).id;
    await publishDraft(github, candidate.plan, id, NodePath.join(root, "scratch"));
    return { candidate, id };
  };

  it("changes eligibility through the release notes alone and is reversible", async () => {
    const github = new FakeGitHub();
    const { candidate, id } = await publish(github);
    const before = [...github.releases.get(id)!.assets.values()].map((asset) => [
      asset.name,
      Buffer.from(asset.data).toString("base64"),
    ]);

    assert.equal(
      await withdrawRelease(
        github,
        candidate.plan.version,
        "boot loop",
        new Date("2026-10-07T00:00:00Z"),
      ),
      "withdrawn",
    );
    assert.equal(
      await withdrawRelease(
        github,
        candidate.plan.version,
        "again",
        new Date("2026-10-08T00:00:00Z"),
      ),
      "already-withdrawn",
    );
    let records = await loadReleaseRecords(github);
    assert.equal(isWithdrawn(records.find((r) => r.id === id)!), true);
    assert.deepStrictEqual(
      classifyRelease(
        records.find((r) => r.id === id)!,
        records,
      ).reasons,
      ["withdrawn"],
    );
    assert.equal(
      selectUpdateCandidate({
        channel: "nightly",
        installedVersion: "1.0.0",
        releases: records,
      }),
      null,
    );
    const after = [...github.releases.get(id)!.assets.values()].map((asset) => [
      asset.name,
      Buffer.from(asset.data).toString("base64"),
    ]);
    assert.deepStrictEqual(after, before);
    assert.isTrue(github.tags.has(candidate.plan.tag));

    assert.equal(
      await restoreRelease(github, candidate.plan.version, NodePath.join(root, "restore")),
      "restored",
    );
    assert.equal(
      await restoreRelease(github, candidate.plan.version, NodePath.join(root, "restore-2")),
      "not-withdrawn",
    );
    records = await loadReleaseRecords(github);
    assert.equal(
      classifyRelease(
        records.find((r) => r.id === id)!,
        records,
      ).eligible,
      true,
    );
  });

  it("refuses to restore a release whose payload no longer verifies", async () => {
    const github = new FakeGitHub();
    const { candidate, id } = await publish(github);
    await withdrawRelease(github, candidate.plan.version, "bad", new Date("2026-10-07T00:00:00Z"));
    github.corruptAsset(id, `T3-Code-${candidate.plan.version}-x64.exe`);
    let failure: unknown;
    await restoreRelease(github, candidate.plan.version, NodePath.join(root, "restore")).catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /Refusing to restore/);
    assert.equal(isWithdrawn({ body: github.releases.get(id)!.body }), true);
  });

  it("reports an unknown version rather than guessing", async () => {
    let failure: unknown;
    await withdrawRelease(new FakeGitHub(), "1.0.0", "x", new Date()).catch(
      (cause) => (failure = cause),
    );
    assert.match(String(failure), /fork-v1\.0\.0 does not exist/);
  });
});

describe("fetching a predecessor", () => {
  it("downloads and verifies a published release and returns its payload digest", async () => {
    const github = new FakeGitHub();
    const candidate = prepareCandidate(root);
    const id = (await createDraft(github, candidate.plan, candidate.candidateDir, "")).id;
    await publishDraft(github, candidate.plan, id, NodePath.join(root, "scratch"));
    const fetched = await fetchRelease(
      github,
      candidate.plan.tag,
      NodePath.join(root, "predecessor"),
    );
    assert.equal(fetched.version, candidate.plan.version);
    assert.isFalse(fetched.baseline);
    assert.match(fetched.digest, /^[0-9a-f]{64}$/);
    assert.isTrue(
      NodeFS.existsSync(
        NodePath.join(root, "predecessor", `T3-Code-${candidate.plan.version}-x64.exe`),
      ),
    );
  });
});

describe("GitHub REST client", () => {
  const recorded: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const respond = (
    handler: (url: string, method: string) => { status: number; body?: unknown },
  ): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      recorded.push({
        url,
        method,
        headers: init?.headers as Record<string, string>,
        body: init?.body,
      });
      const { status, body } = handler(url, method);
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      });
    }) as typeof fetch;
  beforeEach(() => {
    recorded.length = 0;
  });

  it("authenticates, pages through every release, and reads drafts the token can see", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: i,
        tag_name: `t${i}`,
        assets: [],
      }));
    const api = createGitHubApi({
      token: "tok",
      repository: "unn-corp/t3code",
      fetch: respond((url) => ({
        status: 200,
        body: url.endsWith("&page=1") ? page(100) : page(7),
      })),
    });
    const releases = await api.listReleases();
    assert.equal(releases.length, 107);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0]!.headers.Authorization, "Bearer tok");
    assert.include(
      recorded[0]!.url,
      "https://api.github.com/repos/unn-corp/t3code/releases?per_page=100&page=1",
    );
  });

  it("treats a duplicate ref as a lost race and a missing tag as absent, but surfaces real errors", async () => {
    const api = createGitHubApi({
      token: "tok",
      repository: "unn-corp/t3code",
      fetch: respond((url, method) => {
        if (method === "POST")
          return { status: 422, body: { message: "Reference already exists" } };
        if (url.endsWith("/git/ref/tags/fork-v1.0.0")) return { status: 404 };
        return { status: 500, body: { message: "boom" } };
      }),
    });
    assert.equal(await api.createTag("fork-android-code-1", sha("a")), false);
    assert.equal(await api.tagExists("fork-v1.0.0"), false);
    let failure: unknown;
    await api.getRelease(1).catch((cause) => (failure = cause));
    assert.instanceOf(failure, GitHubApiError);
    assert.equal((failure as GitHubApiError).status, 500);
  });

  it("creates drafts pinned to the exact commit and publishes with the intended latest flag", async () => {
    const api = createGitHubApi({
      token: "tok",
      repository: "unn-corp/t3code",
      fetch: respond(() => ({
        status: 200,
        body: { id: 5, tag_name: "fork-v1.0.0", assets: [] },
      })),
    });
    await api.createDraftRelease({
      tagName: "fork-v1.0.0",
      commit: sha("pin"),
      name: "n",
      body: "b",
      prerelease: false,
    });
    await api.updateRelease(5, {
      draft: false,
      prerelease: false,
      makeLatest: true,
    });
    const [create, update] = recorded.map((call) => JSON.parse(String(call.body)));
    assert.deepStrictEqual(
      [create.target_commitish, create.draft, create.make_latest, update.draft, update.make_latest],
      [sha("pin"), true, "false", false, "true"],
    );
  });
});

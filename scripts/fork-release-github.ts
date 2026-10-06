// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - release tooling talks to the GitHub REST API directly.
// GitHub access for the fork release pipeline. `GitHubApi` is the whole surface the pipeline
// needs, so tests run the real publish/withdraw logic against an in-memory implementation.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  allChecksPass,
  candidateDigest,
  verifyPayloadAgainstManifest,
} from "./fork-release-assets.ts";
import {
  BASELINE_MANIFEST_ASSET,
  BASELINE_TAG,
  baselineDigest,
  parseBaselineManifest,
  verifyBaselinePayload,
  type BaselineManifest,
} from "./fork-release-baseline.ts";
import { decodeForkReleaseManifest } from "./fork-release-contract.ts";
import {
  ANDROID_CODE_TAG_PREFIX,
  FORK_MANIFEST_ASSET,
  androidCodeTag,
  candidateMarker,
  classifyRelease,
  forkTagForVersion,
  highestUsedAndroidCode,
  isWithdrawn,
  nextAndroidCodePair,
  recordedChannel,
  recordedCommit,
  withWithdrawal,
  withoutWithdrawal,
  type AndroidCodePair,
  type ReleasePlan,
  type ReleaseRecord,
} from "./fork-release-policy.ts";

export interface RawAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
}

export interface RawRelease {
  readonly id: number;
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly body: string | null;
  readonly created_at: string;
  readonly published_at: string | null;
  readonly assets: ReadonlyArray<RawAsset>;
}

export interface CreateReleaseInput {
  readonly tagName: string;
  readonly commit: string;
  readonly name: string;
  readonly body: string;
  readonly prerelease: boolean;
}

export interface GitHubApi {
  /** Every release the token can see; drafts only appear with push access. */
  listReleases(): Promise<ReadonlyArray<RawRelease>>;
  getRelease(id: number): Promise<RawRelease>;
  downloadAsset(id: number): Promise<Uint8Array>;
  /** Names of tags (without `refs/tags/`) that start with a prefix. */
  listTags(prefix: string): Promise<ReadonlyArray<string>>;
  /** Resolves false when the tag already exists. */
  createTag(name: string, commit: string): Promise<boolean>;
  tagExists(name: string): Promise<boolean>;
  createDraftRelease(input: CreateReleaseInput): Promise<RawRelease>;
  uploadAsset(releaseId: number, name: string, data: Uint8Array): Promise<RawAsset>;
  updateRelease(
    id: number,
    patch: { body?: string; draft?: false; prerelease?: boolean; makeLatest?: boolean },
  ): Promise<RawRelease>;
  deleteRelease(id: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// REST implementation
// ---------------------------------------------------------------------------------------------

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, method: string, url: string, detail: string) {
    super(`${method} ${url} failed with ${status}: ${detail}`);
    this.status = status;
  }
}

export const createGitHubApi = (input: {
  readonly token: string;
  readonly repository: string;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
  readonly uploadBase?: string;
}): GitHubApi => {
  const doFetch = input.fetch ?? fetch;
  const api = input.apiBase ?? "https://api.github.com";
  const uploads = input.uploadBase ?? "https://uploads.github.com";
  const repo = `${api}/repos/${input.repository}`;

  const request = async (
    method: string,
    url: string,
    options: {
      body?: string | Uint8Array<ArrayBuffer>;
      headers?: Record<string, string>;
      ok?: ReadonlyArray<number>;
    } = {},
  ): Promise<Response> => {
    const response = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    if (!response.ok && !(options.ok ?? []).includes(response.status)) {
      throw new GitHubApiError(response.status, method, url, (await response.text()).slice(0, 500));
    }
    return response;
  };
  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
  const paged = async <T>(path: string): Promise<T[]> => {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      const response = await request(
        "GET",
        `${repo}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const batch = await json<T[]>(response);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  };

  return {
    listReleases: () => paged<RawRelease>("/releases"),
    getRelease: async (id) => json<RawRelease>(await request("GET", `${repo}/releases/${id}`)),
    downloadAsset: async (id) =>
      new Uint8Array(
        await (
          await request("GET", `${repo}/releases/assets/${id}`, {
            headers: { Accept: "application/octet-stream" },
          })
        ).arrayBuffer(),
      ),
    listTags: async (prefix) => {
      const refs = await paged<{ ref: string }>(`/git/matching-refs/tags/${prefix}`);
      return refs.map((ref) => ref.ref.slice("refs/tags/".length));
    },
    createTag: async (name, commit) => {
      const response = await request("POST", `${repo}/git/refs`, {
        body: JSON.stringify({ ref: `refs/tags/${name}`, sha: commit }),
        headers: { "Content-Type": "application/json" },
        ok: [422],
      });
      return response.status !== 422;
    },
    tagExists: async (name) =>
      (await request("GET", `${repo}/git/ref/tags/${name}`, { ok: [404] })).status !== 404,
    createDraftRelease: async (release) =>
      json<RawRelease>(
        await request("POST", `${repo}/releases`, {
          body: JSON.stringify({
            tag_name: release.tagName,
            target_commitish: release.commit,
            name: release.name,
            body: release.body,
            draft: true,
            prerelease: release.prerelease,
            make_latest: "false",
          }),
          headers: { "Content-Type": "application/json" },
        }),
      ),
    uploadAsset: async (releaseId, name, data) =>
      json<RawAsset>(
        await request(
          "POST",
          `${uploads}/repos/${input.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
          {
            body: data as Uint8Array<ArrayBuffer>,
            headers: { "Content-Type": "application/octet-stream" },
          },
        ),
      ),
    updateRelease: async (id, patch) =>
      json<RawRelease>(
        await request("PATCH", `${repo}/releases/${id}`, {
          body: JSON.stringify({
            ...(patch.body === undefined ? {} : { body: patch.body }),
            ...(patch.draft === undefined ? {} : { draft: patch.draft }),
            ...(patch.prerelease === undefined ? {} : { prerelease: patch.prerelease }),
            ...(patch.makeLatest === undefined
              ? {}
              : { make_latest: patch.makeLatest ? "true" : "false" }),
          }),
          headers: { "Content-Type": "application/json" },
        }),
      ),
    deleteRelease: async (id) => {
      await request("DELETE", `${repo}/releases/${id}`);
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Reading release state
// ---------------------------------------------------------------------------------------------

/** Lists releases with their decoded fork-release.json; an undecodable manifest is recorded, not hidden. */
export const loadReleaseRecords = async (github: GitHubApi): Promise<ReleaseRecord[]> => {
  const records: ReleaseRecord[] = [];
  for (const raw of await github.listReleases()) {
    const base = {
      id: raw.id,
      tagName: raw.tag_name,
      draft: raw.draft,
      body: raw.body ?? "",
      createdAt: raw.created_at,
      publishedAt: raw.published_at,
      assets: raw.assets.map(({ id, name, size }) => ({ id, name, size })),
    };
    const manifestAsset = raw.assets.find((asset) => asset.name === FORK_MANIFEST_ASSET);
    if (!manifestAsset) {
      records.push({ ...base, manifest: null });
      continue;
    }
    try {
      const bytes = await github.downloadAsset(manifestAsset.id);
      const manifest = decodeForkReleaseManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
      records.push({ ...base, manifest });
    } catch (cause) {
      records.push({
        ...base,
        manifest: null,
        manifestError: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return records;
};

// ---------------------------------------------------------------------------------------------
// Android installation codes
// ---------------------------------------------------------------------------------------------

/**
 * Reserves the next pair of codes. Creating the reservation tag is the atomic step: GitHub
 * rejects a duplicate ref, so two runs can never claim the same code, and the loser re-reads.
 */
export const reserveAndroidCodes = async (
  github: GitHubApi,
  commit: string,
  options: { readonly dryRun?: boolean; readonly attempts?: number } = {},
): Promise<AndroidCodePair> => {
  for (let attempt = 0; attempt < (options.attempts ?? 8); attempt += 1) {
    const [releases, reservationTags] = await Promise.all([
      loadReleaseRecords(github),
      github.listTags(ANDROID_CODE_TAG_PREFIX),
    ]);
    const invalid = releases.find((record) => record.manifestError);
    if (invalid) {
      throw new Error(
        `${invalid.tagName} has an unreadable fork-release.json, so its codes are unknown.`,
      );
    }
    const pair = nextAndroidCodePair(highestUsedAndroidCode({ releases, reservationTags }));
    // A rehearsal reads the allocator but claims nothing, so it can never burn a real code.
    if (options.dryRun || (await github.createTag(androidCodeTag(pair.normal), commit)))
      return pair;
  }
  throw new Error("Could not reserve Android installation codes after repeated conflicts.");
};

// ---------------------------------------------------------------------------------------------
// Draft, verify, publish
// ---------------------------------------------------------------------------------------------

export const releaseNotes = (plan: ReleasePlan, summary: string): string =>
  [
    candidateMarker(plan.commit, plan.channel),
    `Fork ${plan.channel} release ${plan.version} built from \`${plan.commit}\`.`,
    plan.source
      ? `Promoted from nightly \`${plan.source.tag}\` (checks completed ${plan.source.releasedAt}).`
      : "",
    summary,
  ]
    .filter(Boolean)
    .join("\n\n");

const readDirFiles = (dir: string): string[] =>
  NodeFS.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

/**
 * Creates the draft for a candidate directory and uploads every file. The draft is created only
 * once validation is complete, so a draft is always a whole candidate. An existing release for the
 * tag stops the run: payloads and tags are never overwritten.
 */
export const createDraft = async (
  github: GitHubApi,
  plan: ReleasePlan,
  candidateDir: string,
  summary: string,
): Promise<RawRelease> => {
  const manifest = decodeForkReleaseManifest(
    JSON.parse(NodeFS.readFileSync(NodePath.join(candidateDir, FORK_MANIFEST_ASSET), "utf8")),
  );
  if (!allChecksPass(manifest.checks)) {
    throw new Error(`Refusing to draft ${plan.tag}: required checks are not all true.`);
  }
  if (
    manifest.version !== plan.version ||
    manifest.commit !== plan.commit ||
    manifest.channel !== plan.channel
  ) {
    throw new Error("The manifest does not describe the pinned plan.");
  }
  const payload = verifyPayloadAgainstManifest(candidateDir, manifest);
  if (payload.length > 0) throw new Error(`The candidate is incomplete:\n${payload.join("\n")}`);

  const existing = (await github.listReleases()).find((release) => release.tag_name === plan.tag);
  if (existing || (await github.tagExists(plan.tag))) {
    throw new Error(`${plan.tag} already exists; releases are never overwritten.`);
  }

  const draft = await github.createDraftRelease({
    tagName: plan.tag,
    commit: plan.commit,
    name: `T3 Code fork ${plan.version}`,
    body: releaseNotes(plan, summary),
    prerelease: plan.channel === "nightly",
  });
  try {
    for (const name of readDirFiles(candidateDir)) {
      await github.uploadAsset(
        draft.id,
        name,
        NodeFS.readFileSync(NodePath.join(candidateDir, name)),
      );
    }
  } catch (cause) {
    // An unpublished, half-uploaded draft is not a payload; leaving it would block the retry.
    await github.deleteRelease(draft.id);
    throw cause;
  }
  return draft;
};

/** Downloads every asset of a release back and compares it with the manifest it carries. */
export const verifyReleaseAssets = async (
  github: GitHubApi,
  releaseId: number,
  scratchDir: string,
): Promise<string[]> => {
  const release = await github.getRelease(releaseId);
  NodeFS.mkdirSync(scratchDir, { recursive: true });
  for (const asset of release.assets) {
    NodeFS.writeFileSync(
      NodePath.join(scratchDir, asset.name),
      await github.downloadAsset(asset.id),
    );
  }
  const manifestFile = NodePath.join(scratchDir, FORK_MANIFEST_ASSET);
  if (!NodeFS.existsSync(manifestFile))
    return [`${FORK_MANIFEST_ASSET}: missing from the release.`];
  const manifest = decodeForkReleaseManifest(JSON.parse(NodeFS.readFileSync(manifestFile, "utf8")));
  const problems = verifyPayloadAgainstManifest(scratchDir, manifest);
  for (const asset of release.assets) {
    if (asset.size !== NodeFS.statSync(NodePath.join(scratchDir, asset.name)).size) {
      problems.push(`${asset.name}: uploaded size differs from the downloaded bytes.`);
    }
  }
  return problems;
};

/**
 * Re-reads everything that could have changed since planning. Called with a write token, so
 * drafts and withdrawals made during the build are visible.
 */
export const recheckCandidate = async (
  github: GitHubApi,
  plan: ReleasePlan,
  draftId: number,
): Promise<string[]> => {
  const problems: string[] = [];
  const records = await loadReleaseRecords(github);
  const others = records.filter((record) => record.id !== draftId);

  if (others.some((record) => record.tagName === plan.tag))
    problems.push(`${plan.tag} is already used.`);
  if (await github.tagExists(plan.tag)) problems.push(`Tag ${plan.tag} already exists.`);
  for (const record of others) {
    if (
      !isWithdrawn(record) &&
      recordedCommit(record) === plan.commit &&
      recordedChannel(record) === plan.channel
    ) {
      problems.push(`${record.tagName} already ships this commit as ${plan.channel}.`);
    }
  }

  if (plan.source) {
    const source = records.find((record) => record.tagName === plan.source?.tag);
    if (!source) {
      problems.push(`The source nightly ${plan.source.tag} no longer exists.`);
    } else {
      const classification = classifyRelease(source, records);
      if (!classification.eligible) {
        problems.push(
          `The source nightly ${source.tagName} is no longer eligible: ${classification.reasons.join(", ")}.`,
        );
      }
      if (source.manifest?.commit !== plan.commit)
        problems.push("The source nightly's commit changed.");
    }
  }
  return problems;
};

export const publishDraft = async (
  github: GitHubApi,
  plan: ReleasePlan,
  draftId: number,
  scratchDir: string,
): Promise<RawRelease> => {
  const verification = await verifyReleaseAssets(github, draftId, scratchDir);
  if (verification.length > 0)
    throw new Error(`The draft does not match its manifest:\n${verification.join("\n")}`);
  const recheck = await recheckCandidate(github, plan, draftId);
  if (recheck.length > 0)
    throw new Error(`The candidate is no longer publishable:\n${recheck.join("\n")}`);
  return github.updateRelease(draftId, {
    draft: false,
    prerelease: plan.channel === "nightly",
    makeLatest: plan.channel === "stable",
  });
};

// ---------------------------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------------------------

const requireRelease = async (github: GitHubApi, version: string): Promise<RawRelease> => {
  const tag = forkTagForVersion(version);
  const release = (await github.listReleases()).find((entry) => entry.tag_name === tag);
  if (!release) throw new Error(`${tag} does not exist.`);
  return release;
};

/** Withdrawal rewrites the release notes only. Assets, tag, and manifest are never touched. */
export const withdrawRelease = async (
  github: GitHubApi,
  version: string,
  reason: string,
  at: Date,
): Promise<"withdrawn" | "already-withdrawn"> => {
  const release = await requireRelease(github, version);
  const body = release.body ?? "";
  if (isWithdrawn({ body })) return "already-withdrawn";
  await github.updateRelease(release.id, { body: withWithdrawal(body, reason, at.toISOString()) });
  return "withdrawn";
};

/** The reverse of withdrawal. The payload must still verify before the release is eligible again. */
export const restoreRelease = async (
  github: GitHubApi,
  version: string,
  scratchDir: string,
): Promise<"restored" | "not-withdrawn"> => {
  const release = await requireRelease(github, version);
  const body = release.body ?? "";
  if (!isWithdrawn({ body })) return "not-withdrawn";
  const problems = await verifyReleaseAssets(github, release.id, scratchDir);
  if (problems.length > 0)
    throw new Error(`Refusing to restore ${version}:\n${problems.join("\n")}`);
  await github.updateRelease(release.id, { body: withoutWithdrawal(body) });
  return "restored";
};

export interface BaselineRecord {
  readonly releaseId: number;
  readonly manifest: BaselineManifest;
}

/** The manual baseline release, or null when none has been published. */
export const loadBaseline = async (github: GitHubApi): Promise<BaselineRecord | null> => {
  const release = (await github.listReleases()).find((entry) => entry.tag_name === BASELINE_TAG);
  const asset = release?.assets.find((entry) => entry.name === BASELINE_MANIFEST_ASSET);
  if (!release || !asset) return null;
  const manifest = parseBaselineManifest(
    JSON.parse(Buffer.from(await github.downloadAsset(asset.id)).toString("utf8")),
  );
  return { releaseId: release.id, manifest };
};

export interface FetchedPredecessor {
  readonly version: string;
  readonly commit: string;
  readonly digest: string;
  readonly baseline: boolean;
}

/**
 * Downloads a predecessor's assets into a directory, verifying each against the manifest it
 * carries. The digest identifies the payload that update and recovery tests ran from.
 */
export const fetchRelease = async (
  github: GitHubApi,
  tag: string,
  outDir: string,
): Promise<FetchedPredecessor> => {
  if (tag === BASELINE_TAG) {
    const baseline = await loadBaseline(github);
    if (!baseline) throw new Error("The baseline release does not exist.");
    NodeFS.mkdirSync(outDir, { recursive: true });
    for (const asset of (await github.getRelease(baseline.releaseId)).assets) {
      NodeFS.writeFileSync(NodePath.join(outDir, asset.name), await github.downloadAsset(asset.id));
    }
    const problems = verifyBaselinePayload(outDir, baseline.manifest);
    if (problems.length > 0)
      throw new Error(`The baseline does not verify:\n${problems.join("\n")}`);
    return {
      version: baseline.manifest.version,
      commit: baseline.manifest.commit,
      digest: baselineDigest(baseline.manifest),
      baseline: true,
    };
  }
  const release = (await github.listReleases()).find((entry) => entry.tag_name === tag);
  if (!release) throw new Error(`${tag} does not exist.`);
  const problems = await verifyReleaseAssets(github, release.id, outDir);
  if (problems.length > 0) throw new Error(`${tag} does not verify:\n${problems.join("\n")}`);
  const manifest = decodeForkReleaseManifest(
    JSON.parse(NodeFS.readFileSync(NodePath.join(outDir, FORK_MANIFEST_ASSET), "utf8")),
  );
  return {
    version: manifest.version,
    commit: manifest.commit,
    digest: candidateDigest(manifest.assets),
    baseline: false,
  };
};

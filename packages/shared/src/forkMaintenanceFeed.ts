// @effect-diagnostics globalDate:off globalTimers:off — a plain AbortController timeout keeps this usable outside Effect runtimes.
/**
 * Release discovery over GitHub HTTPS. The accepted trust boundary is the fork's
 * GitHub release origin plus platform signatures and the digests recorded in
 * fork-release.json. There is no separate signed index, and a digest alone never
 * authenticates a payload: it only detects corruption and mismatched assets.
 */
import { ForkReleaseManifest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  FORK_MANIFEST_ASSET,
  FORK_RELEASES_API,
  isForkReleaseUrl,
  type ForkReleaseRecord,
} from "./forkMaintenance.ts";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const decodeManifest = Schema.decodeUnknownSync(ForkReleaseManifest);

export type FetchLike = (
  input: string,
  init?: { readonly signal?: AbortSignal; readonly headers?: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { readonly get: (name: string) => string | null };
  readonly text: () => Promise<string>;
}>;

export class ForkFeedError extends Error {
  override readonly name: string = "ForkFeedError";
}

/** GitHub's advertised cooldown is distinct from an ordinary network failure. */
export class ForkFeedRateLimitError extends ForkFeedError {
  override readonly name = "ForkFeedRateLimitError";
  readonly retryAt: number;
  constructor(retryAt: number) {
    super(
      `GitHub's release API rate limit has been reached. Try again after ${new Date(retryAt).toISOString()}.`,
    );
    this.retryAt = retryAt;
  }
}

const rateLimitRetryAt = (response: Awaited<ReturnType<FetchLike>>, now: number): number | null => {
  if (response.status !== 403 && response.status !== 429) return null;
  const remaining = response.headers?.get("x-ratelimit-remaining");
  const retryAfter = response.headers?.get("retry-after");
  if (response.status !== 429 && remaining !== "0" && retryAfter == null) return null;
  const reset = Number(response.headers?.get("x-ratelimit-reset"));
  const retrySeconds = retryAfter == null ? NaN : Number(retryAfter);
  const retryDate = retryAfter == null ? NaN : Date.parse(retryAfter);
  const candidates = [
    Number.isFinite(reset) && reset > 0 ? reset * 1000 : NaN,
    Number.isFinite(retrySeconds) && retrySeconds >= 0 ? now + retrySeconds * 1000 : retryDate,
  ].filter((value) => Number.isFinite(value) && value > now && value <= 8.64e15);
  return candidates.length === 0 ? now + 60_000 : Math.max(...candidates);
};

interface ApiAsset {
  readonly name?: unknown;
  readonly size?: unknown;
  readonly browser_download_url?: unknown;
}
interface ApiRelease {
  readonly id?: unknown;
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly body?: unknown;
  readonly created_at?: unknown;
  readonly published_at?: unknown;
  readonly assets?: unknown;
}

async function getText(
  fetcher: FetchLike,
  url: string,
  limit: number,
  headers?: Record<string, string>,
  now: () => number = Date.now,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      ...(headers === undefined ? {} : { headers }),
    });
    if (!response.ok) {
      const retryAt = rateLimitRetryAt(response, now());
      if (retryAt !== null) throw new ForkFeedRateLimitError(retryAt);
      throw new ForkFeedError(`GitHub returned ${response.status} for ${new URL(url).pathname}.`);
    }
    const text = await response.text();
    if (text.length > limit) throw new ForkFeedError("A release document exceeded its size limit.");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Lists releases and decodes each fork-release.json with the exact contract schema. An undecodable manifest is recorded, never skipped silently. */
export async function listForkReleases(
  fetcher: FetchLike,
  options: { readonly perPage?: number; readonly now?: () => number } = {},
): Promise<ReadonlyArray<ForkReleaseRecord>> {
  const listing: unknown = JSON.parse(
    await getText(
      fetcher,
      `${FORK_RELEASES_API}?per_page=${options.perPage ?? 30}`,
      MAX_LISTING_BYTES,
      { accept: "application/vnd.github+json" },
      options.now,
    ),
  );
  if (!Array.isArray(listing))
    throw new ForkFeedError("GitHub returned an unexpected release listing.");
  const records: ForkReleaseRecord[] = [];
  for (const entry of listing as ReadonlyArray<ApiRelease>) {
    if (
      typeof entry.id !== "number" ||
      typeof entry.tag_name !== "string" ||
      !Array.isArray(entry.assets)
    )
      continue;
    const assets = (entry.assets as ReadonlyArray<ApiAsset>).filter(
      (asset): asset is { name: string; size: number; browser_download_url?: unknown } =>
        typeof asset.name === "string" && typeof asset.size === "number",
    );
    const manifestAsset = (entry.assets as ReadonlyArray<ApiAsset>).find(
      (asset) => asset.name === FORK_MANIFEST_ASSET,
    );
    let manifest: ForkReleaseManifest | null = null;
    let manifestError: string | undefined;
    if (manifestAsset !== undefined) {
      const url = manifestAsset.browser_download_url;
      if (typeof url !== "string" || !isForkReleaseUrl(url))
        manifestError = "The manifest is not served from the fork release origin.";
      else {
        try {
          manifest = decodeManifest(
            JSON.parse(await getText(fetcher, url, MAX_MANIFEST_BYTES, undefined, options.now)),
          );
        } catch (cause) {
          if (cause instanceof ForkFeedRateLimitError) throw cause;
          manifestError = cause instanceof Error ? cause.message : "Unreadable manifest.";
        }
      }
    }
    records.push({
      id: entry.id,
      tagName: entry.tag_name,
      draft: entry.draft === true,
      body: typeof entry.body === "string" ? entry.body : "",
      createdAt: typeof entry.created_at === "string" ? entry.created_at : "",
      publishedAt: typeof entry.published_at === "string" ? entry.published_at : null,
      assets: assets.map((asset) => ({ name: asset.name, size: asset.size })),
      manifest,
      ...(manifestError === undefined ? {} : { manifestError }),
    });
  }
  return records;
}

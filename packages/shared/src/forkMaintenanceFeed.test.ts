// @effect-diagnostics globalDate:off — deterministic GitHub header fixtures use exact epoch timestamps.
import { describe, expect, it } from "@effect/vitest";
import { ForkFeedError, ForkFeedRateLimitError, listForkReleases } from "./forkMaintenanceFeed.ts";

const limitedFeed = (status: number, headers: Record<string, string>) =>
  listForkReleases(
    async () => ({
      ok: false,
      status,
      headers: { get: (name) => headers[name] ?? null },
      text: async () => "",
    }),
    { now: () => 1_000_000 },
  );

describe("GitHub release feed cooldown", () => {
  it.each([
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1600" }, 1_600_000],
    [429, { "retry-after": "120" }, 1_120_000],
    [403, { "retry-after": new Date(1_300_000).toUTCString() }, 1_300_000],
    [
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1600", "retry-after": "120" },
      1_600_000,
    ],
    [429, { "retry-after": "invalid", "x-ratelimit-reset": "invalid" }, 1_060_000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "999" }, 1_060_000],
  ] as const)(
    "reports the explicit retry boundary for HTTP %s (%j)",
    async (status, headers, retryAt) => {
      const failure = await limitedFeed(status, headers).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ForkFeedRateLimitError);
      expect(failure).toMatchObject({ retryAt });
      expect(String(failure)).toContain(new Date(retryAt).toISOString());
    },
  );

  it("keeps an ordinary forbidden response distinct from rate limiting", async () => {
    const failure = await limitedFeed(403, { "x-ratelimit-remaining": "10" }).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ForkFeedError);
    expect(failure).not.toBeInstanceOf(ForkFeedRateLimitError);
    expect(String(failure)).toContain("GitHub returned 403");
  });

  it("stops manifest discovery immediately when GitHub supplies a cooldown", async () => {
    let reads = 0;
    const failure = await listForkReleases(
      async () => {
        reads += 1;
        return reads === 1
          ? {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify([
                  {
                    id: 1,
                    tag_name: "fork-v1.0.1",
                    assets: [
                      {
                        name: "fork-release.json",
                        size: 1,
                        browser_download_url:
                          "https://github.com/unn-corp/t3code/releases/download/fork-v1.0.1/fork-release.json",
                      },
                    ],
                  },
                  { id: 2, tag_name: "fork-v1.0.2", assets: [] },
                ]),
            }
          : {
              ok: false,
              status: 429,
              headers: { get: (name: string) => (name === "retry-after" ? "120" : null) },
              text: async () => "",
            };
      },
      { now: () => 1_000_000 },
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ForkFeedRateLimitError);
    expect(failure).toMatchObject({ retryAt: 1_120_000 });
    expect(reads).toBe(2);
  });
});

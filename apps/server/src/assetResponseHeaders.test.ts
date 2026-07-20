import { describe, expect, it } from "vite-plus/test";

import { buildAssetResponseHeaders } from "./assetResponseHeaders.ts";

describe("buildAssetResponseHeaders", () => {
  it("forces non-image assets to download without overriding the client filename", () => {
    expect(buildAssetResponseHeaders({ download: true })).toEqual({
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": "attachment",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("does not force image assets to download", () => {
    expect(buildAssetResponseHeaders({ download: false })).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });
});

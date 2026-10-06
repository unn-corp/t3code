import { assert, describe, it } from "@effect/vitest";
import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "./update-manifest.ts";

const feed = (blockMapSize: string) => `version: 1.0.1
files:
  - url: T3-Code.AppImage
    sha512: checksum
    size: 1000
    blockMapSize: ${blockMapSize}
releaseDate: '2026-10-06T07:23:00.000Z'
`;

describe("embedded update manifest metadata", () => {
  it("retains blockMapSize when parsing, merging and serializing an electron-builder feed", () => {
    const parsed = parseUpdateManifest(feed("200"), "nightly-linux.yml", "Linux");
    assert.equal(parsed.files[0]?.blockMapSize, 200);
    const merged = mergeUpdateManifests(parsed, parsed, "Linux");
    assert.deepStrictEqual(
      parseUpdateManifest(
        serializeUpdateManifest(merged, { platformLabel: "Linux" }),
        "roundtrip.yml",
        "Linux",
      ),
      parsed,
    );
    assert.throws(
      () =>
        mergeUpdateManifests(
          parsed,
          parseUpdateManifest(feed("201"), "other.yml", "Linux"),
          "Linux",
        ),
      /conflicting file entry/,
    );
  });

  it("rejects empty, oversized, unsafe, negative, fractional, and duplicate sizes", () => {
    for (const size of [
      "0",
      "996",
      "1001",
      "9007199254740993",
      "-1",
      "0.5",
      "200\n    blockMapSize: 201",
    ])
      assert.throws(() => parseUpdateManifest(feed(size), "invalid.yml", "Linux"));
    assert.throws(
      () =>
        parseUpdateManifest(
          feed("200").replace(
            "  - url: T3-Code.AppImage\n    sha512: checksum\n    size: 1000\n",
            "",
          ),
          "orphan.yml",
          "Linux",
        ),
      /unique file entry/,
    );
  });
});

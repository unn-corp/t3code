// @effect-diagnostics nodeBuiltinImport:off — fixtures model electron-builder's embedded trailer.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { verifyEmbeddedBlockMap } from "./embedded-blockmap.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
const fixture = (
  map: unknown = {
    version: "2",
    files: [{ name: "file", offset: 0, checksums: ["checksum"], sizes: [2048] }],
  },
  corrupt = false,
) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "embedded-blockmap-"));
  dirs.push(dir);
  const file = NodePath.join(dir, "fixture.AppImage");
  const compressed = corrupt
    ? Buffer.from("invalid deflate")
    : NodeZlib.deflateRawSync(JSON.stringify(map));
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(compressed.length);
  NodeFS.writeFileSync(file, Buffer.concat([Buffer.alloc(2048), compressed, tail]));
  return { file, size: compressed.length };
};

describe("embedded block map verification", () => {
  it("accepts a bounded block map and checks the actual trailer, not just the feed size", () => {
    const { file, size } = fixture();
    assert.doesNotThrow(() => verifyEmbeddedBlockMap(file, size));
    assert.throws(() => verifyEmbeddedBlockMap(file, size + 1), /trailer differs/);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER])
      assert.throws(() => verifyEmbeddedBlockMap(file, invalid));
  });

  it("refuses corrupt compression, unsupported structures, and blocks beyond the payload", () => {
    const compressed = fixture(undefined, true);
    assert.throws(() => verifyEmbeddedBlockMap(compressed.file, compressed.size));
    for (const map of [
      null,
      { version: "2", files: [] },
      { version: "3", files: [] },
      {
        version: "2",
        files: [{ name: "file", offset: 0, checksums: ["checksum"], sizes: [4096] }],
      },
      { version: "2", files: [{ name: "file", offset: 0, checksums: [], sizes: [2048] }] },
    ]) {
      const { file, size } = fixture(map);
      assert.throws(() => verifyEmbeddedBlockMap(file, size));
    }
  });
});

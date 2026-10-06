// @effect-diagnostics nodeBuiltinImport:off — validates the bytes produced by electron-builder.
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import * as Schema from "effect/Schema";

const decodeBlockMap = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal("2"),
    files: Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1)),
        offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        checksums: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
          Schema.isMinLength(1),
        ),
        sizes: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))).check(Schema.isMinLength(1)),
      }),
    ).check(Schema.isMinLength(1)),
  }),
);

/** AppImage block maps end in a big-endian size and raw-deflated JSON, as read by electron-updater. */
export function verifyEmbeddedBlockMap(file: string, declaredSize: number): void {
  const fd = NodeFS.openSync(file, "r");
  try {
    const bytes = NodeFS.fstatSync(fd).size;
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize <= 0 ||
      declaredSize > 16 << 20 ||
      declaredSize + 4 >= bytes
    )
      throw new Error("Embedded block map size is outside the payload.");
    const trailer = Buffer.alloc(4);
    if (
      NodeFS.readSync(fd, trailer, 0, 4, bytes - 4) !== 4 ||
      trailer.readUInt32BE() !== declaredSize
    )
      throw new Error("Embedded block map trailer differs from the feed's blockMapSize.");
    const data = Buffer.alloc(declaredSize);
    if (NodeFS.readSync(fd, data, 0, declaredSize, bytes - 4 - declaredSize) !== declaredSize)
      throw new Error("Embedded block map is truncated.");
    const map = decodeBlockMap(
      JSON.parse(NodeZlib.inflateRawSync(data, { maxOutputLength: 16 << 20 }).toString("utf8")),
    );
    for (const entry of map.files) {
      if (entry.checksums.length !== entry.sizes.length)
        throw new Error("Embedded block map has an invalid file entry.");
      const end = entry.offset + entry.sizes.reduce((sum, size) => sum + size, 0);
      if (!Number.isSafeInteger(end) || end > bytes - declaredSize - 4)
        throw new Error("Embedded block map describes blocks outside the payload.");
    }
  } finally {
    NodeFS.closeSync(fd);
  }
}

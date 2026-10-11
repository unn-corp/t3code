// @effect-diagnostics nodeBuiltinImport:off — icon digests give desktop caches immutable file names.
import * as NodeCrypto from "node:crypto";

/** A different logo must have a different path, so desktop shells cannot reuse stale pixels. */
export function desktopLauncherIconName(desktopEntryName: string, bytes: Uint8Array): string {
  return `${desktopEntryName}-${NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.png`;
}

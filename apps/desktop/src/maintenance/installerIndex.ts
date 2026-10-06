// @effect-diagnostics nodeBuiltinImport:off — a tiny file beside the artifact cache.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ensurePrivateDirectory } from "./privateDirectory.ts";

/**
 * A build's identity digest is its installer's digest when an update installed it, but a derived value when a person
 * installed it by hand. This maps the second kind to the verified installer cached for it, so reversing an update finds
 * the right payload in either case.
 */
export async function readInstallerIndex(file: string): Promise<Readonly<Record<string, string>>> {
  try {
    const parsed = JSON.parse(await NodeFSP.readFile(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export async function recordInstaller(
  file: string,
  identitySha256: string,
  installerSha256: string,
): Promise<void> {
  const current = await readInstallerIndex(file);
  if (current[identitySha256] === installerSha256) return;
  await ensurePrivateDirectory(NodePath.dirname(file));
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...current, [identitySha256]: installerSha256 }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
}

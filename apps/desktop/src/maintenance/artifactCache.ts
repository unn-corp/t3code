// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off — downloads stream to disk and are hashed on the way.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import { forkAssetUrl } from "@t3tools/shared/forkMaintenance";
import { ensurePrivateDirectory } from "./privateDirectory.ts";
import * as Schema from "effect/Schema";

/**
 * Verified installer payloads, kept outside the application directory an installer replaces. A payload is
 * addressed by its digest, so a rebuilt release of the same version is a different directory and an
 * unverified byte is never reachable. The newest verified builds are retained so a failed or unwanted
 * update can be reversed; pruning is by count and by what a transaction still references, never by free space.
 */
export const RETAINED_PRIOR_BUILDS = 2;

const Record = Schema.Struct({
  version: Schema.String,
  name: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
  verifiedAt: Schema.Number,
});
export type CachedArtifact = typeof Record.Type & { readonly path: string };
const decodeRecord = Schema.decodeUnknownSync(Record);

export type DownloadFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }>;

const SHA256 = /^[a-f0-9]{64}$/;
const isCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const directoryFor = (root: string, sha256: string) => {
  if (!SHA256.test(sha256)) throw new Error("Invalid artifact digest.");
  return NodePath.join(root, sha256);
};

/** The cached payload for a digest, re-hashed byte for byte. Null when absent or altered: a changed file is no payload. */
export async function readVerifiedArtifact(
  root: string,
  sha256: string,
): Promise<CachedArtifact | null> {
  // A digest this cache could never have written (a derived identity, an empty string) is simply absent.
  if (!SHA256.test(sha256)) return null;
  const directory = directoryFor(root, sha256);
  try {
    const record = decodeRecord(
      JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "artifact.json"), "utf8")),
    );
    if (record.sha256 !== sha256) return null;
    const file = NodePath.join(directory, record.name);
    const stat = await NodeFSP.stat(file);
    if (stat.size !== record.bytes) return null;
    const hash = NodeCrypto.createHash("sha256");
    for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === sha256 ? { ...record, path: file } : null;
  } catch (cause) {
    if (isCode(cause, "ENOENT")) return null;
    return null;
  }
}

/**
 * Downloads one release asset from the fork's own release origin, hashing while writing, and publishes it
 * only after size and digest match the manifest. A digest detects corruption and mismatched assets; the
 * origin itself is the trust boundary. Idempotent: an already verified payload is reused.
 */
export async function stageVerifiedArtifact(input: {
  readonly root: string;
  readonly tagName: string;
  readonly version: string;
  readonly asset: { readonly name: string; readonly sha256: string; readonly bytes: number };
  readonly fetch: DownloadFetch;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}): Promise<CachedArtifact> {
  const existing = await readVerifiedArtifact(input.root, input.asset.sha256);
  if (existing !== null) return existing;
  // forkAssetUrl refuses any asset name or tag that is not a fork release.
  const url = forkAssetUrl(input.tagName, input.asset.name);
  await ensurePrivateDirectory(input.root);
  const final = directoryFor(input.root, input.asset.sha256);
  const staging = NodePath.join(input.root, `.staging-${NodeCrypto.randomUUID().slice(0, 8)}`);
  await ensurePrivateDirectory(staging);
  try {
    const controller = new AbortController();
    input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const response = await input.fetch(url, { signal: controller.signal });
    if (!response.ok || response.body === null || response.body === undefined)
      throw new Error(`The release origin returned ${response.status} for ${input.asset.name}.`);
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    const file = NodePath.join(staging, input.asset.name);
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(
        response.body as Parameters<typeof NodeStream.Readable.fromWeb>[0],
      ),
      new NodeStream.Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          bytes += chunk.length;
          // Stop at the manifest's size: an origin cannot make the cache grow without bound.
          if (bytes > input.asset.bytes)
            return callback(new Error(`${input.asset.name} is larger than the release records.`));
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      NodeFS.createWriteStream(file, { flags: "wx", mode: 0o600 }),
    );
    if (bytes !== input.asset.bytes)
      throw new Error(`${input.asset.name} is smaller than the release records.`);
    if (hash.digest("hex") !== input.asset.sha256)
      throw new Error(`${input.asset.name} does not match the digest recorded in the release.`);
    const record = {
      version: input.version,
      name: input.asset.name,
      sha256: input.asset.sha256,
      bytes,
      verifiedAt: input.now(),
    };
    await NodeFSP.writeFile(NodePath.join(staging, "artifact.json"), JSON.stringify(record), {
      mode: 0o600,
    });
    await NodeFSP.rm(final, { recursive: true, force: true });
    await NodeFSP.rename(staging, final);
    return { ...record, path: NodePath.join(final, input.asset.name) };
  } catch (cause) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    throw cause;
  }
}

/**
 * Keeps every protected digest (the staged target, the installed build, anything a transaction references)
 * plus the newest `RETAINED_PRIOR_BUILDS` others. Space pressure never reaches here: a payload needed to reverse
 * an update is not disposable, so a device that cannot hold them blocks the update instead.
 */
export async function pruneArtifacts(
  root: string,
  protect: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> {
  let entries: string[];
  try {
    entries = await NodeFSP.readdir(root);
  } catch (cause) {
    if (isCode(cause, "ENOENT")) return [];
    throw cause;
  }
  const dated: Array<{ readonly sha256: string; readonly verifiedAt: number }> = [];
  for (const name of entries) {
    if (!SHA256.test(name)) continue;
    try {
      dated.push({
        sha256: name,
        verifiedAt: decodeRecord(
          JSON.parse(await NodeFSP.readFile(NodePath.join(root, name, "artifact.json"), "utf8")),
        ).verifiedAt,
      });
    } catch {
      // An unreadable directory is not a verified payload and is not counted; it is removed below only if unprotected.
      if (!protect.has(name))
        await NodeFSP.rm(NodePath.join(root, name), { recursive: true, force: true });
    }
  }
  const keep = new Set([
    ...protect,
    ...dated
      .filter((entry) => !protect.has(entry.sha256))
      .toSorted((a, b) => b.verifiedAt - a.verifiedAt)
      .slice(0, RETAINED_PRIOR_BUILDS)
      .map((entry) => entry.sha256),
  ]);
  const removed: string[] = [];
  for (const entry of dated) {
    if (keep.has(entry.sha256)) continue;
    await NodeFSP.rm(NodePath.join(root, entry.sha256), { recursive: true, force: true });
    removed.push(entry.sha256);
  }
  return removed;
}

/** Bytes the cache would add for a payload not yet present, so capacity can be checked before downloading. */
export const artifactBytesNeeded = async (
  root: string,
  asset: { readonly sha256: string; readonly bytes: number },
) => ((await readVerifiedArtifact(root, asset.sha256)) === null ? asset.bytes : 0);

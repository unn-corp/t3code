// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  pruneArtifacts,
  readVerifiedArtifact,
  stageVerifiedArtifact,
  type DownloadFetch,
} from "./artifactCache.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
const sha = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const root = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-artifacts-"));
  directories.push(directory);
  return NodePath.join(directory, "artifacts");
};
const serving =
  (bytes: Uint8Array | null): DownloadFetch =>
  async () =>
    bytes === null
      ? { ok: false, status: 404, body: null }
      : { ok: true, status: 200, body: new Response(new Uint8Array(bytes)).body };
const stage = (
  target: string,
  name: string,
  bytes: Buffer,
  served: Uint8Array | null = bytes,
  clock = 1,
) =>
  stageVerifiedArtifact({
    root: target,
    tagName: "fork-v1.2.3",
    version: "1.2.3",
    asset: { name, sha256: sha(bytes), bytes: bytes.length },
    fetch: serving(served),
    now: () => clock,
  });

describe("stageVerifiedArtifact", () => {
  it("publishes a payload only after its size and digest match the release", async () => {
    const target = await root();
    const bytes = Buffer.from("installer bytes");
    const staged = await stage(target, "T3-Code-1.2.3.AppImage", bytes);
    expect(await NodeFSP.readFile(staged.path)).toEqual(bytes);
    expect((await readVerifiedArtifact(target, sha(bytes)))?.name).toBe("T3-Code-1.2.3.AppImage");
    // oxlint-disable-next-line t3code/no-global-process-runtime -- These tests assert POSIX file modes, which Windows does not report.
    if (process.platform !== "win32")
      expect((await NodeFSP.stat(staged.path)).mode & 0o777).toBe(0o600);
  });

  it("refuses a body with the wrong digest and leaves nothing behind", async () => {
    const target = await root();
    await expect(
      stage(
        target,
        "T3-Code-1.2.3.AppImage",
        Buffer.from("installer bytes"),
        Buffer.from("installer bytez"),
      ),
    ).rejects.toThrow(/digest/);
    expect(await NodeFSP.readdir(target)).toEqual([]);
  });

  it("refuses a body larger or smaller than the release records", async () => {
    const target = await root();
    const bytes = Buffer.from("installer bytes");
    await expect(
      stage(target, "a.AppImage", bytes, Buffer.concat([bytes, Buffer.from("more")])),
    ).rejects.toThrow(/larger/);
    await expect(stage(target, "a.AppImage", bytes, bytes.subarray(0, 4))).rejects.toThrow(
      /smaller/,
    );
    expect(await NodeFSP.readdir(target)).toEqual([]);
  });

  it("refuses anything that is not a fork release asset name", async () => {
    const target = await root();
    await expect(
      stageVerifiedArtifact({
        root: target,
        tagName: "v1.2.3",
        version: "1.2.3",
        asset: { name: "a.AppImage", sha256: sha("x"), bytes: 1 },
        fetch: serving(Buffer.from("x")),
        now: () => 1,
      }),
    ).rejects.toThrow(/Unsupported release asset/);
    await expect(
      stageVerifiedArtifact({
        root: target,
        tagName: "fork-v1.2.3",
        version: "1.2.3",
        asset: { name: "../escape", sha256: sha("x"), bytes: 1 },
        fetch: serving(Buffer.from("x")),
        now: () => 1,
      }),
    ).rejects.toThrow(/Unsupported release asset/);
  });

  it("treats a payload altered after caching as absent", async () => {
    const target = await root();
    const bytes = Buffer.from("installer bytes");
    const staged = await stage(target, "a.AppImage", bytes);
    await NodeFSP.chmod(staged.path, 0o600);
    await NodeFSP.writeFile(staged.path, "installer bytez");
    expect(await readVerifiedArtifact(target, sha(bytes))).toBeNull();
  });

  it("does not download again what is already verified", async () => {
    const target = await root();
    const bytes = Buffer.from("installer bytes");
    await stage(target, "a.AppImage", bytes);
    // A second call that would fail if it fetched.
    const again = await stage(target, "a.AppImage", bytes, null);
    expect(again.sha256).toBe(sha(bytes));
  });
});

describe("pruneArtifacts", () => {
  it("keeps what a transaction needs plus the two newest others, and nothing is pruned for space", async () => {
    const target = await root();
    const digests: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const bytes = Buffer.from(`build ${index}`);
      await stage(target, `b${index}.AppImage`, bytes, bytes, 100 + index);
      digests.push(sha(bytes));
    }
    const removed = await pruneArtifacts(target, new Set([digests[0]!]));
    // 0 is protected (the installed build); 4 and 3 are the two newest others.
    expect(new Set(removed)).toEqual(new Set([digests[1]!, digests[2]!]));
    expect(await readVerifiedArtifact(target, digests[0]!)).not.toBeNull();
    expect(await readVerifiedArtifact(target, digests[4]!)).not.toBeNull();
    expect(await readVerifiedArtifact(target, digests[1]!)).toBeNull();
  });

  it("is a no-op for a cache that does not exist yet", async () => {
    expect(await pruneArtifacts(await root(), new Set())).toEqual([]);
  });
});

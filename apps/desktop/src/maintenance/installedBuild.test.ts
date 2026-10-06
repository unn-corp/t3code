// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readRecordedBuild, resolveCurrentBuild, writeRecordedBuild } from "./installedBuild.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
const commit = "a".repeat(40);

describe("resolveCurrentBuild", () => {
  it("derives a stable identity for a build that no transaction ever recorded", () => {
    const first = resolveCurrentBuild({ version: "1.0.0", commit, recorded: null });
    expect(resolveCurrentBuild({ version: "1.0.0", commit, recorded: null })).toEqual(first);
    expect(first.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      resolveCurrentBuild({ version: "1.0.1", commit, recorded: null }).artifactSha256,
    ).not.toBe(first.artifactSha256);
  });

  it("trusts a recorded digest only for the version it was recorded for", () => {
    const recorded = {
      version: "1.1.0",
      commit,
      artifactSha256: "b".repeat(64),
      installationSequence: 3,
    };
    expect(resolveCurrentBuild({ version: "1.1.0", commit, recorded })).toMatchObject({
      artifactSha256: "b".repeat(64),
      installationSequence: 3,
    });
    // A person reinstalled another version by hand: the record is stale.
    expect(resolveCurrentBuild({ version: "1.0.0", commit, recorded }).artifactSha256).not.toBe(
      "b".repeat(64),
    );
  });
});

describe("recorded build file", () => {
  it("round trips, and an unreadable file reads as absent rather than guessing", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-installed-"));
    directories.push(directory);
    const file = NodePath.join(directory, "maintenance", "installed-build.json");
    const build = {
      version: "1.1.0",
      commit,
      artifactSha256: "b".repeat(64),
      installationSequence: 1,
    };
    await writeRecordedBuild(file, build);
    expect(await readRecordedBuild(file)).toEqual(build);
    await NodeFSP.writeFile(file, "{not json");
    expect(await readRecordedBuild(file)).toBeNull();
  });
});

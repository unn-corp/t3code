// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ensurePrivateDirectory } from "./privateDirectory.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const scratch = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-private-directory-"));
  roots.push(root);
  return root;
};

describe("ensurePrivateDirectory", () => {
  it("takes a directory that already exists, readable by others, back to owner-only on POSIX", async () => {
    const directory = NodePath.join(await scratch(), "maintenance");
    await NodeFSP.mkdir(directory, { mode: 0o755 });
    await NodeFSP.chmod(directory, 0o755);
    const restricted: string[] = [];
    await ensurePrivateDirectory(directory, {
      platform: "linux",
      restrictWindows: async (target) => void restricted.push(target),
    });
    expect((await NodeFSP.stat(directory)).mode & 0o777).toBe(0o700);
    expect(restricted).toEqual([]);
  });

  it("restricts the directory with an explicit ACL on Windows, where a mode says nothing", async () => {
    const directory = NodePath.join(await scratch(), "handoff");
    const restricted: string[] = [];
    await ensurePrivateDirectory(directory, {
      platform: "win32",
      restrictWindows: async (target) => void restricted.push(target),
    });
    expect(restricted).toEqual([directory]);
  });

  it("fails closed when Windows cannot restrict the directory, naming the directory", async () => {
    const directory = NodePath.join(await scratch(), "handoff");
    await expect(
      ensurePrivateDirectory(directory, {
        platform: "win32",
        restrictWindows: async () => {
          throw new Error("icacls.exe exited with code 5");
        },
      }),
    ).rejects.toThrow(`${directory} could not be made private to this user: icacls.exe exited`);
  });
});

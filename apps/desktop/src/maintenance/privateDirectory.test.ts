// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

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
  it("takes an existing directory back to owner-only access on the host OS", async () => {
    const directory = NodePath.join(await scratch(), "maintenance");
    await NodeFSP.mkdir(directory, { mode: 0o755 });
    await NodeFSP.chmod(directory, 0o755);
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Assert real filesystem protection on each host.
    const windows = process.platform === "win32";
    if (windows) {
      const grant = NodeChildProcess.spawnSync("icacls.exe", [
        directory,
        "/grant",
        "*S-1-1-0:(OI)(CI)R",
      ]);
      expect(grant.status).toBe(0);
    }
    await ensurePrivateDirectory(directory);
    if (windows) {
      const probe = NodeChildProcess.spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$acl = Get-Acl -LiteralPath $env:T3_TEST_PRIVATE_PATH; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if (!$acl.AreAccessRulesProtected -or @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid }).Count -ne 0) { exit 3 }",
        ],
        { env: { ...process.env, T3_TEST_PRIVATE_PATH: directory } },
      );
      expect(probe.status).toBe(0);
    } else expect((await NodeFSP.stat(directory)).mode & 0o777).toBe(0o700);
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

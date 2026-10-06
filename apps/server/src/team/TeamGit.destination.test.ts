import { expect, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off - exercise the native checkout filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { installCheckout, normalizeCheckoutDestination, validateDestination } from "./TeamGit.ts";

it("installs a checkout selected with a trailing directory separator", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "team-destination-"));
  try {
    const destination = normalizeCheckoutDestination(`${root}/project/`);
    await NodeFSP.mkdir(destination);
    const staging = NodePath.join(root, "staging");
    await NodeFSP.mkdir(staging);
    await NodeFSP.writeFile(NodePath.join(staging, "README.md"), "Shared project");
    await installCheckout(staging, destination, await validateDestination(destination));
    expect(await NodeFSP.readFile(NodePath.join(destination, "README.md"), "utf8")).toBe("Shared project");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.each(["", "relative/", "/tmp/../project/", "/tmp/./project/"])(
  "still rejects unsafe or ambiguous destination %s after normalization",
  async (destination) => {
    await expect(validateDestination(normalizeCheckoutDestination(destination))).rejects.toMatchObject({
      reason: "destination",
    });
  },
);

it.each(["relative/project", "/tmp/project/", "/tmp/../project"])(
  "explains why the checkout path %s was rejected",
  async (destination) => {
    await expect(validateDestination(destination)).rejects.toMatchObject({
      reason: "destination",
      message:
        "Choose a local project folder using Browse, or enter a full absolute path without a trailing slash, '.' or '..' segments.",
    });
  },
);

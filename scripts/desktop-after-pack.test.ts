// @effect-diagnostics nodeBuiltinImport:off - This fixture verifies the filesystem repair boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert } from "@effect/vitest";
import { afterEach, describe, it } from "vite-plus/test";

import {
  repairUnpackedEffectModules,
  REQUIRED_UNPACKED_EFFECT_MODULES,
} from "./desktop-after-pack.ts";

const temporaryDirectories: string[] = [];

async function writePackage(
  nodeModulesDir: string,
  packageName: string,
  marker: string,
): Promise<string> {
  const packageDir = NodePath.join(nodeModulesDir, ...packageName.split("/"));
  await NodeFSP.mkdir(packageDir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(packageDir, "package.json"),
    `${JSON.stringify({ name: packageName, main: "index.js" })}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(packageDir, "index.js"), `export default ${marker};\n`);
  return packageDir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop afterPack", () => {
  it("restores the Effect runtime closure when electron-builder omits unpacked payloads", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-after-pack-"));
    temporaryDirectories.push(root);
    const stageAppDir = NodePath.join(root, "stage");
    const appOutDir = NodePath.join(root, "win-unpacked");
    const stageNodeModules = NodePath.join(stageAppDir, "node_modules");

    await NodeFSP.mkdir(stageAppDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(stageAppDir, "package.json"), '{"name":"t3code"}\n');
    await writePackage(stageNodeModules, "effect", '"effect"');
    const platformNodeDir = await writePackage(
      stageNodeModules,
      "@effect/platform-node",
      '"platform-node"',
    );
    const platformNodeModules = NodePath.join(platformNodeDir, "node_modules");
    await writePackage(platformNodeModules, "@effect/platform-node-shared", '"shared"');
    await writePackage(platformNodeModules, "mime", '"mime"');
    await writePackage(platformNodeModules, "undici", '"undici"');

    const staleEffectDir = NodePath.join(
      appOutDir,
      "resources/app.asar.unpacked/node_modules/effect",
    );
    await NodeFSP.mkdir(staleEffectDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(staleEffectDir, "stale.js"), "stale\n");

    await repairUnpackedEffectModules({ stageAppDir, appOutDir });

    const expectedMarkers: Record<(typeof REQUIRED_UNPACKED_EFFECT_MODULES)[number], string> = {
      effect: "effect",
      "@effect/platform-node": "platform-node",
      "@effect/platform-node-shared": "shared",
      mime: "mime",
      undici: "undici",
    };
    for (const packageName of REQUIRED_UNPACKED_EFFECT_MODULES) {
      const packageDir = NodePath.join(
        appOutDir,
        "resources/app.asar.unpacked/node_modules",
        ...packageName.split("/"),
      );
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(packageDir, "package.json"), "utf8"),
      ) as { readonly name: string };
      assert.equal(manifest.name, packageName);
      assert.equal(
        await NodeFSP.readFile(NodePath.join(packageDir, "index.js"), "utf8"),
        `export default "${expectedMarkers[packageName]}";\n`,
      );
    }
    await NodeFSP.access(NodePath.join(staleEffectDir, "stale.js")).then(
      () => assert.fail("The stale unpacked payload should have been replaced."),
      (error: NodeJS.ErrnoException) => assert.equal(error.code, "ENOENT"),
    );
  });
});

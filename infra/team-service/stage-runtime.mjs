import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { selectCliRuntimeExternalDependencies } from "../../scripts/lib/cli-external-packages.ts";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const output = NodePath.resolve(process.argv[2] ?? "/opt/t3-stage");
const serverManifestPath = NodePath.join(root, "apps/server/package.json");
const serverManifest = JSON.parse(NodeFS.readFileSync(serverManifestPath, "utf8"));
const staged = new Map();

// Never fall back to installing newer versions here: copy the exact package
// closure installed from the repository lockfile, including native binaries.
function stagePackage(name, parentManifestPath, optional = false) {
  const require = NodeModule.createRequire(parentManifestPath);
  const candidate = require.resolve
    .paths(name)
    ?.find((directory) => NodeFS.existsSync(NodePath.join(directory, name, "package.json")));
  if (!candidate) {
    if (optional) return;
    throw new Error(`Missing runtime dependency: ${name}`);
  }
  const source = NodeFS.realpathSync(NodePath.join(candidate, name));
  const existing = staged.get(name);
  if (existing) {
    if (existing !== source) throw new Error(`Conflicting runtime versions: ${name}`);
    return;
  }
  staged.set(name, source);
  const manifestPath = NodePath.join(source, "package.json");
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  const destination = NodePath.join(output, "node_modules", name);
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  NodeFS.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) =>
      file === source ||
      !NodePath.relative(source, file).split(NodePath.sep).includes("node_modules"),
  });
  const optionalDependencies = manifest.optionalDependencies ?? {};
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    stagePackage(dependency, manifestPath, Object.hasOwn(optionalDependencies, dependency));
  }
  for (const dependency of Object.keys(optionalDependencies)) {
    stagePackage(dependency, manifestPath, true);
  }
}

NodeFS.mkdirSync(output);
NodeFS.cpSync(NodePath.join(root, "apps/server/dist"), NodePath.join(output, "dist"), {
  recursive: true,
});
for (const file of ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md"]) {
  NodeFS.copyFileSync(NodePath.join(root, file), NodePath.join(output, file));
}
NodeFS.writeFileSync(
  NodePath.join(output, "package.json"),
  `${JSON.stringify({ name: "t3-team-service", private: true, type: "module", version: serverManifest.version })}\n`,
);
for (const name of Object.keys(selectCliRuntimeExternalDependencies(serverManifest.dependencies))) {
  stagePackage(name, serverManifestPath);
}
console.log(`Staged ${staged.size} locked runtime packages.`);

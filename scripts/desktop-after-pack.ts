// @effect-diagnostics nodeBuiltinImport:off - electron-builder hooks run outside an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const REQUIRED_UNPACKED_EFFECT_MODULES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "mime",
  "undici",
] as const;

interface DesktopAfterPackContext {
  readonly appOutDir: string;
}

async function findPackageRoot(resolvedEntry: string, packageName: string): Promise<string> {
  let current = NodePath.dirname(resolvedEntry);
  const root = NodePath.parse(current).root;

  while (current !== root) {
    try {
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(current, "package.json"), "utf8"),
      ) as { readonly name?: unknown };
      if (manifest.name === packageName) {
        return current;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    current = NodePath.dirname(current);
  }

  throw new Error(`Could not locate the package root for ${packageName} from ${resolvedEntry}.`);
}

async function resolvePackageRoot(
  resolver: ReturnType<typeof NodeModule.createRequire>,
  packageName: string,
): Promise<string> {
  return findPackageRoot(resolver.resolve(packageName), packageName);
}

export async function repairUnpackedEffectModules(input: {
  readonly stageAppDir: string;
  readonly appOutDir: string;
}): Promise<void> {
  const stageResolver = NodeModule.createRequire(NodePath.join(input.stageAppDir, "package.json"));
  const platformNodeRoot = await resolvePackageRoot(stageResolver, "@effect/platform-node");
  const platformNodeResolver = NodeModule.createRequire(
    NodePath.join(platformNodeRoot, "package.json"),
  );
  const unpackedNodeModules = NodePath.join(
    input.appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
  );

  for (const packageName of REQUIRED_UNPACKED_EFFECT_MODULES) {
    const resolver =
      packageName === "effect" || packageName === "@effect/platform-node"
        ? stageResolver
        : platformNodeResolver;
    const source = await resolvePackageRoot(resolver, packageName);
    const destination = NodePath.join(unpackedNodeModules, ...packageName.split("/"));

    // electron-builder can mark a module as unpacked in the ASAR header but omit
    // some or all of its payload on Windows. Replace this small runtime closure
    // from the staged pnpm install after ASAR creation and before signing/NSIS.
    await NodeFSP.rm(destination, { recursive: true, force: true });
    await NodeFSP.cp(source, destination, {
      recursive: true,
      dereference: true,
      force: true,
      preserveTimestamps: true,
    });

    const copiedManifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(destination, "package.json"), "utf8"),
    ) as { readonly name?: unknown };
    if (copiedManifest.name !== packageName) {
      throw new Error(`Packaged runtime module verification failed for ${packageName}.`);
    }
  }
}

export async function afterPack(context: DesktopAfterPackContext): Promise<void> {
  const stageAppDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  await repairUnpackedEffectModules({ stageAppDir, appOutDir: context.appOutDir });
}

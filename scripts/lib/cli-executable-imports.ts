// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import ts from "typescript-legacy";

/**
 * Scan an emitted bundle chunk for ESM imports of packages that are not Node
 * built-ins.
 *
 * Inside a Node single-executable, `import` statements and `import()` can only
 * resolve built-in modules; any file-backed specifier throws at module
 * evaluation (static) or at first use (dynamic). External packages therefore
 * have to be reached through `createRequire`, which reads the real filesystem
 * in every runtime. The bundler cannot enforce this, so the check reads what it
 * produced.
 */
export function findEsmImportsOfExternalPackages(source: string): ReadonlyArray<string> {
  const specifiers = new Set<string>();
  const module = ts.createSourceFile(
    "bundle.mjs",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    const dynamic =
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const specifierNode =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : dynamic
          ? node.arguments[0]
          : undefined;
    if (specifierNode && ts.isStringLiteralLike(specifierNode)) {
      const specifier = specifierNode.text;
      // Multi-runtime SDKs can retain optional Bun imports. Bun built-ins are
      // not packages to stage beside the executable, and Effect's Bun server
      // modules are optional peers used only by the Bun branch of server.ts.
      // Static imports still fail here because Node would evaluate them
      // unconditionally.
      const optionalBunRuntimeImport =
        dynamic && (specifier.startsWith("bun:") || specifier.startsWith("@effect/platform-bun/"));
      const runtimeBuiltin = NodeModule.isBuiltin(specifier) || optionalBunRuntimeImport;
      if (!runtimeBuiltin && !specifier.startsWith("./") && !specifier.startsWith("../")) {
        specifiers.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return [...specifiers].sort();
}

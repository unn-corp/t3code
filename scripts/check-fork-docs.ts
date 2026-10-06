// @effect-diagnostics nodeBuiltinImport:off - a standalone CI checker reads files and parses shell examples.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const documents = [
  "AGENTS.md",
  "docs/operations/fork-maintenance.md",
  "docs/operations/fork-releases.md",
  "docs/operations/android-pwa.md",
  "docs/user/android-fork.md",
  "docs/user/updating.md",
  "docs/internals/server-updates.md",
];
function headingAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const withoutCode = text.replace(/```[\s\S]*?```/g, "");
  for (const match of withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const heading = match[1]!.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "");
    const base = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/ /g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\s[^>]*(?:id|name)=["']([^"']+)["']/g))
    anchors.add(match[1]!);
  return anchors;
}
export function checkForkDocs(repositoryRoot = root): string[] {
  const issues: string[] = [];
  for (const name of documents) {
    const path = NodePath.resolve(repositoryRoot, name);
    if (!NodeFS.existsSync(path)) {
      issues.push(`${name}: required fork guide is missing`);
      continue;
    }
    const text = NodeFS.readFileSync(path, "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1]!;
      if (/^(?:https?:|mailto:)/.test(target)) continue;
      const withoutAnchor = decodeURIComponent(target.split("#")[0]!);
      const destination = withoutAnchor
        ? NodePath.resolve(NodePath.dirname(path), withoutAnchor)
        : path;
      if (!NodeFS.existsSync(destination)) issues.push(`${name}: missing linked path ${target}`);
      else if (target.includes("#") && destination.endsWith(".md")) {
        const anchor = decodeURIComponent(target.slice(target.indexOf("#") + 1));
        if (anchor && !headingAnchors(NodeFS.readFileSync(destination, "utf8")).has(anchor))
          issues.push(`${name}: missing linked heading ${target}`);
      }
    }
    for (const match of text.matchAll(/`((?:apps|packages|scripts)\/[A-Za-z0-9_./-]+)`/g)) {
      const reference = match[1]!;
      if (!NodeFS.existsSync(NodePath.resolve(repositoryRoot, reference)))
        issues.push(`${name}: missing implementation path ${reference}`);
    }
    for (const match of text.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)) {
      const result = NodeChildProcess.spawnSync("bash", ["-n"], {
        input: match[1],
        encoding: "utf8",
      });
      if (result.status !== 0)
        issues.push(`${name}: invalid shell example: ${result.stderr.trim()}`);
      for (const command of match[1]!.matchAll(
        /(?:node|bun|vp exec node)\s+(scripts\/[A-Za-z0-9_./-]+)/g,
      )) {
        if (!NodeFS.existsSync(NodePath.resolve(repositoryRoot, command[1]!)))
          issues.push(`${name}: unsupported script example ${command[1]}`);
      }
    }
  }
  return issues;
}
if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const issues = checkForkDocs();
  if (issues.length) {
    process.stderr.write(issues.join("\n") + "\n");
    process.exitCode = 1;
  } else
    process.stdout.write(
      `Verified ${documents.length} fork guides: local links, implementation paths, and shell/script examples.\n`,
    );
}

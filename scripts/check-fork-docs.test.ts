// @effect-diagnostics nodeBuiltinImport:off - This script test validates Markdown against an isolated directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import { checkForkDocs } from "./check-fork-docs.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-doc-links-"));
  for (const file of [
    "AGENTS.md",
    "docs/operations/fork-maintenance.md",
    "docs/operations/fork-releases.md",
    "docs/operations/android-pwa.md",
    "docs/user/android-fork.md",
    "docs/user/updating.md",
    "docs/user/cloud-environments.md",
    "docs/user/providers-codex.md",
    "docs/internals/server-updates.md",
    "docs/internals/discord-bridge.md",
  ]) {
    const target = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, "# Guide\n");
  }
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

it("accepts formatted external API links and local angle-bracket paths with spaces", () => {
  NodeFS.writeFileSync(NodePath.join(root, "Local Guide.md"), "# Setup\n");
  NodeFS.writeFileSync(
    NodePath.join(root, "AGENTS.md"),
    "[Android](<https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionInfo#isActive()>)\n" +
      "[Setup](<Local Guide.md#setup>)\n",
  );
  expect(checkForkDocs(root)).toEqual([]);
});

it("still reports a missing local destination in angle brackets", () => {
  NodeFS.writeFileSync(NodePath.join(root, "AGENTS.md"), "[Setup](<Missing Guide.md>)\n");
  expect(checkForkDocs(root)).toEqual(["AGENTS.md: missing linked path Missing Guide.md"]);
});

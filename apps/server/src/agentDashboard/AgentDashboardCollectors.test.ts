// @effect-diagnostics nodeBuiltinImport:off - tests use local repository fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";

import { collectAgentDashboardData } from "./AgentDashboardCollectors.ts";

const initializeGitRepository = async (path: string): Promise<void> => {
  await NodeFSP.mkdir(path, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q", path]);
  await NodeFSP.writeFile(NodePath.join(path, "README.md"), "collector fixture\n");
  await NodeFSP.writeFile(NodePath.join(path, "package.json"), '{"name":"collector-fixture"}\n');
  await NodeFSP.writeFile(NodePath.join(path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  NodeChildProcess.execFileSync("git", ["-C", path, "add", "."]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.name=T3 Tests",
    "-c",
    "user.email=t3-tests@example.invalid",
    "commit",
    "-qm",
    "initial",
  ]);
};

const makeProject = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make("collector-project"),
  title: "Collector fixture",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

const collectSecurityFindings = async (source: string) => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-collector-"));
  const repositoryPath = NodePath.join(baseDir, "repository");

  try {
    await initializeGitRepository(repositoryPath);
    await NodeFSP.mkdir(NodePath.join(repositoryPath, "src"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(repositoryPath, "src", "config.ts"), source);

    const result = await collectAgentDashboardData({
      stateDir: NodePath.join(baseDir, "userdata"),
      projects: [makeProject(repositoryPath)],
      kind: "security",
      observedAt: "2026-08-10T00:00:00.000Z",
    });

    return result.findings;
  } finally {
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
};

describe("collectAgentDashboardData security checks", () => {
  it("does not report a Firebase web API key as a credential", async () => {
    const publicApiKey = ["AIza", "SyDUMMY_PUBLIC_FIREBASE_KEY"].join("");
    const findings = await collectSecurityFindings(
      [
        'import { initializeApp } from "firebase/app";',
        "",
        "const firebaseConfig = {",
        `  apiKey: "${publicApiKey}",`,
        '  authDomain: "example.firebaseapp.com",',
        '  projectId: "example",',
        '  appId: "1:1234567890:web:abcdef",',
        "};",
        "",
        "initializeApp(firebaseConfig);",
        "",
      ].join("\n"),
    );

    expect(findings).toEqual([]);
  });

  it("still reports an API-key-shaped value outside Firebase client config", async () => {
    const publicApiKey = ["AIza", "SyDUMMY_PUBLIC_FIREBASE_KEY"].join("");
    const findings = await collectSecurityFindings(
      ["export const config = {", "  apiKey", ': "', publicApiKey, '"', "};", ""].join("\n"),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "local-secret-scan",
      title: "Possible credential in repository content",
    });
  });

  it("does not suppress an unrelated key just because Firebase is mentioned", async () => {
    const publicApiKey = ["AIza", "SyDUMMY_PUBLIC_FIREBASE_KEY"].join("");
    const findings = await collectSecurityFindings(
      [
        "// firebaseConfig is documented in another module.",
        "export const config = {",
        "  apiKey",
        ': "',
        publicApiKey,
        '"',
        "};",
        "",
      ].join("\n"),
    );

    expect(findings).toHaveLength(1);
  });
});

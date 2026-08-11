// @effect-diagnostics nodeBuiltinImport:off - collectors intentionally run at the local filesystem boundary.
// @effect-diagnostics globalDate:off - collector output is persisted as ISO timestamps.
import * as NodeChildProcess from "node:child_process";
import type { Dirent } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { promisify } from "node:util";

import type { AgentDashboardCollectorKind, AgentDashboardCollectorState } from "@t3tools/contracts";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import {
  isStableRepositoryPath,
  type AgentDashboardCanonicalFindingInput,
} from "./AgentDashboardStore.ts";

const execFile = promisify(NodeChildProcess.execFile);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 1_000_000;
const SECRET_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,})/i;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".t3", ".next", "dist", "build"]);

export interface AgentDashboardCollectorInput {
  readonly stateDir: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly kind: AgentDashboardCollectorKind;
  readonly projectId?: ProjectId | null | undefined;
  readonly observedAt?: string | undefined;
}

export interface AgentDashboardCollectorResult {
  readonly findings: ReadonlyArray<AgentDashboardCanonicalFindingInput>;
  readonly states: ReadonlyArray<AgentDashboardCollectorState>;
}

const runGit = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const result = await execFile("git", [...args], {
    cwd,
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return String(result.stdout ?? "").trim();
};

const pathExists = async (path: string): Promise<boolean> =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

const projectMatches = (
  project: OrchestrationProjectShell,
  projectId: ProjectId | null | undefined,
) => projectId === null || projectId === undefined || String(project.id) === String(projectId);

const collectorState = (input: {
  readonly kind: AgentDashboardCollectorKind;
  readonly project: OrchestrationProjectShell | null;
  readonly status: AgentDashboardCollectorState["status"];
  readonly source: string;
  readonly message: string | null;
  readonly observedAt: string;
}): AgentDashboardCollectorState => ({
  id: `collector:${input.kind}:${input.project ? String(input.project.id) : "portfolio"}`,
  kind: input.kind,
  status: input.status,
  source: input.source,
  repository: input.project ? { projectId: input.project.id } : null,
  message: input.message,
  observedAt: input.observedAt,
});

const baseFinding = (input: {
  readonly kind: AgentDashboardCanonicalFindingInput["kind"];
  readonly project: OrchestrationProjectShell;
  readonly title: string;
  readonly summary: string;
  readonly severity: NonNullable<AgentDashboardCanonicalFindingInput["severity"]>;
  readonly confidence?: NonNullable<AgentDashboardCanonicalFindingInput["confidence"]>;
  readonly category: string;
  readonly evidence: ReadonlyArray<string>;
  readonly source: string;
  readonly observedAt: string;
}): AgentDashboardCanonicalFindingInput => ({
  kind: input.kind,
  title: input.title,
  summary: input.summary,
  severity: input.severity,
  confidence: input.confidence ?? "medium",
  category: input.category,
  evidence: input.evidence,
  repository: { projectId: String(input.project.id) },
  repositoryPath: input.project.workspaceRoot,
  source: input.source,
  sourceAt: input.observedAt,
  collectedAt: input.observedAt,
});

const walkFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const result: Array<string> = [];
  const visit = async (directory: string): Promise<void> => {
    if (result.length >= MAX_FILES) return;
    let entries: Array<Dirent>;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (result.length >= MAX_FILES || entry.name === ".env" || entry.name.startsWith(".env.")) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(NodePath.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const path = NodePath.join(directory, entry.name);
      try {
        const stat = await NodeFSP.stat(path);
        if (stat.size <= MAX_FILE_BYTES) result.push(path);
      } catch {
        // Files can disappear while a local checkout changes.
      }
    }
  };
  await visit(root);
  return result;
};

const collectEngineering = async (
  project: OrchestrationProjectShell,
  observedAt: string,
): Promise<{
  findings: Array<AgentDashboardCanonicalFindingInput>;
  state: AgentDashboardCollectorState;
}> => {
  try {
    const status = await runGit(project.workspaceRoot, ["status", "--porcelain=v1"]);
    const branch = await runGit(project.workspaceRoot, ["branch", "--show-current"]);
    const findings: Array<AgentDashboardCanonicalFindingInput> = [];
    if (status.length > 0) {
      findings.push(
        baseFinding({
          kind: "engineering",
          project,
          title: "Working tree has uncommitted changes",
          summary:
            "The engineering collector found local changes that are not represented by a commit.",
          severity: "low",
          category: "vcs",
          evidence: [
            `branch:${branch || "detached"}`,
            `${status.split(/\r?\n/).length} changed path(s)`,
          ],
          source: "local-git",
          observedAt,
        }),
      );
    }
    const hasCiWorkflow = await pathExists(
      NodePath.join(project.workspaceRoot, ".github", "workflows"),
    );
    if (!hasCiWorkflow) {
      findings.push(
        baseFinding({
          kind: "operational",
          project,
          title: "No repository CI workflow was detected",
          summary:
            "The local collector could not find a GitHub Actions workflow, so CI and deployment health are not represented here.",
          severity: "medium",
          confidence: "medium",
          category: "ci",
          evidence: [".github/workflows is missing or unavailable"],
          source: "local-engineering-scan",
          observedAt,
        }),
      );
    }
    return {
      findings,
      state: collectorState({
        kind: "engineering",
        project,
        status: "partial",
        source: "local-git",
        message:
          "Local VCS checks completed. CI, deployment, and pull request checks were not executed.",
        observedAt,
      }),
    };
  } catch (cause) {
    return {
      findings: [],
      state: collectorState({
        kind: "engineering",
        project,
        status: "unavailable",
        source: "local-git",
        message:
          cause instanceof Error ? cause.message.slice(0, 500) : "Git status is unavailable.",
        observedAt,
      }),
    };
  }
};

const collectSecurity = async (
  project: OrchestrationProjectShell,
  observedAt: string,
): Promise<{
  findings: Array<AgentDashboardCanonicalFindingInput>;
  state: AgentDashboardCollectorState;
}> => {
  try {
    const findings: Array<AgentDashboardCanonicalFindingInput> = [];
    const files = await walkFiles(project.workspaceRoot);
    for (const file of files) {
      let contents: string;
      try {
        contents = await NodeFSP.readFile(file, "utf8");
      } catch {
        continue;
      }
      if (!SECRET_PATTERN.test(contents)) continue;
      const relative = NodePath.relative(project.workspaceRoot, file);
      findings.push(
        baseFinding({
          kind: "security",
          project,
          title: "Possible credential in repository content",
          summary:
            "A local pattern scan found a credential-shaped value. The value was not stored or emitted.",
          severity: "high",
          confidence: "medium",
          category: "secrets",
          evidence: [`${relative}:redacted`],
          source: "local-secret-scan",
          observedAt,
        }),
      );
      if (findings.length >= 20) break;
    }

    const packageManifest = NodePath.join(project.workspaceRoot, "package.json");
    const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];
    try {
      await NodeFSP.access(packageManifest);
      const hasLockfile = await Promise.any(
        lockfiles.map((name) => NodeFSP.access(NodePath.join(project.workspaceRoot, name))),
      ).then(
        () => true,
        () => false,
      );
      if (!hasLockfile) {
        findings.push(
          baseFinding({
            kind: "security",
            project,
            title: "JavaScript manifest has no lockfile",
            summary:
              "Dependency resolution is not pinned by a repository lockfile, which weakens reproducibility and reviewability.",
            severity: "medium",
            confidence: "high",
            category: "dependencies",
            evidence: ["package.json", "no supported lockfile at repository root"],
            source: "local-dependency-scan",
            observedAt,
          }),
        );
      }
    } catch {
      // Not a JavaScript repository; no dependency finding is appropriate.
    }

    return {
      findings,
      state: collectorState({
        kind: "security",
        project,
        status: "available",
        source: "local-security-scan",
        message: process.env.GITHUB_TOKEN
          ? null
          : "GitHub checks are unavailable without a configured credential; local checks were completed.",
        observedAt,
      }),
    };
  } catch (cause) {
    return {
      findings: [],
      state: collectorState({
        kind: "security",
        project,
        status: "unavailable",
        source: "local-security-scan",
        message:
          cause instanceof Error
            ? cause.message.slice(0, 500)
            : "Security collection is unavailable.",
        observedAt,
      }),
    };
  }
};

const collectResearch = async (
  stateDir: string,
  project: OrchestrationProjectShell,
  observedAt: string,
): Promise<{
  findings: Array<AgentDashboardCanonicalFindingInput>;
  state: AgentDashboardCollectorState;
}> => {
  const watchlistPath = NodePath.join(stateDir, "agent-dashboard", "research-watchlist.json");
  try {
    const raw = JSON.parse(await NodeFSP.readFile(watchlistPath, "utf8")) as unknown;
    const entries = Array.isArray(raw)
      ? raw
      : raw !== null && typeof raw === "object" && !Array.isArray(raw) && "items" in raw
        ? ((raw as { items?: unknown[] }).items ?? [])
        : [];
    const findings = entries
      .filter(
        (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object",
      )
      .filter(
        (entry) =>
          String(entry.repository ?? entry.projectId ?? "") === String(project.id) ||
          String(entry.repository ?? "") === project.title,
      )
      .slice(0, 50)
      .map((entry) =>
        baseFinding({
          kind: "research",
          project,
          title: String(entry.title ?? "Research watch item").slice(0, 300),
          summary: String(
            entry.summary ?? entry.abstract ?? "Research item collected from the local watchlist.",
          ).slice(0, 4_000),
          severity: "info",
          confidence: "low",
          category: String(entry.category ?? "watchlist").slice(0, 80),
          evidence: [String(entry.url ?? entry.source ?? "local watchlist").slice(0, 1_000)],
          source: "local-research-watchlist",
          observedAt,
        }),
      );
    return {
      findings,
      state: collectorState({
        kind: "research",
        project,
        status: "available",
        source: "local-research-watchlist",
        message: null,
        observedAt,
      }),
    };
  } catch (cause) {
    const code =
      cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
    return {
      findings: [],
      state: collectorState({
        kind: "research",
        project,
        status: code === "ENOENT" ? "unavailable" : "partial",
        source: "local-research-watchlist",
        message:
          code === "ENOENT"
            ? "No local research watchlist is configured."
            : "The local research watchlist could not be read.",
        observedAt,
      }),
    };
  }
};

export const collectAgentDashboardData = async (
  input: AgentDashboardCollectorInput,
): Promise<AgentDashboardCollectorResult> => {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const selectedProjects = input.projects.filter((project) =>
    projectMatches(project, input.projectId),
  );
  const stableProjects = (
    await Promise.all(
      selectedProjects.map(async (project) =>
        (await isStableRepositoryPath(project.workspaceRoot)) ? project : null,
      ),
    )
  ).filter((project): project is OrchestrationProjectShell => project !== null);
  const findings: Array<AgentDashboardCanonicalFindingInput> = [];
  const states: Array<AgentDashboardCollectorState> = [];

  for (const project of stableProjects) {
    const collectors =
      input.kind === "all" ? (["research", "engineering", "security"] as const) : [input.kind];
    for (const kind of collectors) {
      const result =
        kind === "research"
          ? await collectResearch(input.stateDir, project, observedAt)
          : kind === "engineering"
            ? await collectEngineering(project, observedAt)
            : await collectSecurity(project, observedAt);
      findings.push(...result.findings);
      states.push(result.state);
    }
  }

  if (stableProjects.length === 0) {
    states.push(
      collectorState({
        kind: input.kind,
        project: null,
        status: "unavailable",
        source: "agent-dashboard",
        message: "No stable repository checkout is available for collection.",
        observedAt,
      }),
    );
  }

  return { findings, states };
};

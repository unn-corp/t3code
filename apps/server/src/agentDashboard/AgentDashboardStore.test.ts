// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off - These tests inspect the compatibility store's raw JSON document.
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- These compatibility-store cases intentionally combine Node filesystem fixtures with the store's public Effect service.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import * as AgentDashboardStore from "./AgentDashboardStore.ts";

const initializeGitRepository = async (path: string): Promise<void> => {
  await NodeFSP.mkdir(path, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q", path]);
  await NodeFSP.writeFile(NodePath.join(path, "README.md"), "test repository\n");
  NodeChildProcess.execFileSync("git", ["-C", path, "add", "README.md"]);
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

it.effect("imports the legacy feed when the T3 target already exists but is empty", () =>
  Effect.promise(async () => {
    const homeDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-legacy-home-"));
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-state-"));
    const targetDirectory = NodePath.join(stateDir, "agent-dashboard");
    const legacyDirectory = NodePath.join(homeDir, ".local", "share", "agent-widget");
    const legacyCard = {
      id: 42,
      ts: 1_786_000_000,
      agent: "hermes",
      title: "Legacy update",
      text: "Still visible after the T3 store was initialized.",
      level: "success",
    };
    const previousHome = process.env.HOME;

    try {
      await NodeFSP.mkdir(targetDirectory, { recursive: true });
      await NodeFSP.mkdir(legacyDirectory, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(targetDirectory, "feed.jsonl"), "\n");
      await NodeFSP.writeFile(
        NodePath.join(legacyDirectory, "feed.jsonl"),
        `${JSON.stringify(legacyCard)}\n`,
      );

      process.env.HOME = homeDir;
      const store = AgentDashboardStore.getStore(stateDir);
      const feed = await Effect.runPromise(store.readFeed);

      expect(feed).toHaveLength(1);
      expect(feed[0]).toMatchObject(legacyCard);
      expect(
        await NodeFSP.readFile(NodePath.join(targetDirectory, "feed.legacy-migrated"), "utf8"),
      ).toBe("1\n");

      await Effect.runPromise(store.clearFeed);
      expect(await Effect.runPromise(store.readFeed)).toHaveLength(0);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await Promise.all([
        NodeFSP.rm(homeDir, { recursive: true, force: true }),
        NodeFSP.rm(stateDir, { recursive: true, force: true }),
      ]);
    }
  }),
);

it.effect("preserves feed origin metadata for project and chat navigation", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-origin-"));

    try {
      const store = AgentDashboardStore.getStore(stateDir);
      const appended = await Effect.runPromise(
        store.appendFeed({
          agent: "codex",
          title: "Origin-aware update",
          text: "Open the source chat from this card.",
          project_name: "T3 Code",
          project_path: "/workspace/t3code",
          thread_id: "thread-1",
        }),
      );

      expect(appended.origin).toEqual({
        projectId: null,
        projectName: "T3 Code",
        projectPath: "/workspace/t3code",
        threadId: "thread-1",
      });
      expect((await Effect.runPromise(store.readFeed))[0]?.origin).toEqual(appended.origin);
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("hides missing and linked-worktree review targets", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-review-targets-"));
    const repositoryPath = NodePath.join(stateDir, "repository");
    const linkedWorktreePath = NodePath.join(stateDir, "Photonic-wt-216");
    const suggestionsPath = NodePath.join(stateDir, "agent-dashboard", "suggestions.json");
    const createdAt = "2026-08-09T00:00:00.000Z";

    try {
      await initializeGitRepository(repositoryPath);
      NodeChildProcess.execFileSync("git", [
        "-C",
        repositoryPath,
        "worktree",
        "add",
        "--detach",
        "-q",
        linkedWorktreePath,
        "HEAD",
      ]);
      await NodeFSP.mkdir(NodePath.dirname(suggestionsPath), { recursive: true });
      await NodeFSP.writeFile(
        suggestionsPath,
        JSON.stringify({
          suggestions: [
            {
              id: "stable",
              title: "Stable checkout finding",
              source: "code_review",
              status: "pending",
              created_at: createdAt,
              repository: { name: "repository", path: repositoryPath },
            },
            {
              id: "linked",
              title: "Linked worktree finding",
              source: "code_review",
              status: "pending",
              created_at: createdAt,
              repository: { name: "Photonic-wt-216", path: linkedWorktreePath },
            },
            {
              id: "missing",
              title: "Missing checkout finding",
              source: "code_review",
              status: "pending",
              created_at: createdAt,
              repository: {
                name: "missing",
                path: NodePath.join(stateDir, "missing-worktree"),
              },
            },
          ],
        }),
      );

      const store = AgentDashboardStore.getStore(stateDir);
      const visible = await Effect.runPromise(store.readReviewSuggestions);

      expect(visible.map((suggestion) => suggestion.id)).toEqual(["stable"]);
      const persisted = JSON.parse(await NodeFSP.readFile(suggestionsPath, "utf8")) as {
        suggestions: Array<{ id: string; status: string; resolution_reason?: string }>;
      };
      expect(persisted.suggestions.find((suggestion) => suggestion.id === "linked")).toMatchObject({
        status: "blocked",
        resolution_reason: "repository_unavailable_or_linked_worktree",
      });
      expect(persisted.suggestions.find((suggestion) => suggestion.id === "missing")).toMatchObject(
        {
          status: "blocked",
          resolution_reason: "repository_unavailable_or_linked_worktree",
        },
      );
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("ingests native T3 review findings with GitHub issue drafts", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-review-ingest-"));
    const repositoryPath = NodePath.join(stateDir, "repository");

    try {
      await initializeGitRepository(repositoryPath);
      const store = AgentDashboardStore.getStore(stateDir);
      const input: AgentDashboardStore.AgentDashboardReviewIngestInput = {
        jobId: "review-thread-1",
        repository: {
          name: "repository",
          path: repositoryPath,
          githubRepo: "acme/repository",
        },
        findings: [
          {
            title: "The parser drops the final record",
            category: "bug",
            summary: "A line-oriented parser never flushes its final buffered record.",
            impact: "The last item silently disappears from imports.",
            confidence: "high",
            evidence: ["src/parser.ts:42 — buffered output is returned without a final flush"],
            nextStep: "Flush the buffer before returning and add an end-of-input test.",
            githubIssueTitle: "Flush the parser buffer at end of input",
            githubIssueBody: "## Problem\nThe parser drops the final record.",
          },
        ],
      };

      expect(await Effect.runPromise(store.appendReviewSuggestions(input))).toBe(1);
      expect(await Effect.runPromise(store.appendReviewSuggestions(input))).toBe(1);

      const suggestions = await Effect.runPromise(store.readReviewSuggestions);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({
        source: "code_review",
        title: input.findings[0]?.title,
        repository: { name: "repository", githubRepo: "acme/repository" },
        githubIssue: {
          title: "Flush the parser buffer at end of input",
          body: "## Problem\nThe parser drops the final record.",
        },
      });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

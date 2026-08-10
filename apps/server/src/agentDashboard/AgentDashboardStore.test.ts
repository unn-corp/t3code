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
        await NodeFSP.readFile(NodePath.join(targetDirectory, "feed.legacy-cursor"), "utf8"),
      ).toBe("42\n");

      await Effect.runPromise(store.clearFeed);
      // Cursor prevents re-importing already-ingested legacy ids after clear.
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
      const beforeStat = await NodeFSP.stat(suggestionsPath);
      const visible = await Effect.runPromise(store.readReviewSuggestions);

      expect(visible.map((suggestion) => suggestion.id)).toEqual(["stable"]);
      // Read path must not rewrite suggestions (no status mutation side effects).
      const afterStat = await NodeFSP.stat(suggestionsPath);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
      const persisted = JSON.parse(await NodeFSP.readFile(suggestionsPath, "utf8")) as {
        suggestions: Array<{ id: string; status: string; resolution_reason?: string }>;
      };
      expect(persisted.suggestions.find((suggestion) => suggestion.id === "linked")).toMatchObject({
        status: "pending",
      });
      expect(persisted.suggestions.find((suggestion) => suggestion.id === "missing")).toMatchObject(
        {
          status: "pending",
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

it.effect("copies accepted images into owned assets and rejects foreign paths", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-image-"));
    const sourceDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-image-src-"));
    const sourceImage = NodePath.join(sourceDir, "shot.png");
    const secretFile = NodePath.join(sourceDir, "secret.txt");
    const pngBytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    try {
      await NodeFSP.writeFile(sourceImage, pngBytes);
      await NodeFSP.writeFile(secretFile, "top-secret\n");
      const store = AgentDashboardStore.getStore(stateDir);

      const appended = await Effect.runPromise(
        store.appendFeed({
          agent: "codex",
          title: "Render",
          image_file: sourceImage,
        }),
      );
      expect(appended.imageUrl).toBe(`/api/agent-feed/img/${appended.id}`);

      const owned = await Effect.runPromise(store.readFeedImage(appended.id));
      expect(owned).not.toBeNull();
      expect(owned?.contentType).toBe("image/png");
      expect(Array.from(owned?.bytes ?? [])).toEqual(Array.from(pngBytes));

      const assetsDir = NodePath.join(stateDir, "agent-dashboard", "assets");
      const ownedFiles = await NodeFSP.readdir(assetsDir);
      expect(ownedFiles).toEqual([`${appended.id}.png`]);

      // Malicious absolute path on a crafted card must not be served.
      const feedPath = NodePath.join(stateDir, "agent-dashboard", "feed.jsonl");
      await NodeFSP.writeFile(
        feedPath,
        `${JSON.stringify({
          id: 99,
          ts: 1,
          agent: "evil",
          title: "leak",
          image_file: secretFile,
        })}\n`,
      );
      // Reset store cache so the rewritten feed is visible through a new instance.
      // getStore is process-wide; reuse same stateDir by reading through existing store
      // after a direct file rewrite — the store re-reads feed.jsonl each call.
      expect(await Effect.runPromise(store.readFeedImage(99))).toBeNull();

      // Symlink escape from owned assets directory.
      const escapeLink = NodePath.join(assetsDir, "100.png");
      await NodeFSP.symlink(secretFile, escapeLink);
      await NodeFSP.appendFile(
        feedPath,
        `${JSON.stringify({
          id: 100,
          ts: 2,
          agent: "evil",
          title: "symlink",
          image_file: escapeLink,
        })}\n`,
      );
      expect(await Effect.runPromise(store.readFeedImage(100))).toBeNull();

      // Traversal-style relative path.
      await NodeFSP.appendFile(
        feedPath,
        `${JSON.stringify({
          id: 101,
          ts: 3,
          agent: "evil",
          title: "traversal",
          image_file: NodePath.join("..", "..", "secret.txt"),
        })}\n`,
      );
      expect(await Effect.runPromise(store.readFeedImage(101))).toBeNull();
    } finally {
      await Promise.all([
        NodeFSP.rm(stateDir, { recursive: true, force: true }),
        NodeFSP.rm(sourceDir, { recursive: true, force: true }),
      ]);
    }
  }),
);

it.effect("idempotently ingests new legacy cards without clobbering local data", () =>
  Effect.promise(async () => {
    const homeDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-cont-home-"));
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-cont-state-"));
    const legacyDirectory = NodePath.join(homeDir, ".local", "share", "agent-widget");
    const previousHome = process.env.HOME;

    try {
      await NodeFSP.mkdir(legacyDirectory, { recursive: true });
      const legacyPath = NodePath.join(legacyDirectory, "feed.jsonl");
      await NodeFSP.writeFile(
        legacyPath,
        `${JSON.stringify({
          id: 1,
          ts: 10,
          agent: "hermes",
          title: "First",
          text: "legacy-one",
          level: "info",
        })}\n`,
      );

      process.env.HOME = homeDir;
      const store = AgentDashboardStore.getStore(stateDir);
      expect(await Effect.runPromise(store.readFeed)).toHaveLength(1);

      // Local card coexists; subsequent legacy append is ingested by id.
      await Effect.runPromise(
        store.appendFeed({
          agent: "t3",
          title: "Local only",
          text: "must survive continuous ingest",
        }),
      );

      await NodeFSP.appendFile(
        legacyPath,
        `${JSON.stringify({
          id: 1,
          ts: 10,
          agent: "hermes",
          title: "First rewritten",
          text: "should not replace existing id",
          level: "warn",
        })}\n${JSON.stringify({
          id: 7,
          ts: 20,
          agent: "hermes",
          title: "Second",
          text: "legacy-two",
          level: "success",
        })}\n`,
      );

      const feed = await Effect.runPromise(store.readFeed);
      const byTitle = new Map(feed.map((card) => [card.title, card]));
      expect(byTitle.get("First")?.text).toBe("legacy-one");
      expect(byTitle.get("First rewritten")).toBeUndefined();
      expect(byTitle.get("Second")?.text).toBe("legacy-two");
      expect(byTitle.get("Local only")?.text).toBe("must survive continuous ingest");

      // Idempotent re-read does not duplicate.
      const again = await Effect.runPromise(store.readFeed);
      expect(again).toHaveLength(feed.length);
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

it.effect("keeps feed and research state-file mtimes stable across pure reads", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-mtimes-"));
    try {
      const store = AgentDashboardStore.getStore(stateDir);
      await Effect.runPromise(
        store.appendFeed({
          agent: "codex",
          title: "Stable",
          text: "read me twice",
        }),
      );
      const researchPath = NodePath.join(stateDir, "agent-dashboard", "research_findings.jsonl");
      await NodeFSP.writeFile(
        researchPath,
        `${JSON.stringify({
          finding_id: "paper-1",
          source: "arxiv",
          title: "A paper",
          timestamp: "2026-08-01T00:00:00.000Z",
        })}\n`,
      );

      const feedPath = NodePath.join(stateDir, "agent-dashboard", "feed.jsonl");
      await Effect.runPromise(store.readFeed);
      await Effect.runPromise(store.readResearchFindings);
      const feedBefore = await NodeFSP.stat(feedPath);
      const researchBefore = await NodeFSP.stat(researchPath);

      await Effect.runPromise(store.readFeed);
      await Effect.runPromise(store.readResearchFindings);
      const feedAfter = await NodeFSP.stat(feedPath);
      const researchAfter = await NodeFSP.stat(researchPath);

      expect(feedAfter.mtimeMs).toBe(feedBefore.mtimeMs);
      expect(researchAfter.mtimeMs).toBe(researchBefore.mtimeMs);
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

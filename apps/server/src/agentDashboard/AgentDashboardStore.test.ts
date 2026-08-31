// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off - retention fixtures need wall-clock-relative timestamps.
// @effect-diagnostics preferSchemaOverJson:off - These tests inspect the compatibility store's raw JSON document.
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- These compatibility-store cases intentionally combine Node filesystem fixtures with the store's public Effect service.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { ProjectId, ThreadId, type AgentDashboardAutomationRun } from "@t3tools/contracts";

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
      ts: 1_900_000_000,
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

it.effect("prunes feed cards and owned images after two days", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-feed-retention-"));
    const dashboardDir = NodePath.join(stateDir, "agent-dashboard");
    const assetsDir = NodePath.join(dashboardDir, "assets");
    const expiredImage = NodePath.join(assetsDir, "1.png");
    try {
      await NodeFSP.mkdir(assetsDir, { recursive: true });
      await NodeFSP.writeFile(expiredImage, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
      await NodeFSP.writeFile(
        NodePath.join(dashboardDir, "feed.jsonl"),
        [
          JSON.stringify({
            id: 1,
            ts: 1,
            agent: "old-agent",
            title: "Expired",
            image_file: expiredImage,
          }),
          JSON.stringify({ id: 2, ts: 1_900_000_000, agent: "new-agent", title: "Current" }),
        ].join("\n") + "\n",
      );
      await NodeFSP.writeFile(NodePath.join(dashboardDir, "feed.legacy-cursor"), "999999999\n");

      const feed = await Effect.runPromise(AgentDashboardStore.getStore(stateDir).readFeed);

      expect(feed.map((card) => card.id)).toEqual([2]);
      expect(
        await NodeFSP.readFile(NodePath.join(dashboardDir, "feed.jsonl"), "utf8"),
      ).not.toContain('"id":1');
      await expect(NodeFSP.access(expiredImage)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("creates and updates repository research watch items", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-research-watch-"));
    try {
      const store = AgentDashboardStore.getStore(stateDir);
      const input = {
        projectId: ProjectId.make("project-one"),
        title: "Track compiler research",
        summary: "Watch for techniques that apply to this repository.",
        url: "https://example.com/research",
        category: "performance",
      } as const;

      expect(await Effect.runPromise(store.upsertResearchWatchItem(input))).toBe(true);
      expect(
        await Effect.runPromise(
          store.upsertResearchWatchItem({ ...input, summary: "Updated research scope." }),
        ),
      ).toBe(true);

      const document = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(stateDir, "agent-dashboard", "research-watchlist.json"),
          "utf8",
        ),
      ) as { items: Array<Record<string, unknown>> };
      expect(document.items).toHaveLength(1);
      expect(document.items[0]).toMatchObject({
        projectId: "project-one",
        title: "Track compiler research",
        summary: "Updated research scope.",
      });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("hides missing and linked-worktree review targets but accepts submodule checkouts", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-review-targets-"));
    const repositoryPath = NodePath.join(stateDir, "repository");
    const submodulePath = NodePath.join(stateDir, "submodule-checkout");
    const submoduleGitPath = NodePath.join(stateDir, "submodule-git");
    const linkedWorktreePath = NodePath.join(stateDir, "Photonic-wt-216");
    const suggestionsPath = NodePath.join(stateDir, "agent-dashboard", "suggestions.json");
    const createdAt = "2026-08-09T00:00:00.000Z";

    try {
      await initializeGitRepository(repositoryPath);
      await initializeGitRepository(submodulePath);
      await NodeFSP.rename(NodePath.join(submodulePath, ".git"), submoduleGitPath);
      await NodeFSP.writeFile(NodePath.join(submodulePath, ".git"), "gitdir: ../submodule-git\n");
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
              id: "submodule",
              title: "Durable submodule checkout finding",
              source: "code_review",
              status: "pending",
              created_at: createdAt,
              repository: { name: "submodule-checkout", path: submodulePath },
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

      expect(visible.map((suggestion) => suggestion.id)).toEqual(
        expect.arrayContaining(["stable", "submodule"]),
      );
      expect(visible).toHaveLength(2);
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

it.effect("keeps prose-only native T3 review findings out of automation", () =>
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
            type: "bug",
            title: "The parser drops the final record",
            category: "bug",
            summary: "A line-oriented parser never flushes its final buffered record.",
            impact: "The last item silently disappears from imports.",
            confidence: "high",
            evidence: ["src/parser.ts:42 — buffered output is returned without a final flush"],
            nextStep: "Flush the buffer before returning and add an end-of-input test.",
            readiness: "needs-research",
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
      const [finding] = await Effect.runPromise(store.readFindings);
      expect(finding?.actionability).toMatchObject({
        readiness: "needs-research",
        proposal: "Flush the buffer before returning and add an end-of-input test.",
        expectedValue: "The last item silently disappears from imports.",
      });

      const findingsPath = NodePath.join(stateDir, "agent-dashboard", "findings.json");
      const persisted = JSON.parse(await NodeFSP.readFile(findingsPath, "utf8")) as {
        findings: Array<{ actionability: unknown }>;
      };
      persisted.findings[0]!.actionability = null;
      await NodeFSP.writeFile(findingsPath, JSON.stringify(persisted, null, 2));

      const [legacyFinding] = await Effect.runPromise(store.readFindings);
      expect(legacyFinding?.actionability).toMatchObject({
        readiness: "needs-research",
        proposal: "Flush the buffer before returning and add an end-of-input test.",
        expectedValue: "The last item silently disappears from imports.",
      });
      expect(
        await Effect.runPromise(
          store.claimFindingThread({
            id: legacyFinding!.id,
            projectId: ProjectId.make("project-1"),
            threadId: ThreadId.make("thread-legacy-implementation"),
          }),
        ),
      ).toBe("noop");
      expect((await Effect.runPromise(store.readFindings))[0]).toMatchObject({
        actionability: { readiness: "needs-research" },
        thread: null,
      });

      const qualifiedInput: AgentDashboardStore.AgentDashboardReviewIngestInput = {
        ...input,
        findings: [
          {
            ...input.findings[0]!,
            readiness: "ready",
            targets: [
              {
                path: "src/parser.ts",
                symbol: "parseRecords",
                evidence: "The parser returns before flushing its final buffer.",
              },
            ],
            validationPlan: ["Run the parser end-of-input regression test."],
            qualificationReason: "The target and validation are repository-grounded.",
          },
        ],
      };
      expect(await Effect.runPromise(store.appendReviewSuggestions(qualifiedInput))).toBe(1);
      expect((await Effect.runPromise(store.readFindings))[0]?.actionability).toMatchObject({
        readiness: "ready",
        targets: [{ path: "src/parser.ts" }],
        validationPlan: ["Run the parser end-of-input regression test."],
        qualificationReason: "The target and validation are repository-grounded.",
      });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("deduplicates canonical findings across runs and preserves disposition", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-canonical-findings-"),
    );
    const repositoryPath = NodePath.join(stateDir, "repository");

    try {
      await initializeGitRepository(repositoryPath);
      const store = AgentDashboardStore.getStore(stateDir);
      const baseInput: AgentDashboardStore.AgentDashboardReviewIngestInput = {
        jobId: "review-job-1",
        runId: "run-1",
        projectId: "project-1",
        threadId: "thread-1",
        repository: {
          name: "repository",
          path: repositoryPath,
        },
        findings: [
          {
            type: "bug",
            title: "The parser drops the final record",
            category: "bug",
            summary: "A line-oriented parser never flushes its final buffered record.",
            impact: "The last item silently disappears from imports.",
            confidence: "high",
            evidence: ["src/parser.ts:42"],
            nextStep: "Flush the buffer before returning.",
            readiness: "needs-research",
            githubIssueTitle: "Flush parser buffer",
            githubIssueBody: "## Problem",
          },
        ],
      };

      expect(await Effect.runPromise(store.appendReviewSuggestions(baseInput))).toBe(1);
      const first = await Effect.runPromise(store.readFindings);
      expect(first).toHaveLength(1);
      const firstFinding = first[0];
      expect(firstFinding?.occurrenceCount).toBe(1);

      expect(
        await Effect.runPromise(
          store.applyFindingAction({
            id: firstFinding!.id,
            action: "snooze",
            snoozeUntil: "2026-08-12T00:00:00.000Z",
            note: "Review after the parser migration.",
          }),
        ),
      ).toBe("applied");

      expect(
        await Effect.runPromise(
          store.appendReviewSuggestions({
            ...baseInput,
            jobId: "review-job-2",
            runId: "run-2",
            findings: [
              {
                ...baseInput.findings[0]!,
                title: "Final parser record is dropped",
                summary: "The parser returns before emitting its last buffered record.",
                evidence: ["src/parser.ts:47"],
              },
            ],
          }),
        ),
      ).toBe(1);

      const findings = await Effect.runPromise(store.readFindings);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        id: firstFinding?.id,
        occurrenceCount: 2,
        lastRunId: "run-2",
        disposition: {
          state: "snoozed",
          snoozeUntil: "2026-08-12T00:00:00.000Z",
          note: "Review after the parser migration.",
        },
        thread: { projectId: "project-1", threadId: "thread-1" },
      });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("qualifies open collector signals and archives verified false positives", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-qualifications-"));
    try {
      const store = AgentDashboardStore.getStore(stateDir);
      await Effect.runPromise(
        store.appendFindings([
          {
            kind: "operational",
            type: "operations",
            title: "No CI workflow",
            summary: "The repository has no workflow.",
            evidence: [".github/workflows is missing"],
            repository: { projectId: "project-1" },
            source: "local-engineering-scan",
          },
          {
            kind: "security",
            type: "security",
            title: "Possible credential",
            summary: "A credential-shaped fixture was found.",
            evidence: ["src/example.test.ts:redacted"],
            repository: { projectId: "project-1" },
            source: "local-secret-scan",
          },
          {
            kind: "review",
            type: "improvement",
            title: "Under-specified observation",
            summary: "A review mentioned a possible improvement without locating it.",
            evidence: ["The review contains no concrete code target."],
            repository: { projectId: "project-1" },
            source: "repository-review",
          },
        ]),
      );
      const findings = await Effect.runPromise(store.readFindings);
      const ci = findings.find((finding) => finding.title === "No CI workflow");
      const secret = findings.find((finding) => finding.title === "Possible credential");
      const incomplete = findings.find(
        (finding) => finding.title === "Under-specified observation",
      );

      expect(
        await Effect.runPromise(
          store.applyFindingQualifications([
            {
              id: ci!.id,
              outcome: "ready",
              proposal: "Add a focused pull-request workflow.",
              expectedValue: "Catch regressions before merge.",
              targets: [
                {
                  path: ".github/workflows/checks.yml",
                  symbol: null,
                  evidence: "The workflow directory is absent.",
                },
              ],
              validationPlan: ["Validate the workflow syntax."],
              sources: [],
              riskTier: "low",
              estimatedEffort: "small",
              reason: "The repository already exposes a deterministic test command.",
            },
            {
              id: secret!.id,
              outcome: "dismiss",
              reason: "The value is an intentionally inert test fixture.",
            },
            {
              id: incomplete!.id,
              outcome: "ready",
              proposal: "Investigate the observation.",
              expectedValue: "Clarify whether it needs work.",
              targets: [],
              validationPlan: [],
              sources: [],
              riskTier: "low",
              estimatedEffort: "small",
              reason: "The observation was not checked against a concrete target.",
            },
          ]),
        ),
      ).toBe(3);

      const qualified = await Effect.runPromise(store.readFindings);
      expect(qualified.find((finding) => finding.id === ci!.id)?.actionability).toMatchObject({
        readiness: "ready",
        riskTier: "low",
        estimatedEffort: "small",
        qualifiedBy: "repository-review",
        qualifiedOccurrenceCount: 1,
      });
      expect(qualified.find((finding) => finding.id === secret!.id)?.disposition).toMatchObject({
        state: "dismissed",
        actor: "repository-review",
        note: "The value is an intentionally inert test fixture.",
      });
      expect(
        qualified.find((finding) => finding.id === incomplete!.id)?.actionability,
      ).toMatchObject({
        readiness: "needs-research",
        targets: [],
        validationPlan: [],
      });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("migrates legacy canonical findings into the persisted product taxonomy", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-finding-type-"));
    try {
      const store = AgentDashboardStore.getStore(stateDir);
      await Effect.runPromise(
        store.appendFindings([
          {
            type: "security",
            kind: "security",
            title: "Unpinned dependency graph",
            summary: "The project manifest does not have a lockfile.",
            category: "dependencies",
            repository: { projectId: "project-1" },
            source: "local-security-scan",
          },
        ]),
      );
      const findingsPath = NodePath.join(stateDir, "agent-dashboard", "findings.json");
      const persisted = await NodeFSP.readFile(findingsPath, "utf8");
      await NodeFSP.writeFile(findingsPath, persisted.replace(/\s*"type": "security",/, ""));

      expect((await Effect.runPromise(store.readFindings))[0]?.type).toBe("security");
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("builds a GitHub issue draft from an actionable canonical research finding", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-research-draft-"));
    try {
      const store = AgentDashboardStore.getStore(stateDir);
      await Effect.runPromise(
        store.appendFindings([
          {
            kind: "research",
            title: "Adopt receipt-driven session activation",
            summary: "Polling delays session adoption and adds repeated projection reads.",
            confidence: "high",
            evidence: ["src/review.ts:42 polls every 250ms"],
            repository: { projectId: "project-1" },
            repositoryPath: "/workspace/t3code",
            source: "repository-research",
            actionability: {
              readiness: "ready",
              proposal: "Replace the polling loop with a session-start receipt.",
              expectedValue: "Remove polling latency and redundant reads.",
              targets: [
                {
                  path: "src/review.ts",
                  symbol: "runReview",
                  evidence: "The session loop polls projection state.",
                },
              ],
              validationPlan: ["Run the focused review runner tests."],
              sources: [
                {
                  title: "Receipt lifecycle documentation",
                  url: "https://example.com/receipts",
                  kind: "documentation",
                },
              ],
              riskTier: "medium",
              estimatedEffort: "medium",
              qualificationReason: "The change is bounded and locally testable.",
              qualifiedAt: "2026-08-09T12:05:00.000Z",
              qualifiedBy: "repository-review",
              qualifiedOccurrenceCount: 1,
            },
          },
        ]),
      );

      const [finding] = await Effect.runPromise(store.readFindings);
      expect(finding?.actionability?.readiness).toBe("ready");
      expect(AgentDashboardStore.buildCanonicalGithubIssueDraft(finding!).body).toContain(
        "## Code targets\n- `src/review.ts` (runReview): The session loop polls projection state.",
      );
      expect(AgentDashboardStore.buildCanonicalGithubIssueDraft(finding!).body).toContain(
        "## Validation\n- Run the focused review runner tests.",
      );
      expect(AgentDashboardStore.buildCanonicalGithubIssueDraft(finding!).body).toContain(
        "[Receipt lifecycle documentation](https://example.com/receipts) (documentation)",
      );
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("links a finding to its working chat and records the transition", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-finding-thread-link-"),
    );
    const repositoryPath = NodePath.join(stateDir, "repository");

    try {
      await initializeGitRepository(repositoryPath);
      const store = AgentDashboardStore.getStore(stateDir);
      await Effect.runPromise(
        store.appendReviewSuggestions({
          jobId: "review-job-1",
          projectId: "project-1",
          repository: { name: "repository", path: repositoryPath },
          findings: [
            {
              type: "bug",
              title: "The parser drops the final record",
              category: "bug",
              summary: "A line-oriented parser never flushes its final buffered record.",
              impact: "The last item silently disappears from imports.",
              confidence: "high",
              evidence: ["src/parser.ts:42"],
              nextStep: "Flush the buffer before returning.",
              readiness: "needs-research",
              githubIssueTitle: "Flush parser buffer",
              githubIssueBody: "## Problem",
            },
          ],
        }),
      );

      const [finding] = await Effect.runPromise(store.readFindings);
      expect(finding).toBeDefined();
      expect(
        await Effect.runPromise(
          store.linkFindingThread({
            id: finding!.id,
            projectId: ProjectId.make("project-1"),
            threadId: ThreadId.make("thread-working"),
          }),
        ),
      ).toBe("applied");

      const [linked] = await Effect.runPromise(store.readFindings);
      expect(linked).toMatchObject({
        id: finding!.id,
        thread: { projectId: "project-1", threadId: "thread-working" },
        disposition: {
          state: "in-progress",
          note: "Work started from the T3 Code Agent Dashboard.",
        },
      });
      expect(await Effect.runPromise(store.readExternalActions)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "open-thread",
            status: "succeeded",
            findingId: finding!.id,
            targetId: "thread-working",
            result: "linked",
          }),
        ]),
      );
      expect(
        await Effect.runPromise(
          store.linkFindingThread({
            id: finding!.id,
            projectId: ProjectId.make("project-1"),
            threadId: ThreadId.make("thread-working"),
          }),
        ),
      ).toBe("noop");
      expect(await Effect.runPromise(store.readExternalActions)).toHaveLength(1);

      expect(
        await Effect.runPromise(
          store.applyFindingAction({
            id: finding!.id,
            action: "complete",
            note: "Implementation and focused validation completed.",
          }),
        ),
      ).toBe("applied");
      expect((await Effect.runPromise(store.readFindings))[0]?.disposition).toMatchObject({
        state: "done",
        note: "Implementation and focused validation completed.",
      });
      expect(
        await Effect.runPromise(
          store.applyFindingAction({
            id: finding!.id,
            action: "complete",
            note: "Implementation and focused validation completed.",
          }),
        ),
      ).toBe("noop");

      expect(
        await Effect.runPromise(
          store.applyFindingAction({
            id: finding!.id,
            action: "reopen",
          }),
        ),
      ).toBe("applied");
      expect((await Effect.runPromise(store.readFindings))[0]?.disposition.state).toBe("open");
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

it.effect("atomically claims and releases a ready finding for continuous implementation", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-finding-claim-"));
    try {
      const store = AgentDashboardStore.getStore(stateDir);
      await Effect.runPromise(
        store.appendFindings([
          {
            kind: "review",
            title: "Remove a repeated projection query",
            summary: "The same projection is loaded twice.",
            repository: { projectId: "project-1" },
            source: "review",
            actionability: {
              readiness: "ready",
              proposal: "Reuse the first projection result.",
              expectedValue: "Avoid redundant work.",
              targets: [
                {
                  path: "apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts",
                  symbol: "getSnapshot",
                  evidence: "The same projection is loaded twice.",
                },
              ],
              validationPlan: ["Run the focused store test."],
              sources: [],
              riskTier: "medium",
              estimatedEffort: "small",
              qualificationReason: "The redundant query is confirmed and locally testable.",
              qualifiedAt: "2026-08-09T12:05:00.000Z",
              qualifiedBy: "repository-review",
              qualifiedOccurrenceCount: 1,
            },
          },
        ]),
      );
      const [finding] = await Effect.runPromise(store.readFindings);
      const first = {
        id: finding!.id,
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-first"),
      };
      expect(await Effect.runPromise(store.claimFindingThread(first))).toBe("noop");
      expect(
        await Effect.runPromise(
          store.applyFindingAction({
            id: finding!.id,
            action: "approve",
          }),
        ),
      ).toBe("applied");
      expect((await Effect.runPromise(store.readFindings))[0]?.actionability).toMatchObject({
        qualifiedBy: "human",
        qualifiedOccurrenceCount: 1,
      });
      expect(await Effect.runPromise(store.claimFindingThread(first))).toBe("applied");
      expect(
        await Effect.runPromise(
          store.claimFindingThread({ ...first, threadId: ThreadId.make("thread-second") }),
        ),
      ).toBe("noop");
      expect((await Effect.runPromise(store.readFindings))[0]).toMatchObject({
        thread: { threadId: "thread-first" },
        disposition: { state: "in-progress", actor: "continuous-improvement" },
      });
      expect(await Effect.runPromise(store.releaseFindingThread(first))).toBe("applied");
      expect((await Effect.runPromise(store.readFindings))[0]).toMatchObject({
        thread: null,
        disposition: { state: "open", actor: "continuous-improvement" },
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
          ts: 1_900_000_000,
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
          ts: 1_900_000_000,
          agent: "hermes",
          title: "First rewritten",
          text: "should not replace existing id",
          level: "warn",
        })}\n${JSON.stringify({
          id: 7,
          ts: 1_900_000_001,
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

const automationRun = (
  id: string,
  kind: string,
  status: AgentDashboardAutomationRun["status"],
  updatedAt: string,
): AgentDashboardAutomationRun => ({
  id,
  kind,
  status,
  trigger: "scheduled",
  repository: { projectId: ProjectId.make("coverage-project") },
  target: "coverage-project",
  threadId: ThreadId.make("coverage-thread"),
  jobId: id,
  model: "gpt-5.6-luna/max",
  retryCount: 0,
  findingCount: 0,
  costUnits: null,
  error: status === "failed" ? "review failed" : null,
  createdAt: "2026-08-01T00:00:00.000Z",
  startedAt: "2026-08-01T00:00:01.000Z",
  updatedAt,
  completedAt:
    status === "failed" || status === "succeeded" || status === "partial" ? updatedAt : null,
});

it.effect(
  "isolates review coverage from implementation history and duplicate terminal writes",
  () =>
    Effect.promise(async () => {
      const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coverage-"));
      try {
        const store = AgentDashboardStore.getStore(stateDir);
        const failedReview = automationRun(
          "review-1",
          "repository-review",
          "failed",
          "2026-08-01T01:00:00.000Z",
        );

        await Effect.runPromise(
          store.recordAutomationRun({
            ...failedReview,
            status: "running",
            error: null,
            updatedAt: "2026-08-01T00:59:00.000Z",
            completedAt: null,
          }),
        );
        await Effect.runPromise(store.recordAutomationRun(failedReview));
        await Effect.runPromise(
          store.recordAutomationRun({
            ...failedReview,
            updatedAt: "2026-08-01T01:05:00.000Z",
            completedAt: "2026-08-01T01:05:00.000Z",
          }),
        );
        await Effect.runPromise(
          store.recordAutomationRun(
            automationRun(
              "implementation-1",
              "continuous-improvement",
              "failed",
              "2026-08-01T02:00:00.000Z",
            ),
          ),
        );

        const coverage = await Effect.runPromise(store.readRepositoryCoverage);
        expect(coverage).toHaveLength(1);
        expect(coverage[0]).toMatchObject({
          consecutiveFailures: 1,
          lastRunId: "review-1",
          lastTerminalRunId: "review-1",
          observedAt: "2026-08-01T01:05:00.000Z",
        });
      } finally {
        await NodeFSP.rm(stateDir, { recursive: true, force: true });
      }
    }),
);

it.effect("repairs contaminated repository coverage from terminal review history", () =>
  Effect.promise(async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coverage-repair-"));
    try {
      const dashboardDir = NodePath.join(stateDir, "agent-dashboard");
      await NodeFSP.mkdir(dashboardDir, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(dashboardDir, "repository-coverage.json"),
        JSON.stringify({
          coverage: [
            {
              repository: { projectId: "coverage-project" },
              status: "failing",
              lastAttemptedAt: "2026-08-01T00:00:00.000Z",
              lastSucceededAt: null,
              nextDueAt: "2026-08-28T00:00:00.000Z",
              consecutiveFailures: 6350,
              lastError: "legacy pollution",
              lastRunId: "implementation:legacy-run",
              observedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        }),
      );
      const store = AgentDashboardStore.getStore(stateDir);
      const succeeded = automationRun(
        "review-repaired",
        "repository-review",
        "succeeded",
        "2026-08-02T00:00:00.000Z",
      );
      await Effect.runPromise(store.repairRepositoryCoverage([succeeded]));

      const coverage = await Effect.runPromise(store.readRepositoryCoverage);
      expect(coverage[0]).toMatchObject({
        status: "current",
        consecutiveFailures: 0,
        lastRunId: "review-repaired",
        lastTerminalRunId: "review-repaired",
        lastSucceededAt: "2026-08-02T00:00:00.000Z",
      });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  }),
);

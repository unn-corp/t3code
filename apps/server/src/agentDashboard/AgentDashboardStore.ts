// @effect-diagnostics nodeBuiltinImport:off - T3 owns a local durable compatibility store at the Node filesystem boundary.
// @effect-diagnostics globalDate:off - persisted compatibility records use Unix timestamps and ISO strings.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import type {
  AgentDashboardFeedAction,
  AgentDashboardFeedCard,
  AgentDashboardFeedOrigin,
  AgentDashboardResearchFinding,
  AgentDashboardReviewSuggestion,
} from "@t3tools/contracts";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";

const MAX_FEED_CARDS = 200;
const MAX_RESEARCH_FINDINGS = 500;
const MAX_TEXT = 8_000;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[0-9]+$/;

type JsonObject = Record<string, unknown>;

export class AgentDashboardStoreError extends Schema.TaggedErrorClass<AgentDashboardStoreError>()(
  "AgentDashboardStoreError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentDashboardFeedImage {
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface AgentDashboardReviewFindingInput {
  readonly title: string;
  readonly category: string;
  readonly summary: string;
  readonly impact: string;
  readonly confidence: string;
  readonly evidence: ReadonlyArray<string>;
  readonly nextStep: string;
  readonly githubIssueTitle: string;
  readonly githubIssueBody: string;
  readonly markdown?: string | undefined;
}

export interface AgentDashboardReviewIngestInput {
  readonly jobId: string;
  readonly repository: {
    readonly name: string;
    readonly path: string;
    readonly githubRepo?: string | null | undefined;
  };
  readonly findings: ReadonlyArray<AgentDashboardReviewFindingInput>;
}

export interface AgentDashboardStoreService {
  readonly readFeed: Effect.Effect<ReadonlyArray<AgentDashboardFeedCard>, AgentDashboardStoreError>;
  readonly appendFeed: (
    input: unknown,
  ) => Effect.Effect<AgentDashboardFeedCard, AgentDashboardStoreError>;
  readonly dismissFeedCard: (id: number) => Effect.Effect<boolean, AgentDashboardStoreError>;
  readonly clearFeed: Effect.Effect<void, AgentDashboardStoreError>;
  readonly readFeedImage: (
    id: number,
  ) => Effect.Effect<AgentDashboardFeedImage | null, AgentDashboardStoreError>;
  readonly readResearchFindings: Effect.Effect<
    ReadonlyArray<AgentDashboardResearchFinding>,
    AgentDashboardStoreError
  >;
  readonly readReviewSuggestions: Effect.Effect<
    ReadonlyArray<AgentDashboardReviewSuggestion>,
    AgentDashboardStoreError
  >;
  readonly appendReviewSuggestions: (
    input: AgentDashboardReviewIngestInput,
  ) => Effect.Effect<number, AgentDashboardStoreError>;
  readonly reviewSuggestion: (
    id: string,
    action: "dismiss" | "block",
  ) => Effect.Effect<boolean, AgentDashboardStoreError>;
  readonly createGithubIssue: (id: string) => Effect.Effect<boolean, AgentDashboardStoreError>;
  readonly feedToken: Effect.Effect<string, AgentDashboardStoreError>;
}

export class AgentDashboardStore extends Context.Service<
  AgentDashboardStore,
  AgentDashboardStoreService
>()("t3/agentDashboard/AgentDashboardStore") {}

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const text = (value: unknown, limit = 500): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result.length > 0 ? result.slice(0, limit) : null;
};

const list = (value: unknown, limit = 24, itemLimit = 180): Array<string> => {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => text(item, itemLimit))
    .filter((item): item is string => item !== null);
};

const integer = (value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(maximum, Math.trunc(parsed)));
};

const timestamp = (value: unknown, fallback = new Date(0).toISOString()): string => {
  const candidate = text(value, 100);
  if (!candidate) return fallback;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : candidate;
};

const isSafeUrl = (value: string): boolean => /^(?:https?|file):\/\//i.test(value);

const feedAction = (value: unknown): AgentDashboardFeedAction | null => {
  const action = asObject(value);
  const label = text(action?.label, 60);
  if (!label) return null;

  const url = text(action?.url, 2_000);
  const file = text(action?.file, 1_000);
  if (url && !isSafeUrl(url)) return null;
  if (!url && !file) return null;

  return {
    label,
    ...(url ? { url } : {}),
    ...(file ? { file } : {}),
    ...(action?.reveal === true ? { reveal: true } : {}),
  };
};

const feedOrigin = (source: JsonObject): AgentDashboardFeedOrigin => {
  const nested = asObject(source.origin) ?? {};
  const projectId = text(
    nested.projectId ?? nested.project_id ?? source.projectId ?? source.project_id,
    200,
  );
  const projectName = text(
    nested.projectName ?? nested.project_name ?? source.projectName ?? source.project_name,
    200,
  );
  const projectPath = text(
    nested.projectPath ??
      nested.project_path ??
      nested.path ??
      source.projectPath ??
      source.project_path ??
      source.workspaceRoot ??
      source.workspace_root ??
      source.cwd,
    2_000,
  );
  const threadId = text(
    nested.threadId ?? nested.thread_id ?? source.threadId ?? source.thread_id,
    200,
  );

  return {
    projectId: projectId === null ? null : ProjectId.make(projectId),
    projectName,
    projectPath,
    threadId: threadId === null ? null : ThreadId.make(threadId),
  };
};

const feedCard = (raw: unknown, id: number, nowSeconds: number): AgentDashboardFeedCard => {
  const source = asObject(raw) ?? {};
  const imageUrl = text(source.image_url ?? source.imageUrl, 4_000);
  const rawActions = Array.isArray(source.actions)
    ? source.actions
        .slice(0, 8)
        .map(feedAction)
        .filter((action): action is AgentDashboardFeedAction => action !== null)
    : [];
  const level = text(source.level, 20);
  const normalizedLevel: AgentDashboardFeedCard["level"] =
    level === "success" || level === "warn" || level === "error" ? level : "info";
  const title = text(source.title, 200);
  const body = text(source.text, MAX_TEXT);
  const persistedImage = text(source.image_file, 2_000);

  return {
    id,
    ts: typeof source.ts === "number" && Number.isFinite(source.ts) ? source.ts : nowSeconds,
    agent: text(source.agent, 80) ?? "agent",
    kind: text(source.kind, 80),
    title,
    text: body,
    imageUrl:
      persistedImage || imageUrl?.startsWith("/img/") ? `/api/agent-feed/img/${id}` : imageUrl,
    level: normalizedLevel,
    tags: list(source.tags, 12, 40),
    ...(source.chart !== undefined ? { chart: source.chart } : {}),
    ...(source.research !== undefined ? { research: source.research } : {}),
    ...(source.focus !== undefined ? { focus: source.focus } : {}),
    actions: rawActions,
    origin: feedOrigin(source),
  };
};

const rawFeedCard = (raw: unknown, id: number): JsonObject => {
  const source = asObject(raw) ?? {};
  const card: JsonObject = {
    id,
    ts: typeof source.ts === "number" && Number.isFinite(source.ts) ? source.ts : Date.now() / 1000,
    agent: text(source.agent, 80) ?? "agent",
    level: ["info", "success", "warn", "error"].includes(String(source.level))
      ? source.level
      : "info",
  };

  for (const [sourceKey, targetKey, limit] of [
    ["kind", "kind", 80],
    ["title", "title", 200],
    ["text", "text", MAX_TEXT],
    ["image_url", "image_url", 4_000],
    ["image_file", "image_file", 2_000],
  ] as const) {
    const value = text(source[sourceKey], limit);
    if (value) card[targetKey] = value;
  }

  const tags = list(source.tags, 12, 40);
  if (tags.length > 0) card.tags = tags;
  for (const key of ["chart", "research", "focus"] as const) {
    if (source[key] !== undefined) card[key] = source[key];
  }
  const actions = Array.isArray(source.actions)
    ? source.actions
        .slice(0, 8)
        .map(feedAction)
        .filter((action): action is AgentDashboardFeedAction => action !== null)
    : [];
  if (actions.length > 0) card.actions = actions;
  const origin = feedOrigin(source);
  if (origin.projectId !== null) card.project_id = origin.projectId;
  if (origin.projectName !== null) card.project_name = origin.projectName;
  if (origin.projectPath !== null) card.project_path = origin.projectPath;
  if (origin.threadId !== null) card.thread_id = origin.threadId;
  if (!(card.title || card.text || card.image_url || card.image_file || card.chart)) {
    throw new Error("feed card needs title, text, image, or chart content");
  }
  return card;
};

const jsonLines = async (path: string): Promise<Array<JsonObject>> => {
  try {
    const contents = await NodeFSP.readFile(path, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => {
        try {
          return asObject(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((item): item is JsonObject => item !== null);
  } catch (cause) {
    const code = asObject(cause)?.code;
    if (code === "ENOENT") return [];
    throw cause;
  }
};

const jsonDocument = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch (cause) {
    const code = asObject(cause)?.code;
    if (code === "ENOENT") return null;
    throw cause;
  }
};

const fileIsEmpty = async (path: string): Promise<boolean> => {
  try {
    return (await NodeFSP.readFile(path, "utf8")).trim().length === 0;
  } catch (cause) {
    if (asObject(cause)?.code === "ENOENT") return true;
    throw cause;
  }
};

const writeAtomic = async (path: string, contents: string): Promise<void> => {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
};

const readLegacySuggestionRecords = (value: unknown): Array<JsonObject> => {
  const object = asObject(value);
  const records = Array.isArray(object?.suggestions)
    ? object.suggestions
    : Array.isArray(value)
      ? value
      : [];
  return records.map(asObject).filter((item): item is JsonObject => item !== null);
};

const runExecutable = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeout?: number;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeout ?? 30_000,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        const output = {
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        };
        if (error) {
          const detail = [output.stderr.trim(), output.stdout.trim(), error.message.trim()]
            .filter((part) => part.length > 0)
            .join("\n");
          reject(new Error(detail || `Command '${command}' failed.`));
          return;
        }
        resolve(output);
      },
    );
  });

/**
 * Review findings must point at a durable repository checkout. Linked
 * worktrees are disposable review targets: they can be pruned after the
 * investigation finishes, leaving the dashboard with a path that cannot be
 * opened when the user chooses "Work on this".
 */
export const isStableRepositoryPath = async (repositoryPath: string): Promise<boolean> => {
  if (!NodePath.isAbsolute(repositoryPath)) return false;

  try {
    const repositoryStat = await NodeFSP.stat(repositoryPath);
    if (!repositoryStat.isDirectory()) return false;

    // A linked worktree and a submodule expose .git as a pointer file. A
    // durable project checkout has its own .git directory.
    const gitStat = await NodeFSP.lstat(NodePath.join(repositoryPath, ".git"));
    if (!gitStat.isDirectory()) return false;

    const result = await runExecutable(
      "git",
      ["-C", repositoryPath, "rev-parse", "--show-toplevel"],
      { timeout: 5_000 },
    );
    const repositoryRoot = result.stdout.trim();
    if (repositoryRoot.length === 0) return false;

    const [resolvedPath, resolvedRoot] = await Promise.all([
      NodeFSP.realpath(repositoryPath),
      NodeFSP.realpath(repositoryRoot),
    ]);
    return resolvedPath === resolvedRoot;
  } catch {
    return false;
  }
};

const normalizeResearch = (
  raw: JsonObject,
  lineNumber: number,
): AgentDashboardResearchFinding | null => {
  const nested = asObject(raw.finding);
  const finding = nested ?? raw;
  const id = text(finding.finding_id ?? finding.id ?? finding.arxiv_id ?? finding.paper_id, 200);
  const source = text(finding.source, 80) ?? "unknown";
  const title = text(finding.title, 300);
  if (!title) return null;
  const url = text(finding.url, 2_000);
  const stableId = id ?? url ?? `line:${lineNumber}`;
  const relevanceScore = integer(finding.relevance_score ?? finding.relevance, 0, 100);
  const rawTimestamp = raw.timestamp ?? finding.timestamp ?? finding.scanned_at;
  const rawSinceDays = finding.since_days;
  const rawCitationCount = finding.citation_count;
  return {
    id: stableId,
    title,
    source,
    url: url && isSafeUrl(url) ? url : null,
    timestamp: timestamp(rawTimestamp),
    abstract: text(finding.abstract ?? finding.summary, 4_000),
    authors: list(finding.authors, 16, 180),
    published: text(finding.published, 80),
    categories: list(finding.categories, 16, 80),
    relevanceScore,
    topicContext: text(finding.topic_context ?? finding._topic_context, 1_000),
    repositories: list(
      finding.repositories ?? (finding.repository ? [finding.repository] : []),
      24,
      500,
    ),
    watchDir: text(finding.watch_dir, 500),
    sinceDays: rawSinceDays === undefined ? null : integer(rawSinceDays, 0, 3_650),
    pdfUrl:
      text(finding.pdf_url, 2_000) && isSafeUrl(text(finding.pdf_url, 2_000) as string)
        ? text(finding.pdf_url, 2_000)
        : null,
    citationCount: rawCitationCount === undefined ? null : integer(rawCitationCount, 0, 10_000_000),
    occurrences: Math.max(1, integer(raw.occurrences, 1, 1_000_000)),
  };
};

const normalizeSuggestion = (raw: JsonObject): AgentDashboardReviewSuggestion | null => {
  if (raw.source !== "code_review") return null;
  const id = text(raw.id, 100);
  const title = text(raw.title, 300);
  if (!id || !title) return null;
  const repository = asObject(raw.repository) ?? {};
  const issue = asObject(raw.github_issue) ?? {};
  const status = ["pending", "accepted", "dismissed", "blocked"].includes(String(raw.status))
    ? (raw.status as AgentDashboardReviewSuggestion["status"])
    : "pending";
  return {
    id,
    profile: text(raw.profile, 100),
    title,
    description: text(raw.description, 4_000) ?? title,
    source: "code_review",
    status,
    createdAt: timestamp(raw.created_at),
    expiresAt: raw.expires_at ? timestamp(raw.expires_at) : null,
    repository: {
      name: text(repository.name, 200) ?? "Unknown repository",
      path: text(repository.path, 1_000) ?? "unknown",
      githubRepo: text(repository.github_repo, 250),
    },
    category: text(raw.category, 40) ?? "insight",
    impact: text(raw.impact, 1_200) ?? "",
    confidence: text(raw.confidence, 40) ?? "medium",
    evidence: list(raw.evidence, 24, 1_000),
    nextStep: text(raw.next_step, 1_200) ?? "",
    report: text(raw.report, 16_000) ?? text(raw.description, 4_000) ?? title,
    githubIssue: {
      title: text(issue.title, 300) ?? title,
      body: text(issue.body, 16_000) ?? text(raw.description, 4_000) ?? title,
      url: text(issue.url, 2_000),
      number: issue.number === null || issue.number === undefined ? null : integer(issue.number, 0),
    },
    jobId: text(raw.job_id, 200),
  };
};

const makeStore = (stateDir: string): AgentDashboardStoreService => {
  const directory = NodePath.join(stateDir, "agent-dashboard");
  const feedPath = NodePath.join(directory, "feed.jsonl");
  const feedMigrationPath = NodePath.join(directory, "feed.legacy-migrated");
  const researchPath = NodePath.join(directory, "research_findings.jsonl");
  const suggestionsPath = NodePath.join(directory, "suggestions.json");
  const tokenPath = NodePath.join(directory, "feed.token");
  const legacyFeedPath = NodePath.join(
    NodeOS.homedir(),
    ".local",
    "share",
    "agent-widget",
    "feed.jsonl",
  );
  const legacyResearchPath = NodePath.join(NodeOS.homedir(), ".hermes", "research_findings.jsonl");
  const legacySuggestionsPath = NodePath.join(
    NodeOS.homedir(),
    ".hermes",
    "cron",
    "suggestions.json",
  );

  let initialized: Promise<void> | null = null;
  let mutation = Promise.resolve();

  const initialize = (): Promise<void> => {
    if (initialized) return initialized;
    initialized = (async () => {
      await NodeFSP.mkdir(directory, { recursive: true });
      let feedMigrationComplete = false;
      try {
        await NodeFSP.access(feedMigrationPath);
        feedMigrationComplete = true;
      } catch (cause) {
        if (asObject(cause)?.code !== "ENOENT") throw cause;
      }
      if (!feedMigrationComplete) {
        if (await fileIsEmpty(feedPath)) {
          try {
            const legacyContents = await NodeFSP.readFile(legacyFeedPath, "utf8");
            if (legacyContents.trim().length > 0) {
              await writeAtomic(
                feedPath,
                legacyContents.endsWith("\n") ? legacyContents : `${legacyContents}\n`,
              );
              await writeAtomic(feedMigrationPath, "1\n");
            }
          } catch (cause) {
            if (asObject(cause)?.code !== "ENOENT") throw cause;
          }
        } else {
          await writeAtomic(feedMigrationPath, "1\n");
        }
      }
      for (const [target, legacy] of [
        [researchPath, legacyResearchPath],
        [suggestionsPath, legacySuggestionsPath],
      ] as const) {
        try {
          await NodeFSP.access(target);
        } catch {
          try {
            await NodeFSP.copyFile(legacy, target);
          } catch {
            // A missing legacy store is a normal first-run state.
          }
        }
      }
      try {
        await NodeFSP.access(tokenPath);
      } catch {
        const configured = process.env.T3_AGENT_FEED_TOKEN?.trim();
        const token = configured || NodeCrypto.randomBytes(32).toString("base64url");
        await NodeFSP.writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      }
    })();
    return initialized;
  };

  const run = <A>(operation: string, task: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        await initialize();
        return await task();
      },
      catch: (cause) => new AgentDashboardStoreError({ operation, cause }),
    });

  const withMutation = <A>(task: () => Promise<A>): Promise<A> => {
    const next = mutation.then(task, task);
    mutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const readReviewSuggestionRaw = async (): Promise<Array<JsonObject>> => {
    const local = readLegacySuggestionRecords(await jsonDocument(suggestionsPath));
    const legacy = readLegacySuggestionRecords(await jsonDocument(legacySuggestionsPath));
    const byId = new Map<string, JsonObject>();

    for (const record of legacy) {
      const id = text(record.id, 100);
      if (id) byId.set(id, record);
    }
    for (const record of local) {
      const id = text(record.id, 100);
      if (!id) continue;
      const previous = byId.get(id);
      if (!previous) {
        byId.set(id, record);
        continue;
      }

      const previousIssue = asObject(previous.github_issue) ?? {};
      const currentIssue = asObject(record.github_issue) ?? {};
      byId.set(id, {
        ...previous,
        ...record,
        github_issue: {
          ...previousIssue,
          ...currentIssue,
          title: text(currentIssue.title, 300) ?? text(previousIssue.title, 300),
          body: text(currentIssue.body, 16_000) ?? text(previousIssue.body, 16_000),
          url: text(currentIssue.url, 2_000) ?? text(previousIssue.url, 2_000),
          number: currentIssue.number ?? previousIssue.number ?? null,
        },
      });
    }

    return [...byId.values()];
  };

  const readFeedRaw = async (): Promise<Array<JsonObject>> => jsonLines(feedPath);
  const persistFeed = async (cards: ReadonlyArray<JsonObject>): Promise<void> => {
    const kept = cards.slice(-MAX_FEED_CARDS);
    await writeAtomic(feedPath, `${kept.map((card) => JSON.stringify(card)).join("\n")}\n`);
  };

  const readFeed = run("read feed", async () => {
    const cards = await readFeedRaw();
    return cards
      .map((card) => integer(card.id, 0))
      .map((id, index) => feedCard(cards[index], id, 0))
      .toSorted((left, right) => right.id - left.id);
  });

  const appendFeed = (input: unknown) =>
    run("append feed card", () =>
      withMutation(async () => {
        const cards = await readFeedRaw();
        const nextId = cards.reduce((max, card) => Math.max(max, integer(card.id, 0)), 0) + 1;
        const raw = rawFeedCard(input, nextId);
        await persistFeed([...cards, raw]);
        return feedCard(raw, nextId, Number(raw.ts));
      }),
    );

  const dismissFeedCard = (id: number) =>
    run("dismiss feed card", () =>
      withMutation(async () => {
        const cards = await readFeedRaw();
        const remaining = cards.filter((card) => integer(card.id, 0) !== id);
        if (remaining.length === cards.length) return false;
        await persistFeed(remaining);
        return true;
      }),
    );

  const clearFeed = run("clear feed", () =>
    withMutation(async () => {
      await persistFeed([]);
    }),
  );

  const readFeedImage = (id: number) =>
    run("read feed image", async () => {
      const cards = await readFeedRaw();
      const card = cards.find((entry) => integer(entry.id, 0) === id);
      const imagePath = text(card?.image_file, 2_000);
      if (!imagePath || !NodePath.isAbsolute(imagePath)) return null;
      try {
        const bytes = await NodeFSP.readFile(imagePath);
        const extension = NodePath.extname(imagePath).toLowerCase();
        const contentType: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".avif": "image/avif",
        };
        return { bytes, contentType: contentType[extension] ?? "application/octet-stream" };
      } catch (cause) {
        if (asObject(cause)?.code === "ENOENT") return null;
        throw cause;
      }
    });

  const readResearchFindings = run("read research findings", async () => {
    const target = await jsonLines(researchPath);
    const byId = new Map<string, AgentDashboardResearchFinding>();
    for (const [index, record] of target.entries()) {
      const normalized = normalizeResearch(record, index + 1);
      if (!normalized) continue;
      const existing = byId.get(normalized.id);
      byId.set(
        normalized.id,
        existing
          ? {
              ...existing,
              ...normalized,
              occurrences: existing.occurrences + normalized.occurrences,
            }
          : normalized,
      );
    }
    const findings = [...byId.values()]
      .toSorted(
        (left, right) =>
          Date.parse(right.timestamp) - Date.parse(left.timestamp) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, MAX_RESEARCH_FINDINGS);
    await writeAtomic(
      researchPath,
      `${findings.map((finding) => JSON.stringify(finding)).join("\n")}\n`,
    );
    return findings;
  });

  const readReviewSuggestions = run("read review suggestions", async () => {
    const target = await readReviewSuggestionRaw();
    const byId = new Map<string, JsonObject>();
    for (const record of target) {
      const id = text(record.id, 100);
      if (id) byId.set(id, record);
    }
    const all = [...byId.values()];
    const now = Date.now();
    const visible: Array<AgentDashboardReviewSuggestion> = [];
    for (const record of all) {
      const suggestion = normalizeSuggestion(record);
      if (!suggestion || suggestion.status !== "pending") continue;
      if (suggestion.expiresAt !== null && Date.parse(suggestion.expiresAt) <= now) continue;

      if (!(await isStableRepositoryPath(suggestion.repository.path))) {
        record.status = "blocked";
        record.resolved_at = new Date(now).toISOString();
        record.resolution_reason = "repository_unavailable_or_linked_worktree";
        continue;
      }
      visible.push(suggestion);
    }

    await writeAtomic(
      suggestionsPath,
      JSON.stringify({ suggestions: all, updated_at: new Date().toISOString() }, null, 2),
    );
    return visible.toSorted(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id),
    );
  });

  const appendReviewSuggestions = (input: AgentDashboardReviewIngestInput) =>
    run("append review suggestions", () =>
      withMutation(async () => {
        const existingRecords = await readReviewSuggestionRaw();
        const byId = new Map<string, JsonObject>();
        for (const record of existingRecords) {
          const recordId = text(record.id, 100);
          if (recordId) byId.set(recordId, record);
        }

        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000).toISOString();
        let changed = 0;
        for (const finding of input.findings.slice(0, 3)) {
          const title = finding.title.trim().slice(0, 300);
          if (!title) continue;
          const digest = NodeCrypto.createHash("sha256")
            .update(
              JSON.stringify({
                jobId: input.jobId,
                repository: input.repository.path,
                title,
                evidence: finding.evidence,
              }),
            )
            .digest("hex")
            .slice(0, 24);
          const id = `t3-review-${digest}`;
          const previous = byId.get(id);
          const previousIssue = asObject(previous?.github_issue) ?? {};
          const report =
            finding.markdown?.trim().slice(0, 16_000) || finding.summary.trim().slice(0, 4_000);
          const record: JsonObject = {
            ...previous,
            id,
            source: "code_review",
            profile: "t3-random-codebase-review",
            title,
            description: finding.summary.trim().slice(0, 4_000) || title,
            status: text(previous?.status, 40) ?? "pending",
            created_at: text(previous?.created_at, 100) ?? createdAt,
            expires_at: text(previous?.expires_at, 100) ?? expiresAt,
            repository: {
              name: input.repository.name.trim().slice(0, 200) || "Unknown repository",
              path: input.repository.path.trim().slice(0, 1_000),
              ...(input.repository.githubRepo
                ? { github_repo: input.repository.githubRepo.trim().slice(0, 250) }
                : {}),
            },
            category: finding.category.trim().slice(0, 40) || "insight",
            impact: finding.impact.trim().slice(0, 1_200),
            confidence: finding.confidence.trim().slice(0, 40) || "medium",
            evidence: finding.evidence.slice(0, 24).map((item) => item.trim().slice(0, 1_000)),
            next_step: finding.nextStep.trim().slice(0, 1_200),
            report,
            github_issue: {
              ...previousIssue,
              title: finding.githubIssueTitle.trim().slice(0, 300) || title,
              body: finding.githubIssueBody.trim().slice(0, 16_000) || report,
              url: text(previousIssue.url, 2_000),
              number: previousIssue.number ?? null,
            },
            job_id: input.jobId.trim().slice(0, 200),
          };
          byId.set(id, record);
          changed += 1;
        }

        await writeAtomic(
          suggestionsPath,
          JSON.stringify({ suggestions: [...byId.values()], updated_at: createdAt }, null, 2),
        );
        return changed;
      }),
    );

  const reviewSuggestion = (id: string, action: "dismiss" | "block") =>
    run("review suggestion", () =>
      withMutation(async () => {
        const target = await readReviewSuggestionRaw();
        const byId = new Map<string, JsonObject>();
        for (const record of target) {
          const recordId = text(record.id, 100);
          if (recordId) byId.set(recordId, record);
        }
        const record = byId.get(id);
        if (!record || record.source !== "code_review") return false;
        record.status = action === "block" ? "blocked" : "dismissed";
        record.resolved_at = new Date().toISOString();
        await writeAtomic(
          suggestionsPath,
          JSON.stringify(
            { suggestions: [...byId.values()], updated_at: new Date().toISOString() },
            null,
            2,
          ),
        );
        return true;
      }),
    );

  const createGithubIssue = (id: string) =>
    run("create GitHub issue", () =>
      withMutation(async () => {
        const target = await readReviewSuggestionRaw();
        const record = target.find((candidate) => text(candidate.id, 100) === id);
        if (!record || record.source !== "code_review") {
          throw new Error("Suggestion not found.");
        }
        if (String(record.status ?? "pending") !== "pending") {
          throw new Error("Suggestion is no longer pending.");
        }

        const issue = asObject(record.github_issue) ?? {};
        const existingUrl = text(issue.url, 2_000);
        if (existingUrl) return true;

        const repository = asObject(record.repository) ?? {};
        const githubRepository = text(repository.github_repo, 250);
        if (!githubRepository || !GITHUB_REPOSITORY_PATTERN.test(githubRepository)) {
          throw new Error("This finding does not have a GitHub repository configured.");
        }

        const title = text(issue.title, 300) ?? text(record.title, 300);
        const body = text(issue.body, 16_000) ?? text(record.report, 16_000);
        if (!title || !body) throw new Error("This finding does not contain an issue draft.");

        const result = await runExecutable(
          "gh",
          [
            "api",
            `repos/${githubRepository}/issues`,
            "--method",
            "POST",
            "-f",
            `title=${title}`,
            "-f",
            `body=${body}`,
          ],
          {
            timeout: 30_000,
            env: {
              ...process.env,
              GH_PROMPT_DISABLED: "1",
              GIT_TERMINAL_PROMPT: "0",
            },
          },
        );
        let payload: JsonObject;
        try {
          const parsed: unknown = JSON.parse(result.stdout);
          payload = asObject(parsed) ?? {};
        } catch {
          throw new Error("GitHub returned an unreadable issue response.");
        }

        const url = text(payload.html_url, 2_000);
        const number = integer(payload.number, 0);
        if (!url || !GITHUB_ISSUE_URL_PATTERN.test(url) || number <= 0) {
          throw new Error("GitHub returned an invalid issue response.");
        }

        record.github_issue = {
          ...issue,
          title,
          body,
          url,
          number,
        };
        await writeAtomic(
          suggestionsPath,
          JSON.stringify({ suggestions: target, updated_at: new Date().toISOString() }, null, 2),
        );
        return true;
      }),
    );

  const feedToken = run("read feed token", async () => {
    const configured = process.env.T3_AGENT_FEED_TOKEN?.trim();
    if (configured) return configured;
    return (await NodeFSP.readFile(tokenPath, "utf8")).trim();
  });

  return {
    readFeed,
    appendFeed,
    dismissFeedCard,
    clearFeed,
    readFeedImage,
    readResearchFindings,
    readReviewSuggestions,
    appendReviewSuggestions,
    reviewSuggestion,
    createGithubIssue,
    feedToken,
  } satisfies AgentDashboardStoreService;
};

const stores = new Map<string, AgentDashboardStoreService>();

/** Returns the process-wide store for a server state directory. */
export const getStore = (stateDir: string): AgentDashboardStoreService => {
  const existing = stores.get(stateDir);
  if (existing) return existing;
  const store = makeStore(stateDir);
  stores.set(stateDir, store);
  return store;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return getStore(config.stateDir);
});

export const layer = Layer.effect(AgentDashboardStore, make);

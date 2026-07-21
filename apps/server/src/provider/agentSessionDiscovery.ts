// @effect-diagnostics nodeBuiltinImport:off
/**
 * Discovery of agent CLI sessions that already exist on disk, for `/resume`.
 *
 * Each supported driver stores conversations in its own layout, under a home
 * directory that is per provider *instance* — so "the Claude account currently
 * selected" is just "the home path on that instance's settings":
 *
 * - codex:  `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, one JSONL per session
 * - claude: `<configDir>/projects/<slugified-cwd>/<sessionId>.jsonl`
 * - grok:   `<home>/sessions/<url-encoded-cwd>/<sessionId>/chat_history.jsonl`
 *
 * Codex discovery lives in `codexSessionDiscovery.ts`; this module adds the
 * other drivers and the dispatch that picks one.
 */
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";

import {
  type DiscoveredCodexSession,
  discoverCodexSessions,
  sortSessionsByRecency,
} from "./codexSessionDiscovery.ts";

/** A resumable session, in the shape the picker renders. */
export type DiscoveredAgentSession = DiscoveredCodexSession;

const PREVIEW_MAX_LENGTH = 120;

/** Injected context replayed as a user turn; never a useful preview. */
export function isInjectedContext(text: string): boolean {
  return (
    /^\s*</.test(text) || /^\s*#+\s*AGENTS\.md/i.test(text) || /^\s*<INSTRUCTIONS>/i.test(text)
  );
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > PREVIEW_MAX_LENGTH
    ? `${single.slice(0, PREVIEW_MAX_LENGTH - 1)}…`
    : single;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read up to `maxBytes` from the head of a file, dropping a partial last line. */
async function readHeadLines(path: string, maxBytes = 256 * 1024): Promise<string[]> {
  const handle = await NodeFs.open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (bytesRead === buffer.length && lines.length > 1) lines.pop();
    return lines;
  } finally {
    await handle.close();
  }
}

/**
 * Claude Code writes one JSONL per session under a per-project directory whose
 * name is the cwd with path separators replaced by dashes. The file name is the
 * session id, which is what `--resume` takes.
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/\\.]/g, "-");
}

/** First human turn in a Claude transcript. */
export function extractClaudePreview(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record["type"] !== "user") continue;
    const message = record["message"];
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>)["content"];
    const texts: string[] = [];
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "object" && part !== null) {
          const text = readString((part as Record<string, unknown>)["text"]);
          if (text !== undefined) texts.push(text);
        }
      }
    }
    for (const text of texts) {
      const trimmed = text.trim();
      if (trimmed.length > 0 && !isInjectedContext(trimmed)) return truncate(trimmed);
    }
  }
  return undefined;
}

/** Resumable Claude sessions under a config dir (i.e. the selected account). */
export async function discoverClaudeSessions(options: {
  readonly configDir: string;
  readonly cwd?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<ReadonlyArray<DiscoveredAgentSession>> {
  const limit = options.limit ?? 50;
  if (limit <= 0) return [];
  const projectsRoot = NodePath.join(options.configDir, "projects");

  const projectDirs = options.cwd
    ? [NodePath.join(projectsRoot, claudeProjectDirName(options.cwd))]
    : (await NodeFs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => NodePath.join(projectsRoot, entry.name));

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of projectDirs) {
    const entries = await NodeFs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const full = NodePath.join(dir, entry.name);
      const stat = await NodeFs.stat(full).catch(() => undefined);
      candidates.push({ path: full, mtimeMs: stat?.mtimeMs ?? 0 });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const sessions: DiscoveredAgentSession[] = [];
  for (const candidate of candidates) {
    if (sessions.length >= limit) break;
    const sessionId = NodePath.basename(candidate.path, ".jsonl");
    const head = await readHeadLines(candidate.path).catch(() => []);
    if (head.length === 0) continue;
    sessions.push({
      sessionId,
      cwd: options.cwd,
      originator: "claude",
      cliVersion: undefined,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(candidate.mtimeMs)),
      preview: extractClaudePreview(head),
      rolloutPath: candidate.path,
    });
  }
  return sessions;
}

/** Grok names its session group directories with a url-encoded cwd. */
export function grokEncodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "%2F");
}

/** First human turn in a Grok chat history. */
export function extractGrokPreview(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    // Grok tags the turn with `type`, not `role`.
    if (record["type"] !== "user") continue;
    const content = record["content"];
    // Check each part on its own: Grok prepends injected blocks
    // (<system-reminder>, <user_info>) as separate parts of the same turn, so
    // joining them first would poison every preview.
    const texts: string[] =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((part) =>
              typeof part === "object" && part !== null
                ? (readString((part as Record<string, unknown>)["text"]) ?? [])
                : [],
            )
          : [];
    for (const text of texts) {
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      // Grok wraps the human turn in <user_query> tags, so the generic
      // "starts with a tag means injected" rule would discard the one message
      // actually worth showing. Unwrap it explicitly.
      const query = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/.exec(trimmed);
      if (query?.[1]) return truncate(query[1]);
      if (!isInjectedContext(trimmed)) return truncate(trimmed);
    }
  }
  return undefined;
}

/** Resumable Grok sessions under a Grok home. */
export async function discoverGrokSessions(options: {
  readonly grokHome: string;
  readonly cwd?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<ReadonlyArray<DiscoveredAgentSession>> {
  const limit = options.limit ?? 50;
  if (limit <= 0) return [];
  const sessionsRoot = NodePath.join(options.grokHome, "sessions");

  const groupDirs = options.cwd
    ? [NodePath.join(sessionsRoot, grokEncodeCwd(options.cwd))]
    : (await NodeFs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => NodePath.join(sessionsRoot, entry.name));

  const candidates: Array<{ dir: string; sessionId: string; mtimeMs: number }> = [];
  for (const group of groupDirs) {
    const entries = await NodeFs.readdir(group, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = NodePath.join(group, entry.name);
      const stat = await NodeFs.stat(dir).catch(() => undefined);
      candidates.push({ dir, sessionId: entry.name, mtimeMs: stat?.mtimeMs ?? 0 });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const sessions: DiscoveredAgentSession[] = [];
  for (const candidate of candidates) {
    if (sessions.length >= limit) break;
    const head = await readHeadLines(NodePath.join(candidate.dir, "chat_history.jsonl")).catch(
      () => [],
    );
    sessions.push({
      sessionId: candidate.sessionId,
      cwd: options.cwd,
      originator: "grok",
      cliVersion: undefined,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(candidate.mtimeMs)),
      preview: extractGrokPreview(head),
      rolloutPath: candidate.dir,
    });
  }
  return sessions;
}

/**
 * Sessions for one driver, from the home belonging to the selected instance.
 *
 * Unknown drivers return nothing rather than failing, so a provider without
 * on-disk sessions simply shows an empty picker.
 */
export async function discoverAgentSessions(options: {
  readonly driver: string;
  /** Home/config dir of the selected provider instance. */
  readonly home?: string | undefined;
  readonly cwd?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<ReadonlyArray<DiscoveredAgentSession>> {
  const { driver, home, cwd, limit } = options;
  switch (driver) {
    case "codex":
      return discoverCodexSessions({
        ...(home !== undefined ? { codexHome: home } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    case "claudeAgent":
    case "claude":
      return home === undefined
        ? []
        : sortSessionsByRecency(await discoverClaudeSessions({ configDir: home, cwd, limit }));
    case "grok":
      return home === undefined
        ? []
        : sortSessionsByRecency(await discoverGrokSessions({ grokHome: home, cwd, limit }));
    default:
      return [];
  }
}

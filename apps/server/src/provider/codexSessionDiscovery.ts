// @effect-diagnostics nodeBuiltinImport:off
/**
 * Discovery of Codex CLI sessions that already exist on disk.
 *
 * T3 can already resume a Codex thread — `openCodexThread` sends `thread/resume`
 * with a thread id — but the only ids it ever sees are ones it recorded itself in
 * `provider_session_runtime.resume_cursor_json`. A conversation started in the
 * terminal is invisible to the app even though it is the *same* kind of session:
 * both are rollout files under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`,
 * and a T3-created one is tagged `originator: "t3code_desktop"`.
 *
 * This module reads those rollout files so the UI can offer them for resume. It is
 * deliberately split into pure parsers plus one filesystem walk, so the parsing is
 * testable without fixtures on disk.
 */
import * as NodeFs from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** A Codex session found on disk that can be resumed. */
export interface DiscoveredCodexSession {
  /** Codex thread id — the value `thread/resume` expects. */
  readonly sessionId: string;
  /** Working directory the session was started in, when recorded. */
  readonly cwd: string | undefined;
  /** Who created it, e.g. "codex_cli" or "t3code_desktop". */
  readonly originator: string | undefined;
  readonly cliVersion: string | undefined;
  /** ISO timestamp from the session header. */
  readonly startedAt: string | undefined;
  /** First human-authored message, trimmed for display. */
  readonly preview: string | undefined;
  readonly rolloutPath: string;
}

/** Header fields parsed from a rollout's first line. */
export interface CodexRolloutHeader {
  readonly sessionId: string;
  readonly cwd: string | undefined;
  readonly originator: string | undefined;
  readonly cliVersion: string | undefined;
  readonly startedAt: string | undefined;
}

const PREVIEW_MAX_LENGTH = 120;

/**
 * Codex replays injected context as `user` messages: tag blocks like
 * `<recommended_plugins>` / `<environment_context>`, and the repo's AGENTS.md
 * instructions. None of it was typed by a human, so it makes a useless preview
 * (every session in a repo would look identical).
 */
const INJECTED_CONTEXT_PATTERNS: readonly RegExp[] = [
  /^\s*</,
  /^\s*#+\s*AGENTS\.md/i,
  /^\s*<INSTRUCTIONS>/i,
];

function isInjectedContext(text: string): boolean {
  return INJECTED_CONTEXT_PATTERNS.some((pattern) => pattern.test(text));
}

/** `$CODEX_HOME` when set, otherwise `~/.codex`. Mirrors the Codex CLI. */
export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = NodeOS.homedir(),
): string {
  const explicit = env["CODEX_HOME"]?.trim();
  return explicit !== undefined && explicit.length > 0
    ? explicit
    : NodePath.join(homeDir, ".codex");
}

/**
 * Parse a rollout's first line. Returns `undefined` for anything that is not a
 * well-formed `session_meta` carrying an id, so a truncated or partially written
 * file is skipped rather than surfaced as a broken entry.
 */
export function parseRolloutHeader(firstLine: string): CodexRolloutHeader | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "session_meta") return undefined;

  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return undefined;
  const meta = payload as Record<string, unknown>;

  // `id` is the resumable thread id; `session_id` is the same value on current
  // Codex builds but read it as a fallback for older rollouts.
  const sessionId = readString(meta["id"]) ?? readString(meta["session_id"]);
  if (sessionId === undefined) return undefined;

  return {
    sessionId,
    cwd: readString(meta["cwd"]),
    originator: readString(meta["originator"]),
    cliVersion: readString(meta["cli_version"]),
    startedAt: readString(meta["timestamp"]) ?? readString(record["timestamp"]),
  };
}

/**
 * First human-authored message in a rollout, for display. Scans `response_item`
 * user messages and skips Codex's injected context blocks.
 */
export function extractRolloutPreview(lines: readonly string[]): string | undefined {
  let fallback: string | undefined;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated tail line, or a huge injected block that ran past the read
      // window. Keep scanning: the clean user_message event usually follows.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const payload = (parsed as Record<string, unknown>)["payload"];
    if (typeof payload !== "object" || payload === null) continue;
    const message = payload as Record<string, unknown>;

    // Preferred: Codex emits the human turn verbatim as a `user_message` event,
    // without the injected context that pollutes the raw response items.
    if (message["type"] === "user_message") {
      const direct = readString(message["message"]);
      if (direct !== undefined) {
        const trimmed = direct.trim();
        if (trimmed.length > 0 && !isInjectedContext(trimmed)) return truncatePreview(trimmed);
      }
    }

    // Fallback: the raw user response item, skipping injected context.
    if (message["type"] === "message" && message["role"] === "user" && fallback === undefined) {
      const content = message["content"];
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue;
        const text = readString((part as Record<string, unknown>)["text"]);
        if (text === undefined) continue;
        const trimmed = text.trim();
        if (trimmed.length === 0 || isInjectedContext(trimmed)) continue;
        fallback = truncatePreview(trimmed);
        break;
      }
    }
  }

  return fallback;
}

function truncatePreview(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > PREVIEW_MAX_LENGTH
    ? `${singleLine.slice(0, PREVIEW_MAX_LENGTH - 1)}…`
    : singleLine;
}

/** Newest first, using the header timestamp and falling back to the filename. */
export function sortSessionsByRecency(
  sessions: readonly DiscoveredCodexSession[],
): ReadonlyArray<DiscoveredCodexSession> {
  return [...sessions].sort((left, right) => {
    const leftKey = left.startedAt ?? left.rolloutPath;
    const rightKey = right.startedAt ?? right.rolloutPath;
    return rightKey.localeCompare(leftKey);
  });
}

/** Recursively collect `rollout-*.jsonl` paths under `sessionsRoot`. */
async function collectRolloutPaths(sessionsRoot: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    // Unreadable or missing directories simply contribute nothing.
    const entries = await NodeFs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        found.push(full);
      }
    }
  };
  await walk(sessionsRoot);
  return found;
}

/**
 * Read only the head of a rollout. These files grow to the size of a whole
 * conversation, and everything needed for a picker entry is in the first lines.
 */
async function readRolloutHead(path: string, maxLines: number): Promise<string[]> {
  const handle = await NodeFs.open(path, "r");
  try {
    // Injected AGENTS.md/context blocks can be tens of KB on their own, so a small
    // window would stop before the first real human message.
    const buffer = Buffer.alloc(512 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // The final line is almost certainly cut mid-JSON; drop it rather than let it
    // look like a corrupt record.
    if (bytesRead === buffer.length && lines.length > 1) lines.pop();
    return lines.slice(0, maxLines);
  } finally {
    await handle.close();
  }
}

export interface DiscoverCodexSessionsOptions {
  /** Codex home; defaults to `$CODEX_HOME` or `~/.codex`. */
  readonly codexHome?: string;
  /** When set, only sessions started in this directory are returned. */
  readonly cwd?: string;
  /** Maximum entries to return. Defaults to 50. */
  readonly limit?: number;
}

/**
 * Codex sessions available to resume, newest first.
 *
 * Never throws for filesystem problems: a missing Codex home, an unreadable
 * directory, or a half-written rollout yields fewer results rather than an error,
 * because this feeds a picker where a hard failure would be worse than a short list.
 */
export async function discoverCodexSessions(
  options: DiscoverCodexSessionsOptions = {},
): Promise<ReadonlyArray<DiscoveredCodexSession>> {
  const codexHome = options.codexHome ?? resolveCodexHome();
  const limit = options.limit ?? 50;
  if (limit <= 0) return [];

  const paths = await collectRolloutPaths(NodePath.join(codexHome, "sessions"));
  // Filenames lead with an ISO-ish timestamp, so this puts likely-newest first
  // and lets us stop reading early once the limit is satisfied.
  paths.sort((left, right) => right.localeCompare(left));

  const sessions: DiscoveredCodexSession[] = [];
  for (const rolloutPath of paths) {
    if (sessions.length >= limit) break;
    let head: string[];
    try {
      head = await readRolloutHead(rolloutPath, 400);
    } catch {
      continue;
    }
    const firstLine = head[0];
    if (firstLine === undefined) continue;
    const header = parseRolloutHeader(firstLine);
    if (header === undefined) continue;
    if (options.cwd !== undefined && header.cwd !== options.cwd) continue;

    sessions.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      originator: header.originator,
      cliVersion: header.cliVersion,
      startedAt: header.startedAt,
      preview: extractRolloutPreview(head.slice(1)),
      rolloutPath,
    });
  }

  return sortSessionsByRecency(sessions);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Pure rendering helpers for the Discord bridge.
 *
 * Everything in this module is a plain function with no Effect, no I/O and no
 * clock access, so it can be exhaustively unit tested. All of the genuinely
 * fiddly logic (chunk boundaries, code fences spanning a split, surrogate
 * pairs) lives here rather than in the reactor.
 */

/** Discord's hard cap for a normal message body. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Working limit for a planned chunk. The margin leaves room for a synthetic
 * closing fence, a reopening fence with a language tag, and the streaming
 * cursor, none of which exist in the source text.
 */
export const CHUNK_LIMIT = 1900;

/** Appended to a still-streaming message so a reader can tell it is live. */
export const STREAMING_CURSOR = " ▍";

const FENCE_LINE = /^\s{0,3}```(.*)$/;

interface FenceState {
  readonly open: boolean;
  readonly lang: string;
}

const CLOSED: FenceState = { open: false, lang: "" };

/**
 * Fence state after consuming `text`, starting from `initial`.
 *
 * A line whose first non-space run is ``` toggles the fence. The trailing text
 * on an opening fence is the language tag; on a closing fence it is ignored.
 */
export function fenceStateAfter(text: string, initial: FenceState = CLOSED): FenceState {
  let state = initial;
  for (const line of text.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (match === null) {
      continue;
    }
    state = state.open ? CLOSED : { open: true, lang: match[1]?.trim() ?? "" };
  }
  return state;
}

/** True when cutting at `index` would land between the halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Best cut point at or before `limit`, preferring a paragraph break, then a
 * line break, then a space. Falls back to a hard cut that never splits a
 * surrogate pair.
 */
export function splitPointFor(text: string, limit: number): number {
  if (text.length <= limit) {
    return text.length;
  }
  const window = text.slice(0, limit + 1);
  for (const separator of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(separator);
    // Ignore a break so early that we would emit a nearly empty chunk and make
    // no progress on a long unbroken blob.
    if (at > Math.floor(limit * 0.5)) {
      return at + separator.length;
    }
  }
  let hard = limit;
  if (splitsSurrogatePair(text, hard)) {
    hard -= 1;
  }
  return hard;
}

/**
 * Split `text` into Discord-postable chunks.
 *
 * A code fence left open at a chunk boundary is closed at the end of that chunk
 * and reopened with the same language tag at the start of the next, so syntax
 * highlighting survives the split.
 */
export function planChunks(text: string, limit: number = CHUNK_LIMIT): ReadonlyArray<string> {
  if (text.length === 0) {
    return [];
  }
  const chunks: string[] = [];
  let rest = text;
  let carriedFence: FenceState = CLOSED;

  while (rest.length > 0) {
    const prefix = carriedFence.open ? "```" + carriedFence.lang + "\n" : "";
    const budget = limit - prefix.length;
    const cut = splitPointFor(rest, budget);
    const body = rest.slice(0, cut);
    rest = rest.slice(cut);

    const endState = fenceStateAfter(body, carriedFence);
    const needsClose = endState.open && rest.length > 0;
    const suffix = needsClose ? (body.endsWith("\n") ? "```" : "\n```") : "";

    chunks.push(prefix + body + suffix);
    carriedFence = rest.length > 0 ? endState : CLOSED;
  }

  return chunks;
}

/** Append the streaming cursor without pushing the chunk over the hard limit. */
export function withStreamingCursor(chunk: string): string {
  if (chunk.length + STREAMING_CURSOR.length > DISCORD_MESSAGE_LIMIT) {
    return chunk;
  }
  return chunk + STREAMING_CURSOR;
}

/** Discord caps thread names at 100 characters. */
export const DISCORD_THREAD_NAME_LIMIT = 100;

const PLACEHOLDER_TITLES = new Set(["", "new thread", "untitled"]);

export function threadNameFor(input: { title: string; threadId: string }): string {
  const title = input.title.trim();
  if (PLACEHOLDER_TITLES.has(title.toLowerCase())) {
    return `Thread ${input.threadId.slice(0, 8)}`;
  }
  if (title.length <= DISCORD_THREAD_NAME_LIMIT) {
    return title;
  }
  return title.slice(0, DISCORD_THREAD_NAME_LIMIT - 1) + "…";
}

export type HeaderStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error"
  | "unknown";

const STATUS_COLORS: Record<HeaderStatus, number> = {
  idle: 0x5865f2,
  ready: 0x5865f2,
  starting: 0xf59e0b,
  running: 0xf59e0b,
  interrupted: 0xf59e0b,
  stopped: 0x6b7280,
  error: 0xef4444,
  unknown: 0x6b7280,
};

export interface HeaderInput {
  readonly title: string;
  readonly threadId: string;
  readonly model: string;
  /** Provider instance id, e.g. `claudeAgent_work`. */
  readonly instanceId: string;
  /** Human label for the instance, when the settings file supplies one. */
  readonly instanceDisplayName: string | null;
  readonly projectTitle: string | null;
  readonly branch: string | null;
  readonly runtimeMode: string;
  readonly status: HeaderStatus;
  readonly deepLink: string | null;
  readonly createdAt: string;
}

export interface DiscordEmbed {
  readonly title: string;
  readonly url?: string;
  readonly description?: string;
  readonly color: number;
  readonly fields: ReadonlyArray<{ name: string; value: string; inline: boolean }>;
  readonly footer: { text: string };
  readonly timestamp: string;
}

/** `Work (claudeAgent_work)`, or just the id when no display name is configured. */
export function formatAccount(instanceId: string, displayName: string | null): string {
  const label = displayName?.trim();
  return label === undefined || label === "" ? instanceId : `${label} (${instanceId})`;
}

/**
 * `full-access` is the wire value for `bypassPermissions`. Spell that out — it
 * is the single most consequential fact about a thread and should not be
 * hidden behind a slug.
 */
export function formatRuntimeMode(runtimeMode: string): string {
  return runtimeMode === "full-access" ? "full-access (bypasses permissions)" : runtimeMode;
}

export function buildHeaderEmbed(input: HeaderInput): DiscordEmbed {
  const description = [input.projectTitle ?? "(no project)", input.branch ?? "(no branch)"].join(
    " · ",
  );
  return {
    title: threadNameFor({ title: input.title, threadId: input.threadId }),
    ...(input.deepLink === null ? {} : { url: input.deepLink }),
    description,
    color: STATUS_COLORS[input.status] ?? STATUS_COLORS.unknown,
    fields: [
      { name: "Model", value: input.model || "(unset)", inline: true },
      {
        name: "Account",
        value: formatAccount(input.instanceId, input.instanceDisplayName),
        inline: true,
      },
      { name: "Runtime", value: formatRuntimeMode(input.runtimeMode), inline: true },
      { name: "Status", value: input.status, inline: true },
    ],
    footer: { text: "T3 Code" },
    timestamp: input.createdAt,
  };
}

/** Prefix used on injected inbound messages so the outbound side can skip them. */
export const DISCORD_ORIGIN_PREFIX = "discord:";

export function isDiscordOriginatedMessageId(messageId: string): boolean {
  return messageId.startsWith(DISCORD_ORIGIN_PREFIX);
}

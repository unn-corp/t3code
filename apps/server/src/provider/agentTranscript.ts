// @effect-diagnostics nodeBuiltinImport:off
/**
 * Full-transcript reading for `/resume`.
 *
 * `agentSessionDiscovery.ts` reads just enough of each session file to show a
 * preview in the picker. This module reads the whole conversation, so a session
 * started in the terminal can be replayed into a thread.
 *
 * It deliberately does NOT go through the adapters' `readThread`. Only Codex
 * implements that against persisted state (`thread/read`); the Claude and Grok
 * adapters snapshot their own in-memory `context.turns`, which is empty for a
 * session this app never started. The files on disk are the only source that
 * works for all three drivers.
 *
 * Each driver interleaves the conversation with material that is not part of it
 * (tool calls and their results, reasoning/thinking blocks, sub-agent chatter,
 * injected context). Everything here is about keeping the human/assistant text
 * and dropping the rest. Shapes below were taken from real session files.
 */
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { isInjectedContext } from "./agentSessionDiscovery.ts";

export type TranscriptRole = "user" | "assistant";

/** One conversational turn, in the order it appears in the transcript. */
export interface TranscriptTurn {
  readonly role: TranscriptRole;
  readonly text: string;
  /** ISO timestamp when the driver records one. Grok does not. */
  readonly timestamp: string | undefined;
}

/** Default cap on imported turns; the most recent ones are kept. */
export const DEFAULT_MAX_TURNS = 50;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Text of every `text` part in a content array, or the string content itself. */
function readContentText(content: unknown, partType = "text"): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record === undefined) continue;
    // `thinking`, `tool_use` and `tool_result` parts share the array with real
    // message text and must not leak into the transcript.
    if (record["type"] !== partType) continue;
    const text = readString(record["text"]);
    if (text !== undefined) texts.push(text.trim());
  }
  return texts.join("\n\n").trim();
}

/**
 * Grok wraps the human turn in `<user_query>` tags, so the generic "starts with
 * a tag means injected" rule would discard the one message worth keeping.
 */
function unwrapUserQuery(text: string): string {
  const match = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/.exec(text);
  return match?.[1] ?? text;
}

/**
 * Claude: `{type: "user"|"assistant", message: {content}, timestamp}`.
 *
 * Tool results are also recorded as `type: "user"`, and in a real session they
 * dominate: one transcript held 727 of them against 34 genuine human turns. They
 * are distinguished by carrying `toolUseResult`.
 */
export function parseClaudeTranscriptLine(line: string): TranscriptTurn | undefined {
  const record = asRecord(safeParse(line));
  if (record === undefined) return undefined;
  const type = record["type"];
  if (type !== "user" && type !== "assistant") return undefined;
  if (type === "user" && record["toolUseResult"] !== undefined) return undefined;

  const message = asRecord(record["message"]);
  if (message === undefined) return undefined;
  const text = readContentText(message["content"]);
  if (text.length === 0) return undefined;
  if (type === "user" && isInjectedContext(text)) return undefined;

  return { role: type, text, timestamp: readString(record["timestamp"]) };
}

/**
 * Codex: the human turn is `event_msg`/`user_message` and the reply is
 * `event_msg`/`agent_message`, both carrying `payload.message` as a string.
 *
 * The parallel `response_item` records are skipped on purpose: the user ones
 * repeat injected context, and the `agent_message` ones are sub-agent traffic
 * (they carry `author`/`recipient`) rather than the reply shown to the user.
 */
export function parseCodexTranscriptLine(line: string): TranscriptTurn | undefined {
  const record = asRecord(safeParse(line));
  if (record === undefined || record["type"] !== "event_msg") return undefined;
  const payload = asRecord(record["payload"]);
  if (payload === undefined) return undefined;

  const payloadType = payload["type"];
  const role: TranscriptRole | undefined =
    payloadType === "user_message"
      ? "user"
      : payloadType === "agent_message"
        ? "assistant"
        : undefined;
  if (role === undefined) return undefined;

  const text = readString(payload["message"])?.trim();
  if (text === undefined || text.length === 0) return undefined;
  if (role === "user" && isInjectedContext(text)) return undefined;

  return { role, text, timestamp: readString(record["timestamp"]) };
}

/**
 * Grok: `{type: "user"|"assistant", content}`. User content is an array of
 * `text` parts; assistant content is a plain string. Records carry no
 * timestamp, so imported Grok turns have none.
 */
export function parseGrokTranscriptLine(line: string): TranscriptTurn | undefined {
  const record = asRecord(safeParse(line));
  if (record === undefined) return undefined;
  const type = record["type"];
  if (type !== "user" && type !== "assistant") return undefined;

  const text = readContentText(record["content"]).trim();
  if (text.length === 0) return undefined;

  if (type === "user") {
    const unwrapped = unwrapUserQuery(text).trim();
    if (unwrapped.length === 0 || isInjectedContext(unwrapped)) return undefined;
    return { role: "user", text: unwrapped, timestamp: undefined };
  }
  return { role: "assistant", text, timestamp: undefined };
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Line parser for a driver, or undefined when the driver has no transcript. */
export function transcriptLineParser(
  driver: string,
): ((line: string) => TranscriptTurn | undefined) | undefined {
  switch (driver) {
    case "codex":
      return parseCodexTranscriptLine;
    case "claudeAgent":
    case "claude":
      return parseClaudeTranscriptLine;
    case "grok":
      return parseGrokTranscriptLine;
    default:
      return undefined;
  }
}

/**
 * Assistant replies arrive as several records per turn (text split around tool
 * calls), which would render as a stream of fragments. Merge adjacent assistant
 * turns into one message. User turns are left alone: two consecutive human
 * messages are two messages.
 */
export function mergeAdjacentAssistantTurns(
  turns: readonly TranscriptTurn[],
): ReadonlyArray<TranscriptTurn> {
  const merged: TranscriptTurn[] = [];
  for (const turn of turns) {
    const previous = merged[merged.length - 1];
    if (turn.role === "assistant" && previous?.role === "assistant") {
      merged[merged.length - 1] = {
        role: "assistant",
        text: `${previous.text}\n\n${turn.text}`,
        // Keep the first fragment's time: it is when the reply began.
        timestamp: previous.timestamp,
      };
      continue;
    }
    merged.push(turn);
  }
  return merged;
}

/** The file holding the conversation, given what discovery recorded. */
export function transcriptPathFor(driver: string, discoveredPath: string): string {
  // Grok's session id names a directory; the other drivers point at the file.
  return driver === "grok" ? NodePath.join(discoveredPath, "chat_history.jsonl") : discoveredPath;
}

export interface ReadAgentTranscriptOptions {
  readonly driver: string;
  /** `rolloutPath` from discovery: a file, or for Grok a session directory. */
  readonly path: string;
  /** Keep at most this many of the most recent turns. */
  readonly maxTurns?: number;
}

export interface AgentTranscript {
  readonly turns: ReadonlyArray<TranscriptTurn>;
  /** Turns dropped by the cap, so the caller can say so rather than imply completeness. */
  readonly omittedTurnCount: number;
}

/**
 * Read a transcript, keeping the most recent `maxTurns` turns.
 *
 * Streamed line by line and trimmed as it goes: these files reach tens of
 * megabytes (27MB in this workspace), and only the tail is ever imported.
 * Unreadable or malformed files yield no turns rather than throwing, matching
 * discovery, because a hard failure here would block resuming entirely.
 */
export async function readAgentTranscript(
  options: ReadAgentTranscriptOptions,
): Promise<AgentTranscript> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const parse = transcriptLineParser(options.driver);
  if (parse === undefined || maxTurns <= 0) return { turns: [], omittedTurnCount: 0 };

  const path = transcriptPathFor(options.driver, options.path);
  let stream: NodeFs.ReadStream;
  try {
    stream = NodeFs.createReadStream(path, { encoding: "utf8" });
  } catch {
    return { turns: [], omittedTurnCount: 0 };
  }

  // Merging happens before the cap, so a reply split across many records counts
  // as the single turn it is.
  const collected: TranscriptTurn[] = [];
  let seenTurnCount = 0;
  const lines = NodeReadline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      const turn = parse(line);
      if (turn === undefined) continue;
      const previous = collected[collected.length - 1];
      if (turn.role === "assistant" && previous?.role === "assistant") {
        collected[collected.length - 1] = {
          role: "assistant",
          text: `${previous.text}\n\n${turn.text}`,
          timestamp: previous.timestamp,
        };
        continue;
      }
      collected.push(turn);
      seenTurnCount += 1;
      // Hold a little more than the cap so the tail stays correct without
      // keeping the whole conversation in memory.
      if (collected.length > maxTurns * 2) collected.splice(0, collected.length - maxTurns);
    }
  } catch {
    // A truncated or unreadable file still yields whatever parsed cleanly.
  } finally {
    lines.close();
    stream.destroy();
  }

  const turns =
    collected.length > maxTurns ? collected.slice(collected.length - maxTurns) : collected;
  return { turns, omittedTurnCount: Math.max(0, seenTurnCount - turns.length) };
}

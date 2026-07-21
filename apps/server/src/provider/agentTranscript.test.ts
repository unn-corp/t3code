// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeAdjacentAssistantTurns,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  parseGrokTranscriptLine,
  readAgentTranscript,
  transcriptPathFor,
} from "./agentTranscript.ts";

// Fixture shapes mirror real session files, including the parts that must be
// dropped: Claude tool results outnumbered human turns 727 to 34 in one
// transcript, and Codex records sub-agent chatter alongside the real reply.

const claudeUser = (text: string, timestamp = "2026-07-19T22:46:30.683Z"): string =>
  JSON.stringify({ type: "user", timestamp, message: { role: "user", content: text } });

const claudeToolResult = (): string =>
  JSON.stringify({
    type: "user",
    toolUseResult: { stdout: "ok" },
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  });

const claudeAssistant = (parts: ReadonlyArray<Record<string, unknown>>): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-19T22:47:00.000Z",
    message: { role: "assistant", content: parts },
  });

const codexEvent = (type: string, message: string): string =>
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-20T08:05:26.234Z",
    payload: { type, message },
  });

describe("parseClaudeTranscriptLine", () => {
  it("reads a human turn with its timestamp", () => {
    expect(parseClaudeTranscriptLine(claudeUser("Fix the login bug"))).toEqual({
      role: "user",
      text: "Fix the login bug",
      timestamp: "2026-07-19T22:46:30.683Z",
    });
  });

  // Tool results are recorded as `type: "user"` and dominate the file, so
  // treating them as human turns would bury the actual conversation.
  it("drops tool results even though they are typed as user records", () => {
    expect(parseClaudeTranscriptLine(claudeToolResult())).toBeUndefined();
  });

  it("keeps assistant text and drops thinking and tool_use parts", () => {
    const line = claudeAssistant([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Here is the fix" },
      { type: "tool_use", name: "Edit", input: {} },
    ]);
    expect(parseClaudeTranscriptLine(line)?.text).toBe("Here is the fix");
  });

  it("skips injected context, empty content, and malformed lines", () => {
    expect(parseClaudeTranscriptLine(claudeUser("<system-reminder>be nice"))).toBeUndefined();
    expect(
      parseClaudeTranscriptLine(claudeAssistant([{ type: "thinking", thinking: "x" }])),
    ).toBeUndefined();
    expect(parseClaudeTranscriptLine("{not json")).toBeUndefined();
  });
});

describe("parseCodexTranscriptLine", () => {
  it("reads the human turn and the agent reply", () => {
    expect(parseCodexTranscriptLine(codexEvent("user_message", "Ship it"))?.role).toBe("user");
    expect(parseCodexTranscriptLine(codexEvent("agent_message", "Shipped"))).toEqual({
      role: "assistant",
      text: "Shipped",
      timestamp: "2026-07-20T08:05:26.234Z",
    });
  });

  // `response_item` carries injected context for users and sub-agent traffic for
  // agents, so only `event_msg` records are the conversation.
  it("ignores response_item records", () => {
    const responseItem = JSON.stringify({
      type: "response_item",
      payload: { type: "agent_message", author: "sub", content: "internal" },
    });
    expect(parseCodexTranscriptLine(responseItem)).toBeUndefined();
  });

  it("ignores unrelated events and malformed lines", () => {
    expect(parseCodexTranscriptLine(codexEvent("token_count", ""))).toBeUndefined();
    expect(parseCodexTranscriptLine("{bad")).toBeUndefined();
  });
});

describe("parseGrokTranscriptLine", () => {
  it("unwraps the user_query wrapper", () => {
    const line = JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>\nAdd tests\n</user_query>" }],
    });
    expect(parseGrokTranscriptLine(line)).toEqual({
      role: "user",
      text: "Add tests",
      timestamp: undefined,
    });
  });

  it("reads assistant string content and drops tool results", () => {
    expect(
      parseGrokTranscriptLine(JSON.stringify({ type: "assistant", content: "Done" }))?.text,
    ).toBe("Done");
    expect(
      parseGrokTranscriptLine(JSON.stringify({ type: "tool_result", content: "stdout" })),
    ).toBeUndefined();
    expect(
      parseGrokTranscriptLine(JSON.stringify({ type: "reasoning", content: [] })),
    ).toBeUndefined();
  });
});

describe("mergeAdjacentAssistantTurns", () => {
  // A reply is split across records around each tool call; unmerged it renders
  // as a stream of fragments instead of one message.
  it("merges consecutive assistant turns but keeps user turns separate", () => {
    const merged = mergeAdjacentAssistantTurns([
      { role: "user", text: "one", timestamp: "t1" },
      { role: "user", text: "two", timestamp: "t2" },
      { role: "assistant", text: "part a", timestamp: "t3" },
      { role: "assistant", text: "part b", timestamp: "t4" },
    ]);
    expect(merged.map((turn) => turn.text)).toEqual(["one", "two", "part a\n\npart b"]);
    expect(merged[2]?.timestamp).toBe("t3");
  });
});

describe("transcriptPathFor", () => {
  it("appends the chat history file for grok only", () => {
    expect(transcriptPathFor("grok", "/s/abc")).toBe(NodePath.join("/s/abc", "chat_history.jsonl"));
    expect(transcriptPathFor("codex", "/s/rollout.jsonl")).toBe("/s/rollout.jsonl");
  });
});

describe("readAgentTranscript", () => {
  const withFile = async (
    contents: string,
    run: (path: string) => Promise<void>,
    name = "transcript.jsonl",
  ): Promise<void> => {
    const dir = await NodeFs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "transcript-"));
    try {
      const path = NodePath.join(dir, name);
      await NodeFs.writeFile(path, contents);
      await run(path);
    } finally {
      await NodeFs.rm(dir, { recursive: true, force: true });
    }
  };

  it("reads a conversation in order, skipping tool noise", async () => {
    const contents = [
      claudeUser("First question"),
      claudeToolResult(),
      claudeAssistant([{ type: "text", text: "First answer" }]),
      claudeUser("Second question"),
    ].join("\n");
    await withFile(contents, async (path) => {
      const { turns, omittedTurnCount } = await readAgentTranscript({ driver: "claude", path });
      expect(turns.map((turn) => [turn.role, turn.text])).toEqual([
        ["user", "First question"],
        ["assistant", "First answer"],
        ["user", "Second question"],
      ]);
      expect(omittedTurnCount).toBe(0);
    });
  });

  it("keeps the most recent turns and reports what it dropped", async () => {
    const contents = Array.from({ length: 10 }, (_, index) => claudeUser(`message ${index}`)).join(
      "\n",
    );
    await withFile(contents, async (path) => {
      const { turns, omittedTurnCount } = await readAgentTranscript({
        driver: "claude",
        path,
        maxTurns: 3,
      });
      expect(turns.map((turn) => turn.text)).toEqual(["message 7", "message 8", "message 9"]);
      expect(omittedTurnCount).toBe(7);
    });
  });

  it("returns nothing for a missing file, unknown driver, or zero cap", async () => {
    expect((await readAgentTranscript({ driver: "claude", path: "/nope.jsonl" })).turns).toEqual(
      [],
    );
    await withFile(claudeUser("hi"), async (path) => {
      expect((await readAgentTranscript({ driver: "cursor", path })).turns).toEqual([]);
      expect((await readAgentTranscript({ driver: "claude", path, maxTurns: 0 })).turns).toEqual(
        [],
      );
    });
  });

  it("survives a truncated final line", async () => {
    await withFile(`${claudeUser("kept")}\n{"type":"user","mess`, async (path) => {
      const { turns } = await readAgentTranscript({ driver: "claude", path });
      expect(turns.map((turn) => turn.text)).toEqual(["kept"]);
    });
  });
});

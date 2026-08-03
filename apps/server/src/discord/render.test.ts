import { assert, it } from "@effect/vitest";

import {
  buildHeaderEmbed,
  CHUNK_LIMIT,
  DISCORD_MESSAGE_LIMIT,
  fenceStateAfter,
  formatAccount,
  formatRuntimeMode,
  isDiscordOriginatedMessageId,
  planChunks,
  splitPointFor,
  STREAMING_CURSOR,
  threadNameFor,
  withStreamingCursor,
} from "./render.ts";

const headerInput = {
  title: "Wire up the bridge",
  threadId: "thr_0123456789abcdef",
  model: "claude-opus-5",
  instanceId: "claudeAgent_work",
  instanceDisplayName: "Work",
  projectTitle: "Arcwright",
  branch: "feat/discord-bridge",
  runtimeMode: "full-access",
  status: "running" as const,
  deepLink: "https://t3.example/threads/env_1/thr_0123456789abcdef",
  createdAt: "2026-08-02T17:00:00.000Z",
};

it("returns no chunks for empty text", () => {
  assert.deepStrictEqual(planChunks(""), []);
});

it("keeps short text as a single chunk", () => {
  assert.deepStrictEqual(planChunks("hello"), ["hello"]);
});

it("never emits a chunk above Discord's hard limit", () => {
  const text = "x".repeat(12_000);
  for (const chunk of planChunks(text)) {
    assert.isAtMost(chunk.length, DISCORD_MESSAGE_LIMIT);
  }
});

it("round-trips unbroken text across chunks", () => {
  const text = "y".repeat(5_000);
  assert.strictEqual(planChunks(text).join(""), text);
});

it("splits exactly at the limit without losing a character", () => {
  const text = "z".repeat(CHUNK_LIMIT);
  assert.deepStrictEqual(planChunks(text), [text]);

  const overBy1 = "z".repeat(CHUNK_LIMIT + 1);
  const chunks = planChunks(overBy1);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks.join(""), overBy1);
});

it("prefers a paragraph break over a hard cut", () => {
  const head = "a".repeat(CHUNK_LIMIT - 100);
  const text = `${head}\n\n${"b".repeat(500)}`;
  const [first] = planChunks(text);
  assert.strictEqual(first, `${head}\n\n`);
});

it("does not split a surrogate pair", () => {
  // Emoji are surrogate pairs in UTF-16; a naive slice would emit a lone half.
  const text = "😀".repeat(CHUNK_LIMIT);
  for (const chunk of planChunks(text)) {
    assert.isFalse(/[\uD800-\uDBFF]$/.test(chunk), "chunk ended on a high surrogate");
    assert.isFalse(/^[\uDC00-\uDFFF]/.test(chunk), "chunk began on a low surrogate");
  }
});

it("tracks fence state across a body", () => {
  assert.deepStrictEqual(fenceStateAfter("no fences here"), { open: false, lang: "" });
  assert.deepStrictEqual(fenceStateAfter("```ts\nconst a = 1;"), { open: true, lang: "ts" });
  assert.deepStrictEqual(fenceStateAfter("```ts\nconst a = 1;\n```"), { open: false, lang: "" });
});

it("closes and reopens a code fence that spans a split", () => {
  const body = "const value = 1;\n".repeat(300);
  const chunks = planChunks("```ts\n" + body + "```");
  assert.isAbove(chunks.length, 1);

  const [first, second] = chunks;
  assert.isTrue(first!.endsWith("```"), "first chunk must close the open fence");
  assert.isTrue(second!.startsWith("```ts\n"), "next chunk must reopen with the language tag");

  // Every chunk must be independently balanced so Discord renders each one.
  for (const chunk of chunks) {
    const fences = chunk.split("\n").filter((line) => /^\s{0,3}```/.test(line)).length;
    assert.strictEqual(fences % 2, 0, `unbalanced fences in chunk: ${chunk.slice(0, 40)}`);
  }
});

it("does not append a closing fence to the final chunk", () => {
  const chunks = planChunks("```ts\nconst a = 1;\n```\ntrailing prose");
  assert.strictEqual(chunks.length, 1);
  assert.isTrue(chunks[0]!.endsWith("trailing prose"));
});

it("adds the streaming cursor only when it fits", () => {
  assert.strictEqual(withStreamingCursor("abc"), "abc" + STREAMING_CURSOR);
  const full = "x".repeat(DISCORD_MESSAGE_LIMIT);
  assert.strictEqual(withStreamingCursor(full), full);
});

it("falls back to a short id for placeholder titles", () => {
  assert.strictEqual(
    threadNameFor({ title: "New thread", threadId: "thr_0123456789" }),
    "Thread thr_0123",
  );
  assert.strictEqual(threadNameFor({ title: "", threadId: "thr_0123456789" }), "Thread thr_0123");
});

it("truncates long thread names to Discord's limit", () => {
  const name = threadNameFor({ title: "t".repeat(300), threadId: "thr_1" });
  assert.strictEqual(name.length, 100);
  assert.isTrue(name.endsWith("…"));
});

it("formats the account with and without a display name", () => {
  assert.strictEqual(formatAccount("claudeAgent_work", "Work"), "Work (claudeAgent_work)");
  assert.strictEqual(formatAccount("cursor", null), "cursor");
  assert.strictEqual(formatAccount("cursor", "  "), "cursor");
});

it("spells out that full-access bypasses permissions", () => {
  assert.strictEqual(formatRuntimeMode("full-access"), "full-access (bypasses permissions)");
  assert.strictEqual(formatRuntimeMode("auto"), "auto");
});

it("renders a header embed with model, account and runtime", () => {
  const embed = buildHeaderEmbed(headerInput);
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.strictEqual(byName.Model, "claude-opus-5");
  assert.strictEqual(byName.Account, "Work (claudeAgent_work)");
  assert.strictEqual(byName.Runtime, "full-access (bypasses permissions)");
  assert.strictEqual(byName.Status, "running");
  assert.strictEqual(embed.description, "Arcwright · feat/discord-bridge");
  assert.strictEqual(embed.url, headerInput.deepLink);
});

it("renders a header before the worktree has a branch", () => {
  // thread.branch is null at thread.created time — the header must still render.
  const embed = buildHeaderEmbed({ ...headerInput, branch: null, projectTitle: null });
  assert.strictEqual(embed.description, "(no project) · (no branch)");
});

it("omits the url when no deep link is configured", () => {
  const embed = buildHeaderEmbed({ ...headerInput, deepLink: null });
  assert.isUndefined(embed.url);
});

it("recognises messages this bridge injected", () => {
  assert.isTrue(isDiscordOriginatedMessageId("discord:1533593019079463064"));
  assert.isFalse(isDiscordOriginatedMessageId("msg_abc"));
});

it("keeps splitPointFor within budget", () => {
  const text = "word ".repeat(1000);
  const at = splitPointFor(text, 100);
  assert.isAtMost(at, 101);
  assert.isAbove(at, 0);
});

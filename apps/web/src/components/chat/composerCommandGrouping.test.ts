import { describe, expect, it } from "vite-plus/test";

import { type ComposerCommandItem, groupCommandItems } from "./ComposerCommandMenu";

const slashItem = (command: string): ComposerCommandItem => ({
  id: `slash:${command}`,
  type: "slash-command",
  command: command as ComposerCommandItem extends { command: infer C } ? C : never,
  label: `/${command}`,
  description: "",
});

const sessionItem = (sessionId: string): ComposerCommandItem => ({
  id: `codex-session:${sessionId}`,
  type: "codex-session",
  sessionId,
  label: "Fix the login bug",
  description: "from the terminal",
});

const allItemIds = (groups: ReturnType<typeof groupCommandItems>): string[] =>
  groups.flatMap((group) => group.items.map((item) => item.id));

describe("groupCommandItems", () => {
  // The /resume session list is reached from the slash-command trigger, and
  // grouping is on whenever the query is empty (typing "/" and clicking
  // /resume). This branch previously kept only slash-command and
  // provider-slash-command items, so every conversation was silently dropped
  // and the picker rendered nothing.
  it("keeps session rows when slash sections are grouped", () => {
    const groups = groupCommandItems(
      [slashItem("model"), sessionItem("abc"), sessionItem("def")],
      "slash-command",
      true,
    );

    expect(allItemIds(groups)).toContain("codex-session:abc");
    expect(allItemIds(groups)).toContain("codex-session:def");
    expect(groups.find((group) => group.id === "sessions")?.label).toBe("Conversations");
  });

  it("keeps session rows when sections are not grouped", () => {
    const groups = groupCommandItems([sessionItem("abc")], "slash-command", false);
    expect(allItemIds(groups)).toEqual(["codex-session:abc"]);
  });

  it("still groups commands when no sessions are present", () => {
    const groups = groupCommandItems([slashItem("model")], "slash-command", true);
    expect(groups.map((group) => group.id)).toEqual(["built-in"]);
  });
});

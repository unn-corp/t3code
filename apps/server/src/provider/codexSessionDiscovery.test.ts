// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  discoverCodexSessions,
  extractRolloutPreview,
  parseRolloutHeader,
  resolveCodexHome,
  sortSessionsByRecency,
} from "./codexSessionDiscovery.ts";

const SESSION_ID = "019f830c-68b1-7860-a771-aed585bb9579";

const sessionMetaLine = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    timestamp: "2026-07-21T05:00:56.940Z",
    type: "session_meta",
    payload: {
      session_id: SESSION_ID,
      id: SESSION_ID,
      timestamp: "2026-07-21T05:00:56.940Z",
      cwd: "/home/dev/proj",
      originator: "codex_cli",
      cli_version: "0.144.6",
      ...overrides,
    },
  });

const userMessageLine = (text: string): string =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });

describe("resolveCodexHome", () => {
  it("prefers CODEX_HOME when set", () => {
    expect(resolveCodexHome({ CODEX_HOME: "/custom/codex" }, "/home/dev")).toBe("/custom/codex");
  });

  it("falls back to ~/.codex when unset or blank", () => {
    expect(resolveCodexHome({}, "/home/dev")).toBe(NodePath.join("/home/dev", ".codex"));
    expect(resolveCodexHome({ CODEX_HOME: "   " }, "/home/dev")).toBe(
      NodePath.join("/home/dev", ".codex"),
    );
  });
});

describe("parseRolloutHeader", () => {
  it("reads the resumable id and metadata", () => {
    const header = parseRolloutHeader(sessionMetaLine());
    expect(header?.sessionId).toBe(SESSION_ID);
    expect(header?.cwd).toBe("/home/dev/proj");
    expect(header?.originator).toBe("codex_cli");
    expect(header?.cliVersion).toBe("0.144.6");
    expect(header?.startedAt).toBe("2026-07-21T05:00:56.940Z");
  });

  it("falls back to session_id when id is absent", () => {
    const line = JSON.stringify({
      type: "session_meta",
      payload: { session_id: SESSION_ID, cwd: "/x" },
    });
    expect(parseRolloutHeader(line)?.sessionId).toBe(SESSION_ID);
  });

  // A rollout is appended to while a session runs, so a partially written or
  // non-header first line must be skipped rather than surfaced as a broken entry.
  it("returns undefined for malformed, non-meta, or id-less lines", () => {
    expect(parseRolloutHeader("{not json")).toBeUndefined();
    expect(parseRolloutHeader(JSON.stringify({ type: "event_msg", payload: {} }))).toBeUndefined();
    expect(
      parseRolloutHeader(JSON.stringify({ type: "session_meta", payload: { cwd: "/x" } })),
    ).toBeUndefined();
    expect(parseRolloutHeader("")).toBeUndefined();
  });
});

describe("extractRolloutPreview", () => {
  it("returns the first human-authored message", () => {
    expect(extractRolloutPreview([userMessageLine("Fix the login bug")])).toBe("Fix the login bug");
  });

  // Codex injects <recommended_plugins>/<environment_context> as `user` messages.
  // Showing those as the preview would make every session look identical.
  it("skips injected context blocks and finds the real message", () => {
    const lines = [
      userMessageLine("<recommended_plugins>\nHere is a list of plugins…"),
      userMessageLine("Test"),
    ];
    expect(extractRolloutPreview(lines)).toBe("Test");
  });

  it("ignores assistant messages and unparsable lines", () => {
    const assistant = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(extractRolloutPreview(["{bad", assistant])).toBeUndefined();
  });

  it("truncates long messages", () => {
    const preview = extractRolloutPreview([userMessageLine("x".repeat(400))]);
    expect(preview).toHaveLength(120);
    expect(preview?.endsWith("…")).toBe(true);
  });
});

describe("sortSessionsByRecency", () => {
  it("orders newest first", () => {
    const make = (id: string, startedAt: string | undefined) => ({
      sessionId: id,
      cwd: undefined,
      originator: undefined,
      cliVersion: undefined,
      startedAt,
      preview: undefined,
      rolloutPath: `/r/${id}.jsonl`,
    });
    const sorted = sortSessionsByRecency([
      make("old", "2026-07-01T00:00:00.000Z"),
      make("new", "2026-07-21T00:00:00.000Z"),
    ]);
    expect(sorted.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });
});

describe("discoverCodexSessions", () => {
  const withTempCodexHome = async (
    build: (sessionsDir: string) => Promise<void>,
    run: (codexHome: string) => Promise<void>,
  ): Promise<void> => {
    const codexHome = await NodeFs.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-discovery-"));
    try {
      const sessionsDir = NodePath.join(codexHome, "sessions", "2026", "07", "21");
      await NodeFs.mkdir(sessionsDir, { recursive: true });
      await build(sessionsDir);
      await run(codexHome);
    } finally {
      await NodeFs.rm(codexHome, { recursive: true, force: true });
    }
  };

  it("finds a rollout and reports its resumable id and preview", async () => {
    await withTempCodexHome(
      async (dir) => {
        await NodeFs.writeFile(
          NodePath.join(dir, `rollout-2026-07-21T01-00-56-${SESSION_ID}.jsonl`),
          [sessionMetaLine(), userMessageLine("Test")].join("\n"),
        );
      },
      async (codexHome) => {
        const sessions = await discoverCodexSessions({ codexHome });
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.sessionId).toBe(SESSION_ID);
        expect(sessions[0]?.preview).toBe("Test");
        expect(sessions[0]?.originator).toBe("codex_cli");
      },
    );
  });

  it("filters by cwd so a picker only offers this project's sessions", async () => {
    await withTempCodexHome(
      async (dir) => {
        await NodeFs.writeFile(
          NodePath.join(dir, `rollout-2026-07-21T01-00-00-${SESSION_ID}.jsonl`),
          sessionMetaLine({ cwd: "/home/dev/proj" }),
        );
        await NodeFs.writeFile(
          NodePath.join(dir, "rollout-2026-07-21T02-00-00-other.jsonl"),
          sessionMetaLine({ id: "other-id", cwd: "/home/dev/elsewhere" }),
        );
      },
      async (codexHome) => {
        const scoped = await discoverCodexSessions({ codexHome, cwd: "/home/dev/proj" });
        expect(scoped.map((s) => s.sessionId)).toEqual([SESSION_ID]);
        expect(await discoverCodexSessions({ codexHome })).toHaveLength(2);
      },
    );
  });

  it("skips unparsable rollouts instead of failing the whole listing", async () => {
    await withTempCodexHome(
      async (dir) => {
        await NodeFs.writeFile(NodePath.join(dir, "rollout-2026-07-21T03-00-00-bad.jsonl"), "{bad");
        await NodeFs.writeFile(
          NodePath.join(dir, `rollout-2026-07-21T01-00-00-${SESSION_ID}.jsonl`),
          sessionMetaLine(),
        );
      },
      async (codexHome) => {
        const sessions = await discoverCodexSessions({ codexHome });
        expect(sessions.map((s) => s.sessionId)).toEqual([SESSION_ID]);
      },
    );
  });

  it("returns an empty list when the codex home does not exist", async () => {
    expect(await discoverCodexSessions({ codexHome: "/nonexistent/codex/home" })).toEqual([]);
  });

  it("honours the limit", async () => {
    await withTempCodexHome(
      async (dir) => {
        for (let index = 0; index < 5; index += 1) {
          await NodeFs.writeFile(
            NodePath.join(dir, `rollout-2026-07-21T0${index}-00-00-id${index}.jsonl`),
            sessionMetaLine({ id: `id${index}` }),
          );
        }
      },
      async (codexHome) => {
        expect(await discoverCodexSessions({ codexHome, limit: 2 })).toHaveLength(2);
        expect(await discoverCodexSessions({ codexHome, limit: 0 })).toEqual([]);
      },
    );
  });
});

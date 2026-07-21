import * as Schema from "effect/Schema";

/**
 * A Codex session that already exists on disk and can be resumed.
 *
 * These come from `$CODEX_HOME/sessions/**\/rollout-*.jsonl`. Sessions started
 * in the terminal and sessions started by this app are the same kind of record;
 * `originator` distinguishes them (e.g. "codex-tui" vs "t3code_desktop").
 */
export const DiscoveredCodexSession = Schema.Struct({
  /** Codex thread id, i.e. the value `thread/resume` expects. */
  sessionId: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  originator: Schema.optionalKey(Schema.String),
  cliVersion: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
  /** First human-authored message, for display in a picker. */
  preview: Schema.optionalKey(Schema.String),
});

export const CodexSessionsListInput = Schema.Struct({
  /**
   * Provider instance whose sessions to list. Determines both the driver
   * (codex / claudeAgent / grok) and the home directory, so "the Claude account
   * currently selected" resolves to that instance's config dir.
   */
  providerInstanceId: Schema.optionalKey(Schema.String),
  /** Restrict to sessions started in this directory. */
  cwd: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
});

export const CodexSessionsListResult = Schema.Struct({
  sessions: Schema.Array(DiscoveredCodexSession),
});

/**
 * Rebind a thread to a Codex session that already exists on disk.
 *
 * The server stores the id as the thread's resume cursor. The next provider
 * start routes through the same `thread/resume` path the app already uses for
 * its own sessions, so a conversation begun in the terminal continues here.
 */
export const CodexSessionsResumeInput = Schema.Struct({
  threadId: Schema.String,
  /** Driver the session belongs to; selects the resume-cursor shape. */
  driver: Schema.optionalKey(Schema.String),
  /** Codex thread id, from `codexSessions.list`. */
  sessionId: Schema.String,
});

export const CodexSessionsResumeResult = Schema.Struct({
  bound: Schema.Boolean,
});

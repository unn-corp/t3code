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
  /** Restrict to sessions started in this directory. */
  cwd: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
});

export const CodexSessionsListResult = Schema.Struct({
  sessions: Schema.Array(DiscoveredCodexSession),
});

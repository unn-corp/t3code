import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * A Codex session that already exists on disk.
 *
 * The composer's `/resume` command lists these so a conversation started in the
 * terminal can be continued in the app. Sessions started here and sessions
 * started by `codex` are the same kind of record; `originator` tells them apart.
 */
export interface CodexSessionOption {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly originator?: string;
  readonly startedAt?: string;
  readonly preview?: string;
}

export const codexSessions = {
  /** Codex sessions available to resume. */
  list: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:codex-sessions:list",
    tag: WS_METHODS.codexSessionsList,
  }),
  /**
   * Point a thread at an existing Codex session. The server persists the id as
   * the thread's resume cursor, so the next turn resumes that conversation
   * through the same `thread/resume` path the app uses for its own sessions.
   */
  resume: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:codex-sessions:resume",
    tag: WS_METHODS.codexSessionsResume,
  }),
};

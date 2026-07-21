import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";

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

/**
 * Codex sessions available to resume for an environment.
 *
 * Yields an empty list rather than failing: this feeds a picker, where an error
 * dialog is worse than an empty menu.
 */
export const codexSessions = {
  list: connectionAtomRuntime.fn(
    Effect.fn("CodexSessions.list")(function* (target: {
      readonly environmentId: EnvironmentId;
      readonly cwd?: string | undefined;
      readonly limit?: number | undefined;
    }) {
      const registry = yield* EnvironmentRegistry;
      const result = yield* registry
        .run(
          target.environmentId,
          request(WS_METHODS.codexSessionsList, {
            ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
            ...(target.limit !== undefined ? { limit: target.limit } : {}),
          }),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not list Codex sessions to resume.").pipe(
              Effect.annotateLogs({ cause: String(error) }),
              Effect.as({ sessions: [] as ReadonlyArray<CodexSessionOption> }),
            ),
          ),
        );
      return result.sessions as ReadonlyArray<CodexSessionOption>;
    }),
  ),

  /**
   * Point a thread at an existing Codex session. The server persists the id as
   * the thread's resume cursor, so the next turn resumes that conversation
   * through the same `thread/resume` path the app uses for its own sessions.
   */
  resume: connectionAtomRuntime.fn(
    Effect.fn("CodexSessions.resume")(function* (target: {
      readonly environmentId: EnvironmentId;
      readonly threadId: string;
      readonly sessionId: string;
    }) {
      const registry = yield* EnvironmentRegistry;
      return yield* registry.run(
        target.environmentId,
        request(WS_METHODS.codexSessionsResume, {
          threadId: target.threadId,
          sessionId: target.sessionId,
        }),
      );
    }),
  ),
};

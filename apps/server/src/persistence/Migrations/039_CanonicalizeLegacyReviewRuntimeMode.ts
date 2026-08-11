import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const LEGACY_REVIEW_RUNTIME_MODE = "automated-review";
const FULL_ACCESS_RUNTIME_MODE = "full-access";

/**
 * The retired review scheduler persisted `automated-review`, which was not a
 * full-access mode in the Codex adapter. Review threads are read-only by
 * prompt, so their execution policy must still be full access and must never
 * depend on an approval prompt.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A legacy review may have been left with an approval request when the
  // process stopped. It is no longer actionable once the review is resumed
  // in full-access mode; keep approvals belonging to ordinary user threads.
  yield* sql`
    DELETE FROM projection_pending_approvals
    WHERE thread_id IN (
      SELECT thread_id
      FROM projection_threads
      WHERE runtime_mode = ${LEGACY_REVIEW_RUNTIME_MODE}
      UNION
      SELECT thread_id
      FROM projection_thread_sessions
      WHERE runtime_mode = ${LEGACY_REVIEW_RUNTIME_MODE}
      UNION
      SELECT thread_id
      FROM provider_session_runtime
      WHERE runtime_mode = ${LEGACY_REVIEW_RUNTIME_MODE}
    )
  `;

  yield* sql`
    UPDATE projection_threads
    SET runtime_mode = ${FULL_ACCESS_RUNTIME_MODE}
    WHERE runtime_mode = ${LEGACY_REVIEW_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET runtime_mode = ${FULL_ACCESS_RUNTIME_MODE}
    WHERE runtime_mode = ${LEGACY_REVIEW_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE provider_session_runtime
    SET runtime_mode = ${FULL_ACCESS_RUNTIME_MODE}
    WHERE runtime_mode = ${LEGACY_REVIEW_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.runtimeMode',
      ${FULL_ACCESS_RUNTIME_MODE}
    )
    WHERE json_extract(payload_json, '$.runtimeMode') = ${LEGACY_REVIEW_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.session.runtimeMode',
      ${FULL_ACCESS_RUNTIME_MODE}
    )
    WHERE json_extract(payload_json, '$.session.runtimeMode') = ${LEGACY_REVIEW_RUNTIME_MODE}
  `;

  yield* sql`
    UPDATE projection_threads
    SET pending_approval_count = (
      SELECT COUNT(*)
      FROM projection_pending_approvals
      WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
        AND projection_pending_approvals.status = 'pending'
    )
  `;
});

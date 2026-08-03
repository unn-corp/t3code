import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs threads whose `latest_turn_id` was cleared when their turn ended.
 *
 * `thread.session-set` used to write `session.activeTurnId` straight through,
 * and that id is null for every non-running status — so the turn-end event
 * unjoined the completed turn from the thread shell. The sidebar reads
 * `latestTurn` through that join, so affected rows lost their "Completed"
 * pill and their settled timestamp. Claude threads mostly escaped it because
 * their checkpoint `thread.turn-diff-completed` lands right after the
 * turn-end event and rewrote the column; Codex streams its turn diff mid-turn
 * (restore before the clear) and Grok's next-turn "starting" cleared it again,
 * so those threads were left blank.
 *
 * The projection is not rebuilt from the event log on upgrade, so point the
 * column back at each thread's most recent real turn. Imported turns are
 * excluded: the live path never makes them the latest turn either.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT turn.turn_id
      FROM projection_turns AS turn
      WHERE turn.thread_id = projection_threads.thread_id
        AND turn.turn_id IS NOT NULL
        AND turn.turn_id NOT LIKE 'import:%'
      ORDER BY turn.requested_at DESC, turn.row_id DESC
      LIMIT 1
    )
    WHERE latest_turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns AS turn
        WHERE turn.thread_id = projection_threads.thread_id
          AND turn.turn_id IS NOT NULL
          AND turn.turn_id NOT LIKE 'import:%'
      )
  `;
});

import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Bridge-owned external state. Deliberately NOT a projection: a Discord thread
  // id is the result of a remote side effect that cannot be replayed, so a
  // projection rebuild would either orphan every link or duplicate every thread.
  yield* sql`
    CREATE TABLE IF NOT EXISTS discord_bridge_threads (
      thread_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      discord_thread_id TEXT NOT NULL UNIQUE,
      header_message_id TEXT NOT NULL,
      last_seen_discord_message_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_discord_bridge_threads_state
    ON discord_bridge_threads(state)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_discord_bridge_threads_discord_thread
    ON discord_bridge_threads(discord_thread_id)
  `;

  // One row per published Discord message chunk. `published_length` only advances
  // on a confirmed write, so a failed flush is retried from the last good offset.
  // `frozen` marks a chunk that is full and must never be edited again, which is
  // what bounds the edit rate for long assistant messages.
  yield* sql`
    CREATE TABLE IF NOT EXISTS discord_bridge_messages (
      message_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      discord_thread_id TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      published_length INTEGER NOT NULL DEFAULT 0,
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, chunk_index)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_discord_bridge_messages_thread
    ON discord_bridge_messages(thread_id)
  `;
});

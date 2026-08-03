import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type DiscordBridgeRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const DiscordBridgeThreadState = Schema.Literals(["active", "archived", "orphaned"]);
export type DiscordBridgeThreadState = typeof DiscordBridgeThreadState.Type;

export const DiscordBridgeThreadRecord = Schema.Struct({
  threadId: Schema.String,
  guildId: Schema.String,
  channelId: Schema.String,
  discordThreadId: Schema.String,
  headerMessageId: Schema.String,
  lastSeenDiscordMessageId: Schema.NullOr(Schema.String),
  state: DiscordBridgeThreadState,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type DiscordBridgeThreadRecord = typeof DiscordBridgeThreadRecord.Type;

export const LinkDiscordThreadInput = Schema.Struct({
  threadId: Schema.String,
  guildId: Schema.String,
  channelId: Schema.String,
  discordThreadId: Schema.String,
  headerMessageId: Schema.String,
  lastSeenDiscordMessageId: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
});
export type LinkDiscordThreadInput = typeof LinkDiscordThreadInput.Type;

export const SetDiscordThreadStateInput = Schema.Struct({
  threadId: Schema.String,
  state: DiscordBridgeThreadState,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type SetDiscordThreadStateInput = typeof SetDiscordThreadStateInput.Type;

export const SetLastSeenDiscordMessageInput = Schema.Struct({
  threadId: Schema.String,
  lastSeenDiscordMessageId: Schema.String,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type SetLastSeenDiscordMessageInput = typeof SetLastSeenDiscordMessageInput.Type;

export const DiscordBridgeMessageRecord = Schema.Struct({
  messageId: Schema.String,
  chunkIndex: Schema.Number,
  threadId: Schema.String,
  discordThreadId: Schema.String,
  discordMessageId: Schema.String,
  publishedLength: Schema.Number,
  frozen: Schema.Boolean,
});
export type DiscordBridgeMessageRecord = typeof DiscordBridgeMessageRecord.Type;

export const UpsertDiscordMessageChunkInput = Schema.Struct({
  messageId: Schema.String,
  chunkIndex: Schema.Number,
  threadId: Schema.String,
  discordThreadId: Schema.String,
  discordMessageId: Schema.String,
  publishedLength: Schema.Number,
  frozen: Schema.Boolean,
  now: Schema.DateTimeUtcFromString,
});
export type UpsertDiscordMessageChunkInput = typeof UpsertDiscordMessageChunkInput.Type;

const DiscordBridgeThreadRawDbRow = Schema.Struct({
  threadId: Schema.String,
  guildId: Schema.Unknown,
  channelId: Schema.Unknown,
  discordThreadId: Schema.Unknown,
  headerMessageId: Schema.Unknown,
  lastSeenDiscordMessageId: Schema.Unknown,
  state: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

const DiscordBridgeMessageRawDbRow = Schema.Struct({
  messageId: Schema.String,
  chunkIndex: Schema.Unknown,
  threadId: Schema.Unknown,
  discordThreadId: Schema.Unknown,
  discordMessageId: Schema.Unknown,
  publishedLength: Schema.Unknown,
  frozen: Schema.Unknown,
});

const decodeThreadRow = Schema.decodeUnknownEffect(DiscordBridgeThreadRecord);

/**
 * SQLite has no boolean type, so `frozen` comes back as 0/1. Decode it as a
 * number and widen to a boolean in plain TypeScript rather than reaching for a
 * schema transform, which this Effect beta does not expose.
 */
const DiscordBridgeMessageDbShape = Schema.Struct({
  messageId: Schema.String,
  chunkIndex: Schema.Number,
  threadId: Schema.String,
  discordThreadId: Schema.String,
  discordMessageId: Schema.String,
  publishedLength: Schema.Number,
  frozen: Schema.Number,
});

const decodeMessageRow = Schema.decodeUnknownEffect(DiscordBridgeMessageDbShape);

const toMessageRecord = (
  row: typeof DiscordBridgeMessageDbShape.Type,
): DiscordBridgeMessageRecord => ({
  messageId: row.messageId,
  chunkIndex: row.chunkIndex,
  threadId: row.threadId,
  discordThreadId: row.discordThreadId,
  discordMessageId: row.discordMessageId,
  publishedLength: row.publishedLength,
  frozen: row.frozen !== 0,
});

export class DiscordBridgeLinkRepository extends Context.Service<
  DiscordBridgeLinkRepository,
  {
    readonly link: (
      input: LinkDiscordThreadInput,
    ) => Effect.Effect<void, DiscordBridgeRepositoryError>;
    readonly getByThreadId: (
      threadId: string,
    ) => Effect.Effect<Option.Option<DiscordBridgeThreadRecord>, DiscordBridgeRepositoryError>;
    readonly getByDiscordThreadId: (
      discordThreadId: string,
    ) => Effect.Effect<Option.Option<DiscordBridgeThreadRecord>, DiscordBridgeRepositoryError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<DiscordBridgeThreadRecord>,
      DiscordBridgeRepositoryError
    >;
    readonly setState: (
      input: SetDiscordThreadStateInput,
    ) => Effect.Effect<void, DiscordBridgeRepositoryError>;
    readonly setLastSeen: (
      input: SetLastSeenDiscordMessageInput,
    ) => Effect.Effect<void, DiscordBridgeRepositoryError>;
    readonly listChunks: (
      messageId: string,
    ) => Effect.Effect<ReadonlyArray<DiscordBridgeMessageRecord>, DiscordBridgeRepositoryError>;
    readonly upsertChunk: (
      input: UpsertDiscordMessageChunkInput,
    ) => Effect.Effect<void, DiscordBridgeRepositoryError>;
  }
>()("t3/persistence/DiscordBridgeLinks/DiscordBridgeLinkRepository") {}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): DiscordBridgeRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertLink = SqlSchema.void({
    Request: LinkDiscordThreadInput,
    execute: (input) =>
      sql`
        INSERT INTO discord_bridge_threads (
          thread_id,
          guild_id,
          channel_id,
          discord_thread_id,
          header_message_id,
          last_seen_discord_message_id,
          state,
          created_at,
          updated_at
        )
        VALUES (
          ${input.threadId},
          ${input.guildId},
          ${input.channelId},
          ${input.discordThreadId},
          ${input.headerMessageId},
          ${input.lastSeenDiscordMessageId},
          'active',
          ${input.createdAt},
          ${input.createdAt}
        )
        ON CONFLICT(thread_id) DO NOTHING
      `,
  });

  const selectByThreadId = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: DiscordBridgeThreadRawDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          guild_id AS "guildId",
          channel_id AS "channelId",
          discord_thread_id AS "discordThreadId",
          header_message_id AS "headerMessageId",
          last_seen_discord_message_id AS "lastSeenDiscordMessageId",
          state AS "state",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM discord_bridge_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const selectByDiscordThreadId = SqlSchema.findOneOption({
    Request: Schema.Struct({ discordThreadId: Schema.String }),
    Result: DiscordBridgeThreadRawDbRow,
    execute: ({ discordThreadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          guild_id AS "guildId",
          channel_id AS "channelId",
          discord_thread_id AS "discordThreadId",
          header_message_id AS "headerMessageId",
          last_seen_discord_message_id AS "lastSeenDiscordMessageId",
          state AS "state",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM discord_bridge_threads
        WHERE discord_thread_id = ${discordThreadId}
      `,
  });

  const selectActive = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: DiscordBridgeThreadRawDbRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          guild_id AS "guildId",
          channel_id AS "channelId",
          discord_thread_id AS "discordThreadId",
          header_message_id AS "headerMessageId",
          last_seen_discord_message_id AS "lastSeenDiscordMessageId",
          state AS "state",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM discord_bridge_threads
        WHERE state = 'active'
        ORDER BY updated_at DESC
      `,
  });

  const updateState = SqlSchema.void({
    Request: SetDiscordThreadStateInput,
    execute: ({ threadId, state, updatedAt }) =>
      sql`UPDATE discord_bridge_threads SET state = ${state}, updated_at = ${updatedAt} WHERE thread_id = ${threadId}`,
  });

  const updateLastSeen = SqlSchema.void({
    Request: SetLastSeenDiscordMessageInput,
    execute: ({ threadId, lastSeenDiscordMessageId, updatedAt }) =>
      sql`
        UPDATE discord_bridge_threads
        SET last_seen_discord_message_id = ${lastSeenDiscordMessageId}, updated_at = ${updatedAt}
        WHERE thread_id = ${threadId}
      `,
  });

  const selectChunks = SqlSchema.findAll({
    Request: Schema.Struct({ messageId: Schema.String }),
    Result: DiscordBridgeMessageRawDbRow,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          chunk_index AS "chunkIndex",
          thread_id AS "threadId",
          discord_thread_id AS "discordThreadId",
          discord_message_id AS "discordMessageId",
          published_length AS "publishedLength",
          frozen AS "frozen"
        FROM discord_bridge_messages
        WHERE message_id = ${messageId}
        ORDER BY chunk_index ASC
      `,
  });

  const upsertChunkRow = SqlSchema.void({
    Request: UpsertDiscordMessageChunkInput,
    execute: (input) =>
      sql`
        INSERT INTO discord_bridge_messages (
          message_id,
          chunk_index,
          thread_id,
          discord_thread_id,
          discord_message_id,
          published_length,
          frozen,
          created_at,
          updated_at
        )
        VALUES (
          ${input.messageId},
          ${input.chunkIndex},
          ${input.threadId},
          ${input.discordThreadId},
          ${input.discordMessageId},
          ${input.publishedLength},
          ${input.frozen ? 1 : 0},
          ${input.now},
          ${input.now}
        )
        ON CONFLICT(message_id, chunk_index) DO UPDATE SET
          discord_message_id = excluded.discord_message_id,
          published_length = excluded.published_length,
          frozen = excluded.frozen,
          updated_at = excluded.updated_at
      `,
  });

  const decodeOneThread = (
    rowOption: Option.Option<{ readonly threadId: string }>,
    operation: string,
  ) =>
    Option.match(rowOption, {
      onNone: () => Effect.succeed(Option.none<DiscordBridgeThreadRecord>()),
      onSome: (row) =>
        decodeThreadRow(row).pipe(
          Effect.mapError((cause) =>
            PersistenceDecodeError.fromSchemaError(operation, cause, { threadId: row.threadId }),
          ),
          Effect.map(Option.some),
        ),
    });

  const link: DiscordBridgeLinkRepository["Service"]["link"] = (input) =>
    insertLink(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DiscordBridgeLinkRepository.link:query",
          "DiscordBridgeLinkRepository.link:encodeRequest",
          { threadId: input.threadId },
        ),
      ),
    );

  const getByThreadId: DiscordBridgeLinkRepository["Service"]["getByThreadId"] = (threadId) =>
    selectByThreadId({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DiscordBridgeLinkRepository.getByThreadId:query",
          "DiscordBridgeLinkRepository.getByThreadId:decodeRow",
          { threadId },
        ),
      ),
      Effect.flatMap((row) =>
        decodeOneThread(row, "DiscordBridgeLinkRepository.getByThreadId:decodeRow"),
      ),
    );

  const getByDiscordThreadId: DiscordBridgeLinkRepository["Service"]["getByDiscordThreadId"] = (
    discordThreadId,
  ) =>
    selectByDiscordThreadId({ discordThreadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DiscordBridgeLinkRepository.getByDiscordThreadId:query",
          "DiscordBridgeLinkRepository.getByDiscordThreadId:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        decodeOneThread(row, "DiscordBridgeLinkRepository.getByDiscordThreadId:decodeRow"),
      ),
    );

  const listActive: DiscordBridgeLinkRepository["Service"]["listActive"] = () =>
    selectActive({}).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DiscordBridgeLinkRepository.listActive:query",
          "DiscordBridgeLinkRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeThreadRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "DiscordBridgeLinkRepository.listActive:decodeRows",
                cause,
                { threadId: row.threadId },
              ),
            ),
          ),
        ),
      ),
    );

  const setState: DiscordBridgeLinkRepository["Service"]["setState"] = (input) =>
    updateState(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DiscordBridgeLinkRepository.setState:query",
          "DiscordBridgeLinkRepository.setState:encodeRequest",
          { threadId: input.threadId },
        ),
      ),
    );

  const setLastSeen: DiscordBridgeLinkRepository["Service"]["setLastSeen"] = (input) =>
    updateLastSeen(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DiscordBridgeLinkRepository.setLastSeen:query",
          "DiscordBridgeLinkRepository.setLastSeen:encodeRequest",
          { threadId: input.threadId },
        ),
      ),
    );

  const listChunks: DiscordBridgeLinkRepository["Service"]["listChunks"] = (messageId) =>
    selectChunks({ messageId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DiscordBridgeLinkRepository.listChunks:query",
          "DiscordBridgeLinkRepository.listChunks:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeMessageRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "DiscordBridgeLinkRepository.listChunks:decodeRows",
                cause,
              ),
            ),
            Effect.map(toMessageRecord),
          ),
        ),
      ),
    );

  const upsertChunk: DiscordBridgeLinkRepository["Service"]["upsertChunk"] = (input) =>
    upsertChunkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DiscordBridgeLinkRepository.upsertChunk:query",
          "DiscordBridgeLinkRepository.upsertChunk:encodeRequest",
          { threadId: input.threadId },
        ),
      ),
    );

  return {
    link,
    getByThreadId,
    getByDiscordThreadId,
    listActive,
    setState,
    setLastSeen,
    listChunks,
    upsertChunk,
  } satisfies DiscordBridgeLinkRepository["Service"];
});

export const layer = Layer.effect(DiscordBridgeLinkRepository, make);

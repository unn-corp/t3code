# Discord bridge

Mirrors every T3 thread into a Discord thread and lets an authorized user reply
from Discord to drive the live session.

Disabled by default. With `discordBridge.enabled: false` (the default) nothing
subscribes, nothing polls, and no table is read.

## Shape

`server.ts` composes and starts `DiscordBridgeLive` in the host runtime. The
bridge observes committed v2 events through
`ThreadManagementService.streamDomainEvents`.

```
server.ts
  └─ DiscordBridgeLive / DiscordBridge.start
       ├─ v2 committed-domain-event stream → enqueue only
       │    └─ DrainableWorker (serial) → retryAutomationWork → Discord REST
       └─ REST history poll → per-message withAutomationWork
            └─ OrchestrationEngineService.dispatch → durable link cursor
```

Outbound events are post-commit observations and never block their producer.
The serial worker gates each write through the shared maintenance and
restored-automation admission policy. Held work stays at the queue head and
retries after admission reopens. Inbound dispatch intentionally enters the
orchestrator; on admission or dispatch failure, the bridge does not react with
✅ or advance its persisted cursor, so the same Discord message is retried.
Admission is acquired only for a non-empty inbound message, not for each idle
poll.

`makeDrainableWorker` processes items one at a time, so Discord writes are
globally ordered and naturally rate-limited.

## Transport: REST only

The bridge opens **no gateway connection**. This is deliberate, because the
Hermes agent gateway may hold a gateway session on the same bot token:

- Two gateway connections on one token share the IDENTIFY budget and
  `max_concurrency`, both receive every guild event, and fail together.
- REST has no session concept. The only shared resource is the rate-limit
  bucket, and each process backs off independently on `retry_after`.
- REST needs no privileged intents. `MESSAGE_CONTENT` gates gateway payloads;
  `GET /channels/{id}/messages` returns `content` regardless.
- No public ingress, so it works behind NAT.

The cost is inbound latency equal to the poll interval (~3 s). If sub-second
replies are ever needed, add a `DiscordGateway` implementation behind the same
seam and register **a second Discord application** — never a second gateway on
the shared token.

## Events

The v2 `eventToWork` mapper in
[`DiscordBridge.ts`](../../apps/server/src/discord/Layers/DiscordBridge.ts)
routes committed domain events as follows:

| Event                                                                                                                           | Bridge action                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `thread.created`                                                                                                                | Create the Discord starter and thread, then persist the link.                                             |
| `message.updated`                                                                                                               | Read authoritative thread detail through `ProjectionSnapshotQuery` and flush that message's current text. |
| `thread.metadata-updated`, `thread.runtime-mode-updated`, `thread.provider-switched`, `run.updated`, `provider-session.updated` | Refresh the linked thread header.                                                                         |
| `runtime-request.updated`, `plan.updated`                                                                                       | Post a short activity note when `mirrorActivity` is enabled.                                              |
| `thread.archived`, `thread.unarchived`, `thread.deleted`                                                                        | Update linked Discord thread/archive state.                                                               |

The `message.updated` event payload is not used as the complete body. The
bridge looks up the current `OrchestrationThread` detail, then records Discord
message chunks in `discord_bridge_messages` so later streaming updates edit
only the tail chunk. This is a snapshot-backed mirror, not a local delta buffer.

## Chunking and edits

Discord caps a message at 2000 characters and allows roughly 5 edits per
5 seconds per channel (a thread counts as a channel).

- `render.ts` plans chunks at ≤1900 characters, preferring `\n\n`, then `\n`,
  then a space, and never splitting a surrogate pair.
- A code fence left open at a boundary is closed and reopened with the same
  language tag, so each chunk renders standalone.
- Chunks other than the tail are **frozen** once full and never edited again.
  Only the tail is ever `PATCH`ed, which bounds the edit rate regardless of
  message length.
- A streaming flush is skipped entirely when fewer than 24 new characters
  arrived within the 2 s window.

All of that logic is pure and lives in `render.ts`, with dense tests in
`render.test.ts`. That is where the real risk is.

## Persistence

`discord_bridge_threads` and `discord_bridge_messages` (migration 036) are plain
tables, **not projections**. `ProjectionPipeline.bootstrap` replays projectors
from the event log; a Discord thread id is the result of a remote side effect
that cannot be replayed, so a rebuild would orphan or duplicate every thread.
Same reasoning as `provider_session_runtime`.

`discord_thread_id` is `UNIQUE`: if the server dies between creating the Discord
thread and inserting the row, the retry conflicts and reconciles instead of
double-creating.

Adding a migration requires **two** edits in `Migrations.ts` — the static import
and the `migrationEntries` row. It is not automatic.

## Inbound

Poll `GET /channels/{thread}/messages?after={cursor}`, oldest first:

1. Skip the bot's own messages (`author.id === applicationId`), any other bot,
   and webhooks. This is what stops an echo loop with Hermes.
2. Enforce `allowedAuthorIds` by exact `author.id` match. An **empty list denies
   everyone** — fail closed. Rejected messages get ❌ rather than silence.
3. If the session is `running`/`starting`, react ⏳ and **do not advance the
   cursor or process later messages in that batch**. The oldest message is
   re-read after the turn settles, so a later bot or ignored message cannot
   move the cursor past it. No queue table is needed; the Discord history
   survives restart.
4. Dispatch `thread.turn.start` with `commandId = "discord:<snowflake>"`.
   Only a successful dispatch receives ✅ and advances the durable cursor.
   Redelivery short-circuits on the existing command receipt, so dedupe is exact
   and free. A maintenance hold leaves the message untouched for the next poll.

The inbound command carries the thread's current runtime and interaction modes
along with the message, preserving the linked thread's existing behavior.

Echo suppression: injected messages carry `messageId = "discord:<snowflake>"`,
and the outbound path skips any id with that prefix. A pure string check, with
no state to lose across restarts.

## Configuration

Non-secret settings live in `ServerSettings.discordBridge`. The bot token does
**not** — it lives in the secret store under `discord-bridge-token`, because
settings.json is copied as test data and returned to clients.

```jsonc
{
  "discordBridge": {
    "enabled": true,
    "guildId": "…",
    "channelId": "…", // the #t3-code text channel
    "applicationId": "…", // used to ignore our own messages
    "allowedAuthorIds": ["…"],
    "publicOrigin": "https://…", // a loopback link is useless from a phone
    "projectAllowlist": [], // empty = every project
    "mirrorActivity": true,
  },
}
```

Token, in order of precedence: secret store `discord-bridge-token`, then the
`T3_DISCORD_BRIDGE_TOKEN` environment variable. A missing token is a normal
standby condition, not an error.

`projectAllowlist` matters on a busy install: without it, enabling the bridge
creates a Discord thread for every new thread in every project.

## Failure handling

| Failure               | Behaviour                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Disabled / no token   | Log once, stay dormant                                                                                                                                 |
| Maintenance hold      | Keep the current outbound event in the serial in-memory worker and retry after admission reopens; a host process restart discards queued observer work |
| Transport fault, 5xx  | `retryTransient` ×3, then drop. Chunk `published_length` advances only on success; a later flush can resend the delta                                  |
| 429                   | Honour `retry_after` exactly, never tighter. A `global` 429 stalls every bucket                                                                        |
| Thread archived       | Unarchive once, else mark `archived`                                                                                                                   |
| 404 / unknown channel | Mark `orphaned`. **Never recreate** — a deleted Discord thread means "stop mirroring"                                                                  |
| 401 / 403             | Log once and stop hammering                                                                                                                            |

## Security

Mirroring the activity feed pushes file contents, diffs, and command output into
Discord, where they persist in Discord's infrastructure after deletion. Two
controls matter and they are independent:

- **Write side**: `allowedAuthorIds`. An authorized author can start turns in
  `full-access` (permission-bypassing) sessions, so this is arbitrary code
  execution on the host, not just chat access. It fails closed.
- **Read side**: Discord channel permissions. The allowlist does nothing about
  who can _read_ the mirror. Deny `VIEW_CHANNEL` to `@everyone` on the mirror
  channel and grant it explicitly.

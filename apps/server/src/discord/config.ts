import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

/**
 * Secret store key for the Discord bot token.
 *
 * The token deliberately does not live in settings.json: that file is copied
 * around as test data and returned to clients through the settings RPC.
 */
export const DISCORD_BRIDGE_TOKEN_SECRET = "discord-bridge-token";

/** Environment fallback, mainly for containers and one-off local runs. */
export const DISCORD_BRIDGE_TOKEN_ENV = "T3_DISCORD_BRIDGE_TOKEN";

const decoder = new TextDecoder();

/**
 * Resolve the bot token, preferring the secret store over the environment.
 *
 * Returns an empty string when no token is configured. A missing token is a
 * normal standby condition, not an error: the bridge simply stays dormant.
 */
export const readDiscordBotToken = Effect.gen(function* () {
  const fromEnv = process.env[DISCORD_BRIDGE_TOKEN_ENV]?.trim();
  const store = yield* Effect.serviceOption(ServerSecretStore);
  if (Option.isSome(store)) {
    const stored = yield* store.value
      .get(DISCORD_BRIDGE_TOKEN_SECRET)
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isSome(stored)) {
      const value = decoder.decode(stored.value).trim();
      if (value !== "") {
        return value;
      }
    }
  }
  return fromEnv === undefined ? "" : fromEnv;
});

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface DiscordBridgeShape {
  /**
   * Subscribe to the orchestration event stream and start the inbound poller.
   *
   * Never fails: when the bridge is disabled or has no token it logs once and
   * returns. The bridge is a post-commit observer and must never be able to
   * affect orchestration.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Resolves when the outbound queue is empty and the worker is idle.
   *
   * Intended for test use, to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

export class DiscordBridge extends Context.Service<DiscordBridge, DiscordBridgeShape>()(
  "t3/discord/Services/DiscordBridge",
) {}

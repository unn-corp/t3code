import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";

export interface DiscordBridgeShape {
  /**
   * Subscribe to the orchestration event stream and start the inbound poller.
   *
   * Never fails: when the bridge is disabled or has no token it logs once and
   * returns. Outbound observers never block committed commands; authorized
   * inbound replies enter orchestration through its normal admission path.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Resolves when the outbound queue is empty and the worker is idle.
   *
   * Intended for test use, to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
  /** Run one inbound poll cycle. Kept explicit so cursor handling is testable without a timer. */
  readonly pollOnce: Effect.Effect<void>;
  /** Queue a committed event for the serial mirror worker. */
  readonly enqueueEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
}

export class DiscordBridge extends Context.Service<DiscordBridge, DiscordBridgeShape>()(
  "t3/discord/Services/DiscordBridge",
) {}

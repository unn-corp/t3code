import { type EnvironmentId, type ServerSelfUpdateInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ConnectionResolver from "./resolver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRoutes, routeEntry } from "./routes.ts";

export class OutdatedHostUpdateError extends Schema.TaggedError<OutdatedHostUpdateError>()(
  "OutdatedHostUpdateError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export type OutdatedHostUpdateStage = "downloading" | "installing" | "resuming";

/**
 * What this client does about a host whose orchestration protocol is too old for it.
 *
 * It does not update it. That host's own self-update would install and restart it without ever
 * asking the device whether an agent is active, and it has no device coordinator to fence writes,
 * snapshot its data, or reverse a failed update. A host without the `forkMaintenance` capability is
 * therefore a manual bootstrap: update it where it runs, once, and every later update is checked and
 * reversible. A host that does advertise the capability updates from App updates instead.
 */
export const updateOutdatedHost = Effect.fn("clientRuntime.connection.updateOutdatedHost")(
  function* (
    environmentId: EnvironmentId,
    _input: ServerSelfUpdateInput,
    _onStage: (stage: OutdatedHostUpdateStage) => Effect.Effect<void>,
  ) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const resolver = yield* ConnectionResolver.ConnectionResolver;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
    if (entry === undefined) {
      return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId });
    }
    const { descriptor } = yield* Effect.firstSuccessOf(
      connectionRoutes(entry).map((route) => resolver.prepareForUpdate(routeEntry(entry, route))),
    );
    return yield* new OutdatedHostUpdateError({
      environmentId,
      message:
        descriptor.capabilities.forkMaintenance === undefined
          ? `Update T3 Code on ${descriptor.label} manually. It predates device maintenance, so this app cannot check that no agent is running there or reverse a failed update, and it will not install over it.`
          : `Update T3 Code on ${descriptor.label} from App updates, which checks activity and keeps a restore point.`,
    });
  },
);

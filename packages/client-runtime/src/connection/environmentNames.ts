import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";

export const StoredEnvironmentName = Schema.Struct({
  environmentId: EnvironmentId,
  name: Schema.String,
});
export type StoredEnvironmentName = typeof StoredEnvironmentName.Type;

export function environmentNameError(name: string): string | null {
  if (name.trim().length > 120) return "Use 120 characters or fewer.";
  for (const character of name) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return "Names cannot contain control characters.";
  }
  return null;
}

/** Names belong to this client's catalog, independent of host discovery and route credentials. */
export class EnvironmentNames extends Context.Reference<{
  readonly changes: Stream.Stream<ReadonlyArray<StoredEnvironmentName>>;
  readonly set: (
    environmentId: EnvironmentId,
    name: string | null,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}>("@t3tools/client-runtime/connection/EnvironmentNames", {
  defaultValue: () => ({
    changes: Stream.succeed([]),
    set: (_environmentId, name) =>
      name === null
        ? Effect.void
        : Effect.fail(
            new ConnectionBlockedError({
              reason: "unsupported",
              detail: "Environment names are unavailable on this client.",
            }),
          ),
  }),
}) {}

export const makeEnvironmentNames = Effect.fn("makeEnvironmentNames")(function* (storage: {
  readonly read: Effect.Effect<ReadonlyArray<StoredEnvironmentName>, ConnectionAttemptError>;
  readonly write: (
    names: ReadonlyArray<StoredEnvironmentName>,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const state = yield* SubscriptionRef.make(yield* storage.read);
  const lock = yield* Semaphore.make(1);
  return EnvironmentNames.of({
    changes: SubscriptionRef.changes(state),
    set: (environmentId, name) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const error = name === null ? null : environmentNameError(name);
          if (error !== null)
            return yield* new ConnectionBlockedError({ reason: "configuration", detail: error });
          const normalized = name?.trim() || null;
          const current = yield* SubscriptionRef.get(state);
          if (
            (current.find((value) => value.environmentId === environmentId)?.name ?? null) ===
            normalized
          )
            return;
          const next = [
            ...current.filter((value) => value.environmentId !== environmentId),
            ...(normalized === null ? [] : [{ environmentId, name: normalized }]),
          ];
          yield* storage.write(next);
          yield* SubscriptionRef.set(state, next);
        }),
      ),
  });
});

// Only presentation changes. The registry keeps the original target and live supervisor.
export function withEnvironmentName(
  entry: ConnectionCatalogEntry,
  name: string,
): ConnectionCatalogEntry {
  const target = entry.target;
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return {
        ...entry,
        nameOverride: name,
        target: new PrimaryConnectionTarget({ ...target, label: name }),
      };
    case "BearerConnectionTarget":
      return {
        ...entry,
        nameOverride: name,
        target: new BearerConnectionTarget({ ...target, label: name }),
      };
    case "RelayConnectionTarget":
      return {
        ...entry,
        nameOverride: name,
        target: new RelayConnectionTarget({ ...target, label: name }),
      };
    case "SshConnectionTarget":
      return {
        ...entry,
        nameOverride: name,
        target: new SshConnectionTarget({ ...target, label: name }),
      };
  }
}

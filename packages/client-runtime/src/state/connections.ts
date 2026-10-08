import type { EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  EnvironmentNames,
  withEnvironmentName,
  type StoredEnvironmentName,
} from "../connection/environmentNames.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  GitHubRoutingPermissions,
  type GitHubRoutingPermission,
  type StoredGitHubRoutingPermission,
} from "../connection/githubRoutingPermissions.ts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  followStreamInEnvironment,
} from "./runtime.ts";

export interface EnvironmentCatalogState {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<EnvironmentIdType, ConnectionCatalogEntry>;
}

/**
 * Environments that take part in the workspace: projects, threads, and shell
 * summaries only come from these. Disabled environments stay in `entries` so
 * Settings can list them and switch them back on.
 */
export function* enabledEnvironmentIds(
  catalog: EnvironmentCatalogState,
): Generator<EnvironmentIdType> {
  for (const [environmentId, entry] of catalog.entries) {
    if (entry.enabled) {
      yield environmentId;
    }
  }
}

const EMPTY_ENVIRONMENT_CATALOG_STATE: EnvironmentCatalogState = Object.freeze({
  isReady: false,
  entries: new Map(),
});

export function createEnvironmentCatalogAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serial = { mode: "serial" as const, key: () => "environment-catalog" };
  const catalogAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) =>
          SubscriptionRef.changes(registry.entries).pipe(
            Stream.map((entries) => ({
              isReady: true,
              entries,
            })),
          ),
        ),
      ),
    ),
    { initialValue: EMPTY_ENVIRONMENT_CATALOG_STATE },
  );

  const namesAtom = runtime.atom(
    Stream.unwrap(EnvironmentNames.pipe(Effect.map((names) => names.changes))),
    { initialValue: [] as ReadonlyArray<StoredEnvironmentName> },
  );
  const projected = new WeakMap<
    ConnectionCatalogEntry,
    { name: string; entry: ConnectionCatalogEntry }
  >();
  const catalogValueAtom = Atom.make((get) => {
    const catalog = Option.getOrElse(
      AsyncResult.value(get(catalogAtom)),
      () => EMPTY_ENVIRONMENT_CATALOG_STATE,
    );
    const names = new Map(
      Option.getOrElse(AsyncResult.value(get(namesAtom)), () => []).map((value) => [
        value.environmentId,
        value.name,
      ]),
    );
    if (names.size === 0) return catalog;
    return {
      ...catalog,
      entries: new Map(
        [...catalog.entries].map(([id, entry]) => {
          const name = names.get(id);
          if (name === undefined) return [id, entry];
          let cached = projected.get(entry);
          if (cached?.name !== name) {
            cached = { name, entry: withEnvironmentName(entry, name) };
            projected.set(entry, cached);
          }
          return [id, cached.entry];
        }),
      ),
    };
  }).pipe(Atom.withLabel("environment-catalog-value"));
  const rename = createRuntimeCommand(runtime, {
    label: "environment-catalog:rename",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: Effect.fn(function* (input: {
      readonly environmentId: EnvironmentIdType;
      readonly name: string | null;
    }) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      if (!(yield* SubscriptionRef.get(registry.entries)).has(input.environmentId)) {
        return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({
          environmentId: input.environmentId,
        });
      }
      const names = yield* EnvironmentNames;
      yield* names.set(input.environmentId, input.name);
    }),
  });

  const githubRoutingPermissionsAtom = runtime.atom(
    Stream.unwrap(GitHubRoutingPermissions.pipe(Effect.map((permissions) => permissions.changes))),
    { initialValue: [] as ReadonlyArray<StoredGitHubRoutingPermission> },
  );
  const githubRoutingPermissionsValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(githubRoutingPermissionsAtom)), () => []),
  ).pipe(Atom.withLabel("environment-github-routing-permissions"));
  const setGitHubRoutingPermission = createRuntimeCommand(runtime, {
    label: "environment-catalog:github-routing-permission",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: Effect.fn(function* (input: {
      readonly environmentId: EnvironmentIdType;
      readonly permission: GitHubRoutingPermission;
    }) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
      if (entry === undefined)
        return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({
          environmentId: input.environmentId,
        });
      const permissions = yield* GitHubRoutingPermissions;
      yield* permissions.set(entry, input.permission);
    }),
  });

  const networkStatusAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.networkStatus)),
      ),
    ),
    { initialValue: "unknown" as const },
  );

  const networkStatusValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(networkStatusAtom)), () => "unknown" as const),
  ).pipe(Atom.withLabel("environment-network-status-value"));

  const stateAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
          ),
        ),
      ),
      { initialValue: AVAILABLE_CONNECTION_STATE },
    ),
  );

  const register = createRuntimeCommand(runtime, {
    label: "environment-catalog:register",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (
      target: Parameters<EnvironmentRegistry.EnvironmentRegistry["Service"]["register"]>[0],
    ) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.register(target)),
      ),
  });
  const remove = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.remove(environmentId)),
      ),
  });
  const removeRelayEnvironments = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-relay-environments",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (_input: void) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRelayEnvironments()),
      ),
  });
  const setEnabled = createRuntimeCommand(runtime, {
    label: "environment-catalog:set-enabled",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly enabled: boolean }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.setEnabled(input.environmentId, input.enabled)),
      ),
  });
  const removeRoute = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-route",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly routeId: string }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRoute(input.environmentId, input.routeId)),
      ),
  });
  const reorderRoutes = createRuntimeCommand(runtime, {
    label: "environment-catalog:reorder-routes",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: {
      readonly environmentId: EnvironmentIdType;
      readonly routeIds: ReadonlyArray<string>;
    }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.reorderRoutes(input.environmentId, input.routeIds)),
      ),
  });
  const retryNow = createRuntimeCommand(runtime, {
    label: "environment-catalog:retry-now",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.retryNow(environmentId)),
      ),
  });

  return {
    catalogAtom,
    catalogValueAtom,
    githubRoutingPermissionsValueAtom,
    setGitHubRoutingPermission,
    networkStatusAtom,
    networkStatusValueAtom,
    stateAtom,
    register,
    remove,
    removeRoute,
    reorderRoutes,
    removeRelayEnvironments,
    retryNow,
    setEnabled,
    rename,
  };
}

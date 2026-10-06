import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { PrimaryConnectionTarget } from "./model.ts";
import { updateOutdatedHost } from "./outdatedHostUpdate.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as Layer from "effect/Layer";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-old"),
  label: "Build Mac",
  httpBaseUrl: "https://build.example.test",
  wsBaseUrl: "wss://build.example.test",
});

const descriptor = (
  protocol: number | undefined,
  serverVersion: string,
  capabilities: ExecutionEnvironmentDescriptor["capabilities"],
) =>
  ({
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: { os: "darwin", arch: "arm64" },
    serverVersion,
    ...(protocol === undefined ? {} : { orchestrationProtocolVersion: protocol }),
    capabilities,
  }) satisfies ExecutionEnvironmentDescriptor;

const refuse = (capabilities: ExecutionEnvironmentDescriptor["capabilities"]) =>
  Effect.gen(function* () {
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [
          TARGET.environmentId,
          { target: TARGET, profile: Option.none(), enabled: false, serverUpdateRequired: true },
        ],
      ]),
    );
    const registry = EnvironmentRegistry.EnvironmentRegistry.of({
      entries,
      setCompatibility: () => Effect.die(new Error("An outdated host must stay blocked.")),
      setEnabled: () => Effect.die(new Error("An outdated host must stay disabled.")),
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const resolver = ConnectionResolver.ConnectionResolver.of({
      prepare: () => Effect.die(new Error("unused")),
      prepareForUpdate: () =>
        Effect.succeed({
          descriptor: descriptor(undefined, "0.0.45", capabilities),
          prepared: {
            environmentId: TARGET.environmentId,
            label: TARGET.label,
            httpBaseUrl: TARGET.httpBaseUrl,
            socketUrl: "wss://build.example.test/ws",
            httpAuthorization: null,
            target: TARGET,
          },
        }),
    });
    const error = yield* Effect.flip(
      updateOutdatedHost(TARGET.environmentId, { targetVersion: "0.0.46" }, () => Effect.void),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
          Layer.succeed(ConnectionResolver.ConnectionResolver, resolver),
        ),
      ),
    );
    // No socket constructor or HTTP client is provided: any attempt to reach the host would have failed the test.
    return { error };
  });

describe("updateOutdatedHost", () => {
  it.effect(
    "never installs over a host that predates device maintenance, and says to update it manually once",
    () =>
      Effect.gen(function* () {
        for (const capabilities of [
          { repositoryIdentity: true, serverSelfUpdate: "boot-service" as const },
          {
            repositoryIdentity: true,
            serverSelfUpdate: "desktop-managed" as const,
            desktopAppUpdate: true,
          },
          { repositoryIdentity: true },
        ]) {
          const { error } = yield* refuse(capabilities);
          expect(error).toMatchObject({
            _tag: "OutdatedHostUpdateError",
            environmentId: TARGET.environmentId,
          });
          expect(error.message).toContain("manually");
          expect(error.message).toContain("predates device maintenance");
        }
      }),
  );

  it.effect(
    "points a host that does advertise device maintenance at App updates instead of its own installer",
    () =>
      Effect.gen(function* () {
        const { error } = yield* refuse({
          repositoryIdentity: true,
          serverSelfUpdate: "boot-service",
          forkMaintenance: {
            protocol: 1,
            coordinatorId: "c",
            participantId: "p",
            admission: true,
            recovery: true,
          },
        });
        expect(error.message).toContain("App updates");
      }),
  );

  it.effect("fails for an environment that is not registered", () =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map());
      const error = yield* Effect.flip(
        updateOutdatedHost(TARGET.environmentId, { targetVersion: "0.0.46" }, () => Effect.void),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              EnvironmentRegistry.EnvironmentRegistry,
              EnvironmentRegistry.EnvironmentRegistry.of({
                entries,
              } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
            ),
            Layer.succeed(
              ConnectionResolver.ConnectionResolver,
              ConnectionResolver.ConnectionResolver.of({
                prepare: () => Effect.die(new Error("unused")),
                prepareForUpdate: () => Effect.die(new Error("unused")),
              }),
            ),
          ),
        ),
      );
      expect(error).toMatchObject({ _tag: "EnvironmentNotRegisteredError" });
    }),
  );
});

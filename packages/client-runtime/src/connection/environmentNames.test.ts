import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setRoutesInCatalog,
} from "../platform/storageDocument.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  RelayConnectionTarget,
} from "./model.ts";
import { BearerConnectionProfile, RelayConnectionRegistration } from "./catalog.ts";
import { makeEnvironmentNames, withEnvironmentName } from "./environmentNames.ts";

const id = EnvironmentId.make("squidhub");
const target = new RelayConnectionTarget({ environmentId: id, label: "vm-host" });
const registration = new RelayConnectionRegistration({ target });
const decode = Schema.decodeUnknownEffect(ConnectionCatalogDocument);

describe("environment names", () => {
  it.effect(
    "survives storage reload, discovery and route changes, and supports reset/removal",
    () =>
      Effect.gen(function* () {
        let document = registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, registration);
        const storage = {
          read: Effect.sync(() => document.environmentNames ?? []),
          write: (environmentNames: NonNullable<typeof document.environmentNames>) =>
            Effect.gen(function* () {
              document = yield* decode({ ...document, environmentNames }).pipe(Effect.orDie);
            }),
        };
        const names = yield* makeEnvironmentNames(storage);
        yield* names.set(id, "  Squidhub (Personal)  ");
        const refreshed = new RelayConnectionTarget({ ...target, label: "new-host" });
        document = registerConnectionInCatalog(
          document,
          new RelayConnectionRegistration({ target: refreshed }),
        );
        document = setRoutesInCatalog(document, id, [refreshed]);
        const reloaded = yield* makeEnvironmentNames(storage);
        expect(yield* Stream.runHead(reloaded.changes)).toEqual(
          Option.some([{ environmentId: id, name: "Squidhub (Personal)" }]),
        );
        expect(document.targets[0]?.label).toBe("new-host");
        yield* reloaded.set(id, "   ");
        expect(document.environmentNames).toEqual([]);
        yield* reloaded.set(id, "Squidhub (Work)");
        expect(removeConnectionFromCatalog(document, id).environmentNames).toEqual([]);
        expect((yield* decode(EMPTY_CONNECTION_CATALOG_DOCUMENT)).environmentNames).toBeUndefined();
      }),
  );

  it.effect("rejects invalid names and leaves the visible value unchanged when saving fails", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "Storage unavailable",
      });
      const names = yield* makeEnvironmentNames({
        read: Effect.succeed([{ environmentId: id, name: "Original" }]),
        write: () => Effect.fail(failure),
      });
      for (const invalid of ["x".repeat(121), "bad\nname", "bad\u0000name"]) {
        expect((yield* Effect.result(names.set(id, invalid)))._tag).toBe("Failure");
      }
      expect((yield* Effect.result(names.set(id, "Changed")))._tag).toBe("Failure");
      expect(yield* Stream.runHead(names.changes)).toEqual(
        Option.some([{ environmentId: id, name: "Original" }]),
      );
    }),
  );

  it("changes only presentation, keeping identity, routes and profile intact", () => {
    const profile = Option.some(
      new BearerConnectionProfile({
        connectionId: "direct",
        environmentId: id,
        label: "vm-host",
        httpBaseUrl: "https://private.test",
        wsBaseUrl: "wss://private.test",
      }),
    );
    const entry = {
      target: new BearerConnectionTarget({
        environmentId: id,
        label: "vm-host",
        connectionId: "direct",
      }),
      profile,
      enabled: false,
      alternateRoutes: [{ target, profile: Option.none() }],
    };
    const named = withEnvironmentName(entry, "Squidhub (Personal)");
    expect(named.target.label).toBe("Squidhub (Personal)");
    expect(named.target.environmentId).toBe(id);
    expect(named.profile).toBe(entry.profile);
    expect(named.alternateRoutes).toBe(entry.alternateRoutes);
    expect(named.enabled).toBe(false);
    expect(entry.target.label).toBe("vm-host");
  });
});

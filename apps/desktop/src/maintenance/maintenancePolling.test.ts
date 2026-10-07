import { assert, describe, it } from "@effect/vitest";
import {
  CURRENT_ACTIVITY_PROTOCOL,
  participantBlockers,
  type MaintenanceParticipant,
} from "@t3tools/shared/forkMaintenanceAdmission";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { startMaintenancePolling } from "./maintenancePolling.ts";

class ObservationUnavailable extends Data.TaggedError("ObservationUnavailable") {}

describe("desktop maintenance activity polling", () => {
  it.effect("acknowledges a fence and detects new work while the controller is waiting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tickStarted = yield* Deferred.make<void>();
        const holdTick = yield* Deferred.make<void>();
        let transactionId: string | null = null;
        let busy = false;
        let participant: MaintenanceParticipant = {
          id: "desktop",
          label: "Arcwright Code desktop",
          kind: "desktop",
          owner: { pid: 1, started: "fixture" },
          homes: ["fixture"],
          updateTarget: false,
          parentId: null,
          observedAt: 0,
          idleSince: -600_000,
          frozenFor: null,
          trialFor: null,
          descendants: [],
          orphaned: false,
          blockers: [],
          activityProtocol: CURRENT_ACTIVITY_PROTOCOL,
        };
        yield* startMaintenancePolling({
          observe: Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                participant = {
                  ...participant,
                  observedAt: now,
                  frozenFor: busy ? null : transactionId,
                  blockers: busy
                    ? [{ participantId: "desktop", reason: "commands", label: "Command running" }]
                    : [],
                };
              }),
            ),
          ),
          tick: Deferred.succeed(tickStarted, undefined).pipe(
            Effect.andThen(Deferred.await(holdTick)),
          ),
        });
        yield* Deferred.await(tickStarted);
        transactionId = "update-1";
        // Beyond the 30 second stale threshold, with the serialized tick still blocked.
        yield* TestClock.adjust(Duration.seconds(35));
        assert.deepStrictEqual(
          participantBlockers([participant], yield* Clock.currentTimeMillis, transactionId),
          [],
        );
        busy = true;
        yield* TestClock.adjust(Duration.seconds(5));
        assert.equal(
          participantBlockers([participant], yield* Clock.currentTimeMillis, transactionId)[0]
            ?.reason,
          "commands",
        );
      }),
    ),
  );

  it.effect("retries a failed observation without waiting for the controller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tickStarted = yield* Deferred.make<void>();
        const holdTick = yield* Deferred.make<void>();
        let attempts = 0;
        let observed = false;
        yield* startMaintenancePolling({
          observe: Effect.suspend(() => {
            attempts += 1;
            if (attempts === 1) return Effect.fail(new ObservationUnavailable());
            return Effect.sync(() => {
              observed = true;
            });
          }),
          tick: Deferred.succeed(tickStarted, undefined).pipe(
            Effect.andThen(Deferred.await(holdTick)),
          ),
        });
        yield* Deferred.await(tickStarted);
        assert.isFalse(observed);
        yield* TestClock.adjust(Duration.seconds(5));
        assert.isTrue(observed);
      }),
    ),
  );
});

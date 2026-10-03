import { assert, it } from "@effect/vitest";
import { OrganizationIntakeResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { OrganizationCorrelationCoordinatorShape } from "./OrganizationCorrelationCoordinator.ts";
import { correlateRecordedIntake } from "./OrganizationIntakeCorrelation.ts";

it.effect("bounds duplicate adapter replays while explicit user retry remains available", () =>
  Effect.gen(function* () {
    let calls = 0;
    const coordinator: OrganizationCorrelationCoordinatorShape = {
      onObservation: () => {
        calls++;
        return Effect.succeed({
          outcome: "insufficient",
          finding: null,
          evidenceCount: 1,
          reason: null,
        });
      },
    };
    const intake = yield* Schema.decodeUnknownEffect(OrganizationIntakeResult)({
      outcome: "duplicate",
      observation: {
        id: "saved-observation",
        organizationId: "organization",
        sourceId: "source",
        projectId: "project",
        externalEventId: "event",
        dedupKey: "key",
        occurredAt: "2026-09-26T12:00:00.000Z",
        receivedAt: "2026-09-26T12:00:00.000Z",
        title: "Saved event",
        body: "",
        attributes: { correlationKey: "case" },
        state: "observed",
      },
    });
    for (let index = 0; index < 100; index++) {
      const result = yield* correlateRecordedIntake(coordinator, intake);
      assert.equal(result.correlation, undefined);
    }
    assert.equal(calls, 0);
    const explicit = yield* correlateRecordedIntake(coordinator, intake, undefined, true);
    assert.equal(explicit.correlation?.outcome, "insufficient");
    assert.equal(calls, 1);
  }),
);

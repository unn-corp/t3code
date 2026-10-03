import { assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { OrganizationLiveWorkRuntimeReadiness } from "./OrganizationLiveWorkExecutor.ts";
import { makeOrganizationLiveWorkReadinessGate } from "./OrganizationLiveWorkReadinessGate.ts";
import { OrganizationWorkIntentActivationReadiness } from "./OrganizationWorkIntentActivation.ts";

class GateTestError extends Data.TaggedError("GateTestError")<{
  readonly message: string;
}> {}

it.effect("does not run recovery or grant readiness when owner claim fails", () =>
  Effect.gen(function* () {
    const gate = makeOrganizationLiveWorkReadinessGate();
    let recoveryCalls = 0;
    const result = yield* gate.initialize(
      Effect.fail(new GateTestError({ message: "owner unavailable" })),
      Effect.sync(() => {
        recoveryCalls++;
        return { held: [] };
      }),
      Effect.succeed({ held: [] }),
    );
    assert.deepEqual(result, { ready: false, reason: "broker_owner_unavailable" });
    assert.equal(recoveryCalls, 0);
    assert.equal(gate.permits("org", "intent"), false);
  }),
);

it.effect("holds readiness when reconciliation fails or retains a scope", () =>
  Effect.gen(function* () {
    const gate = makeOrganizationLiveWorkReadinessGate();
    assert.deepEqual(
      yield* gate.initialize(
        Effect.succeed("epoch-1"),
        Effect.fail(new GateTestError({ message: "recovery failed" })),
        Effect.succeed({ held: [] }),
      ),
      { ready: false, reason: "scope_recovery_unavailable" },
    );
    assert.deepEqual(
      yield* gate.initialize(
        Effect.succeed("epoch-2"),
        Effect.succeed({ held: ["attempt-a"] }),
        Effect.succeed({ held: [] }),
      ),
      { ready: false, reason: "scope_recovery_held" },
    );
    assert.equal(gate.permits("org", "intent"), false);
  }),
);

it.effect("holds readiness while WorkStore recovery is unavailable or unresolved", () =>
  Effect.gen(function* () {
    const gate = makeOrganizationLiveWorkReadinessGate();
    assert.deepEqual(
      yield* gate.initialize(
        Effect.succeed("epoch-1"),
        Effect.succeed({ held: [] }),
        Effect.fail(new GateTestError({ message: "work recovery failed" })),
      ),
      { ready: false, reason: "work_recovery_unavailable" },
    );
    assert.deepEqual(
      yield* gate.initialize(
        Effect.succeed("epoch-2"),
        Effect.succeed({ held: [] }),
        Effect.succeed({ held: ["work-a"] }),
      ),
      { ready: false, reason: "work_recovery_held" },
    );
    assert.equal(gate.permits("org", "intent"), false);
  }),
);

it.effect("grants only after clean recovery and revokes on error or shutdown", () =>
  Effect.gen(function* () {
    const gate = makeOrganizationLiveWorkReadinessGate();
    assert.deepEqual(
      yield* gate.initialize(
        Effect.succeed("epoch-1"),
        Effect.succeed({ held: [] }),
        Effect.succeed({ held: [] }),
      ),
      { ready: true, reason: "ready" },
    );
    assert.equal(gate.permits("org", "intent"), true);
    assert.equal(gate.permits("", "intent"), false);
    yield* Effect.gen(function* () {
      const runtime = yield* OrganizationLiveWorkRuntimeReadiness;
      const activation = yield* OrganizationWorkIntentActivationReadiness;
      assert.equal(runtime.status().ready, true);
      assert.equal(activation.permits("org", "intent"), true);
    }).pipe(
      Effect.provide(Layer.mergeAll(gate.runtimeReadinessLayer, gate.activationReadinessLayer)),
    );
    assert.deepEqual(
      yield* gate.initialize(
        Effect.fail(new GateTestError({ message: "owner lost" })),
        Effect.succeed({ held: [] }),
        Effect.succeed({ held: [] }),
      ),
      { ready: false, reason: "broker_owner_unavailable" },
    );
    yield* gate.initialize(
      Effect.succeed("epoch-2"),
      Effect.succeed({ held: [] }),
      Effect.succeed({ held: [] }),
    );
    gate.revoke("server_stopping");
    assert.deepEqual(gate.status(), { ready: false, reason: "server_stopping" });
  }),
);

it.effect("does not restore readiness after revocation during an owner claim", () =>
  Effect.gen(function* () {
    const gate = makeOrganizationLiveWorkReadinessGate();
    const claim = yield* Deferred.make<string>();
    const started = yield* Deferred.make<void>();
    let recoveryCalls = 0;
    const initializing = yield* gate
      .initialize(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(claim))),
        Effect.sync(() => {
          recoveryCalls++;
          return { held: [] };
        }),
        Effect.succeed({ held: [] }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    gate.revoke("server_stopping");
    yield* Deferred.succeed(claim, "late-owner");
    assert.deepEqual(yield* Fiber.join(initializing), {
      ready: false,
      reason: "server_stopping",
    });
    assert.equal(recoveryCalls, 0);
  }),
);

it.effect("retries held recovery after a delay and grants only when it clears", () =>
  Effect.gen(function* () {
    const gate = makeOrganizationLiveWorkReadinessGate();
    let waits = 0;
    let checks = 0;
    yield* gate.initialize(
      Effect.succeed("epoch-1"),
      Effect.succeed({ held: [] }),
      Effect.succeed({ held: ["unexpired-work"] }),
    );
    assert.equal(gate.status().reason, "work_recovery_held");
    yield* gate.retryUntilReady(
      () => {
        checks++;
        return gate.initialize(
          Effect.succeed("epoch-1"),
          Effect.succeed({ held: [] }),
          Effect.succeed({ held: checks < 2 ? ["unexpired-work"] : [] }),
        );
      },
      Effect.sync(() => {
        waits++;
      }),
    );
    assert.equal(waits, 2);
    assert.equal(checks, 2);
    assert.deepEqual(gate.status(), { ready: true, reason: "ready" });
  }),
);

it.effect("revokes a live grant when the broker owner check fails", () =>
  Effect.gen(function* () {
    const gate = makeOrganizationLiveWorkReadinessGate();
    yield* gate.initialize(
      Effect.succeed("epoch-1"),
      Effect.succeed({ held: [] }),
      Effect.succeed({ held: [] }),
    );
    let checks = 0;
    yield* gate.monitorOwner(() => Effect.sync(() => ++checks < 2), Effect.void);
    assert.equal(checks, 2);
    assert.deepEqual(gate.status(), { ready: false, reason: "broker_owner_unavailable" });
    assert.equal(gate.permits("org", "intent"), false);
  }),
);

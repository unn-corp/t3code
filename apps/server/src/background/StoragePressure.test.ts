import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as StoragePressure from "./StoragePressure.ts";

const gib = 1024 ** 3;

it.effect(
  "caches samples and waits through a recovery cooldown before allowing background work",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      let psi =
        "some avg10=54.50 avg60=0.00 avg300=0.00 total=1\nfull avg10=12.00 avg60=0.00 avg300=0.00 total=1\n";
      const pressure = yield* StoragePressure.makeWith(
        Effect.sync(() => {
          reads++;
          return { psi, availableBytes: 100 * gib, totalBytes: 1000 * gib };
        }),
      );
      assert.equal((yield* pressure.read).reason, "io-pressure");
      psi =
        "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n";
      assert.equal((yield* pressure.read).reason, "io-pressure");
      assert.equal(reads, 1);
      yield* TestClock.adjust("6 seconds");
      assert.equal((yield* pressure.read).reason, "io-pressure");
      assert.equal(reads, 2);
      yield* TestClock.adjust("55 seconds");
      assert.equal((yield* pressure.read).reason, null);
      assert.equal(reads, 3);
    }),
);

it.effect.each([
  { psi: null, availableBytes: 1 * gib, totalBytes: 10 * gib, expected: "low-space" },
  { psi: null, availableBytes: 20 * gib, totalBytes: 1000 * gib, expected: "low-space" },
  {
    psi: "some avg10=19.00\nfull avg10=10.00\n",
    availableBytes: 100 * gib,
    totalBytes: 1000 * gib,
    expected: "io-pressure",
  },
  { psi: "malformed\nfull avg10=999\n", availableBytes: null, totalBytes: null, expected: null },
  { psi: null, availableBytes: 100 * gib, totalBytes: 1000 * gib, expected: null },
] as const)("handles low space, I/O stalls, and unavailable telemetry (%j)", (readings) =>
  Effect.gen(function* () {
    const pressure = yield* StoragePressure.makeWith(Effect.succeed(readings));
    assert.equal((yield* pressure.read).reason, readings.expected);
  }),
);

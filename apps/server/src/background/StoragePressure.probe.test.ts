// @effect-diagnostics nodeBuiltinImport:off - the host probe is mocked; no filesystem calls are made.
import type * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as StoragePressure from "./StoragePressure.ts";

const fs = vi.hoisted(() => ({ readFile: vi.fn(), statfs: vi.fn() }));
vi.mock("node:fs/promises", () => fs);

it.effect("keeps space checks available on hosts without Linux PSI", () => {
  fs.readFile.mockClear();
  fs.statfs.mockResolvedValue({ bsize: 4096, blocks: 1_000_000, bavail: 900_000 });
  return Effect.gen(function* () {
    const pressure = yield* StoragePressure.StoragePressure;
    const snapshot = yield* pressure.read;
    assert.equal(snapshot.reason, null);
    assert.equal(snapshot.ioSomeAvg10, null);
    assert.equal(snapshot.availableBytes, 4096 * 900_000);
    assert.equal(fs.readFile.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      StoragePressure.layerForDatabase("/fixture/state.sqlite").pipe(
        Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
      ),
    ),
  );
});

it.effect(
  "bounds an unavailable space probe and reuses its native request while PSI remains available",
  () =>
    Effect.gen(function* () {
      fs.statfs.mockClear();
      fs.readFile.mockClear();
      let finishDisk!: (stats: NodeFS.StatsFs) => void;
      const disk = new Promise<NodeFS.StatsFs>((resolve) => {
        finishDisk = resolve;
      });
      fs.statfs.mockReturnValue(disk);
      fs.readFile.mockResolvedValue("some avg10=54.00\nfull avg10=0.00\n");
      yield* Effect.gen(function* () {
        const pressure = yield* StoragePressure.StoragePressure;
        const first = yield* pressure.read.pipe(Effect.forkChild);
        yield* TestClock.adjust("250 millis");
        const snapshot = yield* Fiber.join(first);
        assert.equal(snapshot.reason, "io-pressure");
        assert.equal(snapshot.availableBytes, null);
        yield* TestClock.adjust("6 seconds");
        const second = yield* pressure.read.pipe(Effect.forkChild);
        yield* TestClock.adjust("250 millis");
        assert.equal((yield* Fiber.join(second)).reason, "io-pressure");
        assert.equal(fs.statfs.mock.calls.length, 1);
        assert.equal(fs.readFile.mock.calls.length, 2);
        finishDisk({
          type: 0,
          bsize: 4096,
          blocks: 1_000_000,
          bfree: 900_000,
          bavail: 900_000,
          files: 1000,
          ffree: 900,
        });
        yield* Effect.promise(() => disk);
      }).pipe(
        Effect.provide(
          StoragePressure.layerForDatabase("/fixture/state.sqlite").pipe(
            Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
          ),
        ),
      );
    }),
);

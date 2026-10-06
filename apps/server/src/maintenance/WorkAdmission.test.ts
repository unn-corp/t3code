import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { assertAdmitting, MaintenanceWorkHeld, WorkAdmission, withWork } from "./WorkAdmission.ts";

const admission = (log: string[], held = false) => ({
  acquire: held
    ? Effect.fail(new MaintenanceWorkHeld({ cause: "fenced" }))
    : Effect.sync(() => {
        log.push("acquire");
        return () => Effect.sync(() => void log.push("release"));
      }),
  check: held
    ? Effect.fail(new MaintenanceWorkHeld({ cause: "fenced" }))
    : Effect.sync(() => void log.push("check")),
});

describe("work admission", () => {
  it.effect(
    "holds a lease around the work and releases it whether the work succeeds, fails or is interrupted",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        yield* withWork(Effect.sync(() => void log.push("work"))).pipe(
          Effect.provideService(WorkAdmission, admission(log)),
        );
        yield* withWork(Effect.fail("boom")).pipe(
          Effect.provideService(WorkAdmission, admission(log)),
          Effect.ignore,
        );
        const running = yield* Effect.forkChild(
          withWork(Effect.never).pipe(Effect.provideService(WorkAdmission, admission(log))),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(running);
        expect(log).toEqual([
          "acquire",
          "work",
          "release",
          "acquire",
          "release",
          "acquire",
          "release",
        ]);
      }),
  );

  it.effect("never runs the work while the fence is held, and says why", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const exit = yield* withWork(Effect.sync(() => void log.push("work"))).pipe(
        Effect.provideService(WorkAdmission, admission(log, true)),
        Effect.flip,
      );
      expect(exit._tag).toBe("MaintenanceWorkHeld");
      expect(exit.message).toContain("holding new work");
      expect(log).toEqual([]);
    }),
  );

  it.effect("checks admission without holding a lease, for streams and subscriptions", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      yield* assertAdmitting.pipe(Effect.provideService(WorkAdmission, admission(log)));
      expect(log).toEqual(["check"]);
      expect(
        (yield* assertAdmitting.pipe(
          Effect.provideService(WorkAdmission, admission(log, true)),
          Effect.flip,
        ))._tag,
      ).toBe("MaintenanceWorkHeld");
    }),
  );

  it.effect("admits everything when no coordinator is installed (isolated tests)", () =>
    Effect.gen(function* () {
      expect(yield* withWork(Effect.succeed(42))).toBe(42);
      yield* assertAdmitting;
    }),
  );
});

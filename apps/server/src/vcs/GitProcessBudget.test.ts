import { assert, describe, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as GitProcessBudget from "./GitProcessBudget.ts";

describe("GitProcessBudget", () => {
  it.effect("limits heavy work across repositories while metadata reads can proceed", () =>
    Effect.gen(function* () {
      const budget = yield* GitProcessBudget.make.pipe(Effect.provide(NodePath.layer));
      const entered = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        budget.withPermit(
          cwd,
          args,
          Queue.offer(entered, cwd).pipe(Effect.andThen(Deferred.await(release))),
        );
      const first = yield* run("/repo/a", ["-c", "core.fsmonitor=false", "diff"]).pipe(
        Effect.forkChild,
      );
      const second = yield* run("/repo/b", ["custom-heavy-alias"]).pipe(Effect.forkChild);
      assert.deepStrictEqual(
        new Set([yield* Queue.take(entered), yield* Queue.take(entered)]),
        new Set(["/repo/a", "/repo/b"]),
      );
      const third = yield* run("/repo/c", ["add", "-A"]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(yield* Queue.size(entered), 0);
      assert.equal(
        yield* budget.withPermit("/repo/a", ["rev-parse", "HEAD"], Effect.succeed("read")),
        "read",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.joinAll([first, second, third]);
    }),
  );

  it.effect("serializes one checkout without blocking another and releases on cancellation", () =>
    Effect.gen(function* () {
      const budget = yield* GitProcessBudget.make.pipe(Effect.provide(NodePath.layer));
      const entered = yield* Deferred.make<void>();
      const holder = yield* budget
        .withPermit(
          "/repo",
          ["status"],
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const queued = yield* Deferred.make<void>();
      const waiter = yield* budget
        .withPermit("/repo/.", ["diff"], Deferred.succeed(queued, undefined))
        .pipe(Effect.forkChild);
      assert.equal(
        yield* budget.withPermit("/other", ["add", "-A"], Effect.succeed("other")),
        "other",
      );
      assert.isFalse(yield* Deferred.isDone(queued));
      yield* Fiber.interrupt(holder);
      yield* Fiber.join(waiter);
      assert.isTrue(yield* Deferred.isDone(queued));
    }),
  );
});

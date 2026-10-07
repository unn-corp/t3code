// @effect-diagnostics nodeBuiltinImport:off - monotonic timing must include time spent blocked inside synchronous SQLite calls.
import * as NodePerfHooks from "node:perf_hooks";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";

export const operationDuration = Metric.timer("t3_sqlite_operation_duration", {
  description:
    "Native synchronous SQLite call time, including storage and lock waits, excluding connection queue and Effect scheduling time.",
});

type Operation = "open" | "close" | "prepare" | "execute";
const SLOW_OPERATION_MS = 250;
const WARNING_INTERVAL_MS = 60_000;

/** One warning budget per connection; the injectable monotonic clock keeps tests deterministic. */
export const make = (now: () => number = () => NodePerfHooks.performance.now()) => {
  let lastWarning = -Infinity;
  const timers = Object.fromEntries(
    (["open", "close", "prepare", "execute"] as const).map((operation) => [
      operation,
      Metric.withAttributes(operationDuration, { operation }),
    ]),
  );
  return <A, E>(
    operation: Operation,
    run: () => A,
    onError: (cause: unknown) => E,
  ): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      let timing: { started: number; durationMs: number } | undefined;
      const exit = yield* Effect.exit(
        Effect.try({
          try: () => {
            const started = now();
            try {
              return run();
            } finally {
              timing = { started, durationMs: Math.max(0, now() - started) };
            }
          },
          catch: onError,
        }),
      );
      if (!timing) return yield* exit;
      const { started, durationMs } = timing;
      const outcome = Exit.isSuccess(exit) ? "success" : "failure";
      yield* Metric.update(timers[operation]!, Duration.millis(durationMs));
      if (durationMs >= SLOW_OPERATION_MS && started - lastWarning >= WARNING_INTERVAL_MS) {
        lastWarning = started;
        yield* Effect.logWarning("SQLite operation blocked the server", {
          operation,
          durationMs: Math.round(durationMs),
          outcome,
        }).pipe(
          Effect.withSpan("sqlite.operation.slow", {
            level: "Warn",
            attributes: { operation, durationMs: Math.round(durationMs), outcome },
          }),
        );
      }
      return yield* exit;
    });
};

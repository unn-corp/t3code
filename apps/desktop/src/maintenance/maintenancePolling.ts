import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Activity must keep reporting while a serialized controller action waits for
 * post-fence acknowledgements. Sharing its loop with tick can make the desktop
 * block its own installation with a stale heartbeat.
 */
export const startMaintenancePolling = <ObserveError, TickError>(input: {
  readonly observe: Effect.Effect<unknown, ObserveError>;
  readonly tick: Effect.Effect<unknown, TickError>;
}) =>
  Effect.gen(function* () {
    const repeat = <E>(work: Effect.Effect<unknown, E>) =>
      work.pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(Duration.seconds(5))),
        Effect.forkScoped,
      );
    yield* repeat(input.observe);
    yield* repeat(input.tick);
  });

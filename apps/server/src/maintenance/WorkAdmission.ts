import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class MaintenanceWorkHeld extends Schema.TaggedError<MaintenanceWorkHeld>()(
  "MaintenanceWorkHeld",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Device maintenance is holding new work until verification or recovery completes.";
  }
}

export interface WorkAdmissionShape {
  /** Takes a lease that blocks installation until released. Fails while a transaction holds the fence. */
  readonly acquire: Effect.Effect<() => Effect.Effect<void>, MaintenanceWorkHeld>;
  /** Admission without a lease, for streams and subscriptions that must not hold an update open. */
  readonly check: Effect.Effect<void, MaintenanceWorkHeld>;
}

/** Production composition installs the host coordinator. Isolated domain tests use no host files. */
export const WorkAdmission = Context.Reference<WorkAdmissionShape>("t3/maintenance/WorkAdmission", {
  defaultValue: () => ({ acquire: Effect.succeed(() => Effect.void), check: Effect.void }),
});

/** Runs a mutation under a lease. Every external write path goes through this or `assertAdmitting`. */
export const withWork = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MaintenanceWorkHeld, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const admission = yield* WorkAdmission;
      yield* Effect.acquireRelease(admission.acquire, (release) => release());
      return yield* effect;
    }),
  );

export const assertAdmitting: Effect.Effect<void, MaintenanceWorkHeld> = Effect.gen(function* () {
  const admission = yield* WorkAdmission;
  yield* admission.check;
});

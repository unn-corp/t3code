import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const PASSIVE_DIAGNOSTIC_POST_PATH = "/api/observability/v1/traces";

/** Only this bounded telemetry ingestion route is passive; all other HTTP writes are active. */
export const isPassiveDiagnosticWrite = (method: string, url: string): boolean => {
  if (method !== "POST") return false;
  try {
    return new URL(url, "http://localhost").pathname === PASSIVE_DIAGNOSTIC_POST_PATH;
  } catch {
    return false;
  }
};

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

const isMaintenanceWorkHeld = Schema.is(MaintenanceWorkHeld);

export interface WorkAdmissionShape {
  /** Takes a lease that blocks installation until released. Fails while a transaction holds the fence. */
  readonly acquire: Effect.Effect<() => Effect.Effect<void>, MaintenanceWorkHeld>;
  /** Blocks fencing while a short diagnostic write is active without resetting agent idleness. */
  readonly acquirePassive: Effect.Effect<() => Effect.Effect<void>, MaintenanceWorkHeld>;
  /** Admission without a lease, for streams and subscriptions that must not hold an update open. */
  readonly check: Effect.Effect<void, MaintenanceWorkHeld>;
  /** Blocks restored autonomous work until a person reviews its schedules and queues. */
  readonly checkAutomation: Effect.Effect<void, MaintenanceWorkHeld>;
}

/** Production composition installs the host coordinator. Isolated domain tests use no host files. */
export const WorkAdmission = Context.Reference<WorkAdmissionShape>("t3/maintenance/WorkAdmission", {
  defaultValue: () => ({
    acquire: Effect.succeed(() => Effect.void),
    acquirePassive: Effect.succeed(() => Effect.void),
    check: Effect.void,
    checkAutomation: Effect.void,
  }),
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

/** Runs bounded autonomous work under both the device fence and restored-automation review hold. */
export const withAutomationWork = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MaintenanceWorkHeld, R> =>
  Effect.gen(function* () {
    const admission = yield* WorkAdmission;
    yield* admission.checkAutomation;
    return yield* withWork(effect);
  });

/** Re-admits a detached autonomous worker after a hold clears, retaining its durable work. */
export const retryAutomationWork = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MaintenanceWorkHeld, R> => {
  const loop: Effect.Effect<A, E | MaintenanceWorkHeld, R> = Effect.suspend(() =>
    Effect.exit(withAutomationWork(effect)).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
        const failure = Cause.squash(exit.cause);
        if (!isMaintenanceWorkHeld(failure)) return Effect.failCause(exit.cause);
        return Effect.sleep(Duration.seconds(1)).pipe(Effect.andThen(loop));
      }),
    ),
  );
  return loop;
};

/** Runs a bounded diagnostic write under a fence-blocking lease without counting it as agent activity. */
export const withPassiveWork = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MaintenanceWorkHeld, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const admission = yield* WorkAdmission;
      yield* Effect.acquireRelease(admission.acquirePassive, (release) => release());
      return yield* effect;
    }),
  );

export const assertAdmitting: Effect.Effect<void, MaintenanceWorkHeld> = Effect.gen(function* () {
  const admission = yield* WorkAdmission;
  yield* admission.check;
});

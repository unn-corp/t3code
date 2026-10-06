import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import {
  processCreationIdentities,
  processCreationIdentity,
  UNKNOWN_PROCESS_IDENTITY,
  type ProcessIdentityResult,
} from "@t3tools/shared/forkMaintenanceStore";

export type IdleProcessRootKind = "provider" | "terminal";

export interface IdleProcessRoot {
  readonly pid: number;
  readonly started: string;
  readonly kind: IdleProcessRootKind;
}

export interface IdleProcessRootsShape {
  /** Registers an exact process identity until its owning process scope ends. */
  readonly register: (
    pid: number,
    kind: IdleProcessRootKind,
    isCurrent: Effect.Effect<boolean>,
  ) => Effect.Effect<Effect.Effect<void>>;
  readonly snapshot: Effect.Effect<ReadonlyArray<IdleProcessRoot>>;
  readonly identify: (pids: ReadonlyArray<number>) => Promise<ReadonlyArray<ProcessIdentityResult>>;
}

export class IdleProcessRoots extends Context.Service<IdleProcessRoots, IdleProcessRootsShape>()(
  "t3/maintenance/IdleProcessRoots",
) {}

export const make = Effect.gen(function* () {
  const entries = yield* Ref.make<ReadonlyMap<string, IdleProcessRoot>>(new Map());
  const register: IdleProcessRootsShape["register"] = (pid, kind, isCurrent) =>
    Effect.suspend(() => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return Effect.succeed(Effect.void);
      return Effect.exit(isCurrent).pipe(
        Effect.flatMap((currentBefore) => {
          if (Exit.isFailure(currentBefore) || !currentBefore.value)
            return Effect.succeed(Effect.void);
          return Effect.tryPromise({
            try: () => processCreationIdentity(pid),
            catch: () => null,
          }).pipe(
            Effect.orElseSucceed(() => null),
            Effect.flatMap((started) => {
              // An unobservable or already-exited process never receives an idle exemption.
              if (started === null) return Effect.succeed(Effect.void);
              return Effect.exit(isCurrent).pipe(
                Effect.flatMap((currentAfter) => {
                  if (Exit.isFailure(currentAfter) || !currentAfter.value)
                    return Effect.succeed(Effect.void);
                  const key = `${pid}:${started}`;
                  const root = { pid, started, kind } satisfies IdleProcessRoot;
                  let released = false;
                  const release = Effect.suspend(() => {
                    if (released) return Effect.void;
                    released = true;
                    return Ref.update(entries, (current) => {
                      const next = new Map(current);
                      next.delete(key);
                      return next;
                    });
                  });
                  return Ref.update(entries, (current) => new Map(current).set(key, root)).pipe(
                    Effect.as(release),
                  );
                }),
              );
            }),
          );
        }),
      );
    });
  const snapshot = Ref.get(entries).pipe(Effect.map((current) => [...current.values()]));
  const identify: IdleProcessRootsShape["identify"] = processCreationIdentities;
  return IdleProcessRoots.of({ register, snapshot, identify });
});

export const layer = Layer.effect(IdleProcessRoots, make);

/**
 * Provider and terminal spawn sites run in several independently composed layers. The production
 * server provides one shared registry; a composition without it deliberately gets no exemption,
 * leaving the live process visible to the coordinator as blocking work.
 */
export const registerIdleProcessRoot = (
  pid: number,
  kind: IdleProcessRootKind,
  isCurrent: Effect.Effect<boolean>,
): Effect.Effect<Effect.Effect<void>> =>
  Effect.serviceOption(IdleProcessRoots).pipe(
    Effect.flatMap((service) =>
      service._tag === "Some"
        ? service.value.register(pid, kind, isCurrent)
        : Effect.succeed(Effect.void),
    ),
  );

export interface ProcessIdentityObservation {
  readonly pid: number;
  readonly label: string;
  readonly result:
    | { readonly kind: "present"; readonly identity: string }
    | { readonly kind: "absent" }
    | { readonly kind: "unreadable" };
}

/** Only an exact provider service root is idle infrastructure; every terminal shell is unverified work. */
export const classifyProcessActivity = (
  participantId: string,
  observations: ReadonlyArray<ProcessIdentityObservation>,
  roots: ReadonlyArray<IdleProcessRoot>,
) => {
  const rootsByKey = new Map(roots.map((root) => [`${root.pid}:${root.started}`, root]));
  const descendants: Array<{ pid: number; started: string; label: string }> = [];
  const blockers: Array<{
    participantId: string;
    reason: "background-work" | "commands" | "unknown-participant";
    label: string;
  }> = [];
  for (const observation of observations) {
    if (observation.result.kind === "absent") continue;
    if (observation.result.kind === "unreadable") {
      descendants.push({
        pid: observation.pid,
        started: UNKNOWN_PROCESS_IDENTITY,
        label: observation.label.slice(0, 120),
      });
      blockers.push({
        participantId,
        reason: "unknown-participant",
        label: "A process identity could not be verified.",
      });
      continue;
    }
    const { identity } = observation.result;
    descendants.push({
      pid: observation.pid,
      started: identity,
      label: observation.label.slice(0, 120),
    });
    const root = rootsByKey.get(`${observation.pid}:${identity}`);
    if (root?.kind === "provider") continue;
    if (root?.kind === "terminal") {
      blockers.push({
        participantId,
        reason: "commands",
        label:
          "A terminal shell is still open. Close it after its work finishes because command state cannot be verified.",
      });
      continue;
    }
    blockers.push({
      participantId,
      reason: "background-work",
      label: "A live process outside a registered service root is still running.",
    });
  }
  return { descendants, blockers };
};

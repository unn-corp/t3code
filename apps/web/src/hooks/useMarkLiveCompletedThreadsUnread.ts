import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "../state/shell";
import { useUiStateStore } from "../uiStateStore";

export interface CompletedThreadUnreadEnvironment {
  readonly environmentId: EnvironmentId;
  readonly isLive: boolean;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}

export type CompletedThreadUnreadState = ReadonlyMap<
  EnvironmentId,
  ReadonlyMap<ThreadId, string | null>
>;

export interface CompletedThreadUnreadAction {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly completedAt: string;
}

export interface CompletedThreadUnreadTransition {
  readonly state: CompletedThreadUnreadState;
  readonly actions: ReadonlyArray<CompletedThreadUnreadAction>;
}

function eligibleCompletedAt(thread: OrchestrationThreadShell): string | null {
  if (thread.latestTurn?.state !== "completed" || !thread.latestTurn.completedAt) {
    return null;
  }

  const completedAt = Date.parse(thread.latestTurn.completedAt);
  const updatedAt = Date.parse(thread.updatedAt);
  if (!Number.isFinite(completedAt) || !Number.isFinite(updatedAt) || updatedAt < completedAt) {
    return null;
  }

  return thread.latestTurn.completedAt;
}

export function transitionCompletedThreadUnreadState(
  previousState: CompletedThreadUnreadState,
  environments: ReadonlyArray<CompletedThreadUnreadEnvironment>,
): CompletedThreadUnreadTransition {
  const nextState = new Map<EnvironmentId, ReadonlyMap<ThreadId, string | null>>();
  const actions: CompletedThreadUnreadAction[] = [];

  for (const environment of environments) {
    const previousCompletions = previousState.get(environment.environmentId);
    if (!environment.isLive) {
      // Keep the last live observations while a known environment reconnects,
      // but do not treat bootstrap or catch-up snapshots as new completions.
      if (previousCompletions !== undefined) {
        nextState.set(environment.environmentId, previousCompletions);
      }
      continue;
    }

    const currentCompletions = new Map<ThreadId, string | null>();
    for (const thread of environment.threads) {
      const completedAt = eligibleCompletedAt(thread);
      currentCompletions.set(thread.id, completedAt);

      if (
        // An absent previous map means this is the environment's initial live
        // snapshot, whose historical completions establish the read baseline.
        previousCompletions !== undefined &&
        completedAt !== null &&
        thread.archivedAt === null &&
        (!previousCompletions.has(thread.id) || previousCompletions.get(thread.id) !== completedAt)
      ) {
        actions.push({
          environmentId: environment.environmentId,
          threadId: thread.id,
          completedAt,
        });
      }
    }
    nextState.set(environment.environmentId, currentCompletions);
  }

  return { state: nextState, actions };
}

const completedThreadUnreadEnvironmentsAtom = Atom.make(
  (get): ReadonlyArray<CompletedThreadUnreadEnvironment> => {
    const environments: CompletedThreadUnreadEnvironment[] = [];
    for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
      const shellState = get(environmentShell.stateValueAtom(environmentId));
      environments.push({
        environmentId,
        isLive: shellState.status === "live",
        threads: Option.match(shellState.snapshot, {
          onNone: () => [],
          onSome: (snapshot) => snapshot.threads,
        }),
      });
    }
    return environments;
  },
).pipe(Atom.withLabel("completed-thread-unread:environments"));

export function useMarkLiveCompletedThreadsUnread(): void {
  const environments = useAtomValue(completedThreadUnreadEnvironmentsAtom);
  const stateRef = useRef<CompletedThreadUnreadState>(new Map());

  useEffect(() => {
    const transition = transitionCompletedThreadUnreadState(stateRef.current, environments);
    stateRef.current = transition.state;

    const uiState = useUiStateStore.getState();
    for (const action of transition.actions) {
      uiState.markThreadUnread(
        scopedThreadKey(scopeThreadRef(action.environmentId, action.threadId)),
        action.completedAt,
      );
    }
  }, [environments]);
}

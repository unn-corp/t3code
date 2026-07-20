import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurnState,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  transitionCompletedThreadUnreadState,
  type CompletedThreadUnreadEnvironment,
  type CompletedThreadUnreadState,
} from "./useMarkLiveCompletedThreadsUnread";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const COMPLETED_AT = "2026-06-17T18:30:00.000Z";

function makeThread(input: {
  readonly id: string;
  readonly state?: OrchestrationLatestTurnState;
  readonly completedAt?: string | null;
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
}): OrchestrationThreadShell {
  const threadId = ThreadId.make(input.id);
  const state = input.state ?? "completed";
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: input.id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make(`turn-${input.id}`),
      state,
      requestedAt: "2026-06-17T18:00:00.000Z",
      startedAt: "2026-06-17T18:00:01.000Z",
      completedAt: input.completedAt === undefined ? COMPLETED_AT : input.completedAt,
      assistantMessageId: null,
    },
    createdAt: "2026-06-17T18:00:00.000Z",
    updatedAt: input.updatedAt ?? COMPLETED_AT,
    archivedAt: input.archivedAt ?? null,
    session: null,
    latestUserMessageAt: "2026-06-17T18:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function environment(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  isLive = true,
): CompletedThreadUnreadEnvironment {
  return { environmentId: ENVIRONMENT_ID, isLive, threads };
}

function bootstrap(threads: ReadonlyArray<OrchestrationThreadShell> = []) {
  return transitionCompletedThreadUnreadState(new Map(), [environment(threads)]);
}

describe("transitionCompletedThreadUnreadState", () => {
  it("keeps completed threads in the initial historical snapshot read", () => {
    const historical = makeThread({ id: "historical" });

    const transition = bootstrap([historical]);

    expect(transition.actions).toEqual([]);
    expect(transition.state.get(ENVIRONMENT_ID)?.get(historical.id)).toBe(COMPLETED_AT);
  });

  it("marks a first-seen live completed thread unread when updatedAt equals completedAt", () => {
    const initial = bootstrap();
    const completed = makeThread({ id: "live-equal" });

    const transition = transitionCompletedThreadUnreadState(initial.state, [
      environment([completed]),
    ]);

    expect(transition.actions).toEqual([
      { environmentId: ENVIRONMENT_ID, threadId: completed.id, completedAt: COMPLETED_AT },
    ]);
  });

  it("marks a first-seen live completed thread unread when updatedAt is after completedAt", () => {
    const initial = bootstrap();
    const completed = makeThread({
      id: "live-later",
      updatedAt: "2026-06-17T18:31:00.000Z",
    });

    const transition = transitionCompletedThreadUnreadState(initial.state, [
      environment([completed]),
    ]);

    expect(transition.actions).toEqual([
      { environmentId: ENVIRONMENT_ID, threadId: completed.id, completedAt: COMPLETED_AT },
    ]);
  });

  it("marks a completed thread introduced by a post-bootstrap snapshot unread", () => {
    const historical = makeThread({ id: "historical" });
    const initial = bootstrap([historical]);
    const added = makeThread({ id: "snapshot-addition" });

    const transition = transitionCompletedThreadUnreadState(initial.state, [
      environment([historical, added]),
    ]);

    expect(transition.actions).toEqual([
      { environmentId: ENVIRONMENT_ID, threadId: added.id, completedAt: COMPLETED_AT },
    ]);
  });

  it("marks a previously running background thread when it completes", () => {
    const running = makeThread({ id: "background", state: "running", completedAt: null });
    const initial = bootstrap([running]);
    const completed = makeThread({ id: "background" });

    const transition = transitionCompletedThreadUnreadState(initial.state, [
      environment([completed]),
    ]);

    expect(transition.actions).toEqual([
      { environmentId: ENVIRONMENT_ID, threadId: completed.id, completedAt: COMPLETED_AT },
    ]);
  });

  it("preserves observations across reconnect snapshots without repeating unread actions", () => {
    const completed = makeThread({ id: "completed" });
    const initial = bootstrap([completed]);

    const synchronizing = transitionCompletedThreadUnreadState(initial.state, [
      environment([], false),
    ]);
    const reconnected = transitionCompletedThreadUnreadState(synchronizing.state, [
      environment([completed]),
    ]);

    expect(synchronizing.actions).toEqual([]);
    expect(synchronizing.state).toEqual(initial.state);
    expect(reconnected.actions).toEqual([]);
  });

  it("does not repeat an unread action after reconnecting", () => {
    const initial = bootstrap();
    const completed = makeThread({ id: "completed" });
    const firstSeen = transitionCompletedThreadUnreadState(initial.state, [
      environment([completed]),
    ]);
    const synchronizing = transitionCompletedThreadUnreadState(firstSeen.state, [
      environment([completed], false),
    ]);
    const reconnected = transitionCompletedThreadUnreadState(synchronizing.state, [
      environment([completed]),
    ]);

    expect(firstSeen.actions).toHaveLength(1);
    expect(reconnected.actions).toEqual([]);
  });

  it("waits for a completion-consistent updatedAt before marking unread", () => {
    const initial = bootstrap();
    const stale = makeThread({
      id: "stale",
      updatedAt: "2026-06-17T18:29:59.000Z",
    });
    const staleTransition = transitionCompletedThreadUnreadState(initial.state, [
      environment([stale]),
    ]);
    const consistent = makeThread({ id: "stale" });
    const consistentTransition = transitionCompletedThreadUnreadState(staleTransition.state, [
      environment([consistent]),
    ]);

    expect(staleTransition.actions).toEqual([]);
    expect(consistentTransition.actions).toEqual([
      { environmentId: ENVIRONMENT_ID, threadId: consistent.id, completedAt: COMPLETED_AT },
    ]);
  });

  it("does not mark interrupted or error turns as completed", () => {
    const initial = bootstrap();
    const interrupted = makeThread({ id: "interrupted", state: "interrupted" });
    const failed = makeThread({ id: "failed", state: "error" });

    const transition = transitionCompletedThreadUnreadState(initial.state, [
      environment([interrupted, failed]),
    ]);

    expect(transition.actions).toEqual([]);
    expect(transition.state.get(ENVIRONMENT_ID)).toEqual(
      new Map([
        [interrupted.id, null],
        [failed.id, null],
      ]),
    );
  });

  it("treats a removed and re-added environment as a fresh historical bootstrap", () => {
    const historical = makeThread({ id: "historical" });
    const initial = bootstrap([historical]);
    const removed = transitionCompletedThreadUnreadState(initial.state, []);
    const readded = transitionCompletedThreadUnreadState(removed.state, [
      environment([historical]),
    ]);

    expect(removed.state).toEqual(new Map() satisfies CompletedThreadUnreadState);
    expect(readded.actions).toEqual([]);
  });
});

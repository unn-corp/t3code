import type { AgentNotificationEvent, AgentNotificationKind } from "@t3tools/contracts";
import { projectThreadAwareness, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { useEffect, useRef } from "react";

import { useProjects, useThreadShells } from "../state/entities";
import { getClientSettings } from "../hooks/useSettings";
import { playAgentNotificationSound } from "./sound";

type ThreadSnapshot = {
  readonly phase: AgentAwarenessPhase | null;
  readonly hasActionableProposedPlan: boolean;
  readonly updatedAt: string;
};

function eventKindForTransition(
  previous: ThreadSnapshot,
  next: ThreadSnapshot,
): AgentNotificationKind | null {
  if (!previous.hasActionableProposedPlan && next.hasActionableProposedPlan) {
    return "plan_ready";
  }
  if (
    (next.phase === "waiting_for_approval" || next.phase === "waiting_for_input") &&
    next.phase !== previous.phase
  ) {
    return "input_required";
  }
  if (next.phase === "failed" && next.phase !== previous.phase) {
    return "agent_failed";
  }
  if (next.phase === "completed" && next.phase !== previous.phase) {
    return "agent_completed";
  }
  return null;
}

/**
 * Emits local desktop notifications only for live state transitions. The
 * initial snapshot deliberately primes the cache without notifying, so a
 * renderer restart cannot replay old agent work as fresh notifications.
 *
 * Remote delivery will consume the same event contract from the server's
 * durable outbox; this coordinator remains intentionally local to Electron.
 */
export function DesktopAgentNotificationCoordinator() {
  const projects = useProjects();
  const threads = useThreadShells();
  const snapshots = useRef(new Map<string, ThreadSnapshot>());

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.showAgentNotification !== "function") {
      return;
    }

    const projectsByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
    );
    const nextSnapshots = new Map<string, ThreadSnapshot>();

    for (const thread of threads) {
      const project = projectsByKey.get(`${thread.environmentId}:${thread.projectId}`);
      if (!project) continue;

      const awareness = projectThreadAwareness({
        environmentId: thread.environmentId,
        project,
        thread,
      });
      const key = `${thread.environmentId}:${thread.id}`;
      const next = {
        phase: awareness?.phase ?? null,
        hasActionableProposedPlan: thread.hasActionableProposedPlan,
        updatedAt: thread.updatedAt,
      } satisfies ThreadSnapshot;
      nextSnapshots.set(key, next);

      const previous = snapshots.current.get(key);
      if (!previous || !awareness) continue;
      const kind = eventKindForTransition(previous, next);
      if (!kind) continue;

      const event: AgentNotificationEvent = {
        eventId:
          `desktop:${thread.environmentId}:${thread.id}:${kind}:${next.updatedAt}` as AgentNotificationEvent["eventId"],
        environmentId: thread.environmentId,
        threadId: thread.id,
        kind,
        occurredAt: next.updatedAt,
        deepLink: awareness.deepLink as AgentNotificationEvent["deepLink"],
        projectTitle: awareness.projectTitle,
        threadTitle: awareness.threadTitle,
        ...(kind === "input_required"
          ? { inputKind: awareness.phase === "waiting_for_approval" ? "approval" : "input" }
          : {}),
        ...(kind === "plan_ready" ? { planUpdatedAt: next.updatedAt } : {}),
      };
      void bridge
        .showAgentNotification(event)
        .then((outcome) => {
          if (outcome === "attempted" && getClientSettings().agentNotifications.playSound) {
            playAgentNotificationSound(kind);
          }
        })
        .catch(() => {});
    }

    snapshots.current = nextSnapshots;
  }, [projects, threads]);

  return null;
}

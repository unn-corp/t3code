import type { AgentNotificationKind } from "@t3tools/contracts";

const SOUND_BY_NOTIFICATION_KIND: Record<AgentNotificationKind, string> = {
  agent_completed: "/sounds/agent-completed.ogg",
  plan_ready: "/sounds/plan-ready.ogg",
  input_required: "/sounds/input-required.ogg",
  agent_failed: "/sounds/agent-failed.ogg",
};

/**
 * Supplements the operating system's notification sound when the renderer is
 * alive. Browsers can reject background playback, so delivery remains
 * best-effort and the native notification is always shown independently.
 */
export function playAgentNotificationSound(kind: AgentNotificationKind): void {
  const audio = new Audio(SOUND_BY_NOTIFICATION_KIND[kind]);
  audio.volume = kind === "input_required" ? 0.65 : 0.45;
  void audio.play().catch(() => {});
}

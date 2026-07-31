import type {
  AgentNotificationKind,
  AgentNotificationSoundId,
  AgentNotificationSounds,
} from "@t3tools/contracts";

type SoundAsset = {
  readonly label: string;
  readonly url: string;
  /**
   * Playback gain. The bundled samples were mastered at wildly different levels
   * (their RMS spans ~13 dB), so a single volume would make switching sounds
   * jump in loudness. Each gain is derived from the file's measured RMS to land
   * every option at a comparable perceived level.
   */
  readonly gain: number;
};

const SOUND_ASSETS: Record<Exclude<AgentNotificationSoundId, "none">, SoundAsset> = {
  "chime-soft": { label: "Chime", url: "/sounds/chime-soft.ogg", gain: 0.18 },
  marimba: { label: "Marimba", url: "/sounds/marimba.ogg", gain: 0.16 },
  ping: { label: "Ping", url: "/sounds/ping.ogg", gain: 0.13 },
  bloom: { label: "Bloom", url: "/sounds/bloom.ogg", gain: 0.16 },
  pluck: { label: "Pluck", url: "/sounds/pluck.ogg", gain: 0.41 },
  knock: { label: "Knock", url: "/sounds/knock.ogg", gain: 0.15 },
  descend: { label: "Descend", url: "/sounds/descend.ogg", gain: 0.17 },
  alert: { label: "Alert", url: "/sounds/alert.ogg", gain: 0.12 },
  "original-chimes": {
    label: "Original chimes",
    url: "/sounds/agent-completed.ogg",
    gain: 0.83,
  },
  "original-ding": { label: "Original ding", url: "/sounds/plan-ready.ogg", gain: 0.58 },
  "original-alarm": { label: "Original alarm", url: "/sounds/input-required.ogg", gain: 0.3 },
  "original-negative": { label: "Original buzz", url: "/sounds/agent-failed.ogg", gain: 1 },
};

export function agentNotificationSoundLabel(id: AgentNotificationSoundId): string {
  return id === "none" ? "None" : SOUND_ASSETS[id].label;
}

/**
 * Supplements the operating system's notification sound when the renderer is
 * alive. Browsers can reject background playback, so delivery remains
 * best-effort and the native notification is always shown independently.
 */
export function playAgentNotificationSoundId(id: AgentNotificationSoundId): void {
  if (id === "none") return;
  const asset = SOUND_ASSETS[id];
  const audio = new Audio(asset.url);
  audio.volume = asset.gain;
  void audio.play().catch(() => {});
}

export function playAgentNotificationSound(
  kind: AgentNotificationKind,
  sounds: AgentNotificationSounds,
): void {
  playAgentNotificationSoundId(sounds[kind]);
}

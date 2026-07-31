import { describe, expect, it, vi } from "vite-plus/test";
import {
  AGENT_NOTIFICATION_SOUND_IDS,
  DEFAULT_AGENT_NOTIFICATION_SOUNDS,
} from "@t3tools/contracts";

import {
  agentNotificationSoundLabel,
  playAgentNotificationSound,
  playAgentNotificationSoundId,
} from "./sound";

type PlayedAudio = { readonly url: string; volume: number };

/** Captures what `playAgentNotificationSound*` would hand to the browser. */
function captureAudio(): { readonly played: PlayedAudio[] } {
  const played: PlayedAudio[] = [];
  vi.stubGlobal(
    "Audio",
    class {
      volume = 1;
      constructor(readonly url: string) {
        played.push(this as unknown as PlayedAudio);
      }
      play() {
        return Promise.resolve();
      }
    },
  );
  return { played };
}

describe("agent notification sound playback", () => {
  it("labels every id in the picker", () => {
    for (const soundId of AGENT_NOTIFICATION_SOUND_IDS) {
      expect(agentNotificationSoundLabel(soundId)).not.toBe("");
    }
    expect(agentNotificationSoundLabel("none")).toBe("None");
  });

  it("plays the sound chosen for the kind", () => {
    const { played } = captureAudio();
    playAgentNotificationSound("plan_ready", {
      ...DEFAULT_AGENT_NOTIFICATION_SOUNDS,
      plan_ready: "marimba",
    });
    expect(played).toHaveLength(1);
    expect(played[0]?.url).toBe("/sounds/marimba.ogg");
  });

  it("stays silent when a kind is set to None", () => {
    const { played } = captureAudio();
    playAgentNotificationSound("agent_failed", {
      ...DEFAULT_AGENT_NOTIFICATION_SOUNDS,
      agent_failed: "none",
    });
    expect(played).toHaveLength(0);
  });

  it("keeps every option's playback gain in range", () => {
    for (const soundId of AGENT_NOTIFICATION_SOUND_IDS) {
      const { played } = captureAudio();
      playAgentNotificationSoundId(soundId);
      for (const audio of played) {
        expect(audio.volume).toBeGreaterThan(0);
        expect(audio.volume).toBeLessThanOrEqual(1);
      }
    }
  });
});

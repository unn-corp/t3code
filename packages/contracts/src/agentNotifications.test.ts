import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AGENT_NOTIFICATION_SOUND_IDS,
  AgentNotificationEvent,
  AgentNotificationPreferences,
  AgentNotificationSoundId,
  DEFAULT_AGENT_NOTIFICATION_PREFERENCES,
  DEFAULT_AGENT_NOTIFICATION_SOUNDS,
  isAgentNotificationEnabled,
} from "./agentNotifications.ts";

const decode = Schema.decodeUnknownSync(AgentNotificationEvent);

describe("AgentNotificationEvent", () => {
  const base = {
    eventId: "event-1",
    environmentId: "environment-1",
    threadId: "thread-1",
    kind: "agent_completed",
    occurredAt: "2026-07-23T12:00:00.000Z",
    deepLink: "/threads/environment-1/thread-1",
  } as const;

  it("accepts a relative thread route", () => {
    expect(decode(base).deepLink).toBe(base.deepLink);
  });

  it.each([
    "https://example.com",
    "/threads/a/b?token=x",
    "/threads/a/b/c",
    "/threads/env%2Fother/thread",
    "/threads/env%zz/thread",
  ])("rejects non-canonical notification route %s", (deepLink) => {
    expect(() => decode({ ...base, deepLink })).toThrow();
  });

  it("applies the matching per-kind preference", () => {
    expect(isAgentNotificationEnabled(DEFAULT_AGENT_NOTIFICATION_PREFERENCES, "plan_ready")).toBe(
      false,
    );
    expect(
      isAgentNotificationEnabled(
        { ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES, enabled: true, notifyOnPlanReady: false },
        "plan_ready",
      ),
    ).toBe(false);
  });
});

describe("agent notification sounds", () => {
  const decodePreferences = Schema.decodeUnknownSync(AgentNotificationPreferences);

  it("offers every sound id exactly once in the picker", () => {
    expect([...AGENT_NOTIFICATION_SOUND_IDS].sort()).toEqual(
      [...AgentNotificationSoundId.literals].sort(),
    );
  });

  it("lists None last so it does not lead the picker", () => {
    expect(AGENT_NOTIFICATION_SOUND_IDS.at(-1)).toBe("none");
  });

  it("defaults completion to the short generated chime, not the original sample", () => {
    expect(DEFAULT_AGENT_NOTIFICATION_SOUNDS.agent_completed).toBe("chime-soft");
  });

  it("backfills sounds for settings saved before the picker existed", () => {
    const { sounds, ...withoutSounds } = DEFAULT_AGENT_NOTIFICATION_PREFERENCES;
    expect(sounds).toEqual(DEFAULT_AGENT_NOTIFICATION_SOUNDS);
    expect(decodePreferences(withoutSounds).sounds).toEqual(DEFAULT_AGENT_NOTIFICATION_SOUNDS);
  });

  it("round-trips a per-kind override", () => {
    const decoded = decodePreferences({
      ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES,
      sounds: { ...DEFAULT_AGENT_NOTIFICATION_SOUNDS, agent_failed: "none" },
    });
    expect(decoded.sounds.agent_failed).toBe("none");
    expect(decoded.sounds.plan_ready).toBe(DEFAULT_AGENT_NOTIFICATION_SOUNDS.plan_ready);
  });

  it("rejects an unknown sound id", () => {
    expect(() =>
      decodePreferences({
        ...DEFAULT_AGENT_NOTIFICATION_PREFERENCES,
        sounds: { ...DEFAULT_AGENT_NOTIFICATION_SOUNDS, agent_completed: "airhorn" },
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AgentNotificationEvent,
  DEFAULT_AGENT_NOTIFICATION_PREFERENCES,
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

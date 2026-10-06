import { describe, expect, it } from "@effect/vitest";

import { createInteractionTracker, INTERACTION_STALE_MS } from "./interaction.ts";

const make = () => {
  const clock = { value: 1_000_000 };
  return { clock, tracker: createInteractionTracker({ now: () => clock.value }) };
};

describe("createInteractionTracker", () => {
  it("has nothing to wait for when there is no window to type in", () => {
    const { tracker } = make();
    expect(tracker.read(false)).toBeNull();
  });

  it("reports the latest input time and upload count the renderer sent", () => {
    const { clock, tracker } = make();
    tracker.report({ inputActiveAt: clock.value - 10_000, uploadsInFlight: 2 });
    clock.value += 5_000;
    expect(tracker.read(true)).toEqual({ inputActiveAt: 990_000, uploadsInFlight: 2 });
    tracker.report({ inputActiveAt: null, uploadsInFlight: 0 });
    expect(tracker.read(true)).toEqual({ inputActiveAt: 990_000, uploadsInFlight: 0 });
  });

  it("never lets a late or skewed report make a person look idle sooner or active in the future", () => {
    const { clock, tracker } = make();
    tracker.report({ inputActiveAt: clock.value, uploadsInFlight: 0 });
    tracker.report({ inputActiveAt: clock.value - 60_000, uploadsInFlight: 0 });
    expect(tracker.read(true)?.inputActiveAt).toBe(1_000_000);
    tracker.report({ inputActiveAt: clock.value + 3_600_000, uploadsInFlight: 0 });
    expect(tracker.read(true)?.inputActiveAt).toBe(1_000_000);
  });

  it("reads a renderer that stopped reporting as active input, never as idle", () => {
    const { clock, tracker } = make();
    tracker.report({ inputActiveAt: null, uploadsInFlight: 0 });
    clock.value += INTERACTION_STALE_MS + 1;
    expect(tracker.read(true)).toEqual({ inputActiveAt: clock.value, uploadsInFlight: 0 });
  });

  it("treats a window that never reported (an older web build) the same way once the grace period passes", () => {
    const { clock, tracker } = make();
    expect(tracker.read(true)?.inputActiveAt).toBeNull();
    clock.value += INTERACTION_STALE_MS + 1;
    expect(tracker.read(true)?.inputActiveAt).toBe(clock.value);
  });
});

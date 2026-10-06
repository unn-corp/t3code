import type { ForkMaintenanceInteraction } from "@t3tools/contracts";

/** The renderer reports every 30 seconds while it is alive; three missed reports mean it cannot be trusted. */
export const INTERACTION_STALE_MS = 90_000;

/**
 * Renderer-observed input and uploads for the automatic-install gate. Unknown is never idle: a window
 * that stopped reporting (hung, or an older web build with no reporter) reads as active input, so the
 * automatic countdown cannot start behind a person who is typing. Manual installs ignore this.
 */
export function createInteractionTracker(input: { readonly now: () => number }) {
  const startedAt = input.now();
  let lastReportAt: number | null = null;
  let inputActiveAt: number | null = null;
  let uploadsInFlight = 0;
  return {
    report: (report: ForkMaintenanceInteraction) => {
      const now = input.now();
      lastReportAt = now;
      // Input time only moves forward; a late report cannot make a person look idle sooner.
      if (
        report.inputActiveAt !== null &&
        (inputActiveAt === null || report.inputActiveAt > inputActiveAt)
      )
        inputActiveAt = Math.min(report.inputActiveAt, now);
      uploadsInFlight = Math.max(0, report.uploadsInFlight);
    },
    /** Null only when there is no window to type in: then agents and the countdown alone gate installation. */
    read: (hasWindow: boolean): ForkMaintenanceInteraction | null => {
      if (!hasWindow) return null;
      const now = input.now();
      if (now - (lastReportAt ?? startedAt) > INTERACTION_STALE_MS)
        return { inputActiveAt: now, uploadsInFlight };
      return { inputActiveAt, uploadsInFlight };
    },
  };
}
export type InteractionTracker = ReturnType<typeof createInteractionTracker>;

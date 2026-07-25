import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  EnvironmentId,
  EventId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** A privacy-safe, transport-neutral notification emitted by orchestration. */
export const AgentNotificationKind = Schema.Literals([
  "agent_completed",
  "plan_ready",
  "input_required",
  "agent_failed",
]);
export type AgentNotificationKind = typeof AgentNotificationKind.Type;

export const AgentNotificationInputKind = Schema.Literals(["approval", "input"]);
export type AgentNotificationInputKind = typeof AgentNotificationInputKind.Type;

export const AGENT_NOTIFICATION_MAX_TITLE_LENGTH = 120;
const AgentNotificationTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_NOTIFICATION_MAX_TITLE_LENGTH),
);

/**
 * A notification route is deliberately relative. Each channel is responsible
 * for resolving it against its own trusted origin/window.
 */
export const AgentNotificationDeepLink = Schema.String.check(
  // Only accept a relative, two-segment thread route. Percent escapes are
  // validated here and encoded path separators are rejected so a renderer
  // cannot smuggle an arbitrary route through notification click handling.
  Schema.isPattern(
    /^\/threads\/(?![^/]*%(?:2[fF]|5[cC]))(?:[^/?#%]|%[\dA-Fa-f]{2})+\/(?![^/]*%(?:2[fF]|5[cC]))(?:[^/?#%]|%[\dA-Fa-f]{2})+$/u,
  ),
);
export type AgentNotificationDeepLink = typeof AgentNotificationDeepLink.Type;

export const AgentNotificationEvent = Schema.Struct({
  eventId: EventId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  kind: AgentNotificationKind,
  completionId: Schema.optional(TrimmedNonEmptyString),
  failureId: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(TrimmedNonEmptyString),
  inputKind: Schema.optional(AgentNotificationInputKind),
  planId: Schema.optional(TrimmedNonEmptyString),
  planUpdatedAt: Schema.optional(IsoDateTime),
  projectTitle: Schema.optional(AgentNotificationTitle),
  threadTitle: Schema.optional(AgentNotificationTitle),
  occurredAt: IsoDateTime,
  deepLink: AgentNotificationDeepLink,
});
export type AgentNotificationEvent = typeof AgentNotificationEvent.Type;

export const AgentNotificationPreferences = Schema.Struct({
  enabled: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnPlanReady: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
  playSound: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  showProjectAndThreadNames: Schema.Boolean,
});
export type AgentNotificationPreferences = typeof AgentNotificationPreferences.Type;

export const DesktopNotificationAttempt = Schema.Literals([
  "attempted",
  "disabled",
  "suppressed-focused",
  "unsupported",
  "error",
]);
export type DesktopNotificationAttempt = typeof DesktopNotificationAttempt.Type;

export const DEFAULT_AGENT_NOTIFICATION_PREFERENCES: AgentNotificationPreferences = {
  enabled: false,
  notifyOnCompletion: true,
  notifyOnPlanReady: true,
  notifyOnInput: true,
  notifyOnFailure: true,
  playSound: true,
  showProjectAndThreadNames: true,
};

export function isAgentNotificationEnabled(
  preferences: AgentNotificationPreferences,
  kind: AgentNotificationKind,
): boolean {
  if (!preferences.enabled) return false;
  switch (kind) {
    case "agent_completed":
      return preferences.notifyOnCompletion;
    case "plan_ready":
      return preferences.notifyOnPlanReady;
    case "input_required":
      return preferences.notifyOnInput;
    case "agent_failed":
      return preferences.notifyOnFailure;
  }
}

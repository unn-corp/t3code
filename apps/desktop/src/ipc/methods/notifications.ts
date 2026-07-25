import { AgentNotificationEvent, DesktopNotificationAttempt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopNotifications from "../../notifications/DesktopNotifications.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showAgentNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_AGENT_NOTIFICATION_CHANNEL,
  payload: AgentNotificationEvent,
  result: DesktopNotificationAttempt,
  handler: Effect.fn("desktop.ipc.notifications.show")(function* (event) {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    return yield* notifications.show(event);
  }),
});

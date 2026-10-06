import {
  ForkMaintenanceActionInput,
  ForkMaintenanceInteraction,
  ForkRecoveryRequest,
  ForkUpdatePolicyPatch,
  ForkUpdateStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopForkMaintenance from "../../maintenance/DesktopForkMaintenance.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/**
 * The renderer's whole view of device maintenance. Every method is a thin call into the one controller, so a
 * menu click, the settings page, a remote client and an agent all pass the same admission and recovery checks.
 */
export const getMaintenanceStatus = makeIpcMethod({
  channel: IpcChannels.MAINTENANCE_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: ForkUpdateStatus,
  handler: Effect.fn("desktop.ipc.maintenance.getStatus")(function* () {
    return yield* (yield* DesktopForkMaintenance.DesktopForkMaintenance).status;
  }),
});

export const updateMaintenancePolicy = makeIpcMethod({
  channel: IpcChannels.MAINTENANCE_UPDATE_POLICY_CHANNEL,
  payload: ForkUpdatePolicyPatch,
  result: ForkUpdateStatus,
  handler: Effect.fn("desktop.ipc.maintenance.updatePolicy")(function* (patch) {
    return yield* (yield* DesktopForkMaintenance.DesktopForkMaintenance).updatePolicy(patch);
  }),
});

export const runMaintenanceAction = makeIpcMethod({
  channel: IpcChannels.MAINTENANCE_RUN_ACTION_CHANNEL,
  payload: ForkMaintenanceActionInput,
  result: ForkUpdateStatus,
  handler: Effect.fn("desktop.ipc.maintenance.runAction")(function* (input) {
    return yield* (yield* DesktopForkMaintenance.DesktopForkMaintenance).runAction(input);
  }),
});

export const cancelMaintenanceCountdown = makeIpcMethod({
  channel: IpcChannels.MAINTENANCE_CANCEL_COUNTDOWN_CHANNEL,
  payload: Schema.Void,
  result: ForkUpdateStatus,
  handler: Effect.fn("desktop.ipc.maintenance.cancelCountdown")(function* () {
    return yield* (yield* DesktopForkMaintenance.DesktopForkMaintenance).cancelCountdown;
  }),
});

export const reportMaintenanceInteraction = makeIpcMethod({
  channel: IpcChannels.MAINTENANCE_REPORT_INTERACTION_CHANNEL,
  payload: ForkMaintenanceInteraction,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.maintenance.reportInteraction")(function* (input) {
    yield* (yield* DesktopForkMaintenance.DesktopForkMaintenance).reportInteraction(input);
  }),
});

export const requestMaintenanceRecovery = makeIpcMethod({
  channel: IpcChannels.MAINTENANCE_RECOVER_CHANNEL,
  payload: ForkRecoveryRequest,
  result: ForkUpdateStatus,
  handler: Effect.fn("desktop.ipc.maintenance.recover")(function* (request) {
    return yield* (yield* DesktopForkMaintenance.DesktopForkMaintenance).recover(request);
  }),
});

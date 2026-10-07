import { ForkUpdateStatus, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as MaintenanceService from "../../../maintenance/MaintenanceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MaintenanceService.MaintenanceService,
  ],
};

const StatusTool = Tool.make("t3_maintenance_status", {
  ...shared,
  description:
    "Read this device's Arcwright Code update state: current and target build, the activity blocking installation, recovery options, and the homes an update would replace. Read-only.",
  success: ForkUpdateStatus,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CheckTool = Tool.make("t3_maintenance_check", {
  ...shared,
  description:
    "Check for a newer eligible Arcwright Code release and stage it. This never installs. Installation, policy changes and recovery are made by a person (or the device's automatic gate) and are refused while any agent, including this one, is active, so an agent cannot trigger them.",
  success: ForkUpdateStatus,
}).annotate(Tool.Destructive, false);

export const MaintenanceToolkit = Toolkit.make(StatusTool, CheckTool);

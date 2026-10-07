import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as MaintenanceService from "../../../maintenance/MaintenanceService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MaintenanceToolkit } from "./tools.ts";

/** Maintenance failures reach the agent as a plain refusal; the reason is the same one the UI shows. */
const refuse = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });

export const MaintenanceHandlersLive = McpToolAccess.toLayer(MaintenanceToolkit, {
  // Same controller and same service as the WebSocket RPC, the desktop bridge and the CLI.
  t3_maintenance_status: McpToolAccess.readsAsCaller(() =>
    Effect.flatMap(MaintenanceService.MaintenanceService, (maintenance) =>
      maintenance.status.pipe(Effect.mapError(refuse)),
    ),
  ),
  t3_maintenance_check: McpToolAccess.writes(() =>
    Effect.flatMap(MaintenanceService.MaintenanceService, (maintenance) =>
      maintenance.runAction({ action: "check" }).pipe(Effect.mapError(refuse)),
    ),
  ),
});

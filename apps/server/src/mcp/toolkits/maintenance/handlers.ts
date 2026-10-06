import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as MaintenanceService from "../../../maintenance/MaintenanceService.ts";
import { readCaller, readMutationCaller } from "../../threadAccess.ts";
import { MaintenanceToolkit } from "./tools.ts";

/** Maintenance failures reach the agent as a plain refusal; the reason is the same one the UI shows. */
const refuse = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });

export const MaintenanceHandlersLive = MaintenanceToolkit.toLayer({
  // Same controller and same service as the WebSocket RPC, the desktop bridge and the CLI.
  t3_maintenance_status: () =>
    Effect.gen(function* () {
      yield* readCaller();
      const maintenance = yield* MaintenanceService.MaintenanceService;
      return yield* maintenance.status.pipe(Effect.mapError(refuse));
    }),
  t3_maintenance_check: () =>
    Effect.gen(function* () {
      yield* readMutationCaller();
      const maintenance = yield* MaintenanceService.MaintenanceService;
      return yield* maintenance.runAction({ action: "check" }).pipe(Effect.mapError(refuse));
    }),
});

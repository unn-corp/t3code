import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Cloud from "../../../codexCloud/CodexCloudService.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller, assertFullAccess } from "../../threadAccess.ts";
import { CodexCloudToolkit } from "./tools.ts";
const service = (projectId: ProjectId, writes = false) =>
  Effect.gen(function* () {
    const context = yield* readCaller();
    if (writes)
      yield* assertFullAccess(
        context,
        "Cloud work requires a full-access caller in default interaction mode.",
      );
    if (context.caller && context.caller.projectId !== projectId)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Cloud work must belong to the calling thread's project.",
      });
    return yield* Cloud.CodexCloudService;
  });
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const refuse = (error: { readonly message: string }) =>
  isMcpFailure(error)
    ? error
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
export const layer = Access.toLayer(CodexCloudToolkit, {
  codex_cloud_read: Access.reads((input) =>
    service(input.projectId).pipe(
      Effect.flatMap((cloud) => cloud.read(input.projectId)),
      Effect.mapError(refuse),
    ),
  ),
  codex_cloud_command: Access.writes((input) =>
    service(input.command.projectId, true).pipe(
      Effect.flatMap((cloud) => cloud.command(input.command)),
      Effect.mapError(refuse),
    ),
  ),
});

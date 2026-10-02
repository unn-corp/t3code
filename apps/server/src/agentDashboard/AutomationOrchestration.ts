/** Fork automation commands execute against the v2 orchestrator only. */
import { CommandId, OrchestrationV2Command, type OrchestrationCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";

export class AutomationDispatchError extends Schema.TaggedError<AutomationDispatchError>()(
  "AutomationDispatchError",
  { commandType: Schema.String, cause: Schema.Defect() },
) {}
export interface AutomationOrchestrationShape {
  readonly [key: string]: unknown;
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, AutomationDispatchError>;
}
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  AutomationOrchestrationShape
>()("t3/agentDashboard/AutomationOrchestration/OrchestrationEngineService") {}
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const sessions = yield* ProviderSessionManagerV2;
  const dispatch = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      switch (command.type) {
        case "thread.turn.start": {
          const shell = yield* threads.getThreadShell(command.threadId);
          if (shell === null)
            return yield* new AutomationDispatchError({
              commandType: command.type,
              cause: "Thread not found",
            });
          if (command.runtimeMode !== undefined && command.runtimeMode !== shell.runtimeMode) {
            yield* threads.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make(`${command.commandId}:runtime-mode`),
              threadId: command.threadId,
              runtimeMode: command.runtimeMode,
            });
          }
          if (
            command.interactionMode !== undefined &&
            command.interactionMode !== shell.interactionMode
          ) {
            yield* threads.dispatch({
              type: "thread.interaction-mode.set",
              commandId: CommandId.make(`${command.commandId}:interaction-mode`),
              threadId: command.threadId,
              interactionMode: command.interactionMode,
            });
          }
          return (yield* threads.sendToThread({
            projectId: shell.projectId,
            commandId: command.commandId,
            threadId: command.threadId,
            messageId: command.message.messageId,
            text: command.message.text,
            attachments: command.message.attachments ?? [],
            modelSelection: command.modelSelection ?? shell.modelSelection,
            mode: "auto",
            createdBy: "system",
            creationSource: "server",
          })).dispatch;
        }
        case "thread.turn.interrupt": {
          const shell = yield* threads.getThreadShell(command.threadId);
          if (shell === null) return { sequence: 0 };
          const result = yield* threads.interruptThread({
            projectId: shell.projectId,
            threadId: command.threadId,
            commandId: command.commandId,
          });
          return result.type === "interrupt_requested"
            ? result.dispatch
            : { sequence: yield* threads.getThreadEventSequence(command.threadId) };
        }
        case "thread.session.stop": {
          const projection = yield* threads.getThreadProjection(command.threadId);
          for (const session of projection.providerSessions) {
            yield* sessions.detach({
              providerSessionId: session.id,
              threadId: command.threadId,
              detail: "Fork automation stopped the session",
            });
          }
          return { sequence: yield* threads.getThreadEventSequence(command.threadId) };
        }
        default: {
          const translated =
            command.type === "thread.create"
              ? { ...command, createdBy: "system", creationSource: "server" }
              : command.type === "thread.meta.update"
                ? { ...command, type: "thread.metadata.update" }
                : command;
          const native = yield* Schema.decodeUnknownEffect(OrchestrationV2Command)(translated);
          return yield* threads.dispatch(native);
        }
      }
    }).pipe(
      Effect.mapError((cause) => new AutomationDispatchError({ commandType: command.type, cause })),
    );
  return { dispatch } satisfies AutomationOrchestrationShape;
});
export const layer = Layer.effect(OrchestrationEngineService, make);

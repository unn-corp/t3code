import * as ThreadExport from "./orchestration-v2/ThreadExportService.ts";
import * as CodexCloud from "./codexCloud/CodexCloudService.ts";
import {
  ForkExtraWsRpcGroup,
  ForkMaintenanceError,
  PreviewPickedElement,
  WS_METHODS,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod, withRpcWorkAdmission } from "./auth/RpcAuthorization.ts";
import { listNativeSessions, resumeNativeSession } from "./provider/NativeSessionResume.ts";
import { PreviewManager } from "./preview/Manager.ts";
import { PreviewAutomationBroker } from "./mcp/PreviewAutomationBroker.ts";

export const makeForkExtraWsRpcLayer = (session: EnvironmentAuth.AuthenticatedSession) =>
  ForkExtraWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const preview = yield* PreviewManager;
      const cloud = yield* CodexCloud.CodexCloudService;
      const broker = yield* PreviewAutomationBroker;
      const authorize = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError | ForkMaintenanceError, R> => {
        const requiredScope: AuthEnvironmentScope = requiredScopeForRpcMethod(method);
        if (!session.scopes.includes(requiredScope))
          return Effect.fail(
            new EnvironmentAuthorizationError({
              requiredScope,
              message: `The authenticated token is missing required scope: ${requiredScope}.`,
            }),
          );
        return withRpcWorkAdmission(method, effect);
      };
      const exporter = yield* ThreadExport.ThreadExportService.pipe(
        Effect.provide(ThreadExport.layer),
      );
      return ForkExtraWsRpcGroup.of({
        [WS_METHODS.codexCloudRead]: (input) =>
          authorize(WS_METHODS.codexCloudRead, cloud.read(input.projectId)),
        [WS_METHODS.codexCloudCommand]: (input) =>
          authorize(WS_METHODS.codexCloudCommand, cloud.command(input)),
        [WS_METHODS.codexCloudWorkerSetup]: (input) =>
          authorize(WS_METHODS.codexCloudWorkerSetup, cloud.setupWorker(input)),
        [WS_METHODS.threadExport]: (input) =>
          authorize(WS_METHODS.threadExport, exporter.exportThread(input)),
        [WS_METHODS.codexSessionsList]: (input) =>
          authorize(WS_METHODS.codexSessionsList, listNativeSessions(input)),
        [WS_METHODS.codexSessionsResume]: (input) =>
          authorize(WS_METHODS.codexSessionsResume, resumeNativeSession(input)),
        [WS_METHODS.previewAttach]: (input) =>
          Stream.unwrap(authorize(WS_METHODS.previewAttach, preview.attachFrames(input))),
        [WS_METHODS.previewPublishFrame]: (input) =>
          authorize(WS_METHODS.previewPublishFrame, preview.publishFrame(input)),
        [WS_METHODS.previewInput]: (input) =>
          authorize(
            WS_METHODS.previewInput,
            broker
              .dispatchToHost({
                threadId: input.threadId,
                tabId: input.tabId,
                operation: "dispatchInput",
                input: { tabId: input.tabId, event: input.event },
              })
              .pipe(Effect.asVoid),
          ),
        [WS_METHODS.previewPickElement]: (input) =>
          authorize(
            WS_METHODS.previewPickElement,
            broker
              .dispatchToHost({
                threadId: input.threadId,
                tabId: input.tabId,
                operation: "pickElement",
                input: { tabId: input.tabId, x: input.x, y: input.y },
                awaitResponse: true,
              })
              .pipe(
                Effect.map((outcome) => {
                  const result =
                    outcome._tag === "accepted" &&
                    typeof outcome.result === "object" &&
                    outcome.result !== null
                      ? (outcome.result as { picked?: unknown; screenshot?: unknown })
                      : null;
                  return {
                    tabId: input.tabId,
                    picked: Schema.is(PreviewPickedElement)(result?.picked) ? result.picked : null,
                    screenshot: typeof result?.screenshot === "string" ? result.screenshot : null,
                  };
                }),
              ),
          ),
      });
    }),
  );

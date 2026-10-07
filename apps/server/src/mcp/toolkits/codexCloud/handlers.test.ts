import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { McpSchema, Tool } from "effect/ai";
import * as Cloud from "../../../codexCloud/CodexCloudService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { layer } from "./handlers.ts";
import { CodexCloudToolkit } from "./tools.ts";

const decodeToolSchema = Schema.decodeUnknownEffect(McpSchema.ToolJson);

it.effect("refuses cloud execution from restricted callers or another project", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("cloud-caller");
    const original = liveThreadShell(threadId);
    for (const example of [
      {
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
        projectId: original.projectId,
      },
      {
        runtimeMode: "full-access" as const,
        interactionMode: "plan" as const,
        projectId: original.projectId,
      },
      {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        projectId: ProjectId.make("another-project"),
      },
      {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        projectId: original.projectId,
      },
    ]) {
      let calls = 0;
      const dependencies = Layer.mergeAll(
        Layer.succeed(Invocation.McpInvocationContext, {
          environmentId: EnvironmentId.make("cloud-fixture"),
          requestNamespace: "provider:cloud",
          thread: {
            threadId,
            providerSessionId: "provider:cloud",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              ...original,
              runtimeMode: example.runtimeMode,
              interactionMode: example.interactionMode,
            }),
        }),
        Layer.mock(Cloud.CodexCloudService)({
          command: () =>
            Effect.sync(() => {
              calls++;
              return { snapshot: { binding: null, runs: [], workers: [] }, output: "fixture" };
            }),
        }),
      );
      const result = yield* Effect.gen(function* () {
        const toolkit = yield* CodexCloudToolkit;
        return yield* toolkit
          .handle("codex_cloud_command", {
            command: {
              action: "submit",
              projectId: example.projectId,
              requestId: "fixture",
              mode: "cloud",
              agent: "codex",
              prompt: "Harmless fixture",
            },
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }).pipe(
        Effect.provide(Access.HandlersLayer.layer(layer).pipe(Layer.provideMerge(dependencies))),
      );
      const permitted =
        example.runtimeMode === "full-access" &&
        example.interactionMode === "default" &&
        example.projectId === original.projectId;
      expect(calls).toBe(permitted ? 1 : 0);
      if (!permitted) expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    }
  }),
);

it.effect("registers cloud tools with object-root MCP input schemas", () =>
  Effect.gen(function* () {
    for (const tool of Object.values(CodexCloudToolkit.tools)) {
      const schema = yield* decodeToolSchema(Tool.getJsonSchema(tool));
      expect(schema.type).toBe("object");
    }
  }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as Service from "./OrchestratorMcpService.ts";

it.effect("allows only the current provider to select a direct reply and namespaces retries", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:mcp-reply");
    const shell = liveThreadShell(threadId);
    const projection = idleThreadProjection(shell);
    const now = DateTime.makeUnsafe("2026-10-08T12:00:00Z");
    const run: OrchestrationV2Run = {
      id: RunId.make("run:mcp-reply"),
      threadId,
      ordinal: 1,
      providerInstanceId: shell.providerInstanceId,
      modelSelection: shell.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("current"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    let live = true;
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        getThreadRecords: () => Effect.succeed({ ...projection, runs: live ? [run] : [] }),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return {} as never;
          }),
      }),
      Layer.mock(Adapters.ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
      Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(Projects.ProjectService)({}),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("local"),
      requestNamespace: "provider:reply-test",
      thread: {
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: shell.providerInstanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    yield* Effect.gen(function* () {
      const service = yield* Service.OrchestratorMcpService;
      const input = { messageId: MessageId.make("earlier-user"), clientRequestId: "stable-reply" };
      assert.deepEqual(yield* service.replyToMessage(scope, input), {
        threadId,
        runId: run.id,
        messageId: input.messageId,
      });
      yield* service.replyToMessage(scope, input);
      assert.equal(dispatched[0]?.commandId, dispatched[1]?.commandId);
      assert.equal(dispatched[0]?.type, "run.reply-target.set");
      assert.equal(
        (yield* service
          .replyToMessage(
            {
              ...scope,
              thread: { ...scope.thread!, providerInstanceId: ProviderInstanceId.make("other") },
            },
            input,
          )
          .pipe(Effect.flip)).code,
        "parent_not_active",
      );
      live = false;
      assert.equal(
        (yield* service.replyToMessage(scope, input).pipe(Effect.flip)).code,
        "parent_not_active",
      );
      assert.equal(
        (yield* service.replyToMessage({ ...scope, thread: undefined }, input).pipe(Effect.flip))
          .code,
        "thread_credential_required",
      );
      assert.equal(dispatched.length, 2);
    }).pipe(Effect.provide(Service.layer.pipe(Layer.provide(dependencies))));
  }),
);

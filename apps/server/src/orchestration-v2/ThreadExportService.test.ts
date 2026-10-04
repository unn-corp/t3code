import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  v2Projection,
  v2Now,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { formatThreadExport } from "./ThreadExportService.ts";

const messages: OrchestrationV2ConversationMessage[] = Array.from({ length: 120 }, (_, index) => ({
  id: MessageId.make(`message-${index}`),
  threadId: v2Projection.thread.id,
  runId: null,
  nodeId: null,
  role: index % 2 ? "assistant" : "user",
  text: `Retained message ${index}`,
  attachments: [],
  streaming: index === 119,
  createdBy: "user",
  creationSource: "web",
  createdAt: v2Now,
  updatedAt: v2Now,
}));
it("exports every retained message with stable dates and marks partial output", () => {
  const result = formatThreadExport({ ...v2Projection, messages }, "json");
  const document = JSON.parse(result.content);
  expect(document.messages).toHaveLength(120);
  expect(document.messages[0].text).toBe("Retained message 0");
  expect(document.messages[119]).toMatchObject({
    text: "Retained message 119",
    streaming: true,
    createdAt: "2026-06-20T00:00:00.000Z",
  });
  expect(document.formatVersion).toBe(1);
});
it("keeps Markdown content intact and produces a safe filename", () => {
  const result = formatThreadExport(
    {
      ...v2Projection,
      thread: { ...v2Projection.thread, title: "../../notes\nThread" },
      messages: [{ ...messages[0]!, text: "# heading\n```ts\ncode\n```\n🙂" }],
    },
    "markdown",
  );
  expect(result.filename).not.toContain("/");
  expect(result.content).toContain("# heading\n```ts\ncode\n```\n🙂");
});
it("omits provider state, credentials and hidden reasoning", () => {
  const result = formatThreadExport(
    {
      ...v2Projection,
      messages,
      providerThreads: [
        {
          id: ProviderThreadId.make("private-provider-thread"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: v2Projection.thread.providerInstanceId,
          providerSessionId: null,
          appThreadId: v2Projection.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          nativeMetadata: { title: "provider-secret" },
          createdAt: v2Now,
          updatedAt: v2Now,
        },
      ],
      turnItems: [
        {
          id: TurnItemId.make("private-reasoning"),
          threadId: v2Projection.thread.id,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: "Reasoning",
          startedAt: v2Now,
          completedAt: v2Now,
          updatedAt: v2Now,
          type: "reasoning",
          text: "hidden-thought",
          streaming: false,
        },
      ],
    },
    "json",
  );
  expect(result.content).not.toContain("provider-secret");
  expect(result.content).not.toContain("hidden-thought");
  expect(JSON.parse(result.content)).not.toHaveProperty("providerThreads");
});

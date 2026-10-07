import {
  CodexCloudReadInput,
  CodexCloudSnapshot,
  CodexCloudCommandInput,
  CodexCloudCommandResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Cloud from "../../../codexCloud/CodexCloudService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Cloud.CodexCloudService,
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
  ],
};
const Read = Tool.make("codex_cloud_read", {
  ...shared,
  description:
    "Read this project's account-bound Codex Cloud configuration, recent task summaries, and experimental workers. Prompts and output are previews; use status for retained worker output. Workers run Codex or Claude in a cloud checkout through an outbound connection.",
  parameters: CodexCloudReadInput,
  success: CodexCloudSnapshot,
}).annotate(Tool.Readonly, true);
const Command = Tool.make("codex_cloud_command", {
  ...shared,
  description:
    "Configure, probe, submit, inspect, or cancel cloud work in the calling project. Use a stable requestId for submission retries. Unknown submission outcomes require checking ChatGPT. Cloud mode supports Codex; worker mode requires a connected worker and its supported agent. Credentials and worker provisioning are managed by a person in T3.",
  parameters: Schema.Struct({ command: CodexCloudCommandInput }),
  success: CodexCloudCommandResult,
});
export const CodexCloudToolkit = Toolkit.make(Read, Command);

import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const Text = Schema.String.check(Schema.isMaxLength(200_000));
const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,160}$/));

/** Accept only explicit IDs or official environment links; never infer an ID from a repository name. */
export function codexCloudEnvironmentId(input: string): string | null {
  const value = input.trim();
  if (/^[a-zA-Z0-9_-]{1,160}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "chatgpt.com" ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    return (
      /^\/(?:codex\/)?(?:settings\/)?environments\/([a-zA-Z0-9_-]{1,160})\/?$/.exec(
        url.pathname,
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
}
export const CodexCloudBinding = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  environmentId: Identifier,
  label: Schema.String.check(Schema.isMaxLength(120)),
  branch: Schema.String.check(Schema.isMaxLength(200)),
});
export type CodexCloudBinding = typeof CodexCloudBinding.Type;
export const CodexCloudRun = Schema.Struct({
  id: Identifier,
  projectId: ProjectId,
  binding: CodexCloudBinding,
  accountFingerprint: Schema.String,
  mode: Schema.Literals(["cloud", "worker"]),
  agent: Schema.Literals(["codex", "claude"]),
  prompt: Text,
  createdAt: Schema.String,
  status: Schema.Literals([
    "submitting",
    "submitted",
    "unknown",
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]),
  taskId: Schema.NullOr(Identifier),
  url: Schema.NullOr(Schema.String),
  workerId: Schema.NullOr(Identifier),
  sessionId: Schema.NullOr(Identifier),
  continueRunId: Schema.NullOr(Identifier),
  output: Text,
  eventSequence: Schema.Number,
});
export type CodexCloudRun = typeof CodexCloudRun.Type;
export const CodexCloudWorker = Schema.Struct({
  id: Identifier,
  projectId: ProjectId,
  binding: CodexCloudBinding,
  accountFingerprint: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  lastSeen: Schema.NullOr(Schema.String),
  revoked: Schema.Boolean,
  instanceId: Schema.NullOr(Identifier),
  agents: Schema.Array(Schema.Literals(["codex", "claude"])),
});
export type CodexCloudWorker = typeof CodexCloudWorker.Type;
export const CodexCloudSnapshot = Schema.Struct({
  binding: Schema.NullOr(CodexCloudBinding),
  /** Recent run summaries: prompt previews and output tails. Status returns full retained output. */
  runs: Schema.Array(CodexCloudRun),
  workers: Schema.Array(CodexCloudWorker),
});
export type CodexCloudSnapshot = typeof CodexCloudSnapshot.Type;
export const CodexCloudReadInput = Schema.Struct({ projectId: ProjectId });
export const CodexCloudCommandInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("save"),
    projectId: ProjectId,
    binding: Schema.NullOr(CodexCloudBinding),
  }),
  Schema.Struct({
    action: Schema.Literal("probe"),
    projectId: ProjectId,
    binding: CodexCloudBinding,
  }),
  Schema.Struct({
    action: Schema.Literal("submit"),
    projectId: ProjectId,
    requestId: Identifier,
    mode: Schema.Literals(["cloud", "worker"]),
    agent: Schema.Literals(["codex", "claude"]),
    prompt: Text,
    workerId: Schema.optionalKey(Identifier),
    continueRunId: Schema.optionalKey(Identifier),
  }),
  Schema.Struct({
    action: Schema.Literals(["status", "diff", "cancel"]),
    projectId: ProjectId,
    runId: Identifier,
  }),
]);
export type CodexCloudCommandInput = typeof CodexCloudCommandInput.Type;
export const CodexCloudCommandResult = Schema.Struct({
  snapshot: CodexCloudSnapshot,
  output: Text,
});
export const CodexCloudWorkerSetupInput = Schema.Struct({
  projectId: ProjectId,
  origin: Schema.String.check(Schema.isMaxLength(500)),
  revokeWorkerId: Schema.optionalKey(Identifier),
});
export const CodexCloudWorkerSetupResult = Schema.Struct({
  snapshot: CodexCloudSnapshot,
  script: Schema.String,
  token: Schema.String,
  instructions: Schema.String,
});
export class CodexCloudError extends Schema.TaggedError<CodexCloudError>()("CodexCloudError", {
  code: Schema.Literals([
    "storage",
    "account",
    "cli",
    "environment",
    "configuration",
    "task",
    "worker",
    "unauthorized",
  ]),
}) {
  override get message(): string {
    const messages = {
      storage: "Cloud integration state could not be read or saved.",
      account:
        "Select an enabled Codex account with its own ChatGPT CLI login. Managed inference sign-in alone cannot authorize cloud tasks.",
      cli: "The Codex cloud command failed. Check this account's cloud access and environment ID; no automatic resubmission was made.",
      environment:
        "The installed Codex CLI cannot find this environment. Start the experimental worker from the ChatGPT chat where this cloud environment is attached, or use an environment supported by this CLI.",
      configuration: "Choose a valid project, account, and cloud environment first.",
      task: "This task is unavailable or belongs to a different account. An uncertain submission must be checked in ChatGPT before submitting again.",
      worker:
        "This worker is unavailable, busy, or does not support the selected agent. Start or reconnect it in the cloud task.",
      unauthorized: "The cloud worker credential is invalid or revoked.",
    };
    return messages[this.code];
  }
}

import type { OrganizationArchitectMessageId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Failed replies are transport errors, not part of the design conversation. */
export const completedArchitectTranscript = (
  conversation: {
    readonly messages: ReadonlyArray<{
      readonly requestId: string;
      readonly role: "user" | "architect";
      readonly text: string;
    }>;
    readonly requests: ReadonlyArray<{
      readonly requestId: string;
      readonly status: "pending" | "completed" | "failed";
    }>;
  },
  currentMessageId: OrganizationArchitectMessageId,
): { role: "user" | "assistant"; text: string }[] => {
  const completed = new Set(
    conversation.requests
      .filter((request) => request.status === "completed")
      .map((request) => request.requestId),
  );
  const transcript = conversation.messages
    .filter((message) => message.requestId !== currentMessageId && completed.has(message.requestId))
    .slice(-16)
    .map((message) => ({
      role: message.role === "user" ? ("user" as const) : ("assistant" as const),
      text: message.text,
    }));
  while (
    transcript.length > 0 &&
    transcript.reduce((bytes, turn) => bytes + Buffer.byteLength(turn.text, "utf8"), 0) > 12_000
  ) {
    transcript.shift();
  }
  return transcript;
};

/** Only fixed, credential-free messages may cross the provider error boundary. */
export const architectGenerationFailureMessage = (error: unknown): string => {
  if (!Schema.is(TextGenerationError)(error))
    return "The Architect could not complete this request. Try again.";
  if (/timed out/i.test(error.detail))
    return "The Architect provider timed out. Try again or select another model.";
  if (/invalid structured output|proposal revision/i.test(error.detail))
    return "The Architect provider returned an invalid design response. Try again or select another model.";
  if (/CLI command failed|Failed to spawn|provider/i.test(error.detail))
    return "The selected Architect provider failed. Check its setup or select another provider.";
  if (/Architect message|conversation|configuration|prompt.*limit/i.test(error.detail))
    return "The Architect context could not be prepared. Shorten the conversation or simplify the draft.";
  return "The Architect could not complete this request. Try again or select another model.";
};

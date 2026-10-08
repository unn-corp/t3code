import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

/** Keep chip references and their payload together on the actual turn request. */
export function encodeComposerMessageContext(input: {
  text: string;
  context: OrchestrationMessageContext | undefined;
  supportsInlineMessageContext: boolean;
}): { text: string; context?: OrchestrationMessageContext } {
  if (!input.context) return { text: input.text };
  return input.supportsInlineMessageContext
    ? { text: input.text, context: input.context }
    : { text: serializeLegacyContextMessage({ text: input.text, records: input.context.records }) };
}

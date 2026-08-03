import * as Schema from "effect/Schema";

import type { ChatMessage } from "./types";

export const CONVERSATION_REFERENCE_CLIPBOARD_MIME =
  "application/x-t3code-conversation-reference+json";
export const MAX_CONVERSATION_REFERENCE_IMAGES = 8;
export const MAX_CONVERSATION_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CONVERSATION_REFERENCE_IMAGE_DATA_URL_CHARS = 14_000_000;
const MAX_CONVERSATION_REFERENCE_CLIPBOARD_CHARS =
  MAX_CONVERSATION_REFERENCE_IMAGES * MAX_CONVERSATION_REFERENCE_IMAGE_DATA_URL_CHARS + 1_000_000;

export const ConversationReferenceMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  imageCount: Schema.Number,
});

export const ConversationReferenceImage = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

export const ConversationReference = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  title: Schema.String,
  environmentLabel: Schema.String,
  copiedAt: Schema.String,
  messages: Schema.Array(ConversationReferenceMessage),
  images: Schema.Array(ConversationReferenceImage),
  imageCount: Schema.Number,
  omittedImageCount: Schema.Number,
});
export type ConversationReference = typeof ConversationReference.Type;

const decodeConversationReferencePayload = Schema.decodeUnknownSync(ConversationReference);

export function buildConversationReference(input: {
  id: string;
  title: string;
  environmentLabel: string;
  copiedAt: string;
  messages: ReadonlyArray<ChatMessage>;
  images?: ReadonlyArray<ConversationReference["images"][number]>;
}): ConversationReference {
  const messages = input.messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const imageCount =
      message.attachments?.filter((attachment) => attachment.type === "image").length ?? 0;
    return [{ role: message.role, text: message.text, imageCount } as const];
  });
  return {
    version: 1,
    id: input.id,
    title: input.title,
    environmentLabel: input.environmentLabel,
    copiedAt: input.copiedAt,
    messages,
    images: input.images ? [...input.images] : [],
    imageCount: messages.reduce((count, message) => count + message.imageCount, 0),
    omittedImageCount: Math.max(
      0,
      messages.reduce((count, message) => count + message.imageCount, 0) -
        (input.images?.length ?? 0),
    ),
  };
}

function referenceMessageBlock(message: ConversationReference["messages"][number]): string {
  const role = message.role === "assistant" ? "ASSISTANT" : "USER";
  const text = message.text.trim() || "(empty message)";
  const images =
    message.imageCount > 0
      ? `\n[${message.imageCount} image${message.imageCount === 1 ? "" : "s"} attached in source conversation]`
      : "";
  return `${role}:\n${text}${images}`;
}

export function formatConversationReference(reference: ConversationReference): string {
  const header = [
    `Referenced conversation: ${reference.title || "Untitled conversation"}`,
    `Source environment: ${reference.environmentLabel || "Unknown"}`,
    `Copied: ${reference.copiedAt}`,
  ].join("\n");
  const messages =
    reference.messages.map(referenceMessageBlock).join("\n\n") ||
    "(No user or assistant messages.)";
  const omitted =
    reference.omittedImageCount > 0
      ? `\n\n[${reference.omittedImageCount} source image${reference.omittedImageCount === 1 ? " was" : "s were"} not copied.]`
      : "";
  return `${header}\n\n${messages}${omitted}`;
}

export function appendConversationReferencesToPrompt(
  prompt: string,
  references: ReadonlyArray<ConversationReference>,
): string {
  if (references.length === 0) return prompt;
  const context = references
    .map(
      (reference) =>
        `--- BEGIN CONVERSATION REFERENCE ---\n${formatConversationReference(reference)}\n--- END CONVERSATION REFERENCE ---`,
    )
    .join("\n\n");
  return prompt.length > 0 ? `${context}\n\n${prompt}` : context;
}

export function encodeConversationReference(reference: ConversationReference): string {
  return JSON.stringify(reference);
}

export function decodeConversationReference(value: string): ConversationReference | null {
  if (value.length === 0 || value.length > MAX_CONVERSATION_REFERENCE_CLIPBOARD_CHARS) {
    return null;
  }
  try {
    const reference = decodeConversationReferencePayload(JSON.parse(value));
    if (
      reference.images.length > MAX_CONVERSATION_REFERENCE_IMAGES ||
      reference.images.some(
        (image) =>
          image.sizeBytes < 0 ||
          image.sizeBytes > MAX_CONVERSATION_REFERENCE_IMAGE_BYTES ||
          image.dataUrl.length > MAX_CONVERSATION_REFERENCE_IMAGE_DATA_URL_CHARS ||
          !image.dataUrl.startsWith("data:image/") ||
          !image.mimeType.startsWith("image/"),
      )
    ) {
      return null;
    }
    return reference;
  } catch {
    return null;
  }
}

/**
 * Keeps the newest complete message blocks in each referenced conversation.
 * The marker remains part of the transcript so an agent can distinguish a
 * deliberately shortened reference from a complete source history.
 */
export function trimConversationReferencesToFit(
  references: ReadonlyArray<ConversationReference>,
  maxCharacters: number,
): { references: ConversationReference[]; omittedMessageCount: number } {
  const copies = references.map((reference) => ({
    ...reference,
    messages: reference.messages.map((message) => ({ ...message })),
    images: reference.images.map((image) => ({ ...image })),
  }));
  const omittedByReference = new Map<string, number>();
  const marker = (count: number) => ({
    role: "assistant" as const,
    text: `[${count} earlier source message${count === 1 ? " was" : "s were"} omitted to fit the provider limit.]`,
    imageCount: 0,
  });
  const format = () => appendConversationReferencesToPrompt("", copies).length;

  while (format() > maxCharacters) {
    const candidate = copies.find((reference) => reference.messages.length > 0);
    if (!candidate) break;
    candidate.messages.shift();
    omittedByReference.set(candidate.id, (omittedByReference.get(candidate.id) ?? 0) + 1);
  }

  for (const reference of copies) {
    const omitted = omittedByReference.get(reference.id) ?? 0;
    if (omitted > 0) reference.messages.unshift(marker(omitted));
  }
  return {
    references: copies,
    omittedMessageCount: [...omittedByReference.values()].reduce((sum, count) => sum + count, 0),
  };
}

export type ConversationReferenceClipboardWriteResult = "structured" | "plain-text";

/**
 * Always leaves a useful transcript on the clipboard. The custom MIME type is
 * deliberately additive: browsers and Electron clipboard bridges that drop it
 * still receive ordinary text rather than an unusable opaque payload.
 */
export async function writeConversationReferenceToClipboard(
  reference: ConversationReference,
): Promise<ConversationReferenceClipboardWriteResult> {
  const plainText = formatConversationReference(reference);
  const clipboard = navigator.clipboard;
  if (!clipboard) {
    throw new Error("Clipboard access is unavailable.");
  }

  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    try {
      await clipboard.write([
        new ClipboardItem({
          [CONVERSATION_REFERENCE_CLIPBOARD_MIME]: new Blob(
            [encodeConversationReference(reference)],
            { type: CONVERSATION_REFERENCE_CLIPBOARD_MIME },
          ),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      return "structured";
    } catch {
      // Some OS clipboard implementations reject unknown MIME types.
    }
  }

  if (typeof clipboard.writeText !== "function") {
    throw new Error("Clipboard text access is unavailable.");
  }
  await clipboard.writeText(plainText);
  return "plain-text";
}

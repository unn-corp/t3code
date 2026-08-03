import { describe, expect, it } from "vite-plus/test";

import {
  appendConversationReferencesToPrompt,
  buildConversationReference,
  decodeConversationReference,
  encodeConversationReference,
  trimConversationReferencesToFit,
} from "./conversationReference";
import type { ChatMessage } from "./types";

describe("conversation references", () => {
  it("serializes visible messages chronologically and excludes system messages", () => {
    const reference = buildConversationReference({
      id: "reference-1",
      title: "Investigate cache",
      environmentLabel: "Work laptop",
      copiedAt: "2026-08-02T12:00:00.000Z",
      messages: [
        {
          id: "1",
          role: "user",
          text: "Find the bug",
          turnId: null,
          streaming: false,
          createdAt: "a",
          updatedAt: "a",
        },
        {
          id: "2",
          role: "system",
          text: "hidden",
          turnId: null,
          streaming: false,
          createdAt: "a",
          updatedAt: "a",
        },
        {
          id: "3",
          role: "assistant",
          text: "I found it",
          turnId: null,
          streaming: false,
          createdAt: "a",
          updatedAt: "a",
        },
      ] as unknown as ChatMessage[],
    });

    expect(reference.messages).toEqual([
      { role: "user", text: "Find the bug", imageCount: 0 },
      { role: "assistant", text: "I found it", imageCount: 0 },
    ]);
    expect(appendConversationReferencesToPrompt("Fix it", [reference])).toContain(
      "USER:\nFind the bug",
    );
    expect(appendConversationReferencesToPrompt("Fix it", [reference])).toContain(
      "ASSISTANT:\nI found it",
    );
  });

  it("round trips the structured clipboard payload", () => {
    const reference = buildConversationReference({
      id: "reference-1",
      title: "A",
      environmentLabel: "B",
      copiedAt: "now",
      messages: [],
    });
    expect(decodeConversationReference(encodeConversationReference(reference))).toEqual(reference);
    expect(decodeConversationReference("not json")).toBeNull();
  });

  it("rejects oversized structured image payloads", () => {
    const reference = buildConversationReference({
      id: "reference-images",
      title: "A",
      environmentLabel: "B",
      copiedAt: "now",
      messages: [],
    });
    const image = {
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
    };
    expect(
      decodeConversationReference(
        encodeConversationReference({
          ...reference,
          images: Array.from({ length: 9 }, () => image),
        }),
      ),
    ).toBeNull();
  });

  it("tracks source images that could not be copied", () => {
    const reference = buildConversationReference({
      id: "reference-images",
      title: "Images",
      environmentLabel: "Remote",
      copiedAt: "now",
      messages: [
        {
          id: "image-message",
          role: "user",
          text: "See this",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "design.png",
              mimeType: "image/png",
              sizeBytes: 20,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: "a",
          updatedAt: "a",
        },
      ] as unknown as ChatMessage[],
    });

    expect(reference.imageCount).toBe(1);
    expect(reference.omittedImageCount).toBe(1);
  });

  it("trims oldest complete message blocks and leaves an explicit marker", () => {
    const reference = buildConversationReference({
      id: "trim-me",
      title: "Trim",
      environmentLabel: "Local",
      copiedAt: "now",
      messages: [
        {
          id: "1",
          role: "user",
          text: "old source message".repeat(40),
          turnId: null,
          streaming: false,
          createdAt: "a",
          updatedAt: "a",
        },
        {
          id: "2",
          role: "assistant",
          text: "new source message",
          turnId: null,
          streaming: false,
          createdAt: "a",
          updatedAt: "a",
        },
      ] as unknown as ChatMessage[],
    });
    const trimmed = trimConversationReferencesToFit([reference], 260);

    expect(trimmed.omittedMessageCount).toBe(1);
    expect(appendConversationReferencesToPrompt("", trimmed.references)).toContain(
      "1 earlier source message was omitted",
    );
    expect(appendConversationReferencesToPrompt("", trimmed.references)).toContain(
      "new source message",
    );
  });
});

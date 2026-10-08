import { expect, it } from "vite-plus/test";
import {
  projectComposerContextForProvider,
  remapComposerContextAttachments,
} from "@t3tools/shared/composerContextReferences";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { buildMessageContext, previewAnnotationContextReference } from "./composerContextRecords";
import { formatInlineContextReference } from "./composerContextReferences";
import { encodeComposerMessageContext } from "./composerMessageContext";
import type { PreviewAnnotationPayload } from "@t3tools/contracts";

const annotation: PreviewAnnotationPayload = {
  id: "saved-snapshot",
  pageUrl: "https://example.com/checkout",
  pageTitle: "Checkout",
  comment: "Make the button smaller.\nKeep its label unchanged.",
  createdAt: "2026-10-08T03:34:14.107Z",
  elements: [
    {
      id: "button",
      rect: { x: 10, y: 20, width: 100, height: 40 },
      element: {
        pageUrl: "https://example.com/checkout",
        pageTitle: "Checkout",
        tagName: "button",
        selector: "#checkout",
        htmlPreview: '<button id="checkout">Buy</button>',
        componentName: "CheckoutButton",
        source: null,
        stack: [],
        styles: "color: red",
        pickedAt: "2026-10-08T03:34:14.107Z",
      },
    },
  ],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
};
const text = formatInlineContextReference(previewAnnotationContextReference(annotation));
const context = buildMessageContext({
  terminalContexts: [],
  reviewComments: [],
  previewAnnotations: [annotation],
})!;

it("delivers the complete saved annotation behind its chip through the provider projection", () => {
  const message = encodeComposerMessageContext({
    text,
    context,
    supportsInlineMessageContext: true,
  });
  const wireContext = remapComposerContextAttachments(message.context, [], []);
  const prompt = projectComposerContextForProvider({
    text: message.text,
    records: wireContext?.records ?? [],
  });
  expect(prompt).toContain(annotation.comment);
  expect(prompt).toContain(annotation.pageUrl);
  expect(prompt).toContain("CheckoutButton");
  expect(prompt).not.toContain('unavailable="true"');
});

it("sends annotation detail as legacy text when the server cannot accept structured records", () => {
  const message = encodeComposerMessageContext({
    text,
    context,
    supportsInlineMessageContext: false,
  });
  expect(message).not.toHaveProperty("context");
  const upgraded = upgradeLegacyContextMessage(message.text);
  const prompt = projectComposerContextForProvider({
    text: upgraded.text,
    records: upgraded.records,
  });
  expect(prompt).toContain(annotation.comment);
  expect(prompt).toContain("CheckoutButton");
  expect(prompt).not.toContain('unavailable="true"');
});

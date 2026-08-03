import type { AssetResource, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildConversationReference,
  MAX_CONVERSATION_REFERENCE_IMAGES,
  MAX_CONVERSATION_REFERENCE_IMAGE_BYTES,
  writeConversationReferenceToClipboard,
} from "../conversationReference";
import { useAssetUrls } from "../assets/assetUrls";
import { useEnvironmentThread } from "../state/threads";

export type ConversationReferenceCopyRequest = {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly environmentLabel: string;
};

const COPY_REQUEST_EVENT = "t3code:copy-conversation-reference";

export function requestConversationReferenceCopy(request: ConversationReferenceCopyRequest): void {
  window.dispatchEvent(
    new CustomEvent<ConversationReferenceCopyRequest>(COPY_REQUEST_EVENT, {
      detail: request,
    }),
  );
}

export function useConversationReferenceCopyRequests(
  onRequest: (request: ConversationReferenceCopyRequest) => void,
): void {
  useEffect(() => {
    const listener = (event: Event) => {
      const request = (event as CustomEvent<ConversationReferenceCopyRequest>).detail;
      if (request) onRequest(request);
    };
    window.addEventListener(COPY_REQUEST_EVENT, listener);
    return () => window.removeEventListener(COPY_REQUEST_EVENT, listener);
  }, [onRequest]);
}

/**
 * Mount only while copying. `useEnvironmentThread` then opens a single
 * authenticated detail subscription for the selected thread; sidebar shells
 * remain lightweight and no history is preloaded.
 */
export function ConversationReferenceCopyWorker(props: {
  readonly request: ConversationReferenceCopyRequest;
  readonly onCopied: (result: "structured" | "plain-text") => void;
  readonly onFailure: (error: unknown) => void;
  readonly onDone: () => void;
}) {
  const { request } = props;
  const source = useEnvironmentThread(request.threadRef.environmentId, request.threadRef.threadId);
  const finishedRequestKeyRef = useRef<string | null>(null);
  const requestKey = `${request.threadRef.environmentId}:${request.threadRef.threadId}`;
  const [assetWaitExpired, setAssetWaitExpired] = useState(false);
  const sourceThread = source.data._tag === "Some" ? source.data.value : null;
  const sourceImages = useMemo(() => {
    if (sourceThread === null) return [];
    return sourceThread.messages
      .flatMap((message) => message.attachments ?? [])
      .filter((attachment) => attachment.type === "image")
      .slice(-MAX_CONVERSATION_REFERENCE_IMAGES)
      .map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        resource: { _tag: "attachment", attachmentId: attachment.id } satisfies AssetResource,
      }));
  }, [sourceThread]);
  const sourceImageUrls = useAssetUrls(
    request.threadRef.environmentId,
    sourceImages.map((image) => image.resource),
  );

  useEffect(() => {
    setAssetWaitExpired(false);
    const timeout = window.setTimeout(() => setAssetWaitExpired(true), 5_000);
    return () => window.clearTimeout(timeout);
  }, [requestKey]);

  useEffect(() => {
    if (sourceThread === null || finishedRequestKeyRef.current === requestKey) return;
    if (
      sourceImages.length > 0 &&
      sourceImageUrls.some((url) => url === null) &&
      !assetWaitExpired
    ) {
      return;
    }
    finishedRequestKeyRef.current = requestKey;
    void Promise.all(
      sourceImages.map(async (image, index) => {
        const url = sourceImageUrls[index];
        if (!url || image.sizeBytes > MAX_CONVERSATION_REFERENCE_IMAGE_BYTES) return null;
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        if (blob.size > MAX_CONVERSATION_REFERENCE_IMAGE_BYTES || !blob.type.startsWith("image/")) {
          return null;
        }
        return {
          name: image.name,
          mimeType: blob.type || image.mimeType,
          sizeBytes: blob.size,
          dataUrl: await blobToDataUrl(blob),
        };
      }),
    )
      .then((images) =>
        writeConversationReferenceToClipboard(
          buildConversationReference({
            id: requestKey,
            title: request.title,
            environmentLabel: request.environmentLabel,
            copiedAt: new Date().toISOString(),
            messages: sourceThread.messages,
            images: images.filter((image): image is NonNullable<typeof image> => image !== null),
          }),
        ),
      )
      .then(props.onCopied)
      .catch(props.onFailure)
      .finally(props.onDone);
  }, [
    assetWaitExpired,
    props.onCopied,
    props.onDone,
    props.onFailure,
    request,
    requestKey,
    sourceImageUrls,
    sourceImages,
    sourceThread,
  ]);

  useEffect(() => {
    if (source.error._tag !== "Some" || finishedRequestKeyRef.current === requestKey) return;
    finishedRequestKeyRef.current = requestKey;
    props.onFailure(source.error.value);
    props.onDone();
  }, [props, requestKey, source.error]);

  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read copied image."));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Could not read copied image.")),
    );
    reader.readAsDataURL(blob);
  });
}

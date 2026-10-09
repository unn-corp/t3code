import type { MessageId, MessageReplyTarget } from "@t3tools/contracts";
import type { ChatMessage } from "../../types";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ReplyIcon, XIcon } from "lucide-react";
import { messageReplyChain } from "@t3tools/shared/messageReplies";
import { readLocalApi } from "../../localApi";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";

export async function openMessageReplyMenu(
  event: MouseEvent,
  message: ChatMessage,
  onReply: (message: ChatMessage) => void,
) {
  if (event.defaultPrevented || message.role === "system") return;
  const api = readLocalApi();
  if (!api) return;
  event.preventDefault();
  event.stopPropagation();
  const chosen = await api.contextMenu.show([{ id: "reply", label: "Reply to message" }], {
    x: event.clientX,
    y: event.clientY,
  });
  if (chosen === "reply") onReply(message);
}

export function MessageReplyActions({
  message,
  onReply,
  onOpenChain,
}: {
  message: ChatMessage;
  onReply?: ((message: ChatMessage) => void) | undefined;
  onOpenChain: (id: MessageId) => void;
}) {
  const target = message.context?.replyTo;
  return (
    <div
      className={`flex min-w-0 items-center gap-1 ${message.role === "user" ? "justify-end" : ""}`}
    >
      {target && (
        <Button
          variant="ghost-muted"
          size="compact"
          className="min-w-0 max-w-[80%]"
          onClick={() => onOpenChain(message.id)}
          aria-label="Open reply thread"
        >
          <ReplyIcon />
          <span className="max-w-72 truncate">
            {target.role === "user" ? "You" : "Agent"}: {target.text || "Attachment"}
          </span>
        </Button>
      )}
      {onReply && (
        <Button
          variant="ghost-muted"
          size="icon-micro"
          onClick={() => onReply(message)}
          aria-label="Reply to message"
        >
          <ReplyIcon />
        </Button>
      )}
    </div>
  );
}

export function ComposerMessageReply({
  target,
  onCancel,
}: {
  target: MessageReplyTarget;
  onCancel: () => void;
}) {
  return (
    <div
      className="chat-composer-message-reply flex min-w-0 items-center gap-2 px-3 py-2"
      role="status"
    >
      <ReplyIcon className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          Replying to {target.role === "user" ? "you" : "agent"}
        </p>
        <p className="truncate text-sm">{target.text || "Attachment"}</p>
      </div>
      <Button variant="ghost-muted" size="icon-micro" onClick={onCancel} aria-label="Cancel reply">
        <XIcon />
      </Button>
    </div>
  );
}

export type LoadReplyChain = (
  messageId: MessageId,
  offset: number,
) => Promise<{ messages: ReadonlyArray<ChatMessage>; nextOffset: number | null }>;

export function MessageReplyThreadDialog({
  messages,
  selectedId,
  onClose,
  onReply,
  loadChain,
  renderMessage,
}: {
  messages: ReadonlyArray<ChatMessage>;
  selectedId: MessageId | null;
  onClose: () => void;
  onReply?: ((message: ChatMessage) => void) | undefined;
  loadChain?: LoadReplyChain | undefined;
  renderMessage: (message: ChatMessage) => ReactNode;
}) {
  return (
    <Dialog
      open={selectedId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Reply thread</DialogTitle>
          <DialogDescription>Messages connected by replies in this conversation.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {selectedId && (
            <ReplyThreadContents
              key={selectedId}
              selectedId={selectedId}
              messages={messages}
              loadChain={loadChain}
              renderMessage={renderMessage}
              onReply={
                onReply
                  ? (message) => {
                      onReply(message);
                      onClose();
                    }
                  : undefined
              }
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function ReplyThreadContents({
  selectedId,
  messages,
  loadChain,
  renderMessage,
  onReply,
}: {
  selectedId: MessageId;
  messages: ReadonlyArray<ChatMessage>;
  loadChain?: LoadReplyChain | undefined;
  renderMessage: (message: ChatMessage) => ReactNode;
  onReply?: ((message: ChatMessage) => void) | undefined;
}) {
  const [page, setPage] = useState<{
    messages: ReadonlyArray<ChatMessage>;
    nextOffset: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(Boolean(loadChain));
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState({ messageId: selectedId, attempt: 0 });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (loadChain) {
      void loadChain(request.messageId, 0)
        .then((result) => {
          if (!cancelled) setPage(result);
        })
        .catch(() => {
          if (!cancelled) setError("Could not load this reply thread.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [loadChain, request]);
  const localChain = messageReplyChain(messages, selectedId);
  const liveById = new Map(messages.map((message) => [message.id, message]));
  const chain = page
    ? [
        ...new Map([
          ...page.messages.map(
            (message) => [message.id, liveById.get(message.id) ?? message] as const,
          ),
          ...localChain.map((message) => [message.id, message] as const),
        ]).values(),
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    : localChain;
  const loadMore = async () => {
    if (!loadChain || page?.nextOffset == null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await loadChain(selectedId, page.nextOffset);
      if (mounted.current)
        setPage((current) => ({
          messages: [
            ...(current?.messages ?? []),
            ...result.messages.filter(
              (message) => !current?.messages.some((existing) => existing.id === message.id),
            ),
          ],
          nextOffset: result.nextOffset,
        }));
    } catch {
      if (mounted.current) setError("Could not load more replies.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  return (
    <div className="space-y-4">
      {chain.map((message) => (
        <article key={message.id} data-reply-message-id={message.id}>
          {renderMessage(message)}
          {onReply && (
            <div className={message.role === "user" ? "flex justify-end" : ""}>
              <Button variant="ghost-muted" size="compact" onClick={() => onReply(message)}>
                <ReplyIcon />
                Reply
              </Button>
            </div>
          )}
        </article>
      ))}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading replies…
        </p>
      )}
      {error && (
        <div role="alert" className="text-sm">
          <p>{error}</p>
          <Button
            variant="ghost-muted"
            size="compact"
            onClick={() =>
              page
                ? void loadMore()
                : (() => {
                    setLoading(true);
                    setError(null);
                    setRequest((current) => ({ ...current, attempt: current.attempt + 1 }));
                  })()
            }
          >
            Retry
          </Button>
        </div>
      )}
      {page?.nextOffset != null && !error && (
        <Button
          variant="ghost-muted"
          size="compact"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          Load more replies
        </Button>
      )}
      {!loading && !error && chain.length === 0 && (
        <p className="text-sm text-muted-foreground">This message is no longer available.</p>
      )}
    </div>
  );
}

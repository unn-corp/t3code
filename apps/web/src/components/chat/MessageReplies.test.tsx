// @vitest-environment jsdom
// @effect-diagnostics nodeBuiltinImport:off - Verify the shipped reply foreground style.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { act, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatMessage } from "../../types";
import { ComposerSurface } from "./ComposerSurface";
import {
  ComposerMessageReply,
  MessageReplyActions,
  openMessageReplyMenu,
  ReplyThreadContents,
} from "./MessageReplies";

const menu = vi.hoisted(() => vi.fn());
vi.mock("../../localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: menu } }) }));
let container: HTMLDivElement;
let root: Root;
const threadId = ThreadId.make("thread");
const message = (id: string, parent?: string): ChatMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text: `Text ${id}`,
  runId: null,
  streaming: false,
  createdAt: "2026-10-08T12:00:00Z",
  updatedAt: "2026-10-08T12:00:00Z",
  ...(parent
    ? {
        context: {
          version: 1,
          records: [],
          replyTo: {
            threadId,
            messageId: MessageId.make(parent),
            role: "user",
            text: `Text ${parent}`,
          },
        },
      }
    : {}),
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  menu.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("message reply UI", () => {
  it("paints the reply text and cancel control above the composer's glass backdrop", async () => {
    const stylesheet = NodeFS.readFileSync(
      new NodeURL.URL("../../index.css", import.meta.url),
      "utf8",
    );
    const start = stylesheet.indexOf(".chat-composer-message-reply {");
    const style = document.createElement("style");
    style.textContent =
      start < 0 ? "" : stylesheet.slice(start, stylesheet.indexOf("}", start) + 1);
    document.head.append(style);
    try {
      await act(async () =>
        root.render(
          <ComposerSurface.Shell>
            <ComposerMessageReply
              target={message("answer", "question").context!.replyTo!}
              onCancel={vi.fn()}
            />
            <ComposerSurface.Host>Composer</ComposerSurface.Host>
          </ComposerSurface.Shell>,
        ),
      );
      const reply = container.querySelector('[role="status"]')!;
      const foreground = getComputedStyle(reply);
      expect(foreground.position).toBe("relative");
      expect(Number(foreground.zIndex)).toBeGreaterThan(0);
      expect(reply.textContent).toContain("Text question");
      expect(reply.querySelector('[aria-label="Cancel reply"]')).not.toBeNull();
    } finally {
      style.remove();
    }
  });
  it("offers Reply through the native context menu and honors cancellation", async () => {
    const onReply = vi.fn();
    const event = {
      defaultPrevented: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 12,
      clientY: 34,
    } as unknown as MouseEvent;
    const source = message("a");
    menu.mockResolvedValueOnce("reply");
    await openMessageReplyMenu(event, source, onReply);
    expect(menu).toHaveBeenCalledWith([{ id: "reply", label: "Reply to message" }], {
      x: 12,
      y: 34,
    });
    expect(onReply).toHaveBeenCalledWith(source);
    menu.mockResolvedValueOnce(null);
    await openMessageReplyMenu(event, source, onReply);
    expect(onReply).toHaveBeenCalledTimes(1);
    await openMessageReplyMenu({ ...event, defaultPrevented: true }, source, onReply);
    expect(menu).toHaveBeenCalledTimes(2);
  });
  it("opens the selected chain from the indicator and cancels a composer reply", async () => {
    const onOpen = vi.fn();
    const onCancel = vi.fn();
    const source = message("answer", "question");
    await act(async () =>
      root.render(
        <>
          <MessageReplyActions message={source} onOpenChain={onOpen} />
          <ComposerMessageReply target={source.context!.replyTo!} onCancel={onCancel} />
        </>,
      ),
    );
    await act(async () =>
      (container.querySelector('[aria-label="Open reply thread"]') as HTMLButtonElement).click(),
    );
    expect(onOpen).toHaveBeenCalledWith(source.id);
    await act(async () =>
      (container.querySelector('[aria-label="Cancel reply"]') as HTMLButtonElement).click(),
    );
    expect(onCancel).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Text question");
  });
  it("fetches unloaded ancestors, paginates replies, and reuses chat rendering", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [message("root"), message("answer", "root")],
        nextOffset: 2,
      })
      .mockResolvedValueOnce({ messages: [message("followup", "answer")], nextOffset: null });
    const onReply = vi.fn();
    await act(async () =>
      root.render(
        <ReplyThreadContents
          selectedId={MessageId.make("answer")}
          messages={[message("answer", "root"), message("unrelated")]}
          loadChain={load}
          renderMessage={(row) => <p>{row.text}</p>}
          onReply={onReply}
        />,
      ),
    );
    expect(load).toHaveBeenCalledWith("answer", 0);
    expect(container.textContent).toContain("Text root");
    expect(container.textContent).not.toContain("unrelated");
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Load more replies")!
        .click(),
    );
    expect(load).toHaveBeenLastCalledWith("answer", 2);
    expect(container.textContent).toContain("Text followup");
    expect(container.textContent).not.toContain("Load more replies");
    await act(async () => container.querySelector("button")!.click());
    expect(onReply).toHaveBeenCalledWith(message("root"));
  });
  it("lets failed queries retry", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ messages: [message("answer")], nextOffset: null });
    await act(async () =>
      root.render(
        <ReplyThreadContents
          selectedId={MessageId.make("answer")}
          messages={[]}
          loadChain={load}
          renderMessage={(row) => <p>{row.text}</p>}
        />,
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
    await act(async () => container.querySelector("button")!.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Text answer");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("keeps late results from a closed thread out of the next thread", async () => {
    let completeOld!: (page: { messages: ChatMessage[]; nextOffset: null }) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ messages: [message("new")], nextOffset: null });
    const renderMessage = (row: ChatMessage) => <p>{row.text}</p>;
    await act(async () =>
      root.render(
        <ReplyThreadContents
          key="old"
          selectedId={MessageId.make("old")}
          messages={[]}
          loadChain={load}
          renderMessage={renderMessage}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <ReplyThreadContents
          key="new"
          selectedId={MessageId.make("new")}
          messages={[]}
          loadChain={load}
          renderMessage={renderMessage}
        />,
      ),
    );
    await act(async () => completeOld({ messages: [message("old")], nextOffset: null }));
    expect(container.textContent).toContain("Text new");
    expect(container.textContent).not.toContain("Text old");
  });
});

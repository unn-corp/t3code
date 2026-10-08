// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

/** A tab's webContents and debugger, with the debugger's commands left pending until released. */
const makeDebuggee = (
  debuggerInsert?: (text: string) => void,
  debuggerKey?: (key: string) => void,
) => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const commands: Array<{
    method: string;
    params: Record<string, unknown> | undefined;
    sessionId: string | undefined;
  }> = [];
  let text = "";
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string, params?: Record<string, unknown>, sessionId?: string) =>
      new Promise((resolve) => {
        commands.push({ method, params, sessionId });
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        if (method === "Input.insertText") {
          debuggerInsert?.(String(params?.["text"]));
          resolve({});
          return;
        }
        if (method === "Input.dispatchKeyEvent") {
          debuggerKey?.(String(params?.["key"]));
          resolve({});
          return;
        }
        pending.push(() => resolve({ method }));
      }),
  });
  const webContents = {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
    isFocused: () => true,
    insertText: async (inserted: string) => {
      text += inserted;
    },
    focus: () => {
      throw new Error("Typing must not move desktop focus.");
    },
  };
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    text: () => text,
    commands,
  };
};

/** Reads `count` events from one backend's subscription. */
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect("rejects a key press while another guest has desktop focus", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const activeKeys: Array<string> = [];
      const requested = makeDebuggee(undefined, (pressed) => activeKeys.push(pressed));
      requested.tab.webContents.isFocused = () => false;
      host.attach(key, requested.tab);
      host.attach({ ...key, tabId: "tab-2" }, makeDebuggee().tab);
      const reader = yield* takeEvents(host, 3).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Input.dispatchKeyEvent",
            params: { type: "rawKeyDown", key: "Enter" },
            sessionId: "t3-preview-page",
          }),
        }),
      );
      const reply = (yield* Fiber.join(reader)).at(-1) as { message: string };
      expect(JSON.parse(reply.message)).toMatchObject({
        id: 1,
        error: { message: expect.stringContaining("requested Browser tab must have focus") },
      });
      expect(requested.commands).toEqual([]);
      expect(activeKeys).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves focused-tab Enter and shortcut key events without changing focus", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const requested = makeDebuggee();
      host.attach(key, requested.tab);
      const presses = [
        { type: "rawKeyDown", key: "Control", modifiers: 2 },
        { type: "rawKeyDown", key: "a", modifiers: 2 },
        { type: "keyUp", key: "a", modifiers: 2 },
        { type: "keyUp", key: "Control", modifiers: 0 },
        { type: "keyDown", key: "Enter", text: "\r", modifiers: 0 },
        { type: "keyUp", key: "Enter", modifiers: 0 },
      ];
      const reader = yield* takeEvents(host, presses.length + 1).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      for (const [index, params] of presses.entries()) {
        yield* host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({
              id: index + 1,
              method: "Input.dispatchKeyEvent",
              params,
              sessionId: "t3-preview-page",
            }),
          }),
        );
      }
      const replies = (yield* Fiber.join(reader)).slice(1);
      expect(replies).toHaveLength(presses.length);
      for (const reply of replies) {
        expect(JSON.parse((reply as { message: string }).message)).toMatchObject({ result: {} });
      }
      expect(requested.commands).toEqual(
        presses.map((params) => ({
          method: "Input.dispatchKeyEvent",
          params,
          sessionId: undefined,
        })),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("types into the requested guest while another guest has desktop focus", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const active = makeDebuggee();
      // CDP input can follow the embedder's focused guest instead of its target.
      const requested = makeDebuggee((text) => void active.tab.webContents.insertText(text));
      const otherKey = { ...key, tabId: "tab-2" };
      host.attach(key, requested.tab);
      host.attach(otherKey, active.tab);
      const reader = yield* takeEvents(host, 3).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Input.insertText",
            params: { text: "requested repository only" },
            sessionId: "t3-preview-page",
          }),
        }),
      );
      const events = yield* Fiber.join(reader);
      expect(events.at(-1)).toEqual({
        type: "cdp",
        ...key,
        message: encodeJson({ id: 1, result: {}, sessionId: "t3-preview-page" }),
      });
      expect(requested.text()).toBe("requested repository only");
      expect(active.text()).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed guest insertion without retrying through focused CDP input", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      let retried = false;
      const debuggee = makeDebuggee(() => {
        retried = true;
      });
      debuggee.tab.webContents.insertText = async () => {
        throw new Error("Guest renderer was disposed.");
      };
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Input.insertText",
            params: { text: "do not send elsewhere" },
            sessionId: "t3-preview-page",
          }),
        }),
      );
      const [, reply] = yield* Fiber.join(reader);
      expect(JSON.parse((reply as { message: string }).message)).toEqual({
        id: 1,
        error: { code: -32000, message: "Guest renderer was disposed." },
        sessionId: "t3-preview-page",
      });
      expect(retried).toBe(false);
      expect(debuggee.text()).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("preserves the target debugger session for an iframe insertion", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Input.insertText",
            params: { text: "iframe only" },
            sessionId: "iframe-session",
          }),
        }),
      );
      yield* Fiber.join(reader);
      expect(debuggee.commands).toEqual([
        {
          method: "Input.insertText",
          params: { text: "iframe only" },
          sessionId: "iframe-session",
        },
      ]);
      expect(debuggee.text()).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      // Wait until the reader has received the announcement.
      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);
      // Only the new connection's reply arrives; the old one's id could collide.
      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;
      // Before the server sets a directory, Electron keeps its own handling.
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
    }),
  );
});

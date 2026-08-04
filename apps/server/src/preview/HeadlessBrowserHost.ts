/**
 * A preview host for environments with no desktop app.
 *
 * Rendering has always belonged to a client: the desktop runtime owns a webview
 * and registers with the automation broker as a host. A server started with
 * `npx t3` and driven from a phone has no such client, so nothing can render a
 * page. This registers the *server* as a host, backed by a headless Chromium
 * driven over CDP, and answers the same broker requests a desktop host does.
 *
 * Two deliberate limits:
 *
 * - **It never downloads a browser.** A ~150MB download on first preview would
 *   be a surprising thing for `npx t3` to do. If the machine already has
 *   Chrome, Chromium, or Edge, previews work; otherwise this stays dormant and
 *   the viewer keeps its existing "nothing can render this" message.
 * - **It advertises only what it implements.** The broker routes by
 *   `supportedOperations`, so the operations that depend on the desktop's
 *   Playwright injected runtime and element picker are simply not offered.
 *   Claiming them would send agent calls to a host that cannot serve them, and
 *   the broker already prefers the richer host when both are connected.
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  type PreviewAutomationOperation,
  type PreviewAutomationRequest,
  type PreviewInputEvent,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as CdpClient from "./CdpClient.ts";
import {
  chromiumLaunchArgs,
  discoverChromium,
  parseDevToolsEndpoint,
} from "./chromiumDiscovery.ts";
import * as PreviewManager from "./Manager.ts";

/** Everything this host can actually do, and nothing else. */
export const HEADLESS_SUPPORTED_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "evaluate",
  "resize",
  "setColorScheme",
  "streamStart",
  "streamStop",
  "dispatchInput",
] as const satisfies ReadonlyArray<PreviewAutomationOperation>;

const HEADLESS_CLIENT_ID = "t3-headless-preview-host";
const STARTUP_TIMEOUT = Duration.seconds(20);
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

interface PageSession {
  readonly targetId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly threadId: string;
  streaming: boolean;
  viewport: { width: number; height: number };
  sequence: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};

const readNumber = (value: unknown, key: string): number | undefined => {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" ? field : undefined;
};

/**
 * Chromium prints its debugger endpoint once, on stderr, and the port is only
 * knowable from that line because we let the OS choose it.
 */
const awaitDevToolsEndpoint = <E>(stderr: Stream.Stream<Uint8Array, E>) =>
  stderr.pipe(
    Stream.decodeText(),
    Stream.scan("", (accumulated, chunk) => accumulated + chunk),
    Stream.filterMap((accumulated) => {
      const endpoint = parseDevToolsEndpoint(accumulated);
      return endpoint === null ? Result.failVoid : Result.succeed(endpoint);
    }),
    Stream.runHead,
  );

export const run = Effect.gen(function* HeadlessBrowserHostRun() {
  const manager = yield* PreviewManager.PreviewManager;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const executablePath = discoverChromium({
    platform,
    env,
    exists: (candidate) => {
      try {
        return NodeFS.existsSync(candidate);
      } catch {
        return false;
      }
    },
  });
  if (!executablePath) {
    yield* Effect.logDebug(
      "No Chrome or Chromium found, so this server cannot render previews itself. Connect a desktop app to view them.",
    );
    return;
  }

  const parentScope = yield* Effect.scope;
  const pages = yield* Ref.make<ReadonlyMap<string, PageSession>>(new Map());

  /**
   * Launching is deferred until a request actually needs a page.
   *
   * Registering as a host is free, but a browser process is not, and the broker
   * prefers whichever host supports more operations. So whenever a desktop app
   * is connected this host is never asked to do anything and never launches
   * anything: a desktop-hosted environment does not pay for a Chromium it will
   * not use. The same applies to a CLI server nobody opens a preview on.
   */
  const launchBrowser = Effect.fn("HeadlessBrowserHost.launchBrowser")(function* () {
    const userDataDir = yield* Effect.try({
      try: () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-preview-")),
      catch: (cause) => cause,
    }).pipe(Effect.orDie);
    yield* Scope.addFinalizer(
      parentScope,
      Effect.sync(() => {
        try {
          NodeFS.rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          // A scratch profile left behind in tmp is not worth failing shutdown.
        }
      }),
    );

    const command = ChildProcess.make(executablePath, [...chromiumLaunchArgs(userDataDir)], {
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: Duration.seconds(2),
    });
    const child = yield* spawner.spawn(command);
    yield* Scope.addFinalizer(parentScope, child.kill().pipe(Effect.ignore));

    const endpoint = yield* awaitDevToolsEndpoint(child.stderr).pipe(
      Effect.timeoutOption(STARTUP_TIMEOUT),
    );
    const resolvedEndpoint =
      endpoint._tag === "Some" && endpoint.value._tag === "Some" ? endpoint.value.value : null;
    if (!resolvedEndpoint) {
      return yield* new CdpClient.CdpCommandError({
        method: "launch",
        detail: "the preview browser did not report a debugger endpoint in time",
      });
    }
    const connected = yield* CdpClient.connect(resolvedEndpoint).pipe(
      Effect.provideService(Scope.Scope, parentScope),
    );
    // One screencast listener for every page; the session id on the event says
    // which tab produced the frame.
    const unsubscribe = connected.on((event) => {
      if (event.method !== "Page.screencastFrame" || event.sessionId === undefined) return;
      const sessionId = event.sessionId;
      const data = readString(event.params, "data");
      const metadata = event.params["metadata"];
      Effect.runFork(
        Effect.gen(function* () {
          // Acknowledge first: Chromium will not send another frame until the
          // previous one is acknowledged, which is the backpressure we want.
          const cdpSessionId = readNumber(event.params, "sessionId");
          if (cdpSessionId !== undefined) {
            yield* connected
              .send("Page.screencastFrameAck", { sessionId: cdpSessionId }, sessionId)
              .pipe(Effect.ignore);
          }
          if (!data) return;
          const current = yield* Ref.get(pages);
          const page = Array.from(current.values()).find(
            (candidate) => candidate.sessionId === sessionId,
          );
          if (!page || !page.streaming) return;
          page.sequence += 1;
          yield* manager.publishFrame({
            threadId: page.threadId,
            tabId: page.tabId,
            seq: page.sequence,
            data,
            width: readNumber(metadata, "deviceWidth") ?? page.viewport.width,
            height: readNumber(metadata, "deviceHeight") ?? page.viewport.height,
            pageWidth: page.viewport.width,
            pageHeight: page.viewport.height,
            capturedAt: new Date().toISOString(),
          });
        }).pipe(Effect.ignoreCause({ log: true })),
      );
    });
    yield* Scope.addFinalizer(parentScope, Effect.sync(unsubscribe));
    yield* Effect.logInfo(`Headless preview browser ready: ${executablePath}`);
    return connected;
  });

  const browser = yield* SynchronizedRef.make<CdpClient.CdpClient | null>(null);
  const requireBrowser = SynchronizedRef.modifyEffect(browser, (current) =>
    current === null
      ? launchBrowser().pipe(Effect.map((client) => [client, client] as const))
      : Effect.succeed([current, current] as const),
  );

  const attachPage = Effect.fn("HeadlessBrowserHost.attachPage")(function* (input: {
    readonly threadId: string;
    readonly tabId: string;
  }) {
    const cdp = yield* requireBrowser;
    const created = yield* cdp.send("Target.createTarget", { url: "about:blank" });
    const targetId = readString(created, "targetId");
    if (!targetId) {
      return yield* new CdpClient.CdpCommandError({
        method: "Target.createTarget",
        detail: "no target id",
      });
    }
    const attached = yield* cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = readString(attached, "sessionId");
    if (!sessionId) {
      return yield* new CdpClient.CdpCommandError({
        method: "Target.attachToTarget",
        detail: "no session id",
      });
    }
    yield* cdp.send("Page.enable", {}, sessionId);
    yield* cdp.send("Runtime.enable", {}, sessionId);
    yield* cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { ...DEFAULT_VIEWPORT, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const session: PageSession = {
      targetId,
      sessionId,
      tabId: input.tabId,
      threadId: input.threadId,
      streaming: false,
      viewport: { ...DEFAULT_VIEWPORT },
      sequence: 0,
    };
    yield* Ref.update(pages, (current) => {
      const next = new Map(current);
      next.set(input.tabId, session);
      return next;
    });
    return session;
  });

  const requirePage = Effect.fn("HeadlessBrowserHost.requirePage")(function* (input: {
    readonly threadId: string;
    readonly tabId: string | undefined;
  }) {
    const current = yield* Ref.get(pages);
    const existing = input.tabId ? current.get(input.tabId) : undefined;
    if (existing) return existing;
    const anyForThread = Array.from(current.values()).find(
      (page) => page.threadId === input.threadId,
    );
    if (!input.tabId && anyForThread) return anyForThread;
    // A tab the server owns is created lazily: the viewer asked for something
    // this host has not opened yet.
    const opened = yield* manager.open({ threadId: input.threadId as never });
    return yield* attachPage({ threadId: input.threadId, tabId: input.tabId ?? opened.tabId });
  });

  const dispatchInput = Effect.fn("HeadlessBrowserHost.dispatchInput")(function* (
    page: PageSession,
    event: PreviewInputEvent,
  ) {
    const cdp = yield* requireBrowser;
    if (event._tag === "mouse") {
      yield* cdp.send(
        "Input.dispatchMouseEvent",
        {
          type: event.kind,
          x: event.x,
          y: event.y,
          button: event.button,
          clickCount: event.clickCount,
          modifiers: event.modifiers,
        },
        page.sessionId,
      );
      return;
    }
    if (event._tag === "wheel") {
      yield* cdp.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: event.x,
          y: event.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: event.modifiers,
        },
        page.sessionId,
      );
      return;
    }
    yield* cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: event.kind,
        key: event.key,
        code: event.code,
        modifiers: event.modifiers,
        ...(event.text === undefined ? {} : { text: event.text }),
      },
      page.sessionId,
    );
  });

  const handle = Effect.fn("HeadlessBrowserHost.handle")(function* (
    request: PreviewAutomationRequest,
  ) {
    const cdp = yield* requireBrowser;
    const input = isRecord(request.input) ? request.input : {};
    switch (request.operation) {
      case "status": {
        const current = yield* Ref.get(pages);
        const page = request.tabId
          ? current.get(request.tabId)
          : Array.from(current.values()).find(
              (candidate) => candidate.threadId === request.threadId,
            );
        if (!page) {
          return {
            available: true,
            visible: false,
            tabId: null,
            url: null,
            title: null,
            loading: false,
          };
        }
        const evaluated = yield* cdp
          .send(
            "Runtime.evaluate",
            { expression: "[location.href, document.title]", returnByValue: true },
            page.sessionId,
          )
          .pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
        const value = isRecord(evaluated["result"]) ? evaluated["result"]["value"] : undefined;
        const pair = Array.isArray(value) ? value : [];
        return {
          available: true,
          visible: true,
          tabId: page.tabId,
          url: typeof pair[0] === "string" ? pair[0] : null,
          title: typeof pair[1] === "string" ? pair[1] : null,
          loading: false,
        };
      }
      case "open": {
        const page = yield* requirePage({ threadId: request.threadId, tabId: request.tabId });
        const url = typeof input["url"] === "string" ? input["url"] : undefined;
        if (url) yield* cdp.send("Page.navigate", { url }, page.sessionId);
        return {
          available: true,
          visible: true,
          tabId: page.tabId,
          url: url ?? null,
          title: null,
          loading: Boolean(url),
        };
      }
      case "navigate": {
        const page = yield* requirePage({ threadId: request.threadId, tabId: request.tabId });
        const url = typeof input["url"] === "string" ? input["url"] : undefined;
        if (!url) {
          return yield* new CdpClient.CdpCommandError({
            method: "Page.navigate",
            detail: "no url supplied",
          });
        }
        yield* cdp.send("Page.navigate", { url }, page.sessionId);
        return { tabId: page.tabId };
      }
      case "evaluate": {
        const page = yield* requirePage({ threadId: request.threadId, tabId: request.tabId });
        const expression = typeof input["expression"] === "string" ? input["expression"] : "";
        const evaluated = yield* cdp.send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          page.sessionId,
        );
        return isRecord(evaluated["result"]) ? evaluated["result"]["value"] : undefined;
      }
      case "resize": {
        const page = yield* requirePage({ threadId: request.threadId, tabId: request.tabId });
        const width = readNumber(input, "width") ?? page.viewport.width;
        const height = readNumber(input, "height") ?? page.viewport.height;
        page.viewport = { width, height };
        yield* cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width, height, deviceScaleFactor: 1, mobile: false },
          page.sessionId,
        );
        return { tabId: page.tabId, viewport: { width, height } };
      }
      case "setColorScheme": {
        const page = yield* requirePage({ threadId: request.threadId, tabId: request.tabId });
        const colorScheme =
          typeof input["colorScheme"] === "string" ? input["colorScheme"] : "system";
        yield* cdp.send(
          "Emulation.setEmulatedMedia",
          colorScheme === "system"
            ? { features: [] }
            : { features: [{ name: "prefers-color-scheme", value: colorScheme }] },
          page.sessionId,
        );
        return { tabId: page.tabId, colorScheme };
      }
      case "streamStart": {
        const page = yield* requirePage({ threadId: request.threadId, tabId: request.tabId });
        page.streaming = true;
        yield* cdp.send(
          "Page.startScreencast",
          {
            format: "jpeg",
            quality: readNumber(input, "quality") ?? 60,
            maxWidth: readNumber(input, "maxWidth") ?? 1280,
            maxHeight: readNumber(input, "maxHeight") ?? 800,
            everyNthFrame: 1,
          },
          page.sessionId,
        );
        return { tabId: page.tabId, streaming: true };
      }
      case "streamStop": {
        const current = yield* Ref.get(pages);
        const page = request.tabId ? current.get(request.tabId) : undefined;
        if (!page) return { streaming: false };
        page.streaming = false;
        yield* cdp.send("Page.stopScreencast", {}, page.sessionId).pipe(Effect.ignore);
        return { tabId: page.tabId, streaming: false };
      }
      case "dispatchInput": {
        const page = yield* requirePage({ threadId: request.threadId, tabId: request.tabId });
        const event = input["event"];
        if (isRecord(event)) {
          yield* dispatchInput(page, event as unknown as PreviewInputEvent);
        }
        return { tabId: page.tabId };
      }
      default:
        // The broker routes by advertised operations, so this is only reachable
        // if the two lists drift apart.
        return yield* new CdpClient.CdpCommandError({
          method: request.operation,
          detail: "not supported by the headless preview host",
        });
    }
  });

  const events = yield* broker.connect({
    clientId: HEADLESS_CLIENT_ID,
    environmentId: "server-headless" as never,
    supportedOperations: [...HEADLESS_SUPPORTED_OPERATIONS],
  });

  let connectionId: string | null = null;
  yield* events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.type === "connected") {
          connectionId = event.connectionId;
          return;
        }
        if (connectionId === null) return;
        const activeConnectionId = connectionId;
        const outcome = yield* Effect.result(handle(event.request));
        yield* broker
          .respond(
            Result.isSuccess(outcome)
              ? {
                  clientId: HEADLESS_CLIENT_ID,
                  connectionId: activeConnectionId,
                  requestId: event.request.requestId,
                  ok: true,
                  result: outcome.success,
                }
              : {
                  clientId: HEADLESS_CLIENT_ID,
                  connectionId: activeConnectionId,
                  requestId: event.request.requestId,
                  ok: false,
                  error: {
                    _tag: outcome.failure._tag,
                    message: outcome.failure.message,
                  },
                },
          )
          .pipe(Effect.ignore);
      }),
    ),
  );
});

/**
 * Never fails the server. A machine with no browser, or a browser that will not
 * start, must not stop `npx t3` from serving everything else.
 */
export const layer = Layer.effectDiscard(
  Effect.forkScoped(
    run.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The headless preview host stopped.", { cause }),
      ),
    ),
  ),
);

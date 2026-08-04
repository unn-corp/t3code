# Remote preview viewing

How the in-app browser reaches a client that cannot render a page itself (web
and the PWA), instead of being desktop-only.

## Why this shape

The server never renders a page and never has. `apps/server/src/preview/Manager.ts`
is session bookkeeping (tabs, URLs, status, events) and
`apps/server/src/mcp/PreviewAutomationBroker.ts` is a broker: it hands an
operation to whichever **client** registered as an automation host and waits for
that client's answer. The host has always been the desktop runtime, which owns a
Chromium `<webview>`.

That leaves exactly one thing missing for a web client: it has no webview, so it
can neither show the page nor act on it. Everything else already worked, and
notably the desktop host registers **per environment connection rather than per
open panel** (see the comment in `PreviewAutomationHosts.tsx`), so agent-driven
`preview_*` tools already served threads driven from any client. They simply
rendered where that client could not see them.

So this is a transport and surface problem. Nothing in the desktop preview
manager, `PickPreload.ts`, or `PlaywrightInjectedRuntime.ts` is duplicated.

## The path a frame takes

```
desktop host              server                        web / PWA viewer
capture loop  ──publishFrame──▶  frame channel  ──previewAttach──▶  canvas
dispatchInput ◀──dispatchToHost──  previewInput  ◀──pointer/key──   canvas
                          StreamCoordinator
                          demand 0→1 start, 1→0 stop
```

- **`preview.attach`** (streaming) is what a viewer calls. Attaching _is_ the
  demand signal; the last detach drops it back to zero.
- **`preview.publishFrame`** is host to server, fire and forget. A dropped frame
  is always recoverable because a newer one follows.
- **`preview.input`** carries a narrow subset of CDP's `Input` domain, in page
  CSS pixels.

## Design decisions worth keeping

**Frames slide, they do not queue.** The per-tab channel is `PubSub.sliding` of
depth 2. A viewer only ever wants the newest frame, and a stalled subscriber
must not pin decoded JPEGs in memory. This is the only high-rate payload on the
websocket, so the drop policy is deliberate rather than incidental.

**Viewer input does not use `invoke`.** `PreviewAutomationBroker.invoke` takes a
provider-session lease and awaits a reply, which is right for an agent doing a
multi-step interaction and wrong for a pointer at 60Hz: every mouse move would
allocate a pending-request entry and pay a round trip. `dispatchToHost` is
fire-and-forget and takes no lease.

**`dispatchToHost`'s `environmentId` is optional.** A websocket handler has none
to give: `ws.ts` never sees one, because the id is a client-side _label_ for
this server and two clients can name the same process differently. MCP callers,
which do have a scope, still pass it to stay pinned to one runtime.

**Remote viewing is a third frame-capture consumer.** The desktop's
`FrameCaptureSession` already multiplexed recording and picture-in-picture over
one `capturePage` loop; `"remote"` joins them. A tab that is recorded and
watched remotely still captures once, then encodes per viewer bounds.

**Viewer input is human input.** `dispatchRemoteInput` deliberately does not
register through `expectAgentInput`. That mechanism exists to tell agent-driven
input apart from a person's, and someone tapping their phone is a person, so the
tab's controller correctly flips to `human`.

**Host availability is answered on the stream, not by a gate.**
`isPreviewSupportedInRuntime()` now means "can show a preview at all" and is true
in any browser; `isPreviewRenderedLocally()` is the narrower check for controls
that need a local webview. Whether a host is _connected_ changes whenever a
desktop app opens or closes, so it is reported as an `unavailable` event on the
frame stream rather than computed once and cached.

**Demand is re-issued when a host appears.** A viewer can attach before any
desktop app is running, and a host can die and return while a viewer watches.
`broker.hostConnected` lets `StreamCoordinator` re-issue the start for
everything still wanted. Starting a stream the host already runs is a no-op:
its capture session is keyed by consumer.

**The page size travels with the frame.** A viewer maps a tap through
`pageWidth`/`pageHeight` rather than knowing the host's scale factor. The host
re-reads the guest viewport whenever the captured pixel size changes, which is
the only signal the main process gets that a renderer-side layout changed.

## What is still host-only

- **DevTools** opens on the host machine. Remote DevTools needs a served
  devtools-frontend and is out of scope.
- **Reveal artifact** opens the host's file manager, which means nothing on a
  phone.
- **An environment with no host at all** (bare `npx t3`, no desktop app) has
  nothing that can render. The viewer says so rather than hanging. Closing that
  would mean the server owning a Chromium over CDP, which is a deliberate
  non-goal here: it is a heavy dependency for the CLI.
